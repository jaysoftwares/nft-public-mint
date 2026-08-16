// Minting through OpenSea's v2 API.
//
// OpenSea hands back finished calldata rather than parameters, which is
// convenient and also the reason this file exists: calldata from a third party
// is not something to sign blindly across 500 wallets. Two checks stand between
// the response and a signature.
//
//   Decode. Every SeaDrop entry point starts (nftContract, feeRecipient,
//   minterIfNotPayer, quantity, …), so the contract we asked about and the
//   wallet being credited are both readable straight out of the response. A
//   non-zero minterIfNotPayer that is not our wallet would mint to someone else
//   while we pay — the same failure copy-mint guards against.
//
//   Simulate. One eth_estimateGas from a real wallet proves the call would
//   actually succeed, and prices the gas limit as a side effect.
//
// Timing is the awkward part and it is not fixable here: OpenSea refuses to
// issue calldata before a stage opens, so the fetch cannot be moved off the
// critical path. What can be done is to have everything else ready — nonces
// primed, sockets warm, wallets checked — so the only work left at T-0 is the
// API round-trip, signing, and dispatch.

import { Interface, getAddress, formatEther, Wallet, HDNodeWallet } from "ethers";
import { SEADROP_ADDRESS } from "../seadrop-public";
import { NonceManager } from "./nonce-manager";
import { Endpoint, dispatchAll, prepareTx, summariseErrors } from "./dispatcher";
import { fetchBalances, requiredPerWallet, shortfalls, Shortfall } from "./balances";
import { collectReceipts, sleepUntil, ReceiptRow } from "./mint-runtime";
import { simulate } from "./calldata";
import { warmSockets, rpcCall } from "./rpc";
import { record } from "./ledger";
import {
  MintCalldata,
  OpenSeaApiError,
  fetchMintCalldata,
} from "./opensea-api";

const ZERO = "0x0000000000000000000000000000000000000000";

// Every SeaDrop mint entry point shares its first four parameters, so one
// decoder covers public, allowlist and signed stages alike.
const SEADROP_HEADS = new Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
  "function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool) mintParams, bytes32[] proof)",
  "function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool) mintParams, uint256 salt, bytes signature)",
]);

export class OpenSeaMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenSeaMintError";
  }
}

export interface CalldataCheck {
  ok: boolean;
  method?: string;
  decodedContract?: string;
  creditedTo?: string;
  quantity?: number;
  reason?: string;
}

/**
 * Read back what a returned transaction would actually do.
 *
 * An unrecognised target or selector is reported, not rejected — OpenSea may
 * route a drop through something other than the SeaDrop singleton, and the
 * simulation still gates those. What is rejected outright is a call that would
 * credit a wallet other than the one paying.
 */
export function inspectCalldata(
  tx: MintCalldata,
  expectedContract: string,
  minter: string
): CalldataCheck {
  if (tx.to.toLowerCase() !== SEADROP_ADDRESS.toLowerCase()) {
    return {
      ok: true,
      reason: `target is ${tx.to}, not the SeaDrop singleton — relying on simulation alone`,
    };
  }

  let parsed;
  try {
    parsed = SEADROP_HEADS.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    return { ok: true, reason: "unrecognised SeaDrop selector — relying on simulation alone" };
  }
  if (!parsed) {
    return { ok: true, reason: "calldata did not decode — relying on simulation alone" };
  }

  const nftContract = String(parsed.args[0]);
  const minterIfNotPayer = String(parsed.args[2]);
  const quantity = Number(parsed.args[3]);

  if (getAddress(nftContract) !== getAddress(expectedContract)) {
    return {
      ok: false,
      method: parsed.name,
      decodedContract: nftContract,
      reason:
        `calldata mints ${nftContract} but we asked for ${expectedContract} — ` +
        "refusing rather than minting a different collection",
    };
  }

  // Zero means "credit msg.sender", which is what we want. Anything else must
  // be us, or we would be paying for someone else's NFT.
  const credited = minterIfNotPayer === ZERO ? minter : minterIfNotPayer;
  if (getAddress(credited) !== getAddress(minter)) {
    return {
      ok: false,
      method: parsed.name,
      creditedTo: minterIfNotPayer,
      reason:
        `calldata credits ${minterIfNotPayer}, not ${minter} — ` +
        "this would mint into another wallet at our expense",
    };
  }

  return {
    ok: true,
    method: parsed.name,
    decodedContract: nftContract,
    creditedTo: credited,
    quantity,
  };
}

