// The dashboard card.
//
// What this replaces: seven headed blocks of fixed-width label/number rows, all
// of them true, none of them saying whether the thing was working. It read as a
// wall of statistics — "armed 511", "funded 0/511", "signals 0" — in a private
// vocabulary, and the operator's summary of it was that the screen was full of
// text and explained nothing. That was a fair reading. A row saying `armed 511`
// does not tell you that armed means "allowed to buy without asking", and a
// screen of thirty such rows does not tell you which one is the problem.
//
// So the shape changed, on three rules:
//
//   Lead with the verdict, not the data. The first line says whether it is
//   working, and if not, what is stopping it. Everything else is support.
//
//   Say what a number means in the same breath as the number. Not `armed 511`
//   but "511 can buy without asking you first".
//
//   Show less. Anything that is zero, or that duplicates a figure above, or
//   that only matters while something is happening, is not on the card. A
//   number nobody acts on is noise no matter how correct it is.
//
// Nothing here is projected or invented — same rule as before, and the reason
// there is still no floor price or profit line: this bot has no price feed, so
// it cannot honestly show one.

import { DashboardStats, ChainFunding, pct } from "../core/dashboard";
import { Finding, Severity } from "../core/diagnosis";
import { esc, eth, bar } from "./ui";

function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** "19 Aug 08:06 UTC" — the bot runs on a VPS, so the clock has to say which one. */
function stamp(at: number): string {
  const when = new Date(at);
  const month = when.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${when.getUTCDate()} ${month} ${when.toISOString().slice(11, 16)} UTC`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * One chain's line.
 *
 * A chain that would not answer says so in words rather than showing zeroes.
 * Reporting an unread chain as "0 funded" is the single most expensive thing
 * this screen could get wrong: it reads as "your wallets are empty" when the
 * truth is "nobody asked".
 */
function chainLine(chain: ChainFunding, total: number): string {
  const name = `<b>${esc(chain.name)}</b>`;
  if (!chain.read) return `${name} — could not be reached just now`;
  if (chain.funded === 0) {
    return `${name} — no wallets ready · ${eth(chain.totalWei, 4)} ${chain.symbol} held`;
  }
  return (
    `${name} — ${chain.funded} of ${total} ${plural(chain.funded, "wallet", "wallets")} ready · ` +
    `${eth(chain.totalWei, 4)} ${chain.symbol} held`
  );
}

/**
 * The card.
 *
 * `findings` comes from the same health check the "Why?" screen runs, so the
 * dashboard and that screen can never disagree — which they would, inevitably,
 * if each worked the verdict out for itself.
 */
export function renderDashboard(
  stats: DashboardStats,
  findings: Finding[] = [],
  state: Severity = "ok"
): string {
  const { wallets, funding, minted, copied, copy, day } = stats;
  const now = stats.generatedAt;
  const lines: string[] = [];

  // ── The verdict ──
  //
  // First, always, and in one sentence. This is the line that was missing: the
  // old card could show a perfectly healthy set of numbers for a bot that had
  // been unable to buy anything for a week.
  const blockers = findings.filter((f) => f.severity === "blocking");
  if (blockers.length > 0) {
    lines.push(
      `🔴 <b>Not buying anything</b>`,
      ``,
      esc(blockers[0].title) + ".",
      ...(blockers[0].fix ? [`<i>→ ${esc(blockers[0].fix)}</i>`] : []),
      ...(blockers.length > 1
        ? [``, `<i>and ${blockers.length - 1} other ${plural(blockers.length - 1, "problem", "problems")} — tap “Why?” below.</i>`]
        : []),
      ``
    );
  } else if (state === "limiting") {
    lines.push(
      `🟡 <b>Running, but skipping some mints</b>`,
      ``,
      ...(findings[0] ? [esc(findings[0].title) + "."] : []),
      ``
    );
  } else if (copy.enabled) {
    lines.push(
      `🟢 <b>Watching and ready to buy</b>`,
      ``,
      `Following ${copy.targets} ${plural(copy.targets, "wallet", "wallets")} with ` +
        `${funding.readyToFire} of yours ready to copy them.`,
      ``
    );
  } else {
    lines.push(`⚪️ <b>Copy-mint is off</b>`, ``, `Nothing is being bought.`, ``);
  }

  // ── Your wallets ──
  if (wallets.total === 0) {
    lines.push(
      `<b>Your wallets</b>`,
      `You have none yet. Make some under Wallets, then send them ETH for gas.`,
      ``
    );
  } else if (funding.blind) {
    lines.push(
      `<b>Your wallets</b>`,
      `${wallets.total} wallets. No network answered just now, so how many have money ` +
        `is unknown — <i>not</i> zero. Tap ↻ to try again.`,
      ``
    );
  } else {
    const share = pct(funding.fundedAnywhere, wallets.total);
    lines.push(
      `<b>Your wallets</b>`,
      `<code>${bar(funding.fundedAnywhere, wallets.total)}</code>  ${share}%`,
      `<b>${funding.fundedAnywhere} of ${wallets.total}</b> have enough for gas, ` +
        `holding ${eth(funding.totalWei, 4)} ETH between them.`,
      `<b>${funding.readyToFire}</b> of those can buy without asking you first.`,
      ...(wallets.manual > 0
        ? [`<i>${wallets.manual} will always ask you before spending.</i>`]
        : []),
      ``
    );

    // Per network, because gas is per network: the same wallet is ready on one
    // and broke on another, and only this block can say which.
    if (funding.chains.length > 0) {
      lines.push(
        `<b>Ready, by network</b>`,
        ...funding.chains.map((chain) => chainLine(chain, wallets.total)),
        ``
      );
    }

    lines.push(
      `<b>Money to top up with</b>`,
      `${eth(funding.funderWei, 4)} ETH in your funding wallet.`,
      ``
    );
  }

  // ── Copying ──
  lines.push(`<b>Copying</b>`);
  if (copy.targets === 0) {
    lines.push(`You are not following anyone yet.`);
  } else if (copied.runs === 0) {
    lines.push(
      `Following ${copy.targets} ${plural(copy.targets, "wallet", "wallets")}. ` +
        `Nothing bought yet.`
    );
  } else {
    lines.push(
      `Bought <b>${copied.nfts}</b> ${plural(copied.nfts, "NFT", "NFTs")} by copying, ` +
        `across ${copied.collections} ${plural(copied.collections, "collection", "collections")}, ` +
        `for ${eth(copied.spentWei)} ETH.`,
      ...(copied.lastAt !== undefined ? [`<i>Last one ${ago(copied.lastAt, now)}.</i>`] : [])
    );
  }
  lines.push(``);

  // ── Everything bought, if hand-driven mints happened too ──
  if (minted.runs > copied.runs) {
    lines.push(
      `<b>Everything you've minted</b>`,
      `<b>${minted.nfts}</b> ${plural(minted.nfts, "NFT", "NFTs")} across ` +
        `${minted.collections} ${plural(minted.collections, "collection", "collections")}, ` +
        `for ${eth(minted.spentWei)} ETH.`,
      `<i>Includes the copies above and anything you minted by hand.</i>`,
      ``
    );
  }

  // ── Today's spending ──
  //
  // The cap governs autonomous spending only, so hand-driven mints sit beside
  // it rather than inside it — charging them to the same budget is what used to
  // silence copy-mint after the operator minted something themselves.
  lines.push(
    `<b>Spending, last 24 hours</b>`,
    `<code>${bar(Number(day.autoSpentWei), Number(day.capWei))}</code>`,
    `${eth(day.autoSpentWei)} of ${eth(day.capWei)} ETH — the limit on what the bot ` +
      `may spend on its own.`,
    ...(day.manualSpentWei > 0n
      ? [`<i>Plus ${eth(day.manualSpentWei)} ETH you spent yourself, which does not count against it.</i>`]
      : []),
    ``
  );

  lines.push(`<i>${stamp(now)} · ↻ checks every balance again</i>`);
  return lines.join("\n");
}
