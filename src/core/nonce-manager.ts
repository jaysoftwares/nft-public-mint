// Nonce tracking across repeated firings.
//
// The CLI never needs this: it reads nonces once and exits. A bot that fires the
// same hot wallets for weeks does, because of one quiet failure mode —
//
//   wallet 37's tx is dropped by the sequencer. Local nonce says 12, chain says
//   11. Every later tx from wallet 37 queues behind the gap and never mines.
//   Dispatch keeps reporting success. The wallet is dead and nothing says so.
//
// So the hot path reads a cache (0ms), and a background reconcile compares all
// wallets against chain in a single batched POST. Two distinct faults come out
// of that comparison and they need opposite fixes:
//
//   local > pending   transactions we counted were dropped. Nothing is queued;
//                     rewind the local counter to match the node.
//   pending > latest  something is genuinely stuck in the pool. Only a
//                     replacement at the same nonce with a higher tip clears it.
//
// Healing waits for a fault to survive two consecutive reconciles. A tx that is
// merely in flight looks identical to a stuck one for a moment, and replacing a
// healthy transaction wastes gas and can double-mint.

import { Wallet, HDNodeWallet } from "ethers";
import { BatchCall, rpcBatchChunked } from "./rpc";
import { Endpoint, dispatchAll, prepareTx } from "./dispatcher";

export interface NonceTarget {
  id: string;
  address: string;
}

export type FaultKind = "dropped" | "stuck";

export interface NonceFault {
  id: string;
  address: string;
  kind: FaultKind;
  local: number;
  latest: number;
  pending: number;
}

export interface ReconcileReport {
  checked: number;
  faults: NonceFault[];
  /** Faults seen for the first time — reported but not yet healed. */
  provisional: NonceFault[];
}

