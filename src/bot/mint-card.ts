// The mint screen.
//
// Everything a mint needs used to be an argument: `/mint 0x3ae17a… 1
// derived+funded wait`, remembered in the right order while a stage was
// opening. Scheduling was the same command with a time bolted on, and neither
// could answer the question the operator actually has — *which of my wallets
// can mint this?* — because the eligibility check lived in a third command
// whose output was a tag you then had to type back in.
//
// This is one card instead. It carries the drop, every stage either the chain
// or OpenSea can see, a verdict per wallet against the stage that is armed, and
// the two buttons that spend money. The state lives in the draft; this file
// only draws it and hands back keyboards, so what is on screen is a pure
// function of the draft and can be tested without a network or a chat.
//
// Two things shape the layout and are worth stating. Five hundred wallets do
// not fit in an inline keyboard, so the picker pages and filters rather than
// listing. And a message caps at 4,096 characters, so per-wallet detail is a
// summary here and a CSV afterwards.

import { InlineKeyboard } from "grammy";
import {
  MintStage,
  Eligibility,
  StageState,
  stageState,
  canFire,
  paginate,
  summariseSelection,
  SelectionSummary,
} from "../core/mint-plan";
import { EligibilityRow } from "../core/allowlist";
import { esc, eth, short } from "./ui";
import { untilText, whenText } from "../core/schedule";

/** Wallets shown per page of the picker. Ten rows plus five of chrome fits. */
export const WALLETS_PER_PAGE = 10;

/** Above this the card stops listing wallets by name and counts them instead. */
const WALLET_LINES_ON_CARD = 8;

/**
 * Imported first, and everywhere.
 *
 * A whitelist is granted to an address somebody already owns, so the wallet
 * that can mint a gated drop is one they import — that is the ordinary case and
 * the card is built around it. The generated set exists so a few hundred
 * addresses can be made at once for the copy-mint engine; it is bulk plumbing,
 * not the way a person mints a drop they were allowlisted for. Leading the
 * picker with five hundred disposable addresses buried the one wallet that
 * mattered behind fifty pages.
 */
export type WalletFilter = "imported" | "funded" | "eligible" | "all" | "derived";

export const WALLET_FILTERS: WalletFilter[] = [
  "imported",
  "funded",
  "eligible",
  "all",
  "derived",
];

/** The filters offered as buttons, in the order they are worth reaching for. */
const FILTER_BUTTONS: { filter: WalletFilter; label: string }[] = [
  { filter: "imported", label: "🔑 Imported" },
  { filter: "funded", label: "💰 Funded" },
  { filter: "eligible", label: "✅ Eligible" },
  { filter: "all", label: "All" },
];

/**
 * Which slice of the wallets a fresh card should open on.
 *
 * The imported set if there is one, because that is what a person was
 * whitelisted with. Otherwise whatever holds money, and failing that
 * everything — a card that opens on an empty list teaches nothing.
 */
export function defaultFilter(wallets: CardWallet[]): WalletFilter {
  if (wallets.some((w) => w.kind === "imported")) return "imported";
  if (wallets.some((w) => (w.balanceWei ?? 0n) > 0n)) return "funded";
  return "all";
}

/**
 * What a fresh card should already have ticked.
 *
 * A handful of imported wallets is the whole selection somebody meant — they
 * imported them to mint with — so ticking them saves a step that has no other
 * possible answer. A large set is left alone: pre-ticking twenty addresses
 * puts a number on the ⚡ button that nobody chose.
 */
export function initialSelection(wallets: CardWallet[]): string[] {
  const imported = wallets.filter((w) => w.kind === "imported");
  return imported.length > 0 && imported.length <= WALLETS_PER_PAGE
    ? imported.map((w) => w.id)
    : [];
}

export type CardView = "main" | "wallets" | "quantity" | "stages" | "schedule";

export interface CardWallet {
  id: string;
  address: string;
  kind: "derived" | "imported";
  label?: string;
  /** Absent means "not read yet", which is not the same as empty. */
  balanceWei?: bigint;
}

