// "It isn't working." — answered.
//
// This bot had every fact needed to explain itself and no place that put them
// together. Copy-mint was on, nineteen wallets were watched, the watchers were
// connected, and nothing had ever been bought; each of those is reported on a
// different screen and none of them is wrong, so the operator reads four green
// lights and concludes the thing is broken and inexplicable.
//
// What was missing is the join: every watched wallet was set to follow free
// mints only, and every drop they bought cost money. One sentence, and it was
// derivable the whole time from state already on disk.
//
// So this module does one job — look at the whole configuration at once and
// name what is stopping a mint, worst first, in the words somebody would use
// out loud. It is pure: it takes a snapshot and returns findings, so it can be
// tested without a chain, a wallet or Telegram.
//
// Two rules it follows, both learned from the errors it replaces:
//
//   Never report a cause the operator cannot act on as though it were their
//   fault. "No drops have happened yet" is a perfectly good state and must not
//   read like a misconfiguration.
//
//   Never say "none funded and armed" or any other sentence that collapses
//   several different problems into one. If two things are wrong, that is two
//   findings with two fixes.

import { WatchTarget } from "./targets";
import { SkipTally, JournalSummary } from "./copy-journal";

export type Severity = "blocking" | "limiting" | "ok";

export interface Finding {
  severity: Severity;
  /** Short headline, sentence case, no jargon. */
  title: string;
  /** What is actually true right now. */
  detail: string;
  /** What to do about it. Omitted only when there is genuinely nothing to do. */
  fix?: string;
  /** Callback data for a button that performs the fix, when one exists. */
  action?: { label: string; callback: string };
}

/**
 * One network's ability to copy, on its own terms.
 *
 * Readiness is per chain because gas is per chain, and the engine has always
 * worked that way — one watcher and one wallet pool each. The reporting did
 * not, which is the whole problem this type exists to fix: an empty Ethereum
 * pool was announced as "none of your wallets have enough for gas", a sentence
 * that reads as total failure while Robinhood was funded and perfectly able to
 * buy. A chain that cannot pay should cost you that chain, not the bot.
 */
export interface ChainReadiness {
  key: string;
  name: string;
  /** False when balances could not be read — never the same claim as "empty". */
  read: boolean;
  /** A live watcher is attached. */
  watching: boolean;
  /** Matched the selector, armed, funded, not stuck: can buy here right now. */
  ready: number;
  /** Matched the selector and holds enough for gas here. */
  funded: number;
  /** Matched the selector at all. */
  matched: number;
  /** Matched and funded here, but not armed for autonomous firing. */
  unarmed: number;
}

export interface DiagnosisInput {
  copyEnabled: boolean;
  targets: WatchTarget[];
  /** Per network, in the order they should be shown. */
  chains: ChainReadiness[];
  walletsTotal: number;
  selector: string;
  /** True when the chosen selector cannot match imported wallets. */
  selectorExcludesImported: boolean;
  importedTotal: number;
  importedArmed: number;
  maxPriceWei: bigint;
  perEventWei: bigint;
  dailyWei: bigint;
  dailySpentWei: bigint;
  /** Misses grouped by cause, commonest first. */
  skips: SkipTally[];
  journal: JournalSummary;
  minFundedWei: bigint;
}

function eth(wei: bigint, places = 4): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, places).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Everything wrong, worst first.
 *
 * "Blocking" means no mint can happen at all until it is fixed. "Limiting"
 * means mints can happen but this is narrowing them. The distinction matters:
 * an operator reading a list of eight items needs to know which one to do
 * first, and a flat list of warnings is how the original "free only" problem
 * stayed invisible next to nineteen other true statements.
 */