export interface OpenSeaMintDeps {
  readUrl: string;
  allRpcUrls: string[];
  endpoints: Endpoint[];
  chainId: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonces: NonceManager;
  signerFor(id: string): Wallet | HDNodeWallet;
  apiKey: string;
  /** Sanity ceiling on unit price — a guard against an unexpected response. */
  maxUnitPriceWei: bigint;
  pacing: { concurrency: number; minDelayMs: number; maxRetries: number };
}

export interface OpenSeaMintRequest {
  slug: string;
  nftContract: string;
  quantity: number;
  wallets: { id: string; address: string }[];
  /** Wall-clock instant to begin fetching. Undefined starts immediately. */
  startAt?: Date;
  skipUnderfunded: boolean;
  /**
   * Stage price in wei, read from the drop detail before T-0.
   *
   * Used to screen out wallets that cannot pay *before* any API call is made.
   * OpenSea refuses underfunded minters with "Insufficient balance to mint" —
   * even on free drops, since gas still has to be covered — so fetching for
   * them spends rate limit on a guaranteed rejection at the exact moment rate
   * limit is scarcest.
   */
  unitPriceHintWei?: bigint;
}

export type OpenSeaMintEvent =
  | { type: "waiting"; msRemaining: number }
  | { type: "fetching"; done: number; total: number; failures: number }
  | { type: "fetched"; ok: number; failed: number; ms: number; unitPriceWei: bigint }
  | { type: "inspected"; ok: number; rejected: { address: string; reason: string }[] }
  | { type: "simulated"; gasLimit: number }
  | { type: "funding"; eligible: number; underfunded: Shortfall[]; requiredPerWallet: bigint }
  | { type: "signing"; done: number; total: number }
  | { type: "dispatched"; count: number; ms: number }
  | { type: "receipts"; confirmed: number; reverted: number; pending: number; total: number }
  | { type: "done"; report: OpenSeaMintReport };

export interface OpenSeaMintReport {
  slug: string;
  contract: string;
  quantity: number;
  requested: number;
  fetched: number;
  attempted: number;
  accepted: number;
  confirmed: number;
  reverted: number;
  pending: number;
  unitPriceWei: bigint;
  totalValue: bigint;
  fetchMs: number;
  dispatchMs: number;
  rows: ReceiptRow[];
  fetchFailures: { address: string; reason: string }[];
  errorSummary: { reason: string; count: number }[];
}

interface Fetched {
  id: string;
  address: string;
  tx: MintCalldata;
}

