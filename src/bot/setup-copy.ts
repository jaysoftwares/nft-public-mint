// Getting copy-mint actually ready, one network at a time.
//
// The bot had every setting reachable and no path through them. Copy-mint needs
// three things true at once — something to follow, wallets it is allowed to
// spend from, and gas on the network the mint happens on — and each lived on a
// different screen, in a different vocabulary, with nothing anywhere saying
// they had to agree.
//
// There used to be a fourth: the wallets also had to be separately "armed".
// That was removed — choosing which wallets copy-mint spends from already says
// what you want, and a second switch behind the switch only produced a set-up
// that looked complete and bought nothing.
//
// The result was a set-up that looked complete and could not buy: the money
// sat in imported wallets, the selector named generated ones, and the network
// with the funds was not the network being watched most. Every screen was
// telling the truth.
//
// So this walks it. Pick a network, pick which wallets buy there, and then get
// told — in numbers, not in principle — how many are ready, how many are short,
// and exactly how much to send. Nothing here decides anything on its own; it
// only makes the four facts agree where the operator can see them.

import { InlineKeyboard } from "grammy";
import { esc, eth } from "./ui";

export interface WalletBreakdown {
  /** Every wallet in the store. */
  total: number;
  /** Matched by the chosen selector. */
  matched: number;
  /**
   * Matched and holding the gas reservation on this network.
   *
   * Reported, not enforced. Every matched wallet fires; this is how many of
   * them the network will actually accept a transaction from, which is worth
   * knowing before a drop rather than after it.
   */
  funded: number;
}

export interface NetworkStep {
  key: string;
  name: string;
  symbol: string;
  read: boolean;
  wallets: WalletBreakdown;
  /** Per wallet, to clear the gas bar. */
  minFundedWei: bigint;
  /** Held by the funding wallet on this network. */
  funderWei: bigint;
}

/** How many wallets to aim at when telling somebody what to send. */
const SUGGESTED = 25;

function tick(done: boolean): string {
  return done ? "✅" : "⬜️";
}

/**
 * The network picker.
 *
 * Every network is offered with its readiness on the button, because the choice
 * is meaningless without it — "Base" and "Base · 0 ready" are different
 * questions, and only the second one can be answered correctly.
 */
export function networkKeyboard(steps: NetworkStep[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const step of steps) {
    const state = !step.read
      ? "unreachable"
      : step.wallets.funded > 0
        ? `${step.wallets.funded} can pay`
        : "no gas here";
    keyboard.text(`${step.wallets.funded > 0 ? "✅" : "⬜️"} ${step.name} · ${state}`, `cs:chain:${step.key}`).row();
  }
  return keyboard.text("‹ Back", "m:copy");
}

export function renderNetworkChoice(steps: NetworkStep[]): string {
  const ready = steps.filter((s) => s.wallets.funded > 0);
  return [
    `🚀 <b>Set up copy-mint</b>`,
    ``,
    `<b>Step 1 of 3 — pick a network</b>`,
    ``,
    `Gas is held per network, so a wallet ready on one is broke on another. ` +
      `Pick the network you want to be able to buy on and I'll tell you exactly what it needs.`,
    ``,
    ready.length === 0
      ? `<i>None of your networks can buy yet.</i>`
      : `<i>Ready on ${ready.map((s) => esc(s.name)).join(", ")}. ` +
        `Mints on the others are still spotted and reported — they just are not bought.</i>`,
  ].join("\n");
}

/**
 * Which wallets may spend here.
 *
 * Named by where the money actually is rather than by selector syntax. The
 * failure this prevents is silent and was live for weeks: a set whose funds sit
 * entirely in imported wallets, with copy-mint pointed at generated ones,
 * watches every signal go past and fires on none.
 */
export function walletChoiceKeyboard(chainKey: string, current: string): InlineKeyboard {
  const mark = (selector: string, label: string): string =>
    current === selector ? `✅ ${label}` : label;
  return new InlineKeyboard()
    .text(mark("all", "Every wallet — recommended"), `cs:sel:${chainKey}:all`)
    .row()
    .text(mark("derived", "Only generated wallets"), `cs:sel:${chainKey}:derived`)
    .row()
    .text(mark("imported", "Only imported wallets"), `cs:sel:${chainKey}:imported`)
    .row()
    .text("‹ Back", "cs:start");
}

