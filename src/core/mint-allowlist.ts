// Allowlist (FCFS) mints.
//
// The important property this stage has and mintSigned() does not: every
// transaction can be signed before the stage opens. Proofs are public data and
// mintParams are fixed, so nothing is waiting on a third party at T-0 — the fire
// moment is socket writes only, exactly as the public path already achieves.
//
// Each wallet's proof is different, so unlike mintPublic() the calldata is
// per-wallet rather than shared. That costs a little encoding time up front and
// nothing at all at the fire moment.

import { formatEther } from "ethers";
import { Wallet, HDNodeWallet } from "ethers";
import { resolveFeeRecipient } from "../seadrop-public";
import { SEADROP_ADDRESS } from "../seadrop-public";
import {
  EligibilityRow,
  MintParams,
  encodeMintAllowList,
  AllowListError,
} from "./allowlist";
import { NonceManager } from "./nonce-manager";
import { Endpoint, dispatchAll, prepareTx, PreparedTx, summariseErrors } from "./dispatcher";
import { fetchBalances, requiredPerWallet, shortfalls, Shortfall } from "./balances";
import { rpcCall, warmSockets } from "./rpc";
import { FeeQuote, sampleFees } from "./fee-oracle";
import { collectReceipts, sleepUntil } from "./mint-runtime";
import { record } from "./ledger";
import { ReceiptRow } from "./mint-runtime";

export interface AllowListMintDeps {
  readUrl: string;
  allRpcUrls: string[];
  endpoints: Endpoint[];
  chainId: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  /** Price gas from the chain rather than from config. Defaults to on. */
  autoPrice?: boolean;
  maxPriorityFeePerGas: bigint;
  nonces: NonceManager;
  signerFor(id: string): Wallet | HDNodeWallet;
}

export interface AllowListMintRequest {
  nftContract: string;
  quantity: number;
  /** Eligible wallets with their proofs, from checkEligibility(). */
  eligible: EligibilityRow[];
  waitForStart: boolean;
  skipUnderfunded: boolean;
}

export type AllowListEvent =
  | { type: "stage"; params: MintParams; startsAt: Date; endsAt: Date; live: boolean; feeRecipient: string }
  | { type: "funding"; eligible: number; underfunded: Shortfall[]; requiredPerWallet: bigint }
  | { type: "signing"; done: number; total: number }
  | { type: "armed"; total: number; signMs: number }
  | { type: "waiting"; msRemaining: number }
  | { type: "dispatched"; count: number; ms: number; wallets: PreparedTx[] }
  | { type: "receipts"; confirmed: number; reverted: number; pending: number; total: number; rows: ReceiptRow[] }
  | { type: "done"; report: AllowListMintReport };

export interface AllowListMintReport {
  contract: string;
  quantity: number;
  attempted: number;
  accepted: number;
  rejected: number;
  confirmed: number;
  reverted: number;
  pending: number;
  valuePerWallet: bigint;
  totalValue: bigint;
  dispatchMs: number;
  rows: ReceiptRow[];
  errorSummary: { reason: string; count: number }[];
}

