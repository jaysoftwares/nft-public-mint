// The dashboard card.
//
// One screen that answers the questions an operator actually opens the bot to
// ask: how many wallets do I have, how many of them can pay for a mint right
// now, is copy-mint watching anything, and what has it spent. Those facts were
// all reachable before — spread over /status, /wallets, /caps and the copy feed
// — which meant assembling them by hand from four screens while a stage was
// opening.
//
// Telegram gives no control over type size, so hierarchy comes from three
// things instead: the headline is the one number that matters and sits alone at
// the top, every other figure is a fixed-width row so the eye can scan a column
// rather than parse a sentence, and each block is small enough that nothing
// scrolls off a phone.
//
// Every number here is either read from chain a moment ago or recorded locally.
// Nothing is projected, and nothing is a placeholder — a dashboard that
// invented a figure would be worse than no dashboard at all, which is why
// there is no floor price or profit line: this bot has no price feed, so it
// cannot honestly show one.

import { DashboardStats, ChainFunding, pct } from "../core/dashboard";
import { esc, eth, bar } from "./ui";

/** Column widths chosen so the widest row still fits a phone without wrapping. */
const LABEL = 11;
const VALUE = 9;

function stat(label: string, value: string, note?: string): string {
  const row = `<code>${label.padEnd(LABEL)}${value.padStart(VALUE)}</code>`;
  return note ? `${row}  ${note}` : row;
}

