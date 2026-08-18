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
// The second comparison is the delicate one. `pending > latest` is not by itself
// evidence of a stuck transaction — it is the ordinary state of every mint that
// has been accepted and not yet mined. Treating it as a fault is what made the
// reconciler replace healthy mints with 0-value self-sends at twice the tip,
// cancelling the very transaction it was asked to protect, and then tag the
// wallet `stuck` so copy-mint dropped it from the pool.
//
// What actually distinguishes the two is whether the queue is draining. A live
// transaction moves `latest` forward within a block or two; a stuck one leaves
// it pinned. So a stuck verdict needs three things: the gap persists across
// several reconciles, `latest` has not advanced once in that time, and enough
// wall-clock has passed that no ordinary inclusion delay could explain it.

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

/**
 * A dropped counter is cheap to be wrong about — rewinding costs nothing and is
 * reversed by the next reconcile — so two sightings is enough.
 */
export const DROPPED_MIN_OBSERVATIONS = 2;

/**
 * A stuck verdict is expensive to be wrong about: it spends gas and cancels
 * whatever occupies the nonce. It needs the gap to survive several reconciles
 * *and* a wall-clock floor, so a slow block or a busy sequencer cannot look
 * like a wedged pool.
 */
export const STUCK_MIN_OBSERVATIONS = 3;
export const STUCK_MIN_DWELL_MS = 90_000;

interface FaultObservation {
  kind: FaultKind;
  /** Consecutive reconciles this same fault has been seen on. */
  streak: number;
  firstSeenAt: number;
  /** `latest` when the fault was first seen — if it moves, the queue is draining. */
  latestWhenFirstSeen: number;
}

export class NonceManager {
  private readonly readUrl: string;
  private readonly now: () => number;
  private local = new Map<string, number>();
  /** Address → the fault currently being observed, if any. */
  private faults = new Map<string, FaultObservation>();
  /** Addresses whose fault has cleared every confirmation bar. */
  private confirmed = new Set<string>();

  constructor(readUrl: string, now: () => number = Date.now) {
    this.readUrl = readUrl;
    this.now = now;
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
        this.clearFault(target.address);
        // Chain moved ahead of us (a tx we didn't send, or a restart) — trust it.
        if (pending > local) this.local.set(target.address, pending);
        return;
      }

      const previous = this.faults.get(target.address);
      const continuing = previous !== undefined && previous.kind === kind;

      // The pool is draining: a transaction we were watching got mined, so
      // whatever is left in it is in flight, not wedged. This is the check that
      // keeps an ordinary pending mint from being "healed" out of existence.
      if (kind === "stuck" && continuing && latest > previous.latestWhenFirstSeen) {
        this.clearFault(target.address);
        return;
      }

      const observation: FaultObservation = continuing
        ? { ...previous, streak: previous.streak + 1 }
        : { kind, streak: 1, firstSeenAt: this.now(), latestWhenFirstSeen: latest };
      this.faults.set(target.address, observation);

      const fault: NonceFault = { id: target.id, address: target.address, kind, local, latest, pending };

      if (this.isConfirmed(observation)) {
        this.confirmed.add(target.address);
        faults.push(fault);
      } else {
        // Still could be a transaction merely in flight. Report it so an
        // operator can see it building, but do not act on it and do not let it
        // disqualify the wallet from firing.
        this.confirmed.delete(target.address);
        provisional.push(fault);
      }
    });

    return { checked: targets.length, faults, provisional };
  }

  /** Has this fault cleared every bar for acting on it? */
  private isConfirmed(observation: FaultObservation): boolean {
    if (observation.kind === "dropped") {
      return observation.streak >= DROPPED_MIN_OBSERVATIONS;
    }
    return (
      observation.streak >= STUCK_MIN_OBSERVATIONS &&
      this.now() - observation.firstSeenAt >= STUCK_MIN_DWELL_MS
    );
  }

  private clearFault(address: string): void {
    this.faults.delete(address);
    this.confirmed.delete(address);
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
        this.clearFault(fault.address);
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
          // The replacement only occupies the blocked nonce. Anything we had
          // already signed above it is still queued and will mine once the
          // blockage clears, so the counter moves forward — never backwards.
          // Clobbering it to latest + 1 handed already-spent nonces back out,
          // and every transaction signed with one came back "nonce too low".
          const current = this.local.get(fault.address) ?? 0;
          this.local.set(fault.address, Math.max(current, fault.latest + 1));
          this.clearFault(fault.address);
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

  /**
   * Addresses currently considered unusable, for the `stuck` tag.
   *
   * Only confirmed faults count. A wallet with a transaction merely in flight
   * is perfectly able to sign the next one, and excluding it here is what took
   * healthy wallets out of the copy-mint pool and reported "no eligible
   * wallets" moments after a successful mint.
   */
  stuckAddresses(): Set<string> {
    return new Set(this.confirmed);
  }
}
