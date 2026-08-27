// Public SeaDrop mints at 500-wallet scale.
//
// The drop reading and calldata encoding come straight from seadrop-public.ts,
// which is part of the frozen CLI path and is imported here unchanged — it holds
// no console output and imports nothing but ethers, so it works as a library.
//
// What differs from the CLI is everything around it: balances are checked in one
// batched call rather than per wallet, nonces come from the shared cache, and
// dispatch is sharded instead of blasted to every endpoint. Signing still
// happens before the stage opens, so T-0 remains nothing but socket writes.

import { formatEther } from "ethers";
import { buildLocalMintPlan, LocalMintPlan } from "../seadrop-public";
import { ManagedWallet } from "./wallet-store";
import { NonceManager } from "./nonce-manager";
import { Endpoint, dispatchAll, prepareTx, DispatchOutcome, summariseErrors } from "./dispatcher";
import { fetchBalances, requiredPerWallet, shortfalls, Shortfall } from "./balances";
import { rpcCall, warmSockets } from "./rpc";
import { collectReceipts, sleepUntil, ReceiptRow } from "./mint-runtime";
import { record } from "./ledger";
import { Wallet, HDNodeWallet } from "ethers";

export interface MintDeps {
  readUrl: string;
  allRpcUrls: string[];
  endpoints: Endpoint[];
  chainId: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonces: NonceManager;
  signerFor(id: string): Wallet | HDNodeWallet;
}

export interface MintRequest {
  nftContract: string;
  quantity: number;
  wallets: ManagedWallet[];
  /** Hold until the stage opens instead of firing now. */
  waitForStart: boolean;
  /**
   * Do not fire before this instant, whatever the stage says.
   *
   * A booked mint has two clocks — the stage's own opening and the minute the
   * operator asked for — and they are not interchangeable. A stage that is
   * already open would otherwise fire the moment the runner armed it, minutes
   * early, which is not what "schedule this for 15:00" means. Signing still
   * happens before the hold, so T-0 remains nothing but socket writes.
   */
  notBefore?: Date;
  /** Fire anyway when some wallets can't cover the reservation. */
  skipUnderfunded: boolean;
}

export type MintEvent =
  | { type: "plan"; plan: LocalMintPlan; startsAt: Date; endsAt: Date; live: boolean }
  | { type: "funding"; eligible: number; underfunded: Shortfall[]; requiredPerWallet: bigint }
  | { type: "signing"; done: number; total: number }
  | { type: "armed"; total: number; signMs: number }
  | { type: "waiting"; msRemaining: number }
  | { type: "dispatched"; count: number; ms: number }
  | { type: "settled"; accepted: number; rejected: number }
  | { type: "receipts"; confirmed: number; reverted: number; pending: number; total: number }
  | { type: "done"; report: MintReport };

export type { ReceiptRow };

export interface MintReport {
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

export class MintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintError";
  }
}