export interface MintDraft {
  chatId: number;
  messageId: number;
  contract: string;
  chainKey: string;
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  slug?: string;
  collection?: string;
  totalSupply?: string;
  maxSupply?: string;
  stages: MintStage[];
  /** Which stage the buttons act on. */
  stageKey?: string;
  quantity: number;
  /** Wallet ids, in the order they were picked. */
  selected: string[];
  wallets: CardWallet[];
  /** wallet id → stage key → verdict. Absent means never asked. */
  verdicts: Record<string, Record<string, Eligibility>>;
  /** Merkle proofs by wallet id, when a SeaDrop allowlist resolved. */
  proofs?: Record<string, EligibilityRow>;
  filter: WalletFilter;
  page: number;
  view: CardView;
  notes: string[];
  /**
   * Rises on every user action that invalidates an in-flight probe.
   *
   * A probe writes its results only if the draft's sequence still matches the
   * one it started with. Without it, an eligibility check begun against the
   * presale lands after the operator has switched to public and repaints the
   * card with verdicts about a stage nobody is looking at.
   */
  seq: number;
  probing: boolean;
  /** Gas the executor will reserve per wallet, for the honest total. */
  gasReserveWei: bigint;
  createdAt: number;
}

// ── Reading the draft ─────────────────────────────────────────────────────

export function activeStage(draft: MintDraft): MintStage | undefined {
  return draft.stages.find((s) => s.key === draft.stageKey) ?? draft.stages[0];
}

export function verdictFor(
  draft: MintDraft,
  walletId: string,
  stageKey: string | undefined
): Eligibility | undefined {
  if (!stageKey) return undefined;
  return draft.verdicts[walletId]?.[stageKey];
}

export function setVerdict(
  draft: MintDraft,
  walletId: string,
  stageKey: string,
  verdict: Eligibility
): void {
  (draft.verdicts[walletId] ??= {})[stageKey] = verdict;
}

export function selectedWallets(draft: MintDraft): CardWallet[] {
  const byId = new Map(draft.wallets.map((w) => [w.id, w]));
  return draft.selected.map((id) => byId.get(id)).filter((w): w is CardWallet => w !== undefined);
}

/** Price × quantity for one wallet, at the armed stage. */
export function valuePerWallet(draft: MintDraft): bigint {
  const stage = activeStage(draft);
  return (stage?.priceWei ?? 0n) * BigInt(draft.quantity);
}

/**
 * Mint plus the gas reservation, per wallet.
 *
 * Only the price multiplies by the quantity: one transaction mints the whole
 * lot, so multiplying the gas too inflates the estimate by the gas of every NFT
 * after the first — which is the easy mistake and the one that makes a card
 * quote a number nobody is charged.
 */
export function requiredPerWallet(draft: MintDraft): bigint {
  return valuePerWallet(draft) + draft.gasReserveWei;
}

export function selectionSummary(draft: MintDraft): SelectionSummary {
  const stageKey = activeStage(draft)?.key;
  const wallets = selectedWallets(draft);
  const verdicts = new Map(wallets.map((w) => [w.id, verdictFor(draft, w.id, stageKey)]));
  return summariseSelection(wallets, verdicts, requiredPerWallet(draft));
}

/** The wallets the picker is currently showing, before paging. */
export function filteredWallets(draft: MintDraft): CardWallet[] {
  const stageKey = activeStage(draft)?.key;
  const required = requiredPerWallet(draft);
  switch (draft.filter) {
    case "funded":
      return draft.wallets.filter((w) => w.balanceWei !== undefined && w.balanceWei >= required);
    case "eligible":
      return draft.wallets.filter((w) => canFire(verdictFor(draft, w.id, stageKey)));
    case "derived":
      return draft.wallets.filter((w) => w.kind === "derived");
    case "imported":
      return draft.wallets.filter((w) => w.kind === "imported");
    default:
      return draft.wallets;
  }
}

// ── Words ─────────────────────────────────────────────────────────────────

export function badge(verdict: Eligibility | undefined): string {
  switch (verdict) {
    case "eligible":
      return "✅";
    case "ineligible":
      return "❌";
    case "minted_out":
      return "🚫";
    case "underfunded":
      return "💸";
    case "restricted":
      return "⛔";
    case "checking":
      return "⏳";
    default:
      return "·";
  }
}

export function verdictWords(verdict: Eligibility | undefined): string {
  switch (verdict) {
    case "eligible":
      return "eligible";
    case "ineligible":
      return "not on the list";
    case "minted_out":
      return "sold out";
    case "underfunded":
      // OpenSea's own reckoning, not ours — it checks the minter's balance
      // before it will build a transaction, so this is the marketplace
      // refusing rather than the card's arithmetic.
      return "can't cover the mint";
    case "restricted":
      return "address barred by OpenSea";
    case "checking":
      return "checking…";
    case "unknown":
      return "unknown until it opens";
    default:
      return "not checked";
  }
}