export async function executeOpenSeaMint(
  req: OpenSeaMintRequest,
  deps: OpenSeaMintDeps,
  emit: (event: OpenSeaMintEvent) => void
): Promise<OpenSeaMintReport> {
  if (req.wallets.length === 0) throw new OpenSeaMintError("No wallets selected.");

  // Everything that can be done before T-0 is done before T-0. The API call is
  // the only thing that genuinely cannot move.
  await warmSockets(deps.allRpcUrls);
  await deps.nonces.prime(req.wallets);

  // ── Screen out wallets OpenSea would refuse anyway ──
  //
  // Done here, before the hold, so the T-0 burst carries only wallets that can
  // actually mint. The estimate uses the configured gas limit; the real one
  // comes back from simulation later and is usually smaller.
  const preflightRequired = requiredPerWallet(
    deps.gasLimit,
    deps.maxFeePerGas,
    (req.unitPriceHintWei ?? 0n) * BigInt(req.quantity)
  );
  const preflightBalances = await fetchBalances(deps.readUrl, req.wallets);
  const preflightShort = shortfalls(req.wallets, preflightBalances, preflightRequired);
  const affordable = req.wallets.filter((w) => !preflightShort.some((s) => s.id === w.id));

  emit({
    type: "funding",
    eligible: affordable.length,
    underfunded: preflightShort,
    requiredPerWallet: preflightRequired,
  });

  if (preflightShort.length > 0 && !req.skipUnderfunded) {
    throw new OpenSeaMintError(
      `${preflightShort.length} of ${req.wallets.length} wallets hold less than ` +
        `${formatEther(preflightRequired)} ETH. OpenSea refuses underfunded minters outright, ` +
        "so they would be rejected rather than merely failing later."
    );
  }
  if (affordable.length === 0) {
    throw new OpenSeaMintError(
      `Every wallet holds less than ${formatEther(preflightRequired)} ETH. ` +
        "OpenSea will not issue calldata to a wallet that cannot cover the mint and its gas — " +
        "fund them first."
    );
  }

  if (req.startAt && req.startAt.getTime() > Date.now()) {
    emit({ type: "waiting", msRemaining: req.startAt.getTime() - Date.now() });
    await sleepUntil(req.startAt.getTime());
  }

  // ── Fetch calldata, paced ──
  const fetchStart = process.hrtime.bigint();
  const fetched: Fetched[] = [];
  const fetchFailures: { address: string; reason: string }[] = [];

  let cursor = 0;
  let lastStart = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= affordable.length) return;
      const wallet = affordable[index];

      // Slot claimed synchronously so concurrent workers cannot collide on it.
      const slot = Math.max(Date.now(), lastStart + deps.pacing.minDelayMs);
      lastStart = slot;
      const wait = slot - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      let attempt = 0;
      for (;;) {
        try {
          const tx = await fetchMintCalldata(deps.apiKey, req.slug, wallet.address, req.quantity);
          fetched.push({ id: wallet.id, address: wallet.address, tx });
          break;
        } catch (err) {
          const apiError = err instanceof OpenSeaApiError ? err : undefined;
          attempt += 1;
          if (!apiError?.retryable || attempt > deps.pacing.maxRetries) {
            fetchFailures.push({
              address: wallet.address,
              reason: apiError?.message ?? (err as Error).message,
            });
            break;
          }
          const base = apiError.kind === "rate_limited" ? 1500 : 400;
          await new Promise((r) => setTimeout(r, Math.min(20_000, base * 2 ** (attempt - 1))));
        }
      }

      done += 1;
      if (done % 5 === 0 || done === affordable.length) {
        emit({ type: "fetching", done, total: affordable.length, failures: fetchFailures.length });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(deps.pacing.concurrency, affordable.length)) },
      () => worker()
    )
  );

  const fetchMs = Number(process.hrtime.bigint() - fetchStart) / 1e6;
  if (fetched.length === 0) {
    throw new OpenSeaMintError(
      `No calldata obtained for any of ${req.wallets.length} wallet(s).\n` +
        (fetchFailures[0]?.reason ?? "")
    );
  }

  // OpenSea prices the stage; take it from the response rather than guessing.
  const unitPrice = fetched[0].tx.value / BigInt(req.quantity || 1);
  emit({
    type: "fetched",
    ok: fetched.length,
    failed: fetchFailures.length,
    ms: fetchMs,
    unitPriceWei: unitPrice,
  });

  if (unitPrice > deps.maxUnitPriceWei) {
    throw new OpenSeaMintError(
      `Unit price ${formatEther(unitPrice)} ETH exceeds the ${formatEther(deps.maxUnitPriceWei)} ETH ceiling ` +
        "in caps.maxPriceEth. Nothing was sent — raise the cap if this is expected."
    );
  }

  // ── Inspect every response ──
  const rejected: { address: string; reason: string }[] = [];
  const clean: Fetched[] = [];
  for (const item of fetched) {
    const check = inspectCalldata(item.tx, req.nftContract, item.address);
    if (check.ok) clean.push(item);
    else rejected.push({ address: item.address, reason: check.reason ?? "failed inspection" });
  }
  emit({ type: "inspected", ok: clean.length, rejected });

  if (clean.length === 0) {
    throw new OpenSeaMintError(
      `Every response failed inspection. First reason: ${rejected[0]?.reason ?? "unknown"}`
    );
  }

  // ── Simulate one, and take its gas estimate ──
  const probe = clean[0];
  const sim = await simulate(deps.readUrl, {
    from: probe.address,
    to: probe.tx.to,
    data: probe.tx.data,
    value: probe.tx.value,
  });
  if (!sim.ok) {
    throw new OpenSeaMintError(
      `Simulation reverted — nothing sent. ${sim.reason ?? "no reason given"}`
    );
  }
  const gasLimit = Math.max(
    sim.gasEstimate ? Number((sim.gasEstimate * 13n) / 10n) : deps.gasLimit,
    deps.gasLimit
  );
  emit({ type: "simulated", gasLimit });

  // Funding was screened before the burst; re-check only against the real gas
  // limit, which simulation has now priced properly.
  const required = requiredPerWallet(gasLimit, deps.maxFeePerGas, probe.tx.value);
  const balances = await fetchBalances(
    deps.readUrl,
    clean.map((c) => ({ id: c.id, address: c.address }))
  );
  const underfunded = shortfalls(
    clean.map((c) => ({ id: c.id, address: c.address })),
    balances,
    required
  );
  const funded = clean.filter((c) => !underfunded.some((u) => u.id === c.id));
  if (funded.length === 0) {
    throw new OpenSeaMintError(
      `Every wallet fell short of the ${formatEther(required)} ETH reservation once gas was priced.`
    );
  }

  // ── Sign and fire ──
  const prepared = [];
  for (let i = 0; i < funded.length; i++) {
    const item = funded[i];
    const raw = await deps.signerFor(item.id).signTransaction({
      to: item.tx.to,
      data: item.tx.data,
      value: item.tx.value,
      nonce: deps.nonces.next(item.address),
      gasLimit,
      maxFeePerGas: deps.maxFeePerGas,
      maxPriorityFeePerGas: deps.maxPriorityFeePerGas,
      type: 2,
      chainId: deps.chainId,
    });
    prepared.push(prepareTx(item.id, item.address, raw));
    if ((i + 1) % 25 === 0 || i + 1 === funded.length) {
      emit({ type: "signing", done: i + 1, total: funded.length });
    }
  }

  const report = await dispatchAll(prepared, deps.endpoints, {
    onDispatched: (count, ms) => emit({ type: "dispatched", count, ms }),
  });
  for (const outcome of report.outcomes) {
    if (!outcome.accepted) deps.nonces.rollback(outcome.address);
  }

  const totalValue = probe.tx.value * BigInt(report.accepted);
  if (report.accepted > 0) {
    record({
      kind: "mint",
      chainId: deps.chainId,
      contract: req.nftContract,
      walletIds: report.outcomes.filter((o) => o.accepted).map((o) => o.id),
      valueWei: totalValue.toString(),
      fromBlock: await currentBlock(deps.readUrl),
      note: `opensea ${req.slug}`,
    });
  }

  const rows = await collectReceipts(
    deps.readUrl,
    report.outcomes.filter((o) => o.accepted),
    (confirmed, reverted, pending, total) =>
      emit({ type: "receipts", confirmed, reverted, pending, total })
  );
  for (const outcome of report.outcomes) {
    if (outcome.accepted) continue;
    rows.push({ id: outcome.id, address: outcome.address, hash: outcome.hash, status: "reverted" });
  }

  const final: OpenSeaMintReport = {
    slug: req.slug,
    contract: req.nftContract,
    quantity: req.quantity,
    requested: req.wallets.length,
    fetched: fetched.length,
    attempted: prepared.length,
    accepted: report.accepted,
    confirmed: rows.filter((r) => r.status === "confirmed").length,
    reverted: rows.filter((r) => r.status === "reverted").length,
    pending: rows.filter((r) => r.status === "pending").length,
    unitPriceWei: unitPrice,
    totalValue,
    fetchMs,
    dispatchMs: report.dispatchMs,
    rows,
    fetchFailures: [...fetchFailures, ...rejected],
    errorSummary: summariseErrors(report.outcomes),
  };
  emit({ type: "done", report: final });
  return final;
}

async function currentBlock(readUrl: string): Promise<number | undefined> {
  try {
    return Number(BigInt(await rpcCall<string>(readUrl, "eth_blockNumber", [])));
  } catch {
    return undefined;
  }
}
