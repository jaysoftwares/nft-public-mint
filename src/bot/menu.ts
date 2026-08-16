// Button-driven navigation.
//
// Typing `/mint 0x3ae17a… 1 derived+funded wait` works and stays supported, but
// it is a poor primary interface: it demands the operator remember argument
// order and selector syntax while a stage is opening. Buttons carry the state
// instead.
//
// Anything that cannot be a button — a contract address, an ETH amount — is
// collected as a short flow: the bot asks, the next message answers, and the
// flow advances. Flows are per chat and expire, so an abandoned one never
// silently swallows a later message.
//
// Telegram caps callback data at 64 bytes, so the encoding is terse: a prefix
// for the kind, a colon, and the payload.

import { InlineKeyboard } from "grammy";

export type FlowKind = "mint" | "fcfs" | "fund" | "watch" | "sweep" | "check";

export interface Flow {
  kind: FlowKind;
  /** What the flow is currently waiting for. */
  step: "contract" | "amount" | "address" | "ready";
  contract?: string;
  quantity?: number;
  selector?: string;
  amount?: string;
  tier?: string;
  waitForOpen?: boolean;
  startedAt: number;
}

const FLOW_TTL_MS = 10 * 60_000;
const flows = new Map<number, Flow>();

export function startFlow(chatId: number, kind: FlowKind, step: Flow["step"]): Flow {
  const flow: Flow = { kind, step, startedAt: Date.now() };
  flows.set(chatId, flow);
  return flow;
}

export function getFlow(chatId: number): Flow | undefined {
  const flow = flows.get(chatId);
  if (!flow) return undefined;
  // An abandoned flow must not capture a message typed ten minutes later.
  if (Date.now() - flow.startedAt > FLOW_TTL_MS) {
    flows.delete(chatId);
    return undefined;
  }
  return flow;
}

export function clearFlow(chatId: number): void {
  flows.delete(chatId);
}

// ── Keyboards ─────────────────────────────────────────────────────────

export function mainMenu(copyOn: boolean, watching: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("💰 Mint", "m:mint")
    .text("👁 Copy-mint", "m:copy")
    .row()
    .text("👛 Wallets", "m:wallets")
    .text("💸 Money", "m:money")
    .row()
    .text("📊 Status", "a:status")
    .text(copyOn ? `🟢 Copy ON (${watching})` : "🔴 Copy OFF", "m:copy")
    .row()
    .text("❔ Command help", "a:help");
}

export function mintMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎯 Public mint", "i:mint")
    .row()
    .text("🔥 FCFS via OpenSea", "i:fcfs")
    .row()
    .text("🔎 Probe a drop", "i:check")
    .row()
    .text("‹ Back", "m:main");
}

export function walletsMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 List", "a:wallets")
    .text("💵 Balances", "a:balances")
    .row()
    .text("➕ Generate 10", "g:10")
    .text("➕ Generate 100", "g:100")
    .row()
    .text("➕ Generate 500", "g:500")
    .row()
    .text("‹ Back", "m:main");
}

export function moneyMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⛽ Fund wallets", "i:fund")
    .row()
    .text("🧹 Sweep NFTs → vault", "i:sweep")
    .row()
    .text("📈 Spend caps", "a:caps")
    .row()
    .text("‹ Back", "m:main");
}

export function copyMenu(copyOn: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(copyOn ? "🛑 Turn OFF" : "▶️ Turn ON", copyOn ? "c:off" : "c:on")
    .row()
    .text("🎯 Watched targets", "a:targets")
    .row()
    .text("➕ Watch a wallet", "i:watch")
    .row()
    .text("📈 Spend caps", "a:caps")
    .row()
    .text("‹ Back", "m:main");
}

/** Quantities people actually mint, plus a way out. */
export function quantityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", "q:1")
    .text("2", "q:2")
    .text("3", "q:3")
    .text("5", "q:5")
    .row()
    .text("10", "q:10")
    .text("25", "q:25")
    .text("50", "q:50")
    .row()
    .text("✕ Cancel", "x");
}

/**
 * Wallet-set choices, expressed as outcomes rather than selector syntax.
 *
 * The underlying selectors still exist and can be typed; these are the sets
 * worth having one tap away.
 */
export function selectorKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("All funded", "w:derived+funded")
    .row()
    .text("First 3", "w:0-2")
    .text("First 10", "w:0-9")
    .row()
    .text("First 50", "w:0-49")
    .text("First 500", "w:0-499")
    .row()
    .text("Imported only", "w:imported")
    .row()
    .text("✕ Cancel", "x");
}

export function tierKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔥 High", "t:high")
    .text("● Med", "t:med")
    .text("· Low", "t:low")
    .row()
    .text("✕ Cancel", "x");
}

export function amountKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("0.001", "v:0.001")
    .text("0.002", "v:0.002")
    .row()
    .text("0.005", "v:0.005")
    .text("0.01", "v:0.01")
    .row()
    .text("✕ Cancel", "x");
}

/**
 * The last gate before anything spends.
 *
 * Deliberately a separate tap on its own row, with the cost stated in the
 * message above it — an accidental press should not be able to cost money.
 */
export function confirmKeyboard(label = "Fire"): InlineKeyboard {
  return new InlineKeyboard()
    .text(`✅ ${label}`, "go")
    .row()
    .text("⏳ Wait for stage open", "go:wait")
    .row()
    .text("✕ Cancel", "x");
}

export function simpleConfirm(label = "Confirm"): InlineKeyboard {
  return new InlineKeyboard().text(`✅ ${label}`, "go").row().text("✕ Cancel", "x");
}

export function backTo(target: string, label = "‹ Back"): InlineKeyboard {
  return new InlineKeyboard().text(label, target);
}

/** Human summary of a flow, shown above the confirm buttons. */
export function describeFlow(flow: Flow): string {
  const rows: string[] = [];
  if (flow.contract) rows.push(`contract  <code>${flow.contract}</code>`);
  if (flow.quantity !== undefined) rows.push(`quantity  ${flow.quantity}`);
  if (flow.selector) rows.push(`wallets   <code>${flow.selector}</code>`);
  if (flow.amount) rows.push(`amount    ${flow.amount} ETH each`);
  if (flow.tier) rows.push(`tier      ${flow.tier}`);
  return rows.join("\n");
}