function stateBadge(state: StageState): string {
  return state === "live" ? "🟢" : state === "upcoming" ? "⏳" : "✕";
}

export function stageLine(stage: MintStage, now: number): string {
  const state = stageState(stage, now);
  const price = stage.priceWei === 0n ? "free" : `${eth(stage.priceWei)} ETH`;
  const when =
    state === "live"
      ? "open now"
      : state === "upcoming" && stage.startsAt !== undefined
        ? `opens ${whenText(stage.startsAt)} · in ${untilText(stage.startsAt - now)}`
        : state === "ended"
          ? "closed"
          : "timing not published";
  const cap = stage.perWallet !== undefined && stage.perWallet > 0 ? ` · max ${stage.perWallet}` : "";
  return `${stateBadge(state)} <b>${esc(stage.label)}</b> — ${price}${cap}\n     ${esc(when)}`;
}

function walletName(wallet: CardWallet): string {
  return wallet.label?.trim() ? `${wallet.label.trim()} ${short(wallet.address)}` : wallet.id;
}

// ── The card ──────────────────────────────────────────────────────────────

/**
 * Everything on screen, as one string.
 *
 * Sections in the order the decision is made: what this is, who can mint it,
 * when, what it costs and what happens when the button is pressed. The cost
 * line spells out the multiplication because a per-wallet price and a
 * five-hundred-wallet total look identical until the money has moved.
 */
