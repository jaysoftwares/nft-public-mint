// The list Telegram shows when you type "/".
//
// Twenty-five commands were registered and none of them were ever declared to
// Telegram, so the "/" menu was empty and every one of them had to be typed
// from memory — including the ones added to make the bot explain itself, which
// nobody could reach without already knowing they existed.
//
// Two rules for this list, both about it being a picker rather than a manual:
//
//   Order is the interface. Telegram renders these in the order given, so the
//   things reached for daily go at the top and the housekeeping goes at the
//   bottom. Alphabetical would put /allowlist first and /why nineteenth.
//
//   The description is the whole explanation. It sits beside the command in a
//   narrow list, gets one line, and is the only help most people will ever
//   read. No selector syntax, no argument order — those live in /help, which is
//   the last entry precisely because it is the fallback.
//
// Telegram's limits: at most 100 commands, names lowercase and 1–32 characters,
// descriptions 1–256. Anything outside that is rejected for the whole list, not
// just the offending row, so `validateCommands` is asserted in the test suite.

export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommand[] = [
  // ── Every day ──
  { command: "start", description: "Open the main menu" },
  { command: "dashboard", description: "Where everything stands, as one picture" },
  { command: "why", description: "Why nothing is being bought, and how to fix it" },
  { command: "setup", description: "Guided set-up — pick a network, get told what to fund" },
  { command: "signals", description: "Every mint spotted, and what came of each" },

  // ── Copy-mint ──
  { command: "copy", description: "Turn copy-mint on or off" },
  { command: "watch", description: "Follow a wallet and copy its mints" },
  { command: "unwatch", description: "Stop following a wallet" },
  { command: "targets", description: "The wallets you follow, and their settings" },
  { command: "caps", description: "Spending limits, and what has been spent today" },

  // ── Wallets and money ──
  { command: "wallets", description: "List your wallets and what they hold" },
  { command: "fund", description: "Send gas to your wallets" },
  { command: "generate", description: "Make more wallets" },
  { command: "import", description: "Import a private key or seed phrase" },
  { command: "autofire", description: "Let wallets buy without asking you first" },
  { command: "nfts", description: "Which of your wallets are holding NFTs right now" },
  { command: "sweep", description: "Collect your NFTs into one wallet" },
  { command: "autosweep", description: "Collect copied NFTs automatically, as they land" },
  { command: "drain", description: "Send leftover ETH back to your funding wallet" },

  // ── Minting by hand ──
  { command: "mint", description: "Mint a public drop yourself" },
  { command: "fcfs", description: "Mint through OpenSea — whichever stage you qualify for" },
  { command: "probe", description: "Check a drop's stages and prices before minting" },
  { command: "check", description: "See which of your wallets are on an allowlist" },
  { command: "allowlist", description: "Mint an allowlist drop" },
  { command: "schedule", description: "Book a mint for a time — it fires without you" },
  { command: "scheduled", description: "Booked mints, and cancel any of them" },
  { command: "unschedule", description: "Cancel a booked mint by its id" },

  // ── Housekeeping ──
  { command: "status", description: "Connection and wallet health" },
  { command: "tag", description: "Label wallets so you can select them later" },
  { command: "untag", description: "Remove a label from wallets" },
  { command: "settings", description: "Change where swept NFTs are sent" },
  { command: "help", description: "Full command reference, with arguments" },
];

/**
 * Commands that work but are deliberately kept out of the picker.
 *
 * Only aliases belong here. A second name for the same screen is worth
 * supporting for anyone who guesses it and worth hiding from a list whose value
 * is that every row is a different destination.
 */
export const UNLISTED_ALIASES = new Set(["menu"]);

/**
 * Telegram rejects the whole list if any single entry is malformed, which
 * presents as the "/" menu silently staying empty — the exact failure this file
 * exists to fix, and one that would be invisible without a check.
 */
export function validateCommands(commands: BotCommand[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  if (commands.length > 100) problems.push(`${commands.length} commands — Telegram allows 100.`);

  for (const entry of commands) {
    if (!/^[a-z0-9_]{1,32}$/.test(entry.command)) {
      problems.push(`"${entry.command}" is not a valid command name.`);
    }
    if (seen.has(entry.command)) problems.push(`"${entry.command}" is listed twice.`);
    seen.add(entry.command);
    if (entry.description.length < 1 || entry.description.length > 256) {
      problems.push(`"${entry.command}" has a description of ${entry.description.length} characters.`);
    }
  }

  return problems;
}
