// Wallet selection.
//
// With 500 derived wallets, a handful of imported ones, and per-drop eligibility
// on top, "which wallets fire for this?" needs an answer that survives state
// changing under it. Tags are computed from live state rather than curated, so a
// wallet that just ran dry stops matching `funded` without anyone maintaining a
// list.
//
// Automatic tags:  derived imported funded unfunded stuck autofire manual
// Assigned tags:   anything the operator adds, plus eligible:<drop> written by
//                  the allowlist checker in a later phase.
//
// Selector grammar, deliberately small:
//
//   derived+funded        AND — every term must match
//   imported,derived      OR  — comma separates alternatives
//   funded+!stuck         ! negates a term
//   0-99                  derivation index range
//   42                    single derivation index
//   0xabc…                one wallet by address
//   all                   everything
//
// Anything unrecognised is an error rather than a silent no-match: selecting the
// wrong wallets is a money mistake, so a typo must not quietly resolve to zero.

import { ManagedWallet } from "./wallet-store";

export interface WalletState {
  balanceWei?: bigint;
  /** Local nonce has run ahead of chain — this wallet cannot land a tx. */
  nonceGap?: boolean;
  /**
   * The last balance we happen to have for this wallet, however stale.
   *
   * Ordering only. It is deliberately NOT `balanceWei`: that one is absent on
   * the copy path so `funded`/`unfunded` do not resolve against a guess, and
   * that distinction is load-bearing. This field never gates anything — it only
   * decides who gets tried first when a signal arrives and there is no time to
   * ask the chain who is in funds.
   */
  lastKnownBalanceWei?: bigint;
}

export interface TagContext {
  /** Below this balance a wallet counts as unfunded and is skipped by default. */
  minFundedWei: bigint;
  state: Map<string, WalletState>;
  /**
   * Addresses that hold the float and must never be spent by an automatic
   * mint — the configured funder and vault, lowercased.
   *
   * These are roles, not preferences. The funder is the wallet everything else
   * is topped up from, so it is the one wallet that reliably has money in it,
   * which is exactly why an unfiltered "all" selector picks it first and drains
   * it. It happened: the funder sent every copy-mint this deployment has ever
   * made while five hundred derived wallets sat empty and idle.
   */
  protectedAddresses?: Set<string>;
}

export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorError";
  }
}

export function emptyContext(minFundedWei = 0n): TagContext {
  return { minFundedWei, state: new Map() };
}

export function autoTags(wallet: ManagedWallet, ctx: TagContext): string[] {
  const tags: string[] = [wallet.kind];
  const state = ctx.state.get(wallet.id);

  // A fresh reading if there is one, otherwise the last one we happen to hold.
  //
  // Without the fallback, `funded` and `unfunded` were untaggable on the copy
  // path — it builds its context from memory and never sets balanceWei — so a
  // selector of "funded" matched nothing and copy-mint went silently dead. It
  // is the obvious thing to pick when you want only your funded wallets to
  // mint, and it was the one setting guaranteed to stop them.
  const balance = state?.balanceWei ?? state?.lastKnownBalanceWei;
  if (balance !== undefined) {
    tags.push(balance >= ctx.minFundedWei && balance > 0n ? "funded" : "unfunded");
  }
  if (state?.nonceGap) tags.push("stuck");
  tags.push(wallet.autoFire ? "autofire" : "manual");

  return tags;
}

export function allTags(wallet: ManagedWallet, ctx: TagContext): Set<string> {
  return new Set([...autoTags(wallet, ctx), ...wallet.tags.map((t) => t.toLowerCase())]);
}

const KNOWN_FLAGS = new Set([
  "all",
  "derived",
  "imported",
  "funded",
  "unfunded",
  "stuck",
  "autofire",
  "manual",
]);

