// Copy-mint: signal in, transactions out.
//
// The whole path has to fit inside one Base block, and it does so comfortably —
// roughly 300ms of work against a 2,000ms boundary. That slack is deliberately
// spent on safety rather than shaved: the calldata is rewritten per wallet, a
// representative transaction is simulated, and spend caps are enforced, all
// before a single byte is broadcast.
//
// Order matters. Everything that can reject the event does so before anything
// that costs money, so an abort costs nothing at all.

import { ManagedWallet } from "./wallet-store";
import { TagContext, resolveForAutoFire, AutoFirePool } from "./tags";
import { NonceManager } from "./nonce-manager";
import { Endpoint, dispatchAll, prepareTx, summariseErrors } from "./dispatcher";
import { LogEvent } from "./log-watcher";
import { buildReplay, ReplayError } from "./calldata";
import { evaluate, PolicyCaps, PolicyVerdict } from "./policy";
import { rpcCall } from "./rpc";
import { record, spentSince } from "./ledger";
import * as targets from "./targets";
import { Wallet, HDNodeWallet, formatEther } from "ethers";
import { CopyConfig } from "./config";

interface RawTransaction {
  from: string;
  to: string | null;
  input: string;
  value: string;
  hash: string;
}

export interface CopyDeps {
  readUrl: string;
  endpoints: Endpoint[];
  chainId: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  caps: PolicyCaps;
  copy: CopyConfig;
  nonces: NonceManager;
  signerFor(id: string): Wallet | HDNodeWallet;
  wallets(): ManagedWallet[];
  tagContext(force?: boolean): Promise<TagContext>;
}

export interface CopyResult {
  target: string;
  contract: string;
  sourceTx: string;
  block: number;
  walletCount: number;
  accepted: number;
  rejected: number;
  totalCommitWei: bigint;
  unitPriceWei: bigint;
  elapsedMs: number;
  dispatchMs: number;
  hashes: { id: string; address: string; hash: string; accepted: boolean }[];
  errorSummary: { reason: string; count: number }[];
}

export type CopyEvent =
  | { type: "signal"; target: string; contract: string; txHash: string; block: number }
  | { type: "skipped"; target: string; contract: string; reason: string; detail?: string }
  | { type: "simulated"; gasLimit: number; addressBound: boolean; selector: string }
  | { type: "firing"; walletCount: number; totalCommitWei: bigint; trimReason?: string }
  | { type: "result"; result: CopyResult };

/**
 * Say why no wallet fired, in terms the operator can act on.
 *
 * The old wording — "N manual-only, N stuck, none funded and armed" — described
 * an armed-but-unfunded set and a funded-but-unarmed set identically, so a
 * freshly funded wallet reported as having no money. Each cause now gets its
 * own sentence and its own remedy, and the funding bar is quoted so a balance
 * can be checked against it rather than guessed at.
 */
export function explainEmptyPool(pool: AutoFirePool, selector: string): string {
  const bar = `${formatEther(pool.minFundedWei)} ETH`;

  if (pool.total === 0) return "No wallets in the store yet — generate or import some first.";

  if (pool.matched === 0) {
    if (pool.unfunded === pool.total) {
      return (
        `All ${pool.total} wallet(s) are below the ${bar} gas reservation on this chain, ` +
        `so none count as funded. Top them up with /fund.`
      );
    }
    return (
      `No wallet matched the copy selector "${selector}" ` +
      `(${pool.total} in the store, ${pool.unfunded} below the ${bar} bar). ` +
      `Change copy.walletSelector in config.json if the wrong set is being asked for.`
    );
  }

  // Something matched, so the selector is not the problem — the rails are.
  const causes: string[] = [];
  if (pool.excludedManual > 0) {
    causes.push(
      `${pool.excludedManual} matched but ${pool.excludedManual === 1 ? "is" : "are"} not armed ` +
        `for auto-fire — arm with /autofire, or from Wallets → Auto-fire`
    );
  }
  if (pool.excludedStuck > 0) {
    causes.push(
      `${pool.excludedStuck} ${pool.excludedStuck === 1 ? "is" : "are"} behind a nonce gap ` +
        `— the reconciler retries these automatically`
    );
  }
  if (causes.length === 0) {
    causes.push(`${pool.matched} matched but none survived the safety rails`);
  }
  return `${causes.join(". ")}.`;
}

