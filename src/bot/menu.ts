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
  | "schedule"
  /**
   * The one short answer the mint card cannot collect with a button: a
   * contract to point at, a quantity outside the presets, or a firing time.
   * The card owns the rest of the state; this flow only carries the question.
   */
  | "mintCard"
  | "fund"
  | "watch"
  | "sweep"
  | "check"
  | "drain"
  | "destination"
  | "importWallet"
  | "restore"
  | "cap"
  | "targetWallets"
  | "targetPrice";

export interface Flow {
  kind: FlowKind;
  /** What the flow is currently waiting for. */
  step: "contract" | "amount" | "address" | "secret" | "chain" | "time" | "ready";
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
  /** Which spend cap a "cap" flow is collecting an amount for. */
  capKind?: "event" | "max" | "daily";
  importCount?: number;
  address?: string;
  waitForOpen?: boolean;
  /** Raw text of a scheduled mint's firing time, as typed, before parsing. */
  when?: string;
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

export function settingsMenu(duringSetup = false, autoSweepOn = true): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("🎯 Change NFT vault", "cfg:destination").row();
  // Not during setup. Someone who has not yet confirmed a vault has nothing to
  // sweep into, and a switch for a destination that does not exist is a
  // question they cannot answer.
  if (!duringSetup) {
    keyboard.text(`🤖 Auto-sweep: ${autoSweepOn ? "ON" : "OFF"}`, "a:autosweep").row();
    keyboard.text("⛽ Mint gas", "a:gas").row();
  }
  return keyboard.text("‹ Back", duringSetup ? "s:cancel" : "m:main");
}

/**
 * The tip this bot bids, chosen rather than typed.
 *
 * Presets, because the realistic way this number goes wrong is a misplaced
 * decimal at the worst possible moment, and because the useful range is narrow
 * enough to fit on one screen. The current value is ticked so the question
 * "what am I bidding?" is answered without a tap.
 */
export function gasMenu(currentGwei: string, autoPrice: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const presets = ["0.05", "0.25", "0.5", "1"];
  const current = Number(currentGwei);
  presets.forEach((value, index) => {
    const mark = Number(value) === current ? "✓ " : "";
    keyboard.text(`${mark}${value} gwei`, `gas:set:${value}`);
    if (index % 2 === 1) keyboard.row();
  });
  if (presets.length % 2 === 1) keyboard.row();
  return keyboard
    .text(`📈 Auto-price: ${autoPrice ? "ON" : "OFF"}`, autoPrice ? "gas:auto:off" : "gas:auto:on")
    .row()
    .text("‹ Back", "cfg:menu");
}

export function destinationConfirm(address: string, duringSetup = false): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Save NFT vault", `cfg:save:${address}`)
    .row()
    .text("✕ Cancel", duringSetup ? "cfg:menu" : "m:main");
}

/**
 * One way in, not three.
 *
 * This used to offer "Public mint", "FCFS via OpenSea" and "Schedule a mint" as
 * separate paths, which asked the operator to know — before pasting a link —
 * which machinery the drop needed and whether any of their wallets was on its
 * list. The card answers all three from the contract itself: it reads every
 * stage, marks the wallets that can mint each one, and carries both the fire
 * button and the booking. The old paths still work as typed commands.
 */
export function mintMenu(scheduled = 0): InlineKeyboard {
  return new InlineKeyboard()
    .text("💎 Mint a drop", "mc:new")
    .row()
    // Labelled with the count because a booking made yesterday is invisible
    // otherwise — which is how a scheduled mint gets forgotten and fires as a
    // surprise.
    .text(scheduled > 0 ? `📅 Booked (${scheduled})` : "📅 Booked mints", "a:scheduled")
    .row()
    .text("🔎 Probe a drop", "i:check")
    .row()
    .text("‹ Back", "m:main");
}

/**
 * The buttons under a booking that is waiting to fire.
 *
 * Cancel is the whole point: a mint agreed to yesterday for a drop that turned
 * out to be a rug has to be stoppable from a phone, and hunting for an id to
 * type is not stopping it.
 */
export function scheduledKeyboard(ids: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const id of ids.slice(0, 8)) {
    keyboard.text(`✕ Cancel ${id}`, `sch:cancel:${id}`).row();
  }
  return keyboard.text("⏰ Schedule another", "i:schedule").row().text("‹ Back", "m:mint");
}

/** Shown under the details card, before anything is committed to. */
export function scheduleConfirm(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Book it", "sch:go")
    .row()
    .text("✕ Cancel", "sch:drop");
}

/** Times people actually mint at, relative to now, plus a way to type one. */
export function scheduleTimeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("in 5m", "st:in 5m")
    .text("in 15m", "st:in 15m")
    .text("in 1h", "st:in 1h")
    .row()
    .text("in 6h", "st:in 6h")
    .text("in 12h", "st:in 12h")
    .text("in 24h", "st:in 24h")
    .row()
    .text("✕ Cancel", "x");
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

