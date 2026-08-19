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

export type FlowKind =
  | "mint"
  | "fcfs"
  | "fund"
  | "watch"
  | "sweep"
  | "check"
  | "drain"
  | "destination"
  | "importWallet"
  | "restore";

export interface Flow {
  kind: FlowKind;
  /** What the flow is currently waiting for. */
  step: "contract" | "amount" | "address" | "secret" | "chain" | "ready";
  contract?: string;
  quantity?: number;
  selector?: string;
  /**
   * Which chain this flow acts on.
   *
   * Only the flows with no contract to infer it from need this. Everything else
   * detects the chain from the contract, which is why the field is optional.
   */
  chain?: string;
  amount?: string;
  tier?: string;
  mintMode?: string;
  payer?: string;
  importCount?: number;
  address?: string;
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
    // Its own full-width row at the top: it is the screen that answers "where
    // do things stand?", which is what most sessions open with.
    .text("📊 Dashboard", "a:dash")
    .row()
    .text("💰 Mint", "m:mint")
    .text("👁 Copy-mint", "m:copy")
    .row()
    .text("👛 Wallets", "m:wallets")
    .text("💸 Money", "m:money")
    .row()
    .text("🩺 Status", "a:status")
    .text(copyOn ? `🟢 Copy ON (${watching})` : "🔴 Copy OFF", "m:copy")
    .row()
    .text("⚙️ Settings", "cfg:menu")
    .row()
    .text("❔ Command help", "a:help");
}

/**
 * Under the dashboard.
 *
 * Refresh is first because the card is a snapshot and the balances behind it
 * cache for a few seconds; the rest are the places its numbers lead to, so a
 * figure that looks wrong is one tap from the screen that can change it.
 */
export function dashboardMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("↻ Refresh", "a:dash:refresh")
    .row()
    .text("👛 Wallets", "m:wallets")
    .text("💸 Money", "m:money")
    .row()
    .text("👁 Copy-mint", "m:copy")
    .row()
    .text("‹ Back", "m:main");
}

export function settingsMenu(duringSetup = false): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎯 Change NFT vault", "cfg:destination")
    .row()
    .text("‹ Back", duringSetup ? "s:cancel" : "m:main");
}

export function destinationConfirm(address: string, duringSetup = false): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Save NFT vault", `cfg:save:${address}`)
    .row()
    .text("✕ Cancel", duringSetup ? "cfg:menu" : "m:main");
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
    .text("💵 Funded only", "a:balances")
    .row()
    .text("📄 Export all as CSV", "a:csv")
    .row()
    .text("➕ Generate 10", "g:10")
    .text("➕ Generate 100", "g:100")
    .row()
    .text("➕ Generate 500", "g:500")
    .row()
    .text("🔑 Import wallet", "im:menu")
    .row()
    .text("⚡ Auto-fire", "m:autofire")
    .row()
    .text("‹ Back", "m:main");
}

export function walletImportMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔑 Private key", "im:key")
    .row()
    .text("🌱 Seed phrase · first account", "im:seed:1")
    .row()
    .text("🌱 Seed phrase · first 10", "im:seed:10")
    .row()
    .text("‹ Back", "m:wallets");
}

/**
 * Auto-fire is the switch that lets copy signals spend without a confirmation,
 * so the two sets are offered separately: the derived wallets are disposable,
 * the imported ones hold real value and are manual-only until said otherwise.
 */
export function autoFireMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ On — derived", "f:derived:on")
    .text("🛑 Off — derived", "f:derived:off")
    .row()
    .text("✅ On — imported", "f:imported:on")
    .text("🛑 Off — imported", "f:imported:off")
    .row()
    .text("📋 Who's armed?", "a:autofire")
    .row()
    .text("‹ Back", "m:wallets");
}

export function moneyMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⛽ Fund wallets", "i:fund")
    .row()
    .text("🧹 Sweep NFTs → vault", "i:sweep")
    .row()
    .text("💧 Reclaim ETH → funder", "i:drain")
    .row()
    .text("📈 Spend caps", "a:caps")
    .row()
    .text("‹ Back", "m:main");
}

/**
 * Page through a wallet list 25 at a time.
 *
 * The selector rides in the callback data so a page tap is stateless — no flow
 * to expire between pages. Telegram's 64-byte cap is the reason it is truncated
 * rather than passed whole; anything longer is a typed command, not a button.
 */
export function walletsPager(offset: number, shown: number, total: number, selector: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const key = selector.slice(0, 40);
  if (offset > 0) keyboard.text("‹ Prev", `wp:${Math.max(0, offset - 25)}:${key}`);
  if (offset + shown < total) keyboard.text("Next ›", `wp:${offset + shown}:${key}`);
  return keyboard.row().text("📄 Export all as CSV", "a:csv").row().text("‹ Back", "m:wallets");
}