export async function executeAllowListMint(
  req: AllowListMintRequest,
  deps: AllowListMintDeps,
  emit: (event: AllowListEvent) => void
): Promise<AllowListMintReport> {
  if (req.eligible.length === 0) {
    throw new AllowListError("No eligible wallets — run /check first.");
  }

  // Every eligible row carries the same stage parameters; take them from the
  // first and use it for pricing, timing and the per-wallet cap.
  const params = req.eligible[0].mintParams;
  if (!params) throw new AllowListError("Eligibility rows are missing mint parameters.");

  if (req.quantity > Number(params.maxTotalMintableByWallet)) {
    throw new AllowListError(
      `Quantity ${req.quantity} exceeds this stage's per-wallet cap of ${params.maxTotalMintableByWallet}. ` +
        "The proof commits to that cap, so a larger quantity cannot be made valid."
    );
  }

  const fee = await resolveFeeRecipient(
    deps.readUrl,
    req.nftContract,
    params.restrictFeeRecipients
  );
  if (!fee) {
    throw new AllowListError(
      "This drop restricts fee recipients and lists none on chain — the mint cannot be constructed."
    );
  }

  const startsAt = new Date(Number(params.startTime) * 1000);
  const endsAt = new Date(Number(params.endTime) * 1000);
  const now = Date.now();
  const live = now >= startsAt.getTime() && now < endsAt.getTime();
  emit({ type: "stage", params, startsAt, endsAt, live, feeRecipient: fee.address });

  if (now >= endsAt.getTime()) {
    throw new AllowListError(`That stage closed at ${endsAt.toISOString()}.`);
  }
  if (!live && !req.waitForStart) {
    throw new AllowListError(
      `The stage opens at ${startsAt.toISOString()}. Firing now reverts and burns gas — re-run with waiting enabled.`
    );
  }

  // ── Funding ──
  const value = params.mintPrice * BigInt(req.quantity);
  const targets = req.eligible.map((r) => ({ id: r.id, address: r.address }));
  // ── Price the gas from the chain ──
  //
  // The configured pair are bounds now — a ceiling and a floor — with the real
  // bid sampled from recent blocks between them. Done before the reservation
  // below, which is computed from the fee.
  let fees: FeeQuote = {
    maxFeePerGas: deps.maxFeePerGas,
    maxPriorityFeePerGas: deps.maxPriorityFeePerGas,
    baseFeeWei: 0n,
    source: "config",
    ceilingTooLow: false,
  };
  if (deps.autoPrice !== false) {
    fees = await sampleFees(deps.readUrl, {
      ceilingWei: deps.maxFeePerGas,
      priorityFloorWei: deps.maxPriorityFeePerGas,
    });
  }

  const required = requiredPerWallet(deps.gasLimit, fees.maxFeePerGas, value);
  const balances = await fetchBalances(deps.readUrl, targets);
  const underfunded = shortfalls(targets, balances, required);

  const funded = req.eligible.filter((r) => !underfunded.some((u) => u.id === r.id));
  emit({ type: "funding", eligible: funded.length, underfunded, requiredPerWallet: required });

  if (underfunded.length > 0 && !req.skipUnderfunded) {
    throw new AllowListError(
      `${underfunded.length} of ${req.eligible.length} eligible wallets hold less than the ` +
        `${formatEther(required)} ETH a node reserves. Fund them, or re-run allowing them to be skipped.`
    );
  }
  if (funded.length === 0) {
    throw new AllowListError("Every eligible wallet is underfunded — nothing can be sent.");
  }

  // ── Pre-sign, well before the stage ──
  await warmSockets(deps.allRpcUrls);
  await deps.nonces.prime(funded.map((r) => ({ id: r.id, address: r.address })));

  const signStart = process.hrtime.bigint();
  const prepared: PreparedTx[] = [];
  for (let i = 0; i < funded.length; i++) {
    const row = funded[i];
    if (!row.proof || !row.mintParams) continue;

    const data = encodeMintAllowList(
      req.nftContract,
      fee.address,
      req.quantity,
      row.mintParams,
      row.proof
    );
    const raw = await deps.signerFor(row.id).signTransaction({
      to: SEADROP_ADDRESS,
      data,
      value,
      nonce: deps.nonces.next(row.address),
      gasLimit: deps.gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      type: 2,
      chainId: deps.chainId,
    });
    prepared.push(prepareTx(row.id, row.address, raw));
    if ((i + 1) % 25 === 0 || i + 1 === funded.length) {
      emit({ type: "signing", done: i + 1, total: funded.length });
    }
  }

  const signMs = Number(process.hrtime.bigint() - signStart) / 1e6;
  emit({ type: "armed", total: prepared.length, signMs });

  // ── Hold, then fire ──
  if (!live && req.waitForStart) {
    emit({ type: "waiting", msRemaining: startsAt.getTime() - Date.now() });
    // Re-open the sockets on the near side of the fire: the pool drops idle
    // connections after fifteen seconds, and a held mint would otherwise pay
    // for TLS handshakes at the exact moment it should be sending.
    const fireAt = startsAt.getTime();
    if (fireAt - Date.now() > 1_500) {
      await sleepUntil(fireAt - 1_500);
      await warmSockets(deps.allRpcUrls);
    }
    await sleepUntil(fireAt);
  }

  const report = await dispatchAll(prepared, deps.endpoints, {
    onDispatched: (count, ms) => emit({ type: "dispatched", count, ms, wallets: prepared }),
  });

  for (const outcome of report.outcomes) {
    if (!outcome.accepted) deps.nonces.rollback(outcome.address);
  }

  const totalValue = value * BigInt(report.accepted);
  if (report.accepted > 0) {
    record({
      kind: "mint",
      chainId: deps.chainId,
      contract: req.nftContract,
      walletIds: report.outcomes.filter((o) => o.accepted).map((o) => o.id),
      quantity: req.quantity,
      valueWei: totalValue.toString(),
      fromBlock: await currentBlock(deps.readUrl),
      note: "allowlist",
    });
  }

  const rows = await collectReceipts(
    deps.readUrl,
    report.outcomes.filter((o) => o.accepted),
    (confirmed, reverted, pending, total, rows) =>
      emit({ type: "receipts", confirmed, reverted, pending, total, rows })
  );
  for (const outcome of report.outcomes) {
    if (outcome.accepted) continue;
    rows.push({ id: outcome.id, address: outcome.address, hash: outcome.hash, status: "reverted" });
  }

  const final: AllowListMintReport = {
    contract: req.nftContract,
    quantity: req.quantity,
    attempted: prepared.length,
    accepted: report.accepted,
    rejected: report.rejected,
    confirmed: rows.filter((r) => r.status === "confirmed").length,
    reverted: rows.filter((r) => r.status === "reverted").length,
    pending: rows.filter((r) => r.status === "pending").length,
    valuePerWallet: value,
    totalValue,
    dispatchMs: report.dispatchMs,
    rows,
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