function matchTerm(term: string, wallet: ManagedWallet, ctx: TagContext): boolean {
  if (term.startsWith("!")) return !matchTerm(term.slice(1), wallet, ctx);

  if (term === "all") return true;

  // Address form.
  if (/^0x[0-9a-f]{40}$/i.test(term)) {
    return wallet.address.toLowerCase() === term.toLowerCase();
  }

  // Index range, e.g. 0-99.
  const range = /^(\d+)-(\d+)$/.exec(term);
  if (range) {
    if (wallet.kind !== "derived" || wallet.index === undefined) return false;
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (lo > hi) throw new SelectorError(`Range "${term}" runs backwards.`);
    return wallet.index >= lo && wallet.index <= hi;
  }

  // Bare index.
  if (/^\d+$/.test(term)) {
    return wallet.kind === "derived" && wallet.index === Number(term);
  }

  // label:foo matches the wallet label, case-insensitively.
  if (term.startsWith("label:")) {
    const wanted = term.slice(6);
    return (wallet.label ?? "").toLowerCase() === wanted;
  }

  const tags = allTags(wallet, ctx);
  if (tags.has(term)) return true;

  // A namespaced term that no wallet carries is almost always a typo — but
  // eligible:<drop> legitimately matches nothing before /check has run, so
  // namespaced misses stay silent while bare unknown words do not.
  if (!KNOWN_FLAGS.has(term) && !term.includes(":")) {
    throw new SelectorError(
      `Unknown selector term "${term}". Try: all, derived, imported, funded, stuck, autofire, ` +
        `a tag you assigned, an index range like 0-99, or an address.`
    );
  }
  return false;
}

export function matches(selector: string, wallet: ManagedWallet, ctx: TagContext): boolean {
  const groups = selector
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);

  if (groups.length === 0) throw new SelectorError("Empty selector.");

  return groups.some((group) => {
    const terms = group
      .split("+")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    if (terms.length === 0) throw new SelectorError(`Empty selector group in "${selector}".`);
    return terms.every((term) => matchTerm(term, wallet, ctx));
  });
}

export function resolve(
  selector: string,
  wallets: ManagedWallet[],
  ctx: TagContext
): ManagedWallet[] {
  return wallets.filter((w) => matches(selector, w, ctx));
}

export interface AutoFirePool {
  selected: ManagedWallet[];
  /** Matched the selector but is not armed for autonomous firing. */
  excludedManual: number;
  /** Matched and armed, but sitting behind a nonce gap. */
  excludedStuck: number;
  /** Every wallet in the store, before the selector saw them. */
  total: number;
  /** How many the selector matched at all. */
  matched: number;
  /** Wallets anywhere in the store below the gas reservation. */
  unfunded: number;
  /** Armed, funded wallets the selector nonetheless rejected. */
  excludedBySelector: number;
  /** The bar `funded` is measured against, so a balance can be checked against it. */
  minFundedWei: bigint;
}

/**
 * Resolve for an autonomous path. Wallets that opted out of auto-fire and
 * wallets with a nonce gap are removed regardless of what the selector said —
 * a selector should never be able to talk the bot into spending an imported
 * wallet or into queueing a tx behind a gap.
 *
 * The counts alongside the selection exist because "nothing fired" is the one
 * outcome an operator cannot debug from the outside. Reporting only the
 * post-selector exclusions made an unarmed wallet and an empty one produce the
 * same message, which is how a funded wallet came to be described as unfunded.
 */
/**
 * The wallets a copy signal fires from. Selector, minus the ones that cannot
 * physically send.
 *
 * Deliberately does NOT require a wallet to be armed or funded, which is a
 * reversal. The old pool demanded both, and both turned out to be traps rather
 * than protections:
 *
 *   Arming was a second switch behind the switch. An operator who has chosen
 *   which wallets copy-mint spends from has already said what they want; making
 *   them say it again in a different menu only produces a set-up that looks
 *   complete and fires at nothing. Fifteen mints were detected in one day and
 *   every one was declined for want of a flag nobody knew to set.
 *
 *   The funding check cost more than it saved. Deciding it meant reading every
 *   wallet's balance before firing — ten to fifteen seconds on five hundred
 *   wallets, on a path whose whole budget is one block. And it bought nothing:
 *   a wallet without gas has its transaction rejected by the node at no cost,
 *   which is the same outcome, arrived at without spending the drop.
 *
 * A nonce gap is different and still excluded — that wallet's transaction
 * cannot land whatever its balance, and skipping it is free.
 */
