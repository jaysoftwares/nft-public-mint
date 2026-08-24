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
import { TagContext, resolveForCopy } from "./tags";
import { NonceManager } from "./nonce-manager";
import { Endpoint, dispatchAll, prepareTx, summariseErrors, explainRejection } from "./dispatcher";
import { LogEvent } from "./log-watcher";
import { planCopy, CopyPlanError } from "./copy-plan";
import { inspectCalldata } from "./mint-opensea";
import { evaluate, PolicyCaps, PolicyVerdict } from "./policy";
import { rpcCall } from "./rpc";
import { record, spentSince } from "./ledger";
import { recordSignal } from "./copy-journal";
import { collectionName } from "./collection-name";
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
  /** For the journal, so a stored signal says which chain without a lookup. */
  chainName: string;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  caps: PolicyCaps;
  copy: CopyConfig;
  nonces: NonceManager;
  signerFor(id: string): Wallet | HDNodeWallet;
  wallets(): ManagedWallet[];
  /**
   * Selector context, built from memory rather than the network.
   *
   * Synchronous on purpose. The awaited version read every wallet's balance and
   * cost ten to fifteen seconds on the one path that has a block to work in.
   */
  copyContext(): TagContext;
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
  /** What one wallet paid, all in. */
  unitPriceWei: bigint;
  /** NFTs each wallet received. */
  quantity: number;
  /** "replay" or "public-stage" — which rung of the ladder did it. */
  strategy: string;
  /** One plain sentence on how the copy was made. */
  how: string;
  elapsedMs: number;
  dispatchMs: number;
  /**
   * Per wallet: did it get one, and if not, why not — in plain words.
   *
   * The report used to give a count and an aggregated error string, so "8 of
   * 10 accepted" left the owner with no way to tell which two wallets missed
   * out or what to do about them. `reason` is set only on a rejection.
   */
  hashes: {
    id: string;
    address: string;
    hash: string;
    accepted: boolean;
    reason?: string;
  }[];
  errorSummary: { reason: string; count: number }[];
  /** The collection's own name(), when it has one worth showing. */
  collection?: string;
}