/** Per-target filters plus removal, without asking users to retype addresses. */
export function targetsKeyboard(
  entries: { address: string; label?: string; mintMode: string; payer: string }[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const entry of entries.slice(0, 10)) {
    const name = entry.label || `${entry.address.slice(0, 6)}…${entry.address.slice(-4)}`;
    keyboard
      .text(entry.mintMode === "free" ? "✅ Free" : "Free", `tf:free:${entry.address}`)
      .text(entry.mintMode === "paid" ? "✅ Paid" : "Paid", `tf:paid:${entry.address}`)
      .text(entry.mintMode === "both" ? "✅ Both" : "Both", `tf:both:${entry.address}`)
      .row();
    // Which transactions count as this target minting. A vault never sends its
    // own mints, so "self" would watch it forever and copy nothing.
    keyboard
      .text(entry.payer === "self" ? "✅ Own tx" : "Own tx", `tp:self:${entry.address}`)
      .text(entry.payer === "any" ? "✅ Any payer" : "Any payer", `tp:any:${entry.address}`)
      .row();
    keyboard.text(`✕ ${name}`, `uw:${entry.address}`).row();
  }
  return keyboard.text("➕ Watch a wallet", "i:watch").row().text("‹ Back", "m:copy");
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

/**
 * Which chain does this act on?
 *
 * Asked only where there is no contract to infer it from — funding and
 * draining. Those used to fall through to the configured default silently,
 * which meant money moved on whichever chain `config.chain` happened to name
 * rather than the one the operator had in mind. A funder holding 0.0317 ETH on
 * Robinhood and nothing on Base produced exactly the failure you would expect,
 * with no indication that the chain was the reason.
 *
 * The balance rides on the button because it is the fact that settles the
 * choice: a chain with nothing on it is visibly not the one you meant.
 */
export function chainKeyboard(
  chains: { key: string; name: string; balanceLabel?: string }[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const chain of chains) {
    const label = chain.balanceLabel ? `${chain.name} — ${chain.balanceLabel}` : chain.name;
    keyboard.text(label, `ch:${chain.key}`).row();
  }
  return keyboard.text("✕ Cancel", "x");
}

export function tierKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔥 High", "t:high")
    .text("● Med", "t:med")
    .text("· Low", "t:low")
    .row()
    .text("✕ Cancel", "x");
}

export function mintModeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🆓 Free only", "pm:free")
    .row()
    .text("💳 Paid only", "pm:paid")
    .row()
    .text("🔀 Free + paid", "pm:both")
    .row()
    .text("✕ Cancel", "x");
}

/**
 * Whose transaction counts as this target minting.
 *
 * Asked on every new watch rather than defaulted, because the two answers suit
 * opposite kinds of address and getting it wrong is silent: a hot wallet set to
 * "any payer" will copy anything anyone airdrops at it, and a vault set to
 * "own tx" will sit there watching and never fire once.
 */
export function payerKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👤 Only what it sends itself", "pa:self")
    .row()
    .text("🏦 Anything minted to it (vault)", "pa:any")
    .row()
    .text("✕ Cancel", "x");
}

/**
 * Common top-up targets, plus a way to say something else.
 *
 * The presets cover the amounts a disposable minting wallet actually needs, but
 * they are a shortcut, not the whole range — a drop priced outside them left no
 * way through the buttons at all. Typing an amount always worked; nothing
 * advertised it, which made it the same as not existing.
 */
export function amountKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("0.0005", "v:0.0005")
    .text("0.001", "v:0.001")
    .row()
    .text("0.002", "v:0.002")
    .text("0.005", "v:0.005")
    .row()
    .text("0.01", "v:0.01")
    .row()
    .text("✏️ Custom amount", "v:custom")
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

// ── First-run setup ───────────────────────────────────────────────────
//
// Before a wallet store exists the bot has nothing to operate on, so it boots
// into a mode where these are the only buttons that do anything. The point is
// that the recovery phrase is shown to the *owner*, in their own chat, rather
// than to whoever happens to be holding the server's SSH session.

export function setupMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔐 Create wallet store", "s:warn")
    .row()
    .text("♻️ Restore existing seed", "s:restore")
    .row()
    .text("⚙️ Your settings", "cfg:menu")
    .row()
    .text("❔ What is this?", "s:explain");
}

export function setupConfirm(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Show me the phrase", "s:create")
    .row()
    .text("✕ Not now", "s:cancel");
}

/**
 * The phrase is on screen when this is shown. Tapping deletes the message that
 * carries it — the one mitigation available for a secret that has already been
 * through Telegram's servers.
 */
export function phraseWritten(): InlineKeyboard {
  return new InlineKeyboard().text("✅ Written down — delete this message", "s:burn");
}

export function afterSetupMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Generate 500 wallets", "g:500")
    .row()
    .text("➕ Generate 10", "g:10")
    .text("➕ Generate 100", "g:100")
    .row()
    .text("📊 Dashboard", "a:dash")
    .row()
    .text("☰ Main menu", "m:main");
}

/** Human summary of a flow, shown above the confirm buttons. */
export function describeFlow(flow: Flow, chainName?: string): string {
  const rows: string[] = [];
  if (flow.contract) rows.push(`contract  <code>${flow.contract}</code>`);
  // Stated on every confirmation, because with several chains live the network
  // is part of what is being agreed to, not background.
  if (chainName) rows.push(`network   <b>${chainName}</b>`);
  if (flow.quantity !== undefined) rows.push(`quantity  ${flow.quantity}`);
  if (flow.selector) rows.push(`wallets   <code>${flow.selector}</code>`);
  if (flow.amount) rows.push(`amount    ${flow.amount} ETH each`);
  if (flow.tier) rows.push(`tier      ${flow.tier}`);
  return rows.join("\n");
}