/**
 * `back` is where the operator came from.
 *
 * Importing is reached from two places that mean different things: the wallets
 * screen, where it is housekeeping, and the mint card's picker, where it is the
 * middle of a decision about a drop that is opening. Sending the second one
 * back to a wallet menu loses the drop.
 */
export function walletImportMenu(back = "m:wallets"): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔑 Private key", "im:key")
    .row()
    .text("🌱 Seed phrase · first account", "im:seed:1")
    .row()
    .text("🌱 Seed phrase · first 10", "im:seed:10")
    .row()
    .text("‹ Back", back);
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

/**
 * The caps screen, now editable.
 *
 * These bound what the bot spends with nobody watching, and they used to be
 * config.json only — which on a hosted bot meant unreachable by the person
 * whose money it is. The read-only screen above stays the point of the page;
 * these just make the numbers on it changeable by whoever they bind.
 */
export function capsMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ Max price per wallet", "cap:max")
    .row()
    .text("✏️ Per event", "cap:event")
    .text("✏️ Daily", "cap:daily")
    .row()
    .text("👛 Which wallets fire", "sel:menu")
    .row()
    .text("‹ Back", "m:copy");
}

/**
 * Amounts that suit each cap, since they differ by an order of magnitude.
 *
 * The max price is per wallet per mint, the per-event cap covers one whole
 * signal across the set, and the daily is the rolling total — offering the same
 * ladder for all three would make two of them useless.
 */
export function capAmountKeyboard(kind: "event" | "max" | "daily"): InlineKeyboard {
  const presets: Record<typeof kind, string[]> = {
    max: ["0.005", "0.01", "0.02", "0.05"],
    event: ["0.05", "0.1", "0.25", "0.5"],
    daily: ["0.25", "0.5", "1", "2"],
  };
  const keyboard = new InlineKeyboard();
  const values = presets[kind];
  keyboard.text(values[0], `cv:${kind}:${values[0]}`).text(values[1], `cv:${kind}:${values[1]}`).row();
  keyboard.text(values[2], `cv:${kind}:${values[2]}`).text(values[3], `cv:${kind}:${values[3]}`).row();
  return keyboard.text("✏️ Type an amount", `cv:${kind}:custom`).row().text("✕ Cancel", "a:caps");
}

/**
 * Which wallets a copy signal may spend from.
 *
 * Expressed as outcomes rather than selector syntax, because the failure this
 * prevents is silent: a set whose money sits in imported wallets, with a
 * selector naming only the derived ones, watches every signal go by and fires
 * on none of them.
 */
export function walletSelectorMenu(current: string): InlineKeyboard {
  const mark = (selector: string, label: string): string =>
    current === selector ? `✅ ${label}` : label;
  return new InlineKeyboard()
    .text(mark("all", "Every wallet — recommended"), "sel:all")
    .row()
    .text(mark("derived", "Generated wallets only"), "sel:derived")
    .row()
    .text(mark("imported", "Imported wallets only"), "sel:imported")
    .row()
    .text("‹ Back", "a:caps");
}

export function moneyMenu(autoSweepOn: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text("⛽ Fund wallets", "i:fund")
    .row()
    // Above the sweep, because it answers the question the sweep silently
    // assumed: is there anything in the wallets to move?
    .text("🔎 What NFTs do I hold?", "a:nfts")
    .row()
    .text("🧹 Sweep NFTs → vault", "i:sweep")
    .row()
    // Directly under the manual sweep, where somebody who has just done it by
    // hand is looking, and labelled with its state so the screen answers "is
    // this already happening?" without a tap.
    .text(`🤖 Auto-sweep: ${autoSweepOn ? "ON" : "OFF"}`, "a:autosweep")
    .row()
    .text("💧 Reclaim ETH → funder", "i:drain")
    .row()
    .text("📈 Spend caps", "a:caps")
    .row()
    .text("‹ Back", "m:main");
}