export function renderMintCard(draft: MintDraft, now = Date.now()): string {
  const stage = activeStage(draft);
  const summary = selectionSummary(draft);
  const selected = selectedWallets(draft);
  const stageKey = stage?.key;

  const supply =
    draft.totalSupply !== undefined && draft.maxSupply !== undefined
      ? `${draft.totalSupply} / ${draft.maxSupply} minted`
      : draft.maxSupply !== undefined
        ? `${draft.maxSupply} supply`
        : draft.totalSupply !== undefined
          ? `${draft.totalSupply} minted so far`
          : undefined;

  const head = [
    `🎨 <b>${esc(draft.collection ?? "Unnamed collection")}</b>`,
    `<code>${esc(draft.contract)}</code>`,
    `network <b>${esc(draft.chainName)}</b>${draft.slug ? ` · <code>${esc(draft.slug)}</code>` : ""}`,
    supply ? `supply  ${esc(supply)}` : ``,
  ].filter(Boolean);

  // ── Wallets ──
  const imported = draft.wallets.filter((w) => w.kind === "imported").length;

  const walletBlock = (): string[] => {
    if (draft.wallets.length === 0) {
      return [
        `👛 <b>Wallets</b>`,
        `<i>No wallets yet. Tap 👛 Wallets → 🔑 Import to add the wallet you</i>`,
        `<i>are whitelisted with, and mint from it.</i>`,
      ];
    }

    const counted = `${selected.length} of ${draft.wallets.length} picked`;

    // While the picker is open the card is the picker's own legend: what the
    // filter is showing, where in the list you are, and what the badges mean.
    // Without it the rows are ticked against a list whose extent is invisible.
    if (draft.view === "wallets") {
      const shown = paginate(filteredWallets(draft), draft.page, WALLETS_PER_PAGE);
      const all = new Map(
        draft.wallets.map((w) => [w.id, verdictFor(draft, w.id, stageKey)] as const)
      );
      const across = summariseSelection(draft.wallets, all, requiredPerWallet(draft));
      return [
        `👛 <b>Pick wallets</b>  ${counted}`,
        `showing <b>${esc(draft.filter)}</b> · ` +
          (shown.total === 0
            ? `nothing matches`
            : `${shown.offset + 1}–${Math.min(shown.offset + shown.pageSize, shown.total)} of ${shown.total}`),
        `✅ ${across.eligible} eligible · ❌ ${across.refused} refused · ` +
          `${across.unknown} not checked`,
        imported === 0
          ? `<i>Whitelisted on another wallet? Tap 🔑 Import — it is the wallet the</i>\n` +
            `<i>allowlist was granted to that can mint, not a freshly made one.</i>`
          : `<i>Tap a row to tick it. ⚠ marks a wallet holding less than the ` +
            `${eth(requiredPerWallet(draft))} ${esc(draft.nativeSymbol)} this mint needs.</i>`,
      ];
    }

    if (selected.length === 0) {
      return [
        `👛 <b>Wallets</b>  <i>none of ${draft.wallets.length} picked</i>`,
        imported === 0
          ? `<i>Tap 👛 Wallets → 🔑 Import to add the wallet you are whitelisted</i>\n` +
            `<i>with. Anything already here can mint a public stage.</i>`
          : `<i>Tap 👛 Wallets to choose which ones mint — the picker marks</i>\n` +
            `<i>the eligible and the funded, and imports another.</i>`,
      ];
    }

    const lines: string[] = [`👛 <b>Wallets</b>  ${counted}`];
    if (selected.length <= WALLET_LINES_ON_CARD) {
      for (const wallet of selected) {
        const verdict = verdictFor(draft, wallet.id, stageKey);
        const balance =
          wallet.balanceWei === undefined ? "" : ` · ${eth(wallet.balanceWei)} ${draft.nativeSymbol}`;
        lines.push(
          `${badge(verdict)} <code>${esc(walletName(wallet))}</code>${esc(balance)}` +
            (verdict && verdict !== "eligible" ? ` — <i>${esc(verdictWords(verdict))}</i>` : "")
        );
      }
    } else {
      lines.push(
        `✅ ${summary.eligible} eligible · ❌ ${summary.refused} refused · ` +
          `${summary.unknown} not checked`
      );
    }
    if (summary.short > 0) {
      lines.push(
        `💸 ${summary.short} of them ${summary.short === 1 ? "holds" : "hold"} less than the ` +
          `${eth(summary.requiredPerWalletWei)} ${esc(draft.nativeSymbol)} needed`
      );
    }
    return lines;
  };

  // ── Stages ──
  const stageBlock = (): string[] => {
    if (draft.stages.length === 0) {
      return [
        `📅 <b>Stages</b>`,
        `<i>Nothing readable yet — neither a SeaDrop stage on the contract nor an</i>`,
        `<i>OpenSea drop. You can still book it; the runner reads again at T-0.</i>`,
      ];
    }
    return [`📅 <b>Stages</b>`, ...draft.stages.map((s) => stageLine(s, now))];
  };

  // ── Cost ──
  const costBlock = (): string[] => {
    if (!stage) return [];
    const per = valuePerWallet(draft);
    const lines = [
      `💰 <b>Cost</b>`,
      stage.priceWei === 0n
        ? `free × ${draft.quantity} — you pay gas and nothing else`
        : `${eth(stage.priceWei)} × ${draft.quantity} = ${eth(per)} ${draft.nativeSymbol} per wallet`,
    ];
    if (selected.length > 0) {
      lines.push(
        `<b>at most ${eth(summary.totalWei)} ${draft.nativeSymbol}</b> ` +
          `<i>(mint + gas, ${selected.length} wallet${selected.length === 1 ? "" : "s"})</i>`
      );
    }
    return lines;
  };

  // ── Status ──
  const status = (): string => {
    // Said first while the drop is still being read, or the card claims there
    // is nothing to mint for the two seconds before the chain answers.
    if (draft.probing && draft.stages.length === 0) {
      return `⏳ Reading the drop — stages, allowlist and OpenSea.`;
    }
    if (draft.wallets.length === 0) return `👛 Import or generate a wallet first.`;
    // Checked before anything about wallets or timing, because it is the one
    // condition on this card that reverts every transaction at once: a stage
    // that caps a wallet at one refuses a request for two, and the whole set
    // pays gas to be told so.
    if (stage?.perWallet !== undefined && stage.perWallet > 0 && draft.quantity > stage.perWallet) {
      return (
        `⚠️ <b>${esc(stage.label)}</b> allows ${stage.perWallet} per wallet and the amount is ` +
        `${draft.quantity}. Lower it, or every wallet reverts and pays gas for the privilege.`
      );
    }
    if (selected.length === 0) return `👛 Pick the wallets that should mint.`;
    if (!stage) return `⏳ No stage to arm yet — book it and the runner reads again at T-0.`;
    const state = stageState(stage, now);
    if (state === "ended") return `✕ <b>${esc(stage.label)}</b> has closed. Pick another stage.`;
    if (draft.probing) return `⏳ Checking eligibility — ${summary.eligible} clear so far.`;
    if (summary.eligible === 0 && summary.unknown === 0) {
      return `❌ None of the picked wallets can mint <b>${esc(stage.label)}</b>.`;
    }
    if (state === "upcoming") {
      const opensIn = stage.startsAt !== undefined ? ` · fires in ${untilText(stage.startsAt - now)}` : "";
      return `⏳ <b>${esc(stage.label)}</b> has not opened${esc(opensIn)}. Mint now holds until it does.`;
    }
    return `🟢 <b>${esc(stage.label)}</b> is open — Mint now fires immediately.`;
  };

  // Blocks joined by a blank line, and an empty block contributes neither the
  // block nor its separator — otherwise a contract with no readable stage
  // renders a gap where the cost would have been.
  const blocks: string[][] = [head, walletBlock(), stageBlock(), costBlock(), [status()]];
  if (draft.notes.length > 0) {
    blocks.push(draft.notes.slice(0, 3).map((note) => `⚠️ <i>${esc(note)}</i>`));
  }
  return blocks
    .filter((block) => block.length > 0)
    .map((block) => block.join("\n"))
    .join("\n\n");
}