export class CopyEngine {
  private readonly deps: CopyDeps;
  private readonly emit: (event: CopyEvent) => void;
  /** contract (lowercase) → timestamp of the last fire, for dedup. */
  private recentContracts = new Map<string, number>();
  private busy = false;

  constructor(deps: CopyDeps, emit: (event: CopyEvent) => void) {
    this.deps = deps;
    this.emit = emit;
  }

  async handleSignal(event: LogEvent): Promise<void> {
    const started = process.hrtime.bigint();
    const target = event.recipient;
    const contract = event.contract;

    const skip = (reason: string, detail?: string): void =>
      this.emit({ type: "skipped", target, contract, reason, detail });

    this.emit({
      type: "signal",
      target,
      contract,
      txHash: event.transactionHash,
      block: event.blockNumber,
    });

    if (!this.deps.copy.enabled) {
      skip("Copy-mint disabled", "Signal recorded only. Enable with /copy on.");
      return;
    }

    // One event at a time. Two mints landing in the same block would otherwise
    // race for the same nonces and the same budget.
    if (this.busy) {
      skip("Already firing", "Another signal is mid-flight.");
      return;
    }
    this.busy = true;

    try {
      // ── Fetch what they actually called ──
      const tx = await rpcCall<RawTransaction | null>(
        this.deps.readUrl,
        "eth_getTransactionByHash",
        [event.transactionHash],
        4_000
      );
      if (!tx || !tx.to) {
        skip("Transaction unavailable", "Contract creation, or the node has not indexed it yet.");
        return;
      }

      // A mint credited to the target but paid for by someone else is an airdrop
      // or a gift, not a decision the target made. Copying it copies nothing.
      if (tx.from.toLowerCase() !== target.toLowerCase()) {
        skip(
          "Not the target's own transaction",
          `Sent by ${tx.from.slice(0, 10)}… — an airdrop or third-party mint.`
        );
        return;
      }

      // ── Cheap rejections, before any work ──
      const dedupWindowMs = this.deps.copy.dedupWindowSec * 1000;
      const lastFire = this.recentContracts.get(contract.toLowerCase());
      const duplicate = lastFire !== undefined && Date.now() - lastFire < dedupWindowMs;

      const watch = targets.find(target);
      if (!watch) {
        skip("Target no longer watched");
        return;
      }
      const value = BigInt(tx.value);
      if (!targets.allowsMint(watch, value)) {
        const kind = value === 0n ? "free" : "paid";
        skip(
          `${kind === "free" ? "Free" : "Paid"} mint filtered`,
          `This target is set to copy ${watch.mintMode} mints only.`
        );
        return;
      }
      const firesInWindow = targets.firesInWindow(target, 3_600_000);

      // ── Which wallets are allowed to act ──
      const ctx = await this.deps.tagContext();
      const pool = resolveForAutoFire(this.deps.copy.walletSelector, this.deps.wallets(), ctx);
      const tierLimit = this.deps.copy.tiers[watch.tier];
      const candidates = pool.selected.slice(0, tierLimit);

      if (candidates.length === 0) {
        skip("No eligible wallets", explainEmptyPool(pool, this.deps.copy.walletSelector));
        return;
      }

      // ── Rewrite and simulate ──
      let replay;
      try {
        replay = await buildReplay({
          readUrl: this.deps.readUrl,
          target,
          to: tx.to,
          originalData: tx.input,
          value,
          wallets: candidates.map((w) => ({ id: w.id, address: w.address })),
          configuredGasLimit: this.deps.gasLimit,
        });
      } catch (err) {
        if (err instanceof ReplayError) {
          skip("Not replayable", err.message);
          return;
        }
        throw err;
      }
      this.emit({
        type: "simulated",
        gasLimit: replay.gasLimit,
        addressBound: replay.addressBound,
        selector: replay.selector,
      });

      // ── Caps ──
      const gasReservation = BigInt(replay.gasLimit) * this.deps.maxFeePerGas;
      const verdict: PolicyVerdict = evaluate({
        unitPriceWei: value,
        gasReservationWei: gasReservation,
        requestedWallets: candidates.length,
        caps: this.deps.caps,
        // Autonomous spend only. A mint the operator ran by hand is their own
        // decision and must not eat the budget copy-mint fires from.
        spentLast24hWei: spentSince(24, ["mint"], { autoOnly: true }),
        targetFiresInWindow: firesInWindow,
        maxFiresPerWindow: this.deps.copy.maxFiresPerTargetPerHour,
        duplicateContract: duplicate,
      });

      if (!verdict.allowed) {
        skip(verdict.reason, verdict.detail);
        return;
      }

      const firing = candidates.slice(0, verdict.walletCount);
      this.emit({
        type: "firing",
        walletCount: firing.length,
        totalCommitWei: verdict.totalCommitWei,
        trimReason: verdict.trimReason,
      });

      // ── Sign and fire ──
      await this.primeIfNeeded(firing);

      const prepared = [];
      for (const wallet of firing) {
        const raw = await this.deps.signerFor(wallet.id).signTransaction({
          to: replay.to,
          data: replay.dataFor.get(wallet.address)!,
          value: replay.value,
          nonce: this.deps.nonces.next(wallet.address),
          gasLimit: replay.gasLimit,
          maxFeePerGas: this.deps.maxFeePerGas,
          maxPriorityFeePerGas: this.deps.maxPriorityFeePerGas,
          type: 2,
          chainId: this.deps.chainId,
        });
        prepared.push(prepareTx(wallet.id, wallet.address, raw));
      }

      const report = await dispatchAll(prepared, this.deps.endpoints);

      for (const outcome of report.outcomes) {
        if (!outcome.accepted) this.deps.nonces.rollback(outcome.address);
      }

      // ── Record ──
      this.recentContracts.set(contract.toLowerCase(), Date.now());
      this.pruneRecent(dedupWindowMs);
      targets.recordFire(target, 3_600_000);

      if (report.accepted > 0) {
        record({
          kind: "mint",
          auto: true,
          chainId: this.deps.chainId,
          contract,
          walletIds: report.outcomes.filter((o) => o.accepted).map((o) => o.id),
          // Ledger tracks committed value, which is what the daily cap measures.
          valueWei: (verdict.unitCostWei * BigInt(report.accepted)).toString(),
          fromBlock: event.blockNumber,
          note: `copy ${target}`,
        });
      }

      this.emit({
        type: "result",
        result: {
          target,
          contract,
          sourceTx: event.transactionHash,
          block: event.blockNumber,
          walletCount: firing.length,
          accepted: report.accepted,
          rejected: report.rejected,
          totalCommitWei: verdict.totalCommitWei,
          unitPriceWei: value,
          elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
          dispatchMs: report.dispatchMs,
          hashes: report.outcomes.map((o) => ({
            id: o.id,
            address: o.address,
            hash: o.hash,
            accepted: o.accepted,
          })),
          errorSummary: summariseErrors(report.outcomes),
        },
      });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Nonces should already be primed from boot — this is the safety net for a
   * wallet that entered the pool since. It costs one batched call, which the
   * budget can absorb, but it is not the intended path.
   */
  private async primeIfNeeded(wallets: ManagedWallet[]): Promise<void> {
    const missing = wallets
      .filter((w) => !this.deps.nonces.has(w.address))
      .map((w) => ({ id: w.id, address: w.address }));
    if (missing.length > 0) await this.deps.nonces.prime(missing);
  }

  private pruneRecent(windowMs: number): void {
    const cutoff = Date.now() - windowMs;
    for (const [contract, ts] of this.recentContracts) {
      if (ts < cutoff) this.recentContracts.delete(contract);
    }
  }
}