function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "19 Aug 08:06" — the bot runs on a VPS, so the clock has to say which one. */
function stamp(at: number): string {
  const when = new Date(at);
  const month = when.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${when.getUTCDate()} ${month} ${when.toISOString().slice(11, 16)} UTC`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * One chain's row.
 *
 * A chain that would not answer says so rather than showing zeroes. Reporting
 * an unread chain as "0 funded" is the single most expensive thing this screen
 * could get wrong: it reads as "your wallets are empty" when the truth is
 * "nobody asked".
 */
function chainRow(chain: ChainFunding, minters: number): string {
  const name = esc(chain.name).slice(0, LABEL - 1).padEnd(LABEL);
  if (!chain.read) return `<code>${name}${"unread".padStart(VALUE)}</code>`;

  const counts = `${chain.funded}/${minters}`.padStart(VALUE);
  const held = `${eth(chain.totalWei, 4)} ${chain.symbol}`;
  return `<code>${name}${counts}</code>  ${held}` + (chain.unknown > 0 ? `  <i>(${chain.unknown} unread)</i>` : "");
}

export function renderDashboard(stats: DashboardStats): string {
  const { wallets, funding, minted, copied, copy, day } = stats;
  const now = stats.generatedAt;
  const lines: string[] = [`📊 <b>Dashboard</b>`, ``];

  // ── Headline ──
  if (wallets.total === 0) {
    lines.push(
      `<b>No minting wallets yet</b>`,
      ``,
      `<i>Generate a set from Wallets, then fund them. Everything below fills in from there.</i>`,
      ``
    );
  } else if (funding.blind) {
    lines.push(
      `<b>${wallets.total} wallets</b> · balances unread`,
      ``,
      `<i>No chain answered just now, so how many are funded is unknown — not zero. Tap ↻ to try again.</i>`,
      ``
    );
  } else {
    const share = pct(funding.fundedAnywhere, wallets.total);
    lines.push(
      `<b>${funding.fundedAnywhere} of ${wallets.total} wallets funded</b>  ·  ${share}%`,
      `<code>${bar(funding.fundedAnywhere, wallets.total)}</code>`,
      `<i>${eth(funding.totalWei, 4)} ETH held · ${funding.readyToFire} armed and funded, ready to fire</i>`,
      ``
    );
  }

  // ── Wallets ──
  //
  // When nothing could be read, these rows say so rather than printing zeroes.
  // "funded 0" and "funded unknown" look alike and mean opposite things, and
  // the first one reads as an empty set of wallets that may be perfectly funded.
  lines.push(
    `<b>👛 Wallets</b>`,
    ...(funding.blind
      ? [stat("funded", "unread", "no chain answered")]
      : [
          stat("funded", String(funding.fundedAnywhere), "can pay for a mint"),
          stat("empty", String(Math.max(0, wallets.total - funding.fundedAnywhere)), "needs gas"),
        ]),
    stat("armed", String(wallets.armed), "fires on a copy signal"),
    stat("manual", String(wallets.manual), "confirm every time"),
    stat("imported", String(wallets.imported)),
    // Summed over every chain the funder was readable on. Which chain it is
    // actually sitting on decides whether a fund succeeds, so that figure is
    // shown per chain on the buttons of the fund flow rather than implied here.
    stat(
      "funder",
      funding.blind ? "unread" : eth(funding.funderWei, 4),
      funding.blind ? "" : "ETH to fund with, all chains"
    ),
    ``
  );

  // ── Per chain ──
  //
  // Funded is per chain because gas is: the same wallet is ready on Robinhood
  // and broke on Base, and only this block can say which.
  lines.push(
    `<b>⛓ Funded per chain</b>`,
    ...funding.chains.map((chain) => chainRow(chain, wallets.total)),
    `<i>funded = holds at least ${eth(funding.chains[0]?.minFundedWei ?? 0n)} ETH, one mint's gas reservation</i>`,
    ``
  );

  // ── Copy-mint ──
  //
  // Signals acted on and mints that landed are separate numbers on purpose. A
  // target that fires constantly while nothing lands is the failure worth
  // seeing, and one combined figure would hide it in either direction.
  lines.push(
    `<b>👁 Copy-mint</b>  ${copy.enabled ? "🟢 ON" : "🔴 OFF"}`,
    stat("targets", String(copy.targets), plural(copy.targets, "wallet watched", "wallets watched")),
    ...(copy.fires > 0 ? [stat("signals", String(copy.fires), "acted on")] : []),
    stat("copied", String(copied.runs), plural(copied.runs, "mint landed", "mints landed")),
    stat("sent", String(copied.txs), "wallet transactions"),
    stat("spent", eth(copied.spentWei), "ETH"),
    ...(copied.lastAt !== undefined ? [stat("last", ago(copied.lastAt, now))] : []),
    ...(copy.targets === 0
      ? [`<i>Nothing is being watched yet — add a wallet under Copy-mint.</i>`]
      : []),
    ``
  );

  // ── All minting ──
  lines.push(
    `<b>💰 Minting, all time</b>`,
    stat(
      "drops",
      String(minted.runs),
      minted.collections === minted.runs
        ? ""
        : `${minted.collections} ${plural(minted.collections, "collection", "collections")}`
    ),
    stat("NFTs", String(minted.nfts), "bought"),
    stat("sent", String(minted.txs), "wallet transactions"),
    stat("spent", eth(minted.spentWei), "ETH"),
    ...(minted.lastAt !== undefined ? [stat("last", ago(minted.lastAt, now))] : []),
    ``
  );

  // ── The rolling day ──
  //
  // The cap governs autonomous spending only, so hand-driven mints are shown
  // beside it rather than inside it — charging them to the same budget is what
  // used to silence copy-mint after an operator minted something themselves.
  const spentToday = day.autoSpentWei;
  lines.push(
    `<b>📈 Last 24 hours</b>`,
    `<code>${bar(Number(spentToday), Number(day.capWei))}</code>  ${eth(spentToday)} / ${eth(day.capWei)} ETH`,
    stat("auto", eth(day.autoSpentWei), "ETH · counts against the cap"),
    stat("by hand", eth(day.manualSpentWei), "ETH · does not"),
    stat("mints", String(day.mintRuns), `${day.copyRuns} from copy signals`),
    ...(day.fundedWei > 0n ? [stat("funded", eth(day.fundedWei), "ETH sent to wallets")] : []),
    ``
  );

  lines.push(`<i>${stamp(now)} · ↻ re-reads every balance from chain</i>`);
  return lines.join("\n");
}