export interface HealDeps {
  signerFor(id: string): Wallet | HDNodeWallet;
  chainId: number;
  endpoints: Endpoint[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface HealResult {
  id: string;
  address: string;
  action: "rewound" | "replaced" | "failed";
  detail: string;
}

export class NonceManager {
  private readonly readUrl: string;
  private local = new Map<string, number>();
  /** Address → number of consecutive reconciles a fault has persisted. */
  private faultStreak = new Map<string, number>();

  constructor(readUrl: string) {
    this.readUrl = readUrl;
  }

  /** Fetch the starting nonce for every wallet in one batched request. */
  async prime(targets: NonceTarget[]): Promise<void> {
    if (targets.length === 0) return;
    const calls: BatchCall[] = targets.map((t) => ({
      method: "eth_getTransactionCount",
      params: [t.address, "pending"],
    }));
    const results = await rpcBatchChunked<string>(this.readUrl, calls);

    results.forEach((entry, i) => {
      if (entry.result !== undefined) {
        this.local.set(targets[i].address, parseInt(entry.result, 16));
      }
    });
  }

  has(address: string): boolean {
    return this.local.has(address);
  }

  peek(address: string): number | undefined {
    return this.local.get(address);
  }

  /** Take the next nonce and advance. Throws rather than guessing at zero. */
  next(address: string): number {
    const current = this.local.get(address);
    if (current === undefined) {
      throw new Error(`No primed nonce for ${address} — call prime() before signing.`);
    }
    this.local.set(address, current + 1);
    return current;
  }

  /** Hand a nonce back when signing or dispatch failed before broadcast. */
  rollback(address: string): void {
    const current = this.local.get(address);
    if (current !== undefined && current > 0) this.local.set(address, current - 1);
  }

  async reconcile(targets: NonceTarget[]): Promise<ReconcileReport> {
    if (targets.length === 0) return { checked: 0, faults: [], provisional: [] };

    const calls: BatchCall[] = [];
    for (const t of targets) {
      calls.push({ method: "eth_getTransactionCount", params: [t.address, "latest"] });
      calls.push({ method: "eth_getTransactionCount", params: [t.address, "pending"] });
    }
    const results = await rpcBatchChunked<string>(this.readUrl, calls);

    const faults: NonceFault[] = [];
    const provisional: NonceFault[] = [];

    targets.forEach((target, i) => {
      const latestEntry = results[i * 2];
      const pendingEntry = results[i * 2 + 1];
      if (latestEntry?.result === undefined || pendingEntry?.result === undefined) return;

      const latest = parseInt(latestEntry.result, 16);
      const pending = parseInt(pendingEntry.result, 16);
      const local = this.local.get(target.address) ?? pending;

      let kind: FaultKind | null = null;
      if (local > pending) kind = "dropped";
      else if (pending > latest) kind = "stuck";

      if (!kind) {
        this.faultStreak.delete(target.address);
        // Chain moved ahead of us (a tx we didn't send, or a restart) — trust it.
        if (pending > local) this.local.set(target.address, pending);
        return;
      }

      const fault: NonceFault = { id: target.id, address: target.address, kind, local, latest, pending };
      const streak = (this.faultStreak.get(target.address) ?? 0) + 1;
      this.faultStreak.set(target.address, streak);

      // One sighting can just be a tx still in flight. Two is a fault.
      if (streak >= 2) faults.push(fault);
      else provisional.push(fault);
    });

    return { checked: targets.length, faults, provisional };
  }

  /**
   * Clear faults. A dropped counter is rewound locally and costs nothing; a
   * stuck pool entry needs a real replacement transaction at the blocked nonce.
   */
  async heal(faults: NonceFault[], deps: HealDeps): Promise<HealResult[]> {
    const results: HealResult[] = [];
    const replacements: { fault: NonceFault; raw: string }[] = [];

    for (const fault of faults) {
      if (fault.kind === "dropped") {
        this.local.set(fault.address, fault.pending);
        this.faultStreak.delete(fault.address);
        results.push({
          id: fault.id,
          address: fault.address,
          action: "rewound",
          detail: `local ${fault.local} → ${fault.pending}`,
        });
        continue;
      }

      try {
        const signer = deps.signerFor(fault.id);
        // Zero-value self-send: the cheapest transaction that can occupy the
        // blocked nonce and evict whatever is stuck there.
        const raw = await signer.signTransaction({
          to: fault.address,
          value: 0n,
          data: "0x",
          nonce: fault.latest,
          gasLimit: 21_000,
          // Doubling clears the 12.5% minimum bump every client enforces.
          maxFeePerGas: deps.maxFeePerGas * 2n,
          maxPriorityFeePerGas: deps.maxPriorityFeePerGas * 2n,
          type: 2,
          chainId: deps.chainId,
        });
        replacements.push({ fault, raw });
      } catch (err) {
        results.push({
          id: fault.id,
          address: fault.address,
          action: "failed",
          detail: (err as Error).message,
        });
      }
    }

    if (replacements.length > 0) {
      const prepared = replacements.map(({ fault, raw }) =>
        prepareTx(fault.id, fault.address, raw)
      );
      const report = await dispatchAll(prepared, deps.endpoints);

      for (const outcome of report.outcomes) {
        const fault = replacements.find((r) => r.fault.id === outcome.id)!.fault;
        if (outcome.accepted) {
          this.local.set(fault.address, fault.latest + 1);
          this.faultStreak.delete(fault.address);
          results.push({
            id: fault.id,
            address: fault.address,
            action: "replaced",
            detail: `nonce ${fault.latest} replaced at 2× tip`,
          });
        } else {
          results.push({
            id: fault.id,
            address: fault.address,
            action: "failed",
            detail: outcome.errors[0] ?? "rejected by every endpoint",
          });
        }
      }
    }

    return results;
  }

  /** Addresses currently considered unusable, for the `stuck` tag. */
  stuckAddresses(): Set<string> {
    const out = new Set<string>();
    for (const [address, streak] of this.faultStreak) {
      if (streak >= 2) out.add(address);
    }
    return out;
  }
}
