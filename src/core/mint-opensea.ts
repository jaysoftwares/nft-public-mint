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
  OpenSeaFailure,
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
  /**
   * Hold until the stage actually opens, rather than firing once at `startAt`.
   *
   * Without this a scheduled burst is a single shot: if the stage opens even a
   * second later than published — or the clocks disagree — every wallet gets
   * "not currently active" and the run is over. Holding turns a near miss into
   * a wait.
   */
  waitForOpen?: boolean;
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

/**
 * How the pre-open hold is paced.
 *
 * The endpoint refuses to issue calldata before a stage opens, so the only way
 * to start at the instant it does is to keep asking. The cost of asking is rate
 * limit, and rate limit is scarcest at exactly the moment it matters — spending
 * it on a countdown would leave none for the burst it exists to enable.
 *
 * The published start time does most of the work: while it is far away there is
 * nothing to learn, so the hold sleeps instead of polling. Probing only tightens
 * inside the lead window, and even then it is one request for one wallet, not a
 * fetch for all of them. At the tight cadence that is under two requests a
 * second against a documented budget several times larger — deliberately
 * conservative, because being throttled at T-0 costs the drop.
 *
 * The loose cadence outside the window is not redundant: a published start time
 * can move, and a stage that opens early would otherwise be missed entirely.
 */
export const OPEN_POLL = {
  /** Stop sleeping and start probing this long before the published open. */
  leadMs: 5_000,
  /** Cadence inside the lead window, and after an unknown-time start. */
  tightMs: 600,
  /** Cadence while still far out — a guard against a start time that moves. */
  looseMs: 15_000,
  /** Never issue two probes closer together than this, whatever else says. */
  floorMs: 400,
  /** Give up this long after the stage was supposed to open. */
  graceMs: 180_000,
  /**
   * Timeout for a probe, and the ceiling it escalates to.
   *
   * Measured live at the 16:00Z open: the first probe hung and took the full
   * 8s default with it, so detection landed 9s after the stage opened rather
   * than inside a second. A probe is asking a yes/no question and is cheap to
   * repeat, so a hung one should be abandoned quickly rather than waited on.
   *
   * It escalates on consecutive timeouts because the opposite failure is worse:
   * if the endpoint is merely slow under load, a fixed short timeout would
   * abandon every attempt and never get an answer at all. Any answer resets it.
   */
  probeTimeoutMs: 2_500,
  maxProbeTimeoutMs: 8_000,
  /** Applied to the interval after a 429, and the ceiling it climbs to. */
  backoffFactor: 2,
  firstBackoffMs: 2_000,
  maxBackoffMs: 30_000,
};

/**
 * What a refusal during the hold means for whether to keep waiting.
 *
 * `reachedOpenTime` is what makes this safe, and it is not a detail. A drop
 * usually has several stages, and OpenSea picks one server-side from the
 * minter's eligibility — so a probe sent while some *other* stage is live gets
 * a confident answer about that stage, not about the one being waited for. OMR
 * EVO had four stages with a holder claim live and the public sale still an
 * hour out; reading "not eligible" as "open" there would have fired the whole
 * set into a stage it could not mint, an hour early, and called it a day.
 *
 * So nothing observed before the target open time is conclusive. After it,
 * "not eligible" and "insufficient balance" are answers about a *wallet*, which
 * means the stage is answering: waiting longer will not change them, and the
 * burst should go ahead, since every wallet asks for itself and this prober's
 * verdict is not theirs.
 */
export function openSignal(
  kind: OpenSeaFailure | undefined,
  reachedOpenTime: boolean
): "open" | "wait" | "abort" {
  // Neither a rejected key nor a barred account is repaired by waiting, and
  // both are visible before the open — so they abort regardless of timing.
  // A restricted prober would otherwise spin out the whole grace period.
  if (kind === "auth" || kind === "account_restricted") return "abort";

  if (!reachedOpenTime) return "wait";

  switch (kind) {
    case "not_eligible":
    case "insufficient_balance":
      return "open";
    case "minted_out":
      return "abort";
    default:
      // not_live, rate_limited, server, unknown, or a transport error.
      return "wait";
  }
}

export type OpenSeaMintEvent =
  | { type: "waiting"; msRemaining: number }
  | { type: "probing"; attempt: number; msPastOpen: number; reason: string }
  | { type: "open"; attempts: number; waitedMs: number; hadCalldata: boolean }
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Wait for the stage to start answering, then hand back the calldata that
 * proved it.
 *
 * One wallet does the asking. Probing with all of them would multiply the rate
 * limit spend by the size of the set for no extra information — the endpoint is
 * either issuing calldata or it is not, and that is a property of the stage.
 *
 * Returns the prober's calldata on success, or undefined when the stage turned
 * out to be open but had nothing to give this particular wallet (not eligible,
 * or unable to pay). That is still a green light: the burst goes ahead and each
 * wallet gets its own answer.
 */