/** The one-tap switch behind the auto-sweep screen. */
export function autoSweepMenu(on: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(on ? "🛑 Turn OFF" : "▶️ Turn ON", on ? "as:off" : "as:on")
    .row()
    .text("🎯 Change NFT vault", "cfg:destination")
    .row()
    .text("‹ Back", "m:money");
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

/**
 * The watch list, one row per target.
 *
 * Every setting used to live on this screen, three rows deep per address, which
 * made ten targets thirty rows of buttons with no way to tell which belonged to
 * what. Each address now opens its own page instead.
 */
export function targetsKeyboard(entries: { address: string; label?: string }[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const entry of entries.slice(0, 12)) {
    const name = entry.label || `${entry.address.slice(0, 8)}…${entry.address.slice(-6)}`;
    keyboard.text(`🎯 ${name}`, `tg:${entry.address}`).row();
  }
  return keyboard.text("➕ Watch a wallet", "i:watch").row().text("‹ Back", "m:copy");
}

/**
 * One target's page: every rule that decides whether its mints get copied.
 *
 * Wallets-per-fire and the price ceiling are per target rather than shared,
 * because both answers are really "how much do I trust this address", and three
 * tiers plus one global ceiling in a config file could not express that — least
 * of all from a phone.
 */
export function targetDetailKeyboard(entry: {
  address: string;
  mintMode: string;
  payer: string;
}): InlineKeyboard {
  const a = entry.address;
  return new InlineKeyboard()
    .text("🔎 What does it mint?", `tq:${a}`)
    .row()
    .text(entry.mintMode === "free" ? "✅ Free" : "Free", `tf:free:${a}`)
    .text(entry.mintMode === "paid" ? "✅ Paid" : "Paid", `tf:paid:${a}`)
    .text(entry.mintMode === "both" ? "✅ Both" : "Both", `tf:both:${a}`)
    .row()
    .text(entry.payer === "self" ? "✅ Own tx" : "Own tx", `tp:self:${a}`)
    .text(entry.payer === "any" ? "✅ Any payer" : "Any payer", `tp:any:${a}`)
    .row()
    .text("✏️ Wallets per fire", `tw:${a}`)
    .row()
    .text("✏️ Price limit", `tpr:${a}`)
    .row()
    .text("✕ Stop watching", `uw:${a}`)
    .row()
    .text("‹ All targets", "a:targets");
}

/** How many wallets fire for this target. "Tier" hands it back to the shared number. */
export function targetWalletsKeyboard(address: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", `twv:1:${address}`)
    .text("3", `twv:3:${address}`)
    .text("5", `twv:5:${address}`)
    .row()
    .text("10", `twv:10:${address}`)
    .text("25", `twv:25:${address}`)
    .text("50", `twv:50:${address}`)
    .row()
    .text("100", `twv:100:${address}`)
    .text("250", `twv:250:${address}`)
    .text("500", `twv:500:${address}`)
    .row()
    .text("✏️ Type a number", `twv:custom:${address}`)
    .row()
    .text("↺ Use the tier's number", `twv:tier:${address}`)
    .row()
    .text("‹ Back", `tg:${address}`);
}

/** This target's own price ceiling. "Global" hands it back to caps.maxPriceEth. */
export function targetPriceKeyboard(address: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("0.005", `tpv:0.005:${address}`)
    .text("0.01", `tpv:0.01:${address}`)
    .row()
    .text("0.02", `tpv:0.02:${address}`)
    .text("0.05", `tpv:0.05:${address}`)
    .row()
    .text("0.1", `tpv:0.1:${address}`)
    .text("0.25", `tpv:0.25:${address}`)
    .row()
    .text("✏️ Type an amount", `tpv:custom:${address}`)
    .row()
    .text("↺ Use the global cap", `tpv:global:${address}`)
    .row()
    .text("‹ Back", `tg:${address}`);
}

export function copyMenu(copyOn: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(copyOn ? "🛑 Turn OFF" : "▶️ Turn ON", copyOn ? "c:off" : "c:on")
    .row()
    // First, because it is the only screen that walks all four requirements.
    // Everything below it changes one setting in isolation, which is how a
    // set-up ends up complete on every screen and unable to buy on any network.
    .text("🚀 Set up copy-mint", "cs:start")
    .row()
    .text("🩺 Why isn't it buying?", "a:why")
    .row()
    .text("📜 Mints spotted", "a:signals")
    .row()
    .text("🎯 Wallets I follow", "a:targets")
    .row()
    .text("➕ Follow a wallet", "i:watch")
    .row()
    .text("💷 Spending limits", "a:caps")
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

/**
 * Which of their mints to follow.
 *
 * This setting has now been wrong in both directions, so the wording carries
 * the history. "Free only" led here once, read like the cautious choice, was
 * picked for all nineteen wallets, and silently disabled the product — every
 * drop that cost money went past unbought. The fix was to lead with "any mint",
 * which then did the opposite: the bot spent real ETH on drops nobody had
 * looked at.
 *
 * Free-only leads again because that is the operator's standing instruction,
 * but it is no longer presented as the safe default with the consequence
 * hidden. Each option says what it will cost or miss, and every skip now lands
 * in the journal behind /why, so "it is watching and buying nothing" is a
 * question with an answer rather than a silence.
 *
 * The price ceiling, not this setting, is what actually bounds spending.
 */
export function mintModeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Only free mints  ·  current policy", "pm:free")
    .row()
    .text("💳 Any mint they make (will spend, up to your price cap)", "pm:both")
    .row()
    .text("💳 Only paid ones (ignores free drops)", "pm:paid")
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
