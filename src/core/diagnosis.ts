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

export interface DiagnosisInput {
  copyEnabled: boolean;
  targets: WatchTarget[];
  /** Chains whose watcher is currently connected, and those that are not. */
  watchersUp: number;
  watchersTotal: number;
  walletsTotal: number;
  /** Matched the copy selector. */
  walletsMatched: number;
  /** Matched, armed, funded — the set that can actually buy. */
  walletsReady: number;
  walletsUnfunded: number;
  walletsUnarmed: number;
  selector: string;
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

  // ── Wallets that cannot pay ──

  if (input.walletsMatched === 0) {
    findings.push({
      severity: "blocking",
      title: "No wallet is allowed to buy",
      detail:
        `Copy-mint is set to spend from “${input.selector}”, and none of your ` +
        `${input.walletsTotal} wallets fit that description.`,
      fix: "Change which wallets copy-mint may spend from.",
      action: { label: "👛 Which wallets fire", callback: "sel:menu" },
    });
  } else if (input.walletsReady === 0) {
    // Split deliberately. "None ready" used to cover both an unfunded set and
    // an unarmed one, which are opposite problems with opposite fixes, and the
    // shared wording sent people to top up wallets that already had money.
    if (input.walletsUnfunded > 0) {
      findings.push({
        severity: "blocking",
        title: "None of your wallets have enough for gas",
        detail:
          `A wallet needs at least ${eth(input.minFundedWei)} ETH set aside for gas before it can mint. ` +
          `${input.walletsUnfunded} of ${input.walletsTotal} are below that.`,
        fix: "Send them some ETH.",
        action: { label: "💸 Fund wallets", callback: "m:fund" },
      });
    }
    if (input.walletsUnarmed > 0) {
      findings.push({
        severity: "blocking",
        title: `${input.walletsUnarmed} funded ${input.walletsUnarmed === 1 ? "wallet is" : "wallets are"} not armed`,
        detail:
          "They have money but are set to ask before every mint, so copy-mint will never use them on its own.",
        fix: "Arm them for automatic firing.",
        action: { label: "⚡ Arm wallets", callback: "af:menu" },
      });
    }
  }

  // ── Watchers ──

  if (input.watchersUp === 0 && input.watchersTotal > 0) {
    findings.push({
      severity: "blocking",
      title: "Not connected to any chain",
      detail: "Mints cannot be spotted at all while this is true.",
      fix: "Usually clears itself within a minute. If it does not, the RPC provider is down.",
    });
  } else if (input.watchersUp < input.watchersTotal) {
    findings.push({
      severity: "limiting",
      title: `Connected to ${input.watchersUp} of ${input.watchersTotal} chains`,
      detail: "Mints on the missing chains are not being spotted right now.",
      fix: "Usually reconnects on its own.",
    });
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
    if (input.journal.seen === 0) {
      findings.push({
        severity: "ok",
        title: "Set up correctly — waiting for someone to mint",
        detail:
          `Watching ${input.targets.length} ${input.targets.length === 1 ? "wallet" : "wallets"} ` +
          `with ${input.walletsReady} ready to buy. None of them has minted anything yet.`,
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
