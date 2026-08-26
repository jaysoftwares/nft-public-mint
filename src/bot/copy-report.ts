// The message somebody reads after a drop.
//
// Kept out of index.ts and free of bot handles so it can be exercised offline —
// this is the one screen that decides whether the owner understands what just
// happened to their money.
//
// It has failed that job twice, in opposite directions. First it was a ratio
// and an aggregated node error, naming neither the collection nor a wallet.
// Then it listed every wallet that missed out, grouped under its cause — which
// on a five-hundred-wallet store is fine with one cause and 4,218 characters
// with four. Telegram rejects anything over 4,096, notify() swallowed the
// rejection, and the bot went silent exactly when it succeeded.
//
// So the rule here is: everything that varies with the size of the store is
// either capped or counted. A message this renderer produces cannot grow past
// about 1,500 characters no matter how many wallets fired or how many
// different ways they were turned down.

import { CopyResult } from "../core/copy-mint";
import { esc, short, eth, txLink } from "./ui";

/** Only the fields the report needs, so a test does not have to build a chain. */
export interface ReportChain {
  name: string;
  chainId: number;
}

/**
 * How many wallets are named individually before the rest become a count.
 *
 * Only wallets that actually minted are listed — those are the ones the owner
 * goes looking for the NFT in. Twelve shows a normal funded set in full.
 */
const WALLETS_LISTED = 12;

/** Distinct rejection causes named before the rest collapse into "other". */
const CAUSES_LISTED = 3;

/** Dispatching five hundred transactions takes half a minute; "31240ms" is not a time. */
function took(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

/**
 * The message somebody actually reads after a drop.
 *
 * It answers, in this order: did I get it, what is it, who did we copy, which
 * of my wallets got one, and — in one line, never a list — what stopped the
 * rest.
 */
export function renderCopyResult(r: CopyResult, chain: ReportChain): string {
  const won = r.hashes.filter((h) => h.accepted);
  const lost = r.hashes.filter((h) => !h.accepted);
  const what = r.collection ? esc(r.collection) : `contract ${esc(short(r.contract))}`;
  const each = r.quantity > 1 ? `${r.quantity} each` : `1 each`;
  const price = r.unitPriceWei > 0n ? `${eth(r.unitPriceWei)} ETH per wallet` : `free`;

  const lines: string[] = [
    won.length > 0 ? `✅ <b>Mint copied — ${what}</b>` : `❌ <b>Could not mint ${what}</b>`,
    ``,
    // The target is the whole reason this happened and was missing from the
    // report entirely. Full address, in code, so it is one tap to copy.
    `Followed <code>${esc(r.target)}</code>`,
    won.length > 0
      ? `${won.length} of ${r.walletCount} wallet${r.walletCount === 1 ? "" : "s"} minted ${each} · ${price}`
      : `None of your ${r.walletCount} wallet${r.walletCount === 1 ? "" : "s"} got one.`,
  ];

  if (won.length > 0) {
    lines.push(``, `<b>Minted by</b>`);
    for (const h of won.slice(0, WALLETS_LISTED)) {
      lines.push(`  <code>${esc(h.address)}</code>`);
    }
    if (won.length > WALLETS_LISTED) {
      lines.push(`  …and ${won.length - WALLETS_LISTED} more`);
    }
  }

  if (lost.length > 0) {
    // One line, whatever the store size. Five hundred wallets short of gas is
    // one fact repeated, not five hundred facts, and the addresses belong on
    // the wallet screen — printing them here is what broke the message.
    const counts = new Map<string, number>();
    for (const h of lost) {
      const reason = h.reason ?? "Rejected without a reason";
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const rest = ranked.slice(CAUSES_LISTED).reduce((total, [, count]) => total + count, 0);
    const causes = ranked
      .slice(0, CAUSES_LISTED)
      // A single cause needs no count — it is all of them, and the total is
      // already at the front of the line.
      .map(([reason, count]) => (ranked.length === 1 ? esc(reason) : `${esc(reason)} (${count})`));
    if (rest > 0) causes.push(`other (${rest})`);

    lines.push(
      ``,
      `${lost.length} wallet${lost.length === 1 ? "" : "s"} missed out — ${causes.join(" · ")}`
    );
  }

  lines.push(``, `<i>${esc(chain.name)} · ${esc(r.how)} · ${took(r.elapsedMs)}</i>`);

  if (won.length > 0) {
    lines.push(txLink(chain.chainId, won[0].hash, "view transaction"));
  }

  return lines.join("\n");
}