export async function holdUntilOpen(
  req: OpenSeaMintRequest,
  deps: OpenSeaMintDeps,
  prober: { id: string; address: string },
  emit: (event: OpenSeaMintEvent) => void
): Promise<Fetched | undefined> {
  const startedAt = Date.now();
  const openAt = req.startAt?.getTime();
  const deadline = (openAt ?? startedAt) + OPEN_POLL.graceMs;

  let attempts = 0;
  let backoffMs = 0;
  let probeTimeoutMs = OPEN_POLL.probeTimeoutMs;
  let lastReason = "waiting for the stage to open";

  for (;;) {
    const now = Date.now();

    if (now > deadline) {
      throw new OpenSeaMintError(
        `The stage never opened. Gave up ${Math.round((now - (openAt ?? startedAt)) / 1000)}s ` +
          `after the published start, having asked ${attempts} time(s).\n` +
          `Last answer: ${lastReason}`
      );
    }

    // While the open is still far off there is nothing to learn from asking, so
    // this sleeps rather than spending requests on a countdown.
    const untilOpen = openAt === undefined ? 0 : openAt - now;
    if (untilOpen > OPEN_POLL.leadMs) {
      emit({ type: "waiting", msRemaining: untilOpen });
      await sleep(Math.min(untilOpen - OPEN_POLL.leadMs, OPEN_POLL.looseMs));
      continue;
    }

    // Without a published time there is nothing to be early relative to, so any
    // answer counts. With one, only answers from the open onwards do.
    const reachedOpenTime = openAt === undefined || now >= openAt;

    attempts += 1;
    try {
      // Calldata in hand means a stage is live, eligible and priced for this
      // wallet — even if it is not the one that was being waited for. That is a
      // mint the operator asked for, and maxUnitPriceWei still gates the cost.
      const tx = await fetchMintCalldata(
        deps.apiKey,
        req.slug,
        prober.address,
        req.quantity,
        probeTimeoutMs
      );
      emit({
        type: "open",
        attempts,
        waitedMs: Date.now() - startedAt,
        hadCalldata: true,
      });
      return { id: prober.id, address: prober.address, tx };
    } catch (err) {
      const apiError = err instanceof OpenSeaApiError ? err : undefined;
      lastReason = apiError?.message ?? (err as Error).message;
      const signal = openSignal(apiError?.kind, reachedOpenTime);

      if (signal === "abort") throw apiError ?? err;

      if (signal === "open") {
        emit({ type: "open", attempts, waitedMs: Date.now() - startedAt, hadCalldata: false });
        return undefined;
      }

      // A timeout is not an answer, so the next attempt waits a little longer
      // for one. Anything the endpoint actually said resets the patience.
      if (apiError === undefined && /abort|timeout/i.test(lastReason)) {
        probeTimeoutMs = Math.min(OPEN_POLL.maxProbeTimeoutMs, Math.round(probeTimeoutMs * 1.6));
      } else {
        probeTimeoutMs = OPEN_POLL.probeTimeoutMs;
      }

      // Only a throttle earns a longer gap. Backing off on "not currently
      // active" would walk the cadence away from the open it is waiting for.
      if (apiError?.kind === "rate_limited") {
        backoffMs = Math.min(
          OPEN_POLL.maxBackoffMs,
          backoffMs === 0 ? OPEN_POLL.firstBackoffMs : backoffMs * OPEN_POLL.backoffFactor
        );
      } else {
        backoffMs = 0;
      }

      const nextInMs = Math.max(OPEN_POLL.floorMs, backoffMs || OPEN_POLL.tightMs);
      emit({
        type: "probing",
        attempt: attempts,
        msPastOpen: openAt === undefined ? Date.now() - startedAt : Date.now() - openAt,
        reason: lastReason,
      });
      await sleep(nextInMs);
    }
  }
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

  // ── Hold for the stage ──
  //
  // Two modes. Scheduled-only sleeps to the instant and fires once, which is
  // right when the time is known to be right. Holding keeps asking until the
  // endpoint actually answers, which is right when it might not be.
  let seeded: Fetched | undefined;
  if (req.waitForOpen) {
    seeded = await holdUntilOpen(req, deps, affordable[0], emit);
  } else if (req.startAt && req.startAt.getTime() > Date.now()) {
    emit({ type: "waiting", msRemaining: req.startAt.getTime() - Date.now() });
    await sleepUntil(req.startAt.getTime());
  }

  // ── Fetch calldata, paced ──
  const fetchStart = process.hrtime.bigint();
  const fetched: Fetched[] = [];
  const fetchFailures: { address: string; reason: string }[] = [];

  // The probe that opened the door already holds valid calldata for its wallet.
  // Throwing it away would cost a second request for no gain, at the one moment
  // requests are worth most.
  const queue = seeded ? affordable.filter((w) => w.id !== seeded!.id) : affordable;
  if (seeded) fetched.push(seeded);

  let cursor = 0;
  let lastStart = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= queue.length) return;
      const wallet = queue[index];

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
      if (done % 5 === 0 || done === queue.length) {
        emit({ type: "fetching", done, total: queue.length, failures: fetchFailures.length });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(deps.pacing.concurrency, Math.max(1, queue.length))) },
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
