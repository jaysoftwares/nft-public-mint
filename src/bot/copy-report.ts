// The message somebody reads after a drop.
//
// Kept out of index.ts and free of bot handles so it can be exercised offline —
// this is the one screen that decides whether the owner understands what just
// happened to their money, and it was previously a ratio and a raw node error.

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
 * Telegram caps a message at 4096 characters and a full store is five hundred
 * wallets, so everything cannot be listed. Twelve is enough to read at a glance
 * and enough that a normal funded set — usually ten or twenty wallets — is
 * shown in full rather than summarised.
 */
const WALLETS_LISTED = 12;

/**
 * The message somebody actually reads after a drop.
 *
 * It answers, in this order: did I get it, what is it, which of my wallets got
 * one, and what went wrong with the rest. The previous version gave a ratio and
 * an aggregated error string — "8/10 accepted" and "2× insufficient funds for
 * gas * price + value" — which named neither the collection nor a single
 * wallet, so the owner could not tell which two to top up.
 */
export function renderCopyResult(r: CopyResult, chain: ReportChain): string {
  const won = r.hashes.filter((h) => h.accepted);
  const lost = r.hashes.filter((h) => !h.accepted);
  const what = r.collection ? esc(r.collection) : `contract ${esc(short(r.contract))}`;

  const lines: string[] = [
    won.length > 0
      ? `<b>✅ Minted ${what}</b>`
      : `<b>❌ Could not mint ${what}</b>`,
    ``,
    won.length > 0
      ? `${won.length} of your ${r.walletCount} wallet${r.walletCount === 1 ? "" : "s"} got ` +
        `${r.quantity > 1 ? `${r.quantity} NFTs each` : `one`}` +
        (r.unitPriceWei > 0n ? `, at ${eth(r.unitPriceWei)} ETH per wallet.` : `, free.`)
      : `None of your ${r.walletCount} wallet${r.walletCount === 1 ? "" : "s"} got one.`,
  ];

  if (won.length > 0) {
    lines.push(``, `<b>Wallets that minted</b>`);
    for (const h of won.slice(0, WALLETS_LISTED)) {
      lines.push(`  ✅ <code>${esc(h.address)}</code>`);
    }
    if (won.length > WALLETS_LISTED) {
      lines.push(`  …and ${won.length - WALLETS_LISTED} more`);
    }
  }

  if (lost.length > 0) {
    // Grouped by cause, because five hundred wallets short of gas is one fact
    // repeated, not five hundred facts. The addresses still appear underneath
    // each cause so the owner knows exactly which wallets to top up.
    const byReason = new Map<string, string[]>();
    for (const h of lost) {
      const reason = h.reason ?? "Rejected without a reason";
      const list = byReason.get(reason) ?? [];
      list.push(h.address);
      byReason.set(reason, list);
    }

    lines.push(``, `<b>Wallets that missed out</b>`);
    for (const [reason, addresses] of [...byReason.entries()].sort(
      (a, b) => b[1].length - a[1].length
    )) {
      lines.push(`  ${esc(reason)} — ${addresses.length} wallet${addresses.length === 1 ? "" : "s"}`);
      for (const address of addresses.slice(0, WALLETS_LISTED)) {
        lines.push(`      <code>${esc(address)}</code>`);
      }
      if (addresses.length > WALLETS_LISTED) {
        lines.push(`      …and ${addresses.length - WALLETS_LISTED} more`);
      }
    }
  }

  lines.push(
    ``,
    `<i>${esc(chain.name)} · ${esc(r.how)}</i>`,
    `<i>spotted and sent in ${r.elapsedMs.toFixed(0)}ms</i>`
  );

  if (won.length > 0) {
    lines.push(``, txLink(chain.chainId, won[0].hash, "view transaction"));
  }

  return lines.join("\n");
}