export function resolveForCopy(
  selector: string,
  wallets: ManagedWallet[],
  ctx: TagContext
): {
  selected: ManagedWallet[];
  matched: number;
  stuck: number;
  total: number;
  excludedProtected: number;
} {
  const matched = resolve(selector, wallets, ctx);
  // The funder and the vault come out before anything else looks at this pool.
  // Every other exclusion here is a preference the operator can overrule from
  // the keyboard; this one is structural, so it is applied first and is not
  // reachable by widening the selector to "all".
  const spendable = withoutProtected(matched, ctx);
  const selected = byLikelihoodOfLanding(
    spendable.filter((w) => !ctx.state.get(w.id)?.nonceGap),
    ctx
  );
  return {
    selected,
    matched: spendable.length,
    stuck: spendable.length - selected.length,
    total: wallets.length,
    excludedProtected: matched.length - spendable.length,
  };
}

/**
 * Put the wallets most likely to land a transaction at the front.
 *
 * A copy signal takes the first N of this list, where N is the tier's wallet
 * limit — so order is not cosmetic, it decides who actually mints. Store order
 * put d:1…d:50 at the front, none of which had ever been funded, while the ten
 * wallets holding all the gas sat at the end of the list and were never
 * reached. The only reason anything minted at all was that the funder sits at
 * index zero, which is the bug this ordering exists to make unnecessary.
 *
 * Nothing is excluded here. A wallet whose balance was never read ranks above
 * one known to be empty but below one known to be in funds, because "unknown"
 * is not evidence either way — the deliberate choice not to gate on funding
 * stands, and this only changes who is asked first.
 */
function byLikelihoodOfLanding(wallets: ManagedWallet[], ctx: TagContext): ManagedWallet[] {
  const rank = (w: ManagedWallet): number => {
    const known = ctx.state.get(w.id)?.lastKnownBalanceWei;
    if (known === undefined) return 1;
    return known >= ctx.minFundedWei && known > 0n ? 0 : 2;
  };
  // Stable: equal ranks keep store order, so a funded set stays in a
  // predictable, reproducible sequence from one signal to the next.
  return wallets
    .map((wallet, index) => ({ wallet, index, rank: rank(wallet) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.wallet);
}

/**
 * Drop the wallets whose job is to hold money, not to spend it.
 *
 * Exported because anything that *reports* on the minting pool has to agree
 * with what actually mints. Counting the funder as a funded, ready wallet is
 * how "you have money on this network" and "nothing can buy anything" end up
 * on the same screen.
 */
export function withoutProtected(wallets: ManagedWallet[], ctx: TagContext): ManagedWallet[] {
  const guarded = ctx.protectedAddresses;
  if (!guarded || guarded.size === 0) return wallets;
  return wallets.filter((w) => !guarded.has(w.address.toLowerCase()));
}

export function resolveForAutoFire(
  selector: string,
  wallets: ManagedWallet[],
  ctx: TagContext
): AutoFirePool {
  // Same structural exclusion as resolveForCopy — the two must agree about who
  // is allowed to spend, or the wallets that get primed are not the wallets
  // that fire.
  const matched = withoutProtected(resolve(selector, wallets, ctx), ctx);
  const excludedManual = matched.filter((w) => !w.autoFire).length;
  const afterAutoFire = matched.filter((w) => w.autoFire);
  const excludedStuck = afterAutoFire.filter((w) => ctx.state.get(w.id)?.nonceGap).length;

  const isFunded = (w: ManagedWallet): boolean => {
    const balance = ctx.state.get(w.id)?.balanceWei;
    // An unknown balance is not evidence of an empty wallet, so it is not
    // counted as one — a failed balance read must not read as "you have no money".
    return balance === undefined || (balance >= ctx.minFundedWei && balance > 0n);
  };

  const matchedIds = new Set(matched.map((w) => w.id));

  return {
    selected: afterAutoFire.filter((w) => !ctx.state.get(w.id)?.nonceGap),
    excludedManual,
    excludedStuck,
    total: wallets.length,
    matched: matched.length,
    unfunded: wallets.filter((w) => !isFunded(w)).length,
    excludedBySelector: wallets.filter(
      (w) => !matchedIds.has(w.id) && w.autoFire && isFunded(w)
    ).length,
    minFundedWei: ctx.minFundedWei,
  };
}

export interface TagSummary {
  total: number;
  counts: Record<string, number>;
}

export function summarise(wallets: ManagedWallet[], ctx: TagContext): TagSummary {
  const counts: Record<string, number> = {};
  for (const wallet of wallets) {
    for (const tag of allTags(wallet, ctx)) {
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }
  return { total: wallets.length, counts };
}