// ── Keyboards ─────────────────────────────────────────────────────────────

/**
 * The main keyboard.
 *
 * Configuration on top, the two spending buttons in the middle on rows of their
 * own — an accidental press must not be able to cost money — and everything
 * else below. "Mint now" stays present even when no wallet is eligible; it
 * refuses with a reason rather than vanishing, because a button that disappears
 * teaches nothing about why.
 */
export function mintCardKeyboard(draft: MintDraft, now = Date.now()): InlineKeyboard {
  switch (draft.view) {
    case "wallets":
      return walletPickerKeyboard(draft);
    case "quantity":
      return quantityPickerKeyboard(draft);
    case "stages":
      return stagePickerKeyboard(draft, now);
    case "schedule":
      return schedulePickerKeyboard(draft, now);
    default:
      break;
  }

  const stage = activeStage(draft);
  const keyboard = new InlineKeyboard()
    .text(`🎫 Amount: ${draft.quantity}`, "mc:qty")
    .text(`👛 Wallets: ${draft.selected.length}`, "mc:w")
    .row();

  if (draft.stages.length > 1) {
    keyboard.text(`🎟 Stage: ${stage ? stage.label.slice(0, 20) : "—"}`, "mc:stage").row();
  }

  keyboard.text("⚡ Mint now", "mc:fire").row();
  keyboard.text("⏰ Schedule it", "mc:sched").row();
  keyboard.text("🔄 Re-check eligibility", "mc:recheck").row();
  keyboard.text("✕ Close", "mc:close");
  return keyboard;
}

/**
 * The wallet picker.
 *
 * A checkbox per wallet, ten to a page, each row carrying the two facts that
 * decide the tick: whether it can mint this stage, and whether it can pay for
 * it. Import sits at the top rather than buried at the bottom, because adding
 * the wallet an allowlist was granted to is the ordinary way to mint a gated
 * drop — not an afterthought once the existing list has disappointed. The
 * filter row and the bulk row are there for the generated set, which can run to
 * hundreds and is bulk plumbing rather than the way a person mints.
 */