export function diagnose(input: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];

  // ── Blocking: nothing can possibly fire ──

  if (!input.copyEnabled) {
    findings.push({
      severity: "blocking",
      title: "Copy-mint is switched off",
      detail: "Mints by the wallets you watch are being spotted and recorded, but nothing is being bought.",
      fix: "Turn it on from the main menu.",
      action: { label: "🟢 Turn copy-mint on", callback: "c:on" },
    });
  }

  if (input.targets.length === 0) {
    findings.push({
      severity: "blocking",
      title: "You are not watching any wallets",
      detail: "There is nobody to copy, so nothing will ever fire.",
      fix: "Add the wallet of someone whose mints you want to follow.",
      action: { label: "➕ Watch a wallet", callback: "i:watch" },
    });
    // Everything below is about following wallets. Without any, it is noise.
    return findings;
  }

  if (input.walletsTotal === 0) {
    findings.push({
      severity: "blocking",
      title: "You have no minting wallets",
      detail: "There is nothing to buy with.",
      fix: "Generate a set of wallets, then send them some ETH for gas.",
      action: { label: "👛 Wallets", callback: "m:wallets" },
    });
    return findings;
  }

  // ── The one that actually silenced this bot ──
  //
  // Reported per configuration rather than per wallet: "12 of your 19 wallets"
  // is the sentence that makes it obvious, where twelve separate warnings is
  // the sentence that hides it.
  const freeOnly = input.targets.filter((t) => t.mintMode === "free");
  const paidOnly = input.targets.filter((t) => t.mintMode === "paid");

  if (freeOnly.length === input.targets.length && input.targets.length > 0) {
    findings.push({
      severity: "blocking",
      title: `All ${input.targets.length} watched wallets are set to “free mints only”`,
      detail:
        "Any drop that costs money is ignored, and nearly every real drop costs money. " +
        "This is the most common reason the bot watches for days and buys nothing.",
      fix: "Switch them to “any mint”. Your price limit is what stops overspending, not this setting.",
      action: { label: "✅ Follow any mint, on all of them", callback: "fixall:mode" },
    });
  } else if (freeOnly.length > 0) {
    findings.push({
      severity: "limiting",
      title: `${freeOnly.length} of your ${input.targets.length} watched wallets only follow free mints`,
      detail: "Paid drops by those wallets are ignored.",
      fix: "Switch them to “any mint” unless you meant to follow free drops only.",
      action: { label: "✅ Follow any mint, on all of them", callback: "fixall:mode" },
    });
  }

  if (paidOnly.length > 0) {
    findings.push({
      severity: "limiting",
      title: `${paidOnly.length} watched ${paidOnly.length === 1 ? "wallet only follows" : "wallets only follow"} paid mints`,
      detail: "Free drops by those wallets are ignored.",
      fix: "Switch to “any mint” if you also want the free ones.",
    });
  }

  // ── Which wallets are even allowed to buy ──

  const anyMatched = input.chains.some((c) => c.matched > 0);
  if (!anyMatched) {
    findings.push({
      severity: "blocking",
      title: "No wallet is allowed to buy",
      detail:
        `Copy-mint is set to spend from “${input.selector}”, and none of your ` +
        `${input.walletsTotal} wallets fit that description.`,
      fix: "Change which wallets copy-mint may spend from.",
      action: { label: "👛 Choose which wallets buy", callback: "sel:menu" },
    });
  }

  // The trap behind "my imported wallets have the money and it still does
  // nothing". They are excluded twice over — the default selector names only
  // generated wallets, and imported keys default to manual because they hold
  // real value. Both have to be undone, and neither is discoverable.
  if (input.importedTotal > 0 && input.selectorExcludesImported) {
    findings.push({
      severity: "limiting",
      title: `Your ${input.importedTotal} imported wallets are not being used`,
      detail:
        `Copy-mint is set to spend from “${input.selector}”, which only covers generated wallets. ` +
        `If the money is in your imported ones, it is not being reached.`,
      fix: "Point copy-mint at any funded wallet, or at your imported ones.",
      action: { label: "👛 Choose which wallets buy", callback: "sel:menu" },
    });
  } else if (input.importedTotal > 0 && input.importedArmed === 0) {
    findings.push({
      severity: "blocking",
      title: `Your imported wallets are set to ask first`,
      detail:
        `All ${input.importedTotal} are manual-only, so copy-mint will never spend from them on its ` +
        `own — imported keys start that way because they usually hold real money.`,
      fix: "Arm them if you want copy-mint to buy with them automatically.",
      action: { label: "⚡ Arm imported wallets", callback: "f:imported:on" },
    });
  }

  // ── Per network ──
  //
  // Reported one chain at a time, and never as a single verdict. A funded
  // Robinhood and an empty Ethereum is a working bot with one network switched
  // off, not a broken one, and the old wording could not tell those apart.
  const readable = input.chains.filter((c) => c.read);
  const live = readable.filter((c) => c.ready > 0);

  if (readable.length > 0 && live.length === 0 && anyMatched) {
    // Nothing can act anywhere — but "has no money" and "has money and is not
    // allowed to spend it" are opposite problems with opposite fixes, and
    // collapsing them is exactly the mistake this module was written to stop.
    const fundedSomewhere = readable.some((c) => c.funded > 0);
    findings.push(
      fundedSomewhere
        ? {
            severity: "blocking",
            title: "Your funded wallets all ask before spending",
            detail:
              `They hold enough to mint, but every one of them is set to confirm first, so ` +
              `copy-mint can never act on a signal by itself.`,
            fix: "Arm the wallets you want copy-mint to buy with.",
            action: { label: "⚡ Arm wallets", callback: "af:menu" },
          }
        : {
            severity: "blocking",
            title: "No network has a wallet that can pay",
            detail:
              `A wallet needs at least ${eth(input.minFundedWei)} ETH on the network it is buying ` +
              `on. None of yours clears that anywhere.`,
            fix: "Fund your wallets on the network you want to copy on.",
            action: { label: "💸 Fund wallets", callback: "m:fund" },
          }
    );
  } else {
    for (const chain of readable) {
      if (chain.ready > 0) continue;
      // Not blocking. This chain is out; the others carry on.
      findings.push({
        severity: "limiting",
        title: `${chain.name}: nothing here can pay`,
        detail:
          chain.funded === 0
            ? `No wallet holds the ${eth(input.minFundedWei)} ETH needed for gas on ${chain.name}, ` +
              `so mints there will be spotted and reported but not copied.`
            : `${chain.funded} funded on ${chain.name}, but ${chain.unarmed} of them ask before spending, ` +
              `so none can act on their own.`,
        fix:
          chain.funded === 0
            ? `Send ETH to your wallets on ${chain.name}, or stop watching it.`
            : `Arm them, or pick a different set of wallets.`,
        action:
          chain.funded === 0
            ? { label: "💸 Fund wallets", callback: "m:fund" }
            : { label: "⚡ Arm wallets", callback: "af:menu" },
      });
    }
  }

  for (const chain of input.chains) {
    if (!chain.read) {
      findings.push({
        severity: "limiting",
        title: `${chain.name}: could not be reached`,
        detail: "Balances there are unknown right now — which is not the same as empty.",
        fix: "Usually clears on its own.",
      });
    } else if (!chain.watching) {
      findings.push({
        severity: "limiting",
        title: `${chain.name}: not connected`,
        detail: `Mints on ${chain.name} are not being spotted right now.`,
        fix: "Usually reconnects within a minute.",
      });
    }
  }

  // ── Budget ──

  if (input.dailySpentWei >= input.dailyWei) {
    findings.push({
      severity: "blocking",
      title: "Today's budget is spent",
      detail: `The bot has used its ${eth(input.dailyWei)} ETH daily allowance on copies.`,
      fix: "Raise the daily limit, or wait for the 24 hours to roll over.",
      action: { label: "✏️ Spending limits", callback: "a:caps" },
    });
  }

  // ── What the misses actually were ──
  //
  // Configuration can look perfect and still be wrong for the drops that turned
  // up. The record knows; nothing used to read it back.
  const topSkip = input.skips[0];
  if (topSkip && topSkip.count >= 2 && topSkip.fix) {
    const already = findings.some((f) => f.fix === topSkip.fix);
    if (!already) {
      findings.push({
        severity: "limiting",
        title: `${topSkip.count} mints were passed over for the same reason`,
        detail: topSkip.reason,
        fix: topSkip.fix,
      });
    }
  }

  // ── Nothing is wrong ──

  if (findings.length === 0) {
    const ready = input.chains.reduce((n, c) => Math.max(n, c.ready), 0);
    const on = input.chains.filter((c) => c.ready > 0).map((c) => c.name);
    if (input.journal.seen === 0) {
      findings.push({
        severity: "ok",
        title: "Set up correctly — waiting for someone to mint",
        detail:
          `Watching ${input.targets.length} ${input.targets.length === 1 ? "wallet" : "wallets"} ` +
          `with up to ${ready} of yours ready to buy on ${on.join(" and ")}. ` +
          `None of them has minted anything yet.`,
      });
    } else {
      findings.push({
        severity: "ok",
        title: "Working",
        detail:
          `${input.journal.seen} mints spotted in the last week, ${input.journal.fired} copied.`,
      });
    }
  }

  return findings;
}

/** Worst severity present, for the one-line summary at the top of a screen. */
export function overallState(findings: Finding[]): Severity {
  if (findings.some((f) => f.severity === "blocking")) return "blocking";
  if (findings.some((f) => f.severity === "limiting")) return "limiting";
  return "ok";
}
