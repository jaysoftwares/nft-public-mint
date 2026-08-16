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
}

export interface TagContext {
  /** Below this balance a wallet counts as unfunded and is skipped by default. */
  minFundedWei: bigint;
  state: Map<string, WalletState>;
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

  if (state?.balanceWei !== undefined) {
    tags.push(state.balanceWei >= ctx.minFundedWei && state.balanceWei > 0n ? "funded" : "unfunded");
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

/**
 * Resolve for an autonomous path. Wallets that opted out of auto-fire and
 * wallets with a nonce gap are removed regardless of what the selector said —
 * a selector should never be able to talk the bot into spending an imported
 * wallet or into queueing a tx behind a gap.
 */
export function resolveForAutoFire(
  selector: string,
  wallets: ManagedWallet[],
  ctx: TagContext
): { selected: ManagedWallet[]; excludedManual: number; excludedStuck: number } {
  const matched = resolve(selector, wallets, ctx);
  const excludedManual = matched.filter((w) => !w.autoFire).length;
  const afterAutoFire = matched.filter((w) => w.autoFire);
  const excludedStuck = afterAutoFire.filter((w) => ctx.state.get(w.id)?.nonceGap).length;
  return {
    selected: afterAutoFire.filter((w) => !ctx.state.get(w.id)?.nonceGap),
    excludedManual,
    excludedStuck,
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