export function renderWalletChoice(step: NetworkStep, current: string): string {
  return [
    `🚀 <b>Set up copy-mint</b> · ${esc(step.name)}`,
    ``,
    `<b>Step 2 of 3 — which wallets buy?</b>`,
    ``,
    `You have <b>${step.wallets.total}</b> wallets in total.`,
    ``,
    `<i>Currently set to “${esc(current)}”. If your money is in wallets you imported ` +
      `yourself, the generated set will never touch it — pick the first option and it ` +
      `stops mattering which is which.</i>`,
  ].join("\n");
}

/**
 * The readiness sheet: what is true, what is missing, and what to send.
 *
 * The amount is spelled out rather than described. "Fund your wallets" is the
 * instruction that produced a bot with no gas on two of three networks; a
 * number, a destination and a button is the instruction that gets followed.
 */
export function renderReadiness(step: NetworkStep, selector: string, copyOn: boolean): string {
  const w = step.wallets;
  const short = Math.max(0, Math.min(SUGGESTED, w.matched) - w.funded);
  const needed = step.minFundedWei * BigInt(short);

  const lines = [
    `🚀 <b>Set up copy-mint</b> · ${esc(step.name)}`,
    ``,
    `<b>Step 3 of 3 — get it ready</b>`,
    ``,
  ];

  if (!step.read) {
    lines.push(
      `⚠️ <b>${esc(step.name)} could not be reached just now</b>`,
      ``,
      `Balances there are unknown — which is not the same as empty. Try again in a moment.`
    );
    return lines.join("\n");
  }

  lines.push(
    `${tick(w.matched > 0)} <b>Buying with</b> — ${w.matched} of your ${w.total} wallets`,
    `${tick(w.funded > 0)} <b>Have gas on ${esc(step.name)}</b> — ${w.funded} of those ${w.matched}`,
    `${tick(copyOn)} <b>Copy-mint switched on</b>`,
    ``
  );

  if (w.funded > 0) {
    lines.push(
      `🟢 <b>${w.funded} ${w.funded === 1 ? "wallet can" : "wallets can"} pay on ${esc(step.name)}.</b>`,
      ``
    );
  }

  // The remaining work, in order, each as one instruction.
  const todo: string[] = [];
  if (w.matched === 0) {
    todo.push(`Pick a wallet set that exists — none of your wallets match “${esc(selector)}”.`);
  }
  if (w.funded === 0 && w.matched > 0) {
    todo.push(
      `Send gas. Each wallet needs <b>${eth(step.minFundedWei)} ${esc(step.symbol)}</b>. ` +
        `For ${Math.min(SUGGESTED, w.matched)} wallets that is about ` +
        `<b>${eth(needed)} ${esc(step.symbol)}</b> in total.`
    );
  } else if (short > 0) {
    todo.push(
      `Top up the rest. ${short} more ${short === 1 ? "wallet needs" : "wallets need"} ` +
        `<b>${eth(step.minFundedWei)} ${esc(step.symbol)}</b> each — about ` +
        `<b>${eth(needed)} ${esc(step.symbol)}</b>.`
    );
  }
  if (!copyOn) todo.push(`Switch copy-mint on.`);

  if (todo.length > 0) {
    lines.push(`<b>Still to do</b>`);
    todo.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    lines.push(``);
  }

  lines.push(
    `<i>Your funding wallet holds ${eth(step.funderWei)} ${esc(step.symbol)} on ${esc(step.name)}.</i>`
  );

  if (w.funded > 0 && todo.length === 0) {
    lines.push(
      ``,
      `<i>Mints on your other networks are still spotted and reported. They are only bought ` +
        `where wallets are funded, so setting one up never costs you the others.</i>`
    );
  }

  return lines.join("\n");
}

export function readinessKeyboard(step: NetworkStep, copyOn: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const w = step.wallets;

  if (w.funded < Math.min(SUGGESTED, w.matched) || w.funded === 0) {
    keyboard.text(`💸 Send gas on ${step.name}`, "m:fund").row();
  }
  if (!copyOn) keyboard.text("🟢 Switch copy-mint on", "c:on").row();

  return keyboard
    .text("↻ Check again", `cs:chain:${step.key}`)
    .text("👛 Change wallets", `cs:wallets:${step.key}`)
    .row()
    .text("‹ Networks", "cs:start")
    .text("Done", "m:copy");
}