export type CopyEvent =
  | { type: "signal"; target: string; contract: string; txHash: string; block: number }
  | {
      type: "skipped";
      target: string;
      contract: string;
      reason: string;
      detail?: string;
      /** What the operator can change. Absent when there is genuinely nothing. */
      fix?: string;
    }
  | {
      type: "simulated";
      gasLimit: number;
      addressBound: boolean;
      selector: string;
      /** Which rung of the ladder built this. */
      strategy: string;
      /** One plain sentence describing what is about to be bought. */
      how: string;
      quantity: number;
    }
  | {
      type: "firing";
      walletCount: number;
      totalCommitWei: bigint;
      trimReason?: string;
      /** Set when somebody other than the target paid for the source mint. */
      paidBy?: string;
    }
  | { type: "result"; result: CopyResult };

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

    // Every miss is both shown live and written down. The live card collapses
    // and rotates, which is right for watching and useless for asking later —
    // and "why has this never fired?" is always asked later.
    const skip = (reason: string, detail?: string, fix?: string): void => {
      this.emit({ type: "skipped", target, contract, reason, detail, fix });
      try {
        recordSignal({
          chainId: this.deps.chainId,
          chainName: this.deps.chainName,
          target,
          contract,
          txHash: event.transactionHash,
          block: event.blockNumber,
          outcome: "skipped",
          what: detail ? `${reason} — ${detail}` : reason,
          fix,
        });
      } catch {
        // A journal that cannot be written must never stop a mint.
      }
    };

    this.emit({
      type: "signal",
      target,
      contract,
      txHash: event.transactionHash,
      block: event.blockNumber,
    });

    if (!this.deps.copy.enabled) {
      skip(
        "Copy-mint is switched off",
        "The mint was spotted and written down, but nothing was bought.",
        "Tap the red “Copy OFF” button on the main menu to turn it on."
      );
      return;
    }

    // One event at a time. Two mints landing in the same block would otherwise
    // race for the same nonces and the same budget.
    if (this.busy) {
      skip(
        "Busy with another mint",
        "Two watched wallets minted at almost the same moment, and only the first was followed.",
        "Working as intended — buying two drops at once would double-spend the same wallets."
      );
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
        skip(
          "Could not read their transaction",
          "The node had not caught up with it yet.",
          "Nothing to change — this is a passing RPC hiccup."
        );
        return;
      }

      // ── Cheap rejections, before any work ──
      const dedupWindowMs = this.deps.copy.dedupWindowSec * 1000;
      const lastFire = this.recentContracts.get(contract.toLowerCase());
      const duplicate = lastFire !== undefined && Date.now() - lastFire < dedupWindowMs;

      const watch = targets.find(target);
      if (!watch) {
        skip("That wallet is no longer being watched", undefined, "Nothing to change.");
        return;
      }

      // Who sent it, and does this target accept that?
      //
      // Under `self` a mint credited to the target but paid for by someone else
      // is an airdrop, not a decision the target made. Under `any` it is the
      // whole point: the address worth watching is often a vault that never
      // sends a transaction of its own, and every mint reaching it was paid for
      // by a rotating hot wallet. See PayerMode in targets.ts.
      const paidByOther = tx.from.toLowerCase() !== target.toLowerCase();
      if (paidByOther && !targets.allowsPayer(watch, tx.from)) {
        skip(
          "Somebody else paid for their mint",
          `The NFT went to the wallet you watch, but ${tx.from.slice(0, 10)}… paid for it. ` +
            `This wallet is set to follow only mints it pays for itself.`,
          `Open Copy-mint → this wallet and switch it to “any payer”. Vault wallets almost ` +
            `always receive mints paid for by a different hot wallet, so “own tx” never fires for them.`
        );
        return;
      }
      const value = BigInt(tx.value);
      if (!targets.allowsMint(watch, value)) {
        // The single commonest reason this bot does nothing.
        //
        // "Free only" is the narrowest setting on the watch screen and reads
        // like the safe one, so it gets chosen — and then every paid mint is
        // dropped in silence. Nineteen wallets were watched for days at this
        // setting while every drop they bought cost money. Say the price, say
        // the setting, and say where to change it.
        const paid = value > 0n;
        skip(
          paid ? "They paid for this one, and you only follow free mints" : "This one was free, and you only follow paid mints",
          paid
            ? `They spent ${formatEther(value)} ETH on it. This wallet is set to “free mints only”, so it was left alone.`
            : `It cost nothing. This wallet is set to “paid mints only”, so it was left alone.`,
          `Open Copy-mint → this wallet and switch it to “any mint”. Most real drops cost ` +
            `something, so “free only” will sit and watch almost everything go past.`
        );
        return;
      }
      const firesInWindow = targets.firesInWindow(target, 3_600_000);

      // ── Which wallets are allowed to act ──
      //
      // No balance read and no arming check: whatever the selector names, fires.
      // Both gates were removed deliberately — see resolveForCopy. A wallet
      // short of gas has its transaction rejected by the node for nothing,
      // which is the same outcome as excluding it, reached without spending the
      // drop working out which wallets those are.
      //
      // Two things do still shape this pool, and neither costs a request: the
      // funder and vault are removed outright, and the rest are ordered so
      // wallets last seen holding gas are asked before wallets last seen empty.
      // Order matters because only the first `walletLimit` of them are used.
      const ctx = this.deps.copyContext();
      const pool = resolveForCopy(this.deps.copy.walletSelector, this.deps.wallets(), ctx);
      // This target's own number when it has one, the tier's shared default
      // otherwise. Same for the price ceiling further down.
      const walletLimit = targets.walletsFor(watch, this.deps.copy.tiers);
      const candidates = pool.selected.slice(0, walletLimit);

      if (candidates.length === 0) {
        // "Nothing matched" and "the only match was your funder" have the same
        // shape and completely different fixes, so they are never merged.
        const onlyProtected = pool.matched === 0 && pool.excludedProtected > 0;
        skip(
          "No wallets to buy with",
          pool.total === 0
            ? "You have no wallets yet."
            : onlyProtected
              ? `The only wallet matching "${this.deps.copy.walletSelector}" is your funding ` +
                `wallet, which is never allowed to mint — it is the float everything else ` +
                `is topped up from.`
              : pool.matched === 0
                ? `None of your ${pool.total} wallets match "${this.deps.copy.walletSelector}".`
                : `All ${pool.matched} matching wallets are behind a nonce gap and cannot send right now.`,
          onlyProtected
            ? "Send gas to your minting wallets under Wallets → Fund, then copy-mint has something to buy with."
            : pool.matched === 0
              ? "Change which wallets copy-mint buys with, under Copy-mint."
              : "The reconciler clears nonce gaps on its own within a minute."
        );
        return;
      }

      // ── Work out how to copy it, and prove the plan works ──
      //
      // Two rungs: replay their calldata, or failing that mint the same
      // collection's own public stage. See copy-plan.ts — the second rung is
      // what makes a gated drop copyable at all, and its absence is why this
      // reported "cannot be replayed" and stopped.
      let replay;
      try {
        replay = await planCopy({
          readUrl: this.deps.readUrl,
          target,
          to: tx.to,
          originalData: tx.input,
          value,
          contract,
          wallets: candidates.map((w) => ({ id: w.id, address: w.address })),
          configuredGasLimit: this.deps.gasLimit,
          // Only meaningful when the payer and the recipient differ; harmless
          // otherwise, since a self-paid mint has nothing to rewrite anyway.
          requireAddressBound: paidByOther,
          allowPublicFallback: this.deps.copy.publicFallback !== false,
        });
      } catch (err) {
        if (err instanceof CopyPlanError) {
          skip("Could not copy this mint", err.message, err.fix);
          return;
        }
        throw err;
      }

      // Re-check the filter against what *we* will pay.
      //
      // The public rung prices from chain, so a free allowlist mint they got
      // for nothing can cost real money through the open stage. The earlier
      // check tested their price, which is now the wrong number: somebody who
      // asked to follow only free mints must not be handed a bill because the
      // free door was shut to us. Their answer governs our spending, not theirs.
      if (replay.strategy !== "replay" && !targets.allowsMint(watch, replay.value)) {
        skip(
          "Their mint was free, ours would not be",
          `They got in through a stage we cannot use. The public stage costs ` +
            `${formatEther(replay.value)} ETH, and this wallet is set to follow free mints only.`,
          `Switch it to “any mint” if you are happy to pay the public price when their ` +
            `stage is closed to you.`
        );
        return;
      }

      // Who does the rewritten calldata actually credit?
      //
      // Substitution fixes the shape and eth_estimateGas proves the call works,
      // but neither says the NFT lands with us — a mint into someone else's
      // wallet simulates perfectly. On SeaDrop the calldata decodes, so this is
      // answerable rather than inferred; anywhere else it defers to simulation
      // exactly as the FCFS path does. Every wallet is checked, because each one
      // carries its own rewritten bytes.
      for (const wallet of candidates) {
        const check = inspectCalldata(
          { to: replay.to, data: replay.dataFor.get(wallet.address)!, value: replay.value },
          contract,
          wallet.address
        );
        if (!check.ok) {
          skip(
            "That mint would have gone to someone else's wallet",
            check.reason,
            "Nothing to change — this guard stops the bot paying for another person's NFT."
          );
          return;
        }
      }

      this.emit({
        type: "simulated",
        gasLimit: replay.gasLimit,
        addressBound: replay.addressBound,
        selector: replay.selector,
        strategy: replay.strategy,
        how: replay.how,
        quantity: replay.quantity,
      });

      // ── Caps ──
      //
      // Priced from the plan, not from their transaction. On the public rung we
      // are buying at the open stage's price, which may be nothing like what
      // they paid on an allowlist — charging their price to our budget would
      // measure the wrong money entirely.
      const gasReservation = BigInt(replay.gasLimit) * this.deps.maxFeePerGas;
      const verdict: PolicyVerdict = evaluate({
        unitPriceWei: replay.value,
        quantity: replay.quantity,
        gasReservationWei: gasReservation,
        requestedWallets: candidates.length,
        // A per-target ceiling replaces the global one for this signal only.
        // The per-event and daily caps are untouched, so raising what a single
        // mint may cost never raises what a day may.
        caps: {
          ...this.deps.caps,
          maxPriceWei: targets.maxPriceFor(watch, this.deps.caps.maxPriceWei),
        },
        // Autonomous spend only. A mint the operator ran by hand is their own
        // decision and must not eat the budget copy-mint fires from.
        spentLast24hWei: spentSince(24, ["mint"], { autoOnly: true }),
        targetFiresInWindow: firesInWindow,
        maxFiresPerWindow: this.deps.copy.maxFiresPerTargetPerHour,
        duplicateContract: duplicate,
      });

      if (!verdict.allowed) {
        skip(verdict.reason, verdict.detail, verdict.fix);
        return;
      }

      const firing = candidates.slice(0, verdict.walletCount);
      this.emit({
        type: "firing",
        walletCount: firing.length,
        totalCommitWei: verdict.totalCommitWei,
        trimReason: verdict.trimReason,
        paidBy: paidByOther ? tx.from : undefined,
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
          // Money that actually left for the drop, and nothing else. Gas is not
          // spending: it is a reservation the wallet already holds, most of which
          // comes back, and counting it here is what made every free mint show up
          // in the ledger at 0.0005 ETH and read as a purchase.
          valueWei: (verdict.unitSpendWei * BigInt(report.accepted)).toString(),
          // Now knowable on both rungs, so the NFT count stops being an
          // undercount of one per transaction.
          quantity: replay.quantity,
          fromBlock: event.blockNumber,
          note: `copy ${target}`,
        });
      }

      try {
        recordSignal({
          chainId: this.deps.chainId,
          chainName: this.deps.chainName,
          target,
          contract,
          txHash: event.transactionHash,
          block: event.blockNumber,
          outcome: report.accepted > 0 ? "fired" : "failed",
          what:
            report.accepted > 0
              ? `Bought it with ${report.accepted} wallet(s). ${replay.how}`
              : `Tried to buy it with ${firing.length} wallet(s) and every transaction was rejected. ` +
                (summariseErrors(report.outcomes)[0]?.reason ?? "No reason given."),
          fix:
            report.accepted > 0
              ? undefined
              : "Usually gas or funding. Check the wallet screen, then top up with Fund.",
          walletsFired: firing.length,
          walletsAccepted: report.accepted,
          spentWei: (verdict.unitSpendWei * BigInt(report.accepted)).toString(),
          strategy: replay.strategy,
        });
      } catch {
        /* never let bookkeeping affect the outcome */
      }

      // Asked for after the transactions are on the wire, so it costs the mint
      // nothing, and it is what turns "0x0d842ce4…" into a name the owner
      // recognises. Cached per contract, and undefined is fine.
      const collection = await collectionName(this.deps.readUrl, contract).catch(() => undefined);

      this.emit({
        type: "result",
        result: {
          target,
          contract,
          collection,
          sourceTx: event.transactionHash,
          block: event.blockNumber,
          walletCount: firing.length,
          accepted: report.accepted,
          rejected: report.rejected,
          totalCommitWei: verdict.totalCommitWei,
          unitPriceWei: replay.value,
          quantity: replay.quantity,
          strategy: replay.strategy,
          how: replay.how,
          elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
          dispatchMs: report.dispatchMs,
          hashes: report.outcomes.map((o) => ({
            id: o.id,
            address: o.address,
            hash: o.hash,
            accepted: o.accepted,
            reason: o.accepted ? undefined : explainRejection(o.errors),
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