export async function executePublicMint(
  req: MintRequest,
  deps: MintDeps,
  emit: (event: MintEvent) => void
): Promise<MintReport> {
  if (req.wallets.length === 0) {
    throw new MintError("No wallets selected — nothing to mint from.");
  }

  // ── Read the drop from chain (frozen module, unchanged) ──
  const plan = await buildLocalMintPlan(deps.readUrl, req.nftContract, req.quantity);
  if (!plan) {
    throw new MintError(
      `No SeaDrop public drop readable for ${req.nftContract}.\n` +
        "Either it isn't a SeaDrop collection, or it keeps its drop config on the token contract."
    );
  }

  const startsAt = new Date(plan.drop.startTime * 1000);
  const endsAt = new Date(plan.drop.endTime * 1000);
  const now = Date.now();
  const live = now >= startsAt.getTime() && now < endsAt.getTime();
  emit({ type: "plan", plan, startsAt, endsAt, live });

  if (now >= endsAt.getTime()) {
    throw new MintError(`That stage closed at ${endsAt.toISOString()}.`);
  }
  if (!live && !req.waitForStart) {
    throw new MintError(
      `The stage opens at ${startsAt.toISOString()}. Firing now would revert with NotActive and burn gas — ` +
        "run it again with waiting enabled."
    );
  }
  if (plan.drop.maxTotalMintableByWallet > 0 && req.quantity > plan.drop.maxTotalMintableByWallet) {
    throw new MintError(
      `Quantity ${req.quantity} exceeds this drop's per-wallet cap of ${plan.drop.maxTotalMintableByWallet}.`
    );
  }

  // ── Can these wallets actually pay? ──
  const targets = req.wallets.map((w) => ({ id: w.id, address: w.address }));
  const required = requiredPerWallet(deps.gasLimit, deps.maxFeePerGas, plan.value);
  const balances = await fetchBalances(deps.readUrl, targets);
  const underfunded = shortfalls(targets, balances, required);

  const eligible = req.wallets.filter((w) => !underfunded.some((u) => u.id === w.id));
  emit({ type: "funding", eligible: eligible.length, underfunded, requiredPerWallet: required });

  if (underfunded.length > 0 && !req.skipUnderfunded) {
    throw new MintError(
      `${underfunded.length} of ${req.wallets.length} wallets hold less than the ` +
        `${formatEther(required)} ETH a node reserves before accepting the transaction. ` +
        "Fund them, or re-run allowing underfunded wallets to be skipped."
    );
  }
  if (eligible.length === 0) {
    throw new MintError("Every selected wallet is underfunded — nothing can be sent.");
  }

  // ── Warm sockets and prime nonces while there is still time ──
  await warmSockets(deps.allRpcUrls);
  const eligibleTargets = eligible.map((w) => ({ id: w.id, address: w.address }));
  await deps.nonces.prime(eligibleTargets);

  // ── Sign everything now ──
  const signStart = process.hrtime.bigint();
  const prepared = [];
  for (let i = 0; i < eligible.length; i++) {
    const wallet = eligible[i];
    const signer = deps.signerFor(wallet.id);
    const raw = await signer.signTransaction({
      to: plan.to,
      data: plan.data,
      value: plan.value,
      nonce: deps.nonces.next(wallet.address),
      maxFeePerGas: deps.maxFeePerGas,
      maxPriorityFeePerGas: deps.maxPriorityFeePerGas,
      gasLimit: deps.gasLimit,
      type: 2,
      chainId: deps.chainId,
    });
    prepared.push(prepareTx(wallet.id, wallet.address, raw));
    if ((i + 1) % 25 === 0 || i + 1 === eligible.length) {
      emit({ type: "signing", done: i + 1, total: eligible.length });
    }
  }
  const signMs = Number(process.hrtime.bigint() - signStart) / 1e6;
  emit({ type: "armed", total: prepared.length, signMs });

  // ── Hold ──
  //
  // The later of the two clocks wins. Firing at the booked minute into a stage
  // that has not opened reverts and burns gas; firing at the opening ignores
  // what was actually asked for. Waiting for both is the only reading that is
  // never wrong.
  const holdUntil = Math.max(
    !live && req.waitForStart ? startsAt.getTime() : 0,
    req.notBefore ? req.notBefore.getTime() : 0
  );
  if (holdUntil > Date.now()) {
    emit({ type: "waiting", msRemaining: holdUntil - Date.now() });
    await sleepUntil(holdUntil);
  }

  // ── Fire ──
  const report = await dispatchAll(prepared, deps.endpoints, {
    onDispatched: (count, ms) => emit({ type: "dispatched", count, ms }),
  });
  emit({ type: "settled", accepted: report.accepted, rejected: report.rejected });

  // Nonces consumed by rejected transactions were never used on chain; hand
  // them back so the next run doesn't open a gap of its own making.
  for (const outcome of report.outcomes) {
    if (!outcome.accepted) deps.nonces.rollback(outcome.address);
  }

  const totalValue = plan.value * BigInt(report.accepted);
  if (report.accepted > 0) {
    record({
      kind: "mint",
      chainId: deps.chainId,
      contract: req.nftContract,
      walletIds: report.outcomes.filter((o) => o.accepted).map((o) => o.id),
      quantity: req.quantity,
      valueWei: totalValue.toString(),
      fromBlock: await currentBlock(deps.readUrl),
    });
  }

  // ── Receipts, for accepted transactions only ──
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

  const final: MintReport = {
    contract: req.nftContract,
    quantity: req.quantity,
    attempted: prepared.length,
    accepted: report.accepted,
    rejected: report.rejected,
    confirmed: rows.filter((r) => r.status === "confirmed").length,
    reverted: rows.filter((r) => r.status === "reverted").length,
    pending: rows.filter((r) => r.status === "pending").length,
    valuePerWallet: plan.value,
    totalValue,
    dispatchMs: report.dispatchMs,
    rows,
    errorSummary: summariseErrors(report.outcomes),
  };
  emit({ type: "done", report: final });
  return final;
}

// Recorded with the mint so a later sweep knows the earliest block worth
// scanning. Failing to read it costs scan efficiency, never correctness.
async function currentBlock(readUrl: string): Promise<number | undefined> {
  try {
    return Number(BigInt(await rpcCall<string>(readUrl, "eth_blockNumber", [])));
  } catch {
    return undefined;
  }
}