export function walletPickerKeyboard(draft: MintDraft): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const stageKey = activeStage(draft)?.key;
  const required = requiredPerWallet(draft);
  const list = filteredWallets(draft);
  const view = paginate(list, draft.page, WALLETS_PER_PAGE);
  const imported = draft.wallets.filter((w) => w.kind === "imported").length;

  // Full width and first when there is nothing imported: at that point it is
  // the only button on this screen that can make a gated drop mintable.
  if (imported === 0) {
    keyboard.text("🔑 Import the wallet you're whitelisted with", "im:menu").row();
  }

  for (const { filter, label } of FILTER_BUTTONS) {
    keyboard.text(draft.filter === filter ? `● ${label}` : label, `mc:w:f:${filter}`);
  }
  keyboard.row();

  if (view.items.length === 0) {
    keyboard
      .text(
        draft.filter === "imported"
          ? "— nothing imported yet, tap 🔑 below —"
          : draft.filter === "eligible"
            ? "— nothing confirmed eligible yet —"
            : "— no wallets match this filter —",
        "mc:w:f:all"
      )
      .row();
  }

  for (const wallet of view.items) {
    const on = draft.selected.includes(wallet.id);
    const verdict = verdictFor(draft, wallet.id, stageKey);
    const money =
      wallet.balanceWei === undefined
        ? "?"
        : wallet.balanceWei >= required
          ? eth(wallet.balanceWei)
          : `${eth(wallet.balanceWei)}⚠`;
    keyboard
      .text(
        `${on ? "☑" : "☐"} ${wallet.id} ${badge(verdict)} ${short(wallet.address)} · ${money}`,
        `mc:w:t:${wallet.id}`
      )
      .row();
  }

  if (view.hasPrev || view.hasNext) {
    if (view.hasPrev) keyboard.text("‹ Prev", `mc:w:p:${Math.max(0, view.offset - WALLETS_PER_PAGE)}`);
    keyboard.text(
      `${view.offset + 1}–${Math.min(view.offset + view.pageSize, view.total)} of ${view.total}`,
      "mc:noop"
    );
    if (view.hasNext) keyboard.text("Next ›", `mc:w:p:${view.offset + WALLETS_PER_PAGE}`);
    keyboard.row();
  }

  keyboard
    .text("✅ All eligible", "mc:w:all:eligible")
    .text("💰 All funded", "mc:w:all:funded")
    .row()
    .text("☑ This page", "mc:w:all:page")
    .text("🧹 Clear", "mc:w:none")
    .row()
    .text("🔍 Check this page", "mc:w:check")
    .row();
  if (imported > 0) keyboard.text("🔑 Import another wallet", "im:menu").row();
  keyboard.text(`✓ Done — ${draft.selected.length} picked`, "mc:back");
  return keyboard;
}

export function quantityPickerKeyboard(draft: MintDraft): InlineKeyboard {
  const stage = activeStage(draft);
  const cap = stage?.perWallet;
  const presets = [1, 2, 3, 5, 10, 25, 50].filter((n) => cap === undefined || cap <= 0 || n <= cap);
  const keyboard = new InlineKeyboard();
  const star = (n: number): string => (draft.quantity === n ? `★ ${n}` : String(n));
  presets.slice(0, 4).forEach((n) => keyboard.text(star(n), `mc:qty:${n}`));
  keyboard.row();
  presets.slice(4).forEach((n) => keyboard.text(star(n), `mc:qty:${n}`));
  if (presets.length > 4) keyboard.row();
  return keyboard.text("✏️ Type a number", "mc:qty:custom").row().text("‹ Back", "mc:back");
}

export function stagePickerKeyboard(draft: MintDraft, now = Date.now()): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const stage of draft.stages) {
    const state = stageState(stage, now);
    const chosen = stage.key === draft.stageKey ? "★ " : "";
    const price = stage.priceWei === 0n ? "free" : `${eth(stage.priceWei)}`;
    keyboard
      .text(`${chosen}${stateBadge(state)} ${stage.label.slice(0, 24)} · ${price}`, `mc:stage:${stage.key}`)
      .row();
  }
  return keyboard.text("‹ Back", "mc:back");
}

/**
 * When to fire.
 *
 * Every stage that has not opened gets a one-tap button carrying its own
 * announced start, because that is the time somebody means and typing it out
 * introduces a chance to get it wrong. The relative presets are for the drop
 * whose time you were told in a group chat and the contract has not published.
 */
export function schedulePickerKeyboard(draft: MintDraft, now = Date.now()): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const upcoming = draft.stages
    .filter((s) => stageState(s, now) === "upcoming" && s.startsAt !== undefined)
    .sort((a, b) => (a.startsAt as number) - (b.startsAt as number))
    .slice(0, 3);

  for (const stage of upcoming) {
    keyboard
      .text(
        `⏰ ${stage.label.slice(0, 22)} · in ${untilText((stage.startsAt as number) - now)}`,
        `mc:sched:stage:${stage.key}`
      )
      .row();
  }

  keyboard
    .text("in 5m", "mc:sched:in 5m")
    .text("in 15m", "mc:sched:in 15m")
    .text("in 1h", "mc:sched:in 1h")
    .row()
    .text("in 6h", "mc:sched:in 6h")
    .text("in 12h", "mc:sched:in 12h")
    .text("in 24h", "mc:sched:in 24h")
    .row()
    .text("✏️ Type a time", "mc:sched:custom")
    .row()
    .text("‹ Back", "mc:back");
  return keyboard;
}

/** Shown when a card is opened without a contract to point it at. */
export function mintPromptKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("‹ Back", "m:mint");
}
