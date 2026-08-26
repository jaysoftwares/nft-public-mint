// Telegram bot entry point.
//
// Every private Telegram chat is an isolated user: config, encrypted seed,
// wallets, ledger and targets live under that chat's own state directory.
//
// The passphrase is never a chat command — it comes from the environment or the
// console at boot.

import { Bot, InputFile, Context, InlineKeyboard } from "grammy";
import { isAddress, getAddress, parseEther, ZeroAddress } from "ethers";
import { AsyncLocalStorage } from "node:async_hooks";
import { config as loadEnv } from "dotenv";
import {
  loadConfig,
  writeDefaultConfig,
  writeConfigIfMissing,
  updateUserSettings,
  chainOverrideFrom,
  withoutKeywordPairs,
  BotConfig,
  ResolvedConfig,
  ConfigError,
} from "../core/config";
import { storedUserChatIds, userStateDir, withStateDir } from "../core/paths";
import { deriveUserPassphrase } from "../core/user-key";
import { Session, ChainContext } from "./session";
import { ManagedWallet } from "../core/wallet-store";
import {
  readImportBlob,
  initNew,
  initFromMnemonic,
  importEntriesFromMnemonic,
  storeExists,
} from "../core/wallet-store";
import { ensureUserFundingWallet } from "./user-wallet";
import {
  resolve as resolveWallets,
  resolveForAutoFire,
  withoutProtected,
  summarise,
  SelectorError,
} from "../core/tags";
import { gasReservation, shortfalls } from "../core/balances";
import {
  planFunding,
  executeFunding,
  planEthSweep,
  executeEthSweep,
  parseFundAmount,
  TRANSFER_GAS,
} from "../core/funding";
import { discoverMintedHoldings, sweepNfts, MintSite } from "../core/holdings";
import { explainRejection } from "../core/dispatcher";
import { collectionName } from "../core/collection-name";
import { executePublicMint, MintEvent, MintReport } from "../core/mint-public";
import { entries as ledgerEntries, spentSince } from "../core/ledger";
import { collectDashboard, ChainReading } from "../core/dashboard";
import { probeTarget, assessMint } from "../core/target-probe";
import * as targets from "../core/targets";
import { CopyEvent } from "../core/copy-mint";
import { renderCopyResult } from "./copy-report";
import {
  fetchAllowListRoot,
  findAllowListUri,
  toHttpUrl,
  parseAllowList,
  checkEligibility,
  eligibilityTag,
  EligibilityReport,
  ZERO_ROOT,
  AllowListError,
} from "../core/allowlist";
import { executeAllowListMint, AllowListEvent, AllowListMintReport } from "../core/mint-allowlist";
import { fetchSigners } from "../core/signed-mint";
import {
  slugForContract,
  openSeaChainSlug,
  fetchDrop,
  probeIssuance,
  stageIsLive,
  describeStage,
  OpenSeaApiError,
} from "../core/opensea-api";
import { resolveCollectionInput } from "../core/collection-input";
import { rpcCall } from "../core/rpc";
import {
  executeOpenSeaMint,
  OpenSeaMintEvent,
  OpenSeaMintReport,
} from "../core/mint-opensea";
import { diagnose, overallState, Finding, ChainReadiness, Severity } from "../core/diagnosis";
import {
  tallySkips,
  recentSignals,
  summarise as summariseJournal,
} from "../core/copy-journal";
import { StatusCard, esc, eth, bar, short, clamp, toCsv, txLink } from "./ui";
import { renderHealth, healthMenu, renderSignals, signalsMenu } from "./health";
import {
  NetworkStep,
  networkKeyboard,
  renderNetworkChoice,
  walletChoiceKeyboard,
  renderWalletChoice,
  renderReadiness,
  readinessKeyboard,
} from "./setup-copy";
import { BOT_COMMANDS } from "./commands";
import { renderDashboard } from "./dashboard";
import {
  buildDashboardSvg,
  renderDashboardPng,
  TargetRow,
  WalletRow,
} from "./dashboard-image";
import { feedFor, clearFeed, contractLabel } from "./copy-feed";
import { askPassphrase } from "../tools/tty";
import {
  Flow,
  startFlow,
  getFlow,
  clearFlow,
  mainMenu,
  dashboardMenu,
  mintMenu,
  walletsMenu,
  walletImportMenu,
  moneyMenu,
  copyMenu,
  quantityKeyboard,
  selectorKeyboard,
  tierKeyboard,
  mintModeKeyboard,
  payerKeyboard,
  capsMenu,
  capAmountKeyboard,
  walletSelectorMenu,
  targetDetailKeyboard,
  targetWalletsKeyboard,
  targetPriceKeyboard,
  amountKeyboard,
  chainKeyboard,
  confirmKeyboard,
  simpleConfirm,
  backTo,
  describeFlow,
  autoFireMenu,
  walletsPager,
  targetsKeyboard,
  setupMenu,
  setupConfirm,
  phraseWritten,
  afterSetupMenu,
  settingsMenu,
  destinationConfirm,
} from "./menu";

loadEnv();

let session: Session;
let config: ResolvedConfig;

interface UserRuntime {
  chatId: number;
  stateDir: string;
  config: ResolvedConfig;
  passphrase: string;
  session?: Session;
}

/**
 * Ceiling on a hand-typed funding target, per wallet.
 *
 * Funding tops every selected wallet *up to* this balance, so the figure is
 * multiplied by the size of the set — 500 wallets makes a misplaced decimal a
 * three-order-of-magnitude mistake. The preset buttons top out at 0.01, so this
 * leaves ample room for a genuinely expensive drop while still catching the
 * fat-finger. Typed commands are unaffected; this guards the button flow, where
 * there is no argument to re-read before it runs.
 */
const MAX_FUND_PER_WALLET_WEI = parseEther("0.5");

const runtimeContext = new AsyncLocalStorage<UserRuntime>();
const runtimePromises = new Map<number, Promise<UserRuntime>>();
let bootstrapConfig: ResolvedConfig;
let masterPassphrase: string;

function currentRuntime(): UserRuntime {
  const runtime = runtimeContext.getStore();
  if (!runtime) throw new Error("No Telegram user runtime is active.");
  return runtime;
}

function contextual<T extends object>(target: () => T): T {
  return new Proxy({} as T, {
    get(_unused, property) {
      const value = Reflect.get(target(), property);
      return typeof value === "function" ? value.bind(target()) : value;
    },
    set(_unused, property, value) {
      return Reflect.set(target(), property, value);
    },
  });
}

config = contextual(() => currentRuntime().config);
session = contextual(() => {
  const active = currentRuntime().session;
  if (!active) throw new Error("This user has not created a wallet store yet.");
  return active;
});

function isReady(): boolean {
  return currentRuntime().session !== undefined;
}

function initialUserConfig(): BotConfig {
  return {
    chain: bootstrapConfig.chain,
    // A zero destination is a non-spendable setup sentinel. Wallet creation is
    // blocked until the user confirms a real NFT vault in Settings.
    vault: ZeroAddress,
    funder: ZeroAddress,
    hotSetSize: bootstrapConfig.hotSetSize,
    reconcileBatch: bootstrapConfig.reconcileBatch,
    gas: { ...bootstrapConfig.gas },
    caps: { ...bootstrapConfig.caps },
    copy: {
      ...bootstrapConfig.copy,
      enabled: false,
      tiers: { ...bootstrapConfig.copy.tiers },
    },
    signed: {
      ...bootstrapConfig.signed,
      api: {
        ...bootstrapConfig.signed.api,
        headers: { ...bootstrapConfig.signed.api.headers },
      },
      siwe: { ...bootstrapConfig.signed.siwe },
    },
    rpc: {
      read: [...bootstrapConfig.rpc.read],
      send: [...bootstrapConfig.rpc.send],
    },
  };
}

function userPassphrase(chatId: number): string {
  return deriveUserPassphrase(masterPassphrase, chatId);
}

async function createUserRuntime(chatId: number): Promise<UserRuntime> {
  const dir = userStateDir(chatId);
  return withStateDir(dir, async () => {
    writeConfigIfMissing(initialUserConfig());
    const runtime: UserRuntime = {
      chatId,
      stateDir: dir,
      config: loadConfig(),
      passphrase: userPassphrase(chatId),
    };
    return runtimeContext.run(runtime, async () => {
      if (storeExists()) await startSession();
      return runtime;
    });
  });
}

function userRuntime(chatId: number): Promise<UserRuntime> {
  const existing = runtimePromises.get(chatId);
  if (existing) return existing;
  const creating = createUserRuntime(chatId).catch((err) => {
    runtimePromises.delete(chatId);
    throw err;
  });
  runtimePromises.set(chatId, creating);
  return creating;
}

async function runForUser(ctx: Context, next: () => Promise<void>): Promise<void> {
  const chat = ctx.chat;
  if (!chat) return;
  if (chat.type !== "private") {
    await ctx.reply("Use this bot in a private chat so wallets cannot be shared by a group.");
    return;
  }
  const pending = userRuntime(chat.id);
  const runtime = await pending;
  try {
    await withStateDir(runtime.stateDir, () => runtimeContext.run(runtime, next));
  } finally {
    // Setup-only visitors have no timers or live resources. Reload their tiny
    // config on the next message instead of retaining an unbounded public-user
    // cache. A created Session stays resident for background automation.
    if (!runtime.session && runtimePromises.get(chat.id) === pending) {
      runtimePromises.delete(chat.id);
    }
  }
}

async function resumeStoredUsers(): Promise<void> {
  const ids = storedUserChatIds();
  for (let offset = 0; offset < ids.length; offset += 3) {
    const batch = ids.slice(offset, offset + 3);
    await Promise.all(
      batch.map((chatId) =>
        userRuntime(chatId).catch((err) => {
          console.error(`  chat ${chatId}: could not resume — ${(err as Error).message}`);
        })
      )
    );
  }
  if (ids.length > 0) console.log(`  Resumed ${ids.length} stored user session(s).`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Arguments a button flow has assembled, standing in for a typed command line.
 *
 * Set immediately before invoking a command handler and cleared straight after,
 * so the button UI reuses the command implementations verbatim rather than
 * duplicating them. One code path, two front ends.
 */
const argOverrides = new Map<number, string[]>();

function args(ctx: Context): string[] {
  const chatId = ctx.chat?.id;
  if (chatId !== undefined) {
    const override = argOverrides.get(chatId);
    if (override) return override;
  }
  const text = (ctx.message?.text ?? "").trim();
  return text.split(/\s+/).slice(1);
}

async function runWithArgs(
  ctx: Context,
  list: string[],
  handler: (ctx: Context) => Promise<void>
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  argOverrides.set(chatId, list);
  try {
    await handler(ctx);
  } finally {
    argOverrides.delete(chatId);
  }
}

/**
 * Resolve a selector to wallets.
 *
 * `chainKey` undefined means "no chain was named" — balances then come from
 * every chain at once rather than from a configured favourite, so `funded`
 * means funded somewhere. Only callers that move money pass a real key, and
 * those obtain it by asking or by detecting it from a contract.
 */
async function select(
  selector: string,
  ctx: Context,
  chainKey: string | undefined,
  force = false
): Promise<ManagedWallet[] | null> {
  try {
    const tagCtx =
      chainKey === undefined
        ? await session.tagContextAnyChain(force)
        : await session.tagContext(chainKey, force);
    const matched = resolveWallets(selector, session.wallets(), tagCtx);
    if (matched.length === 0) {
      await ctx.reply(`No wallets match <code>${esc(selector)}</code>.`, { parse_mode: "HTML" });
      return null;
    }
    return matched;
  } catch (err) {
    if (err instanceof SelectorError) {
      await ctx.reply(esc(err.message));
      return null;
    }
    throw err;
  }
}

function fail(ctx: Context, err: unknown): Promise<unknown> {
  const message = err instanceof Error ? err.message : String(err);
  return ctx.reply(`⚠️ ${esc(message)}`, { parse_mode: "HTML" });
}

/**
 * Which chain does this command mean?
 *
 * All configured chains are live at once, so there is nothing to switch. The
 * chain is worked out from the contract — whichever one has code at that
 * address — and an explicit `on <chain>` overrides it. That covers the
 * CREATE2 case where the same address is deployed on several chains, and the
 * case where the command takes no contract at all.
 */
async function chainFor(ctx: Context, contract?: string): Promise<ChainContext> {
  const parts = args(ctx);
  const override = chainOverrideFrom(parts);
  if (override) return session.chain(override);
  if (contract && isAddress(contract)) {
    // Detection is authoritative: the chain with code at that address is the
    // chain the contract is on. It is not a default — it is an answer.
    return (await session.detectChain(contract)).chain;
  }

  // Nothing to detect from. This used to return the configured chain, which
  // reads as a decision the operator made and is not one: with three chains
  // live, a fund whose funder held nothing on the configured chain failed for
  // a reason nothing on screen mentioned. Commands that reach here must say
  // which chain they mean.
  throw new Error(
    `This command needs a chain. Add <code>on ${session.availableChains
      .map((c) => c.key)
      .join("</code> / <code>on ")}</code>, or run it from the menu, which asks.`
  );
}

// ── Commands ──────────────────────────────────────────────────────────────

const HELP = `<b>Copymint</b>

<b>Wallets</b>
/dashboard — wallets, funding, copies and spend on one card
/status — set overview, balances, nonce health
/wallets [selector] — list matching wallets
/wallets csv — every wallet, tag and balance as a file
/generate &lt;n&gt; — derive n more wallets
/import — securely prompt for a private key or seed phrase
/autofire &lt;selector&gt; on|off — autonomous firing per wallet
/tag &lt;selector&gt; &lt;tag&gt; · /untag &lt;selector&gt; &lt;tag&gt;

<b>Money</b>
/fund &lt;selector&gt; &lt;eth&gt; — top wallets up to a target balance
/sweep [selector] [contract] — move NFTs to the vault, leave gas
/drain [selector] — send ETH back to the funder, leave nothing

<b>Minting</b>
/mint &lt;contract&gt; &lt;qty&gt; [selector] [wait] — public SeaDrop mint
/check &lt;contract&gt; [listUrl] — who's on the allowlist
/allowlist &lt;contract&gt; &lt;qty&gt; [selector] [wait] — FCFS allowlist mint

<b>FCFS via OpenSea</b> <i>(needs OPENSEA_API_KEY)</i>
/probe &lt;contract&gt; — stages, and what OpenSea will issue now
/fcfs &lt;contract&gt; &lt;qty&gt; [selector] [at HH:MM] — allowlist/signed/public,
whichever you're eligible for. Times are UTC.

<b>Copy-mint</b>
/watch &lt;address&gt; [high|med|low] [both|free|paid] [self|any] [label] — copy their mints
  <code>both</code> is the default and what you almost always want.
  <code>free</code> and <code>paid</code> narrow it, and will silently ignore everything else.
  <code>self</code> copies only what the address sends itself (default).
  <code>any</code> also copies mints someone else paid for and credited to it —
  what you need when the address is a vault that never mints directly.
/unwatch &lt;address&gt; · /targets — manage the watch list
/copy on|off — autonomous firing kill switch
/setup — guided set-up: pick a network, get told what to fund
/why — why nothing is being bought, and how to fix it
/signals — every mint spotted, and what came of each
/caps — spend limits and today's usage

<b>Settings</b>
/settings — change your NFT vault

<b>Selectors</b>
<code>all</code> <code>derived</code> <code>imported</code> <code>funded</code> <code>stuck</code> <code>autofire</code> <code>manual</code>
<code>0-99</code> index range · <code>0x…</code> address · <code>+</code> and · <code>,</code> or · <code>!</code> not

Your funding wallet is created automatically and kept out of autonomous minting.`;

/**
 * The dashboard, as a single card.
 *
 * Balances are the expensive part — five hundred wallets across three chains is
 * fifteen hundred reads through a rate-limited provider — so opening the card
 * uses the session's short-lived balance cache and only ↻ forces a fresh read
 * from chain. The card is sent before those reads finish and edited in place
 * when they land, because a tap that shows nothing for ten seconds reads as a
 * bot that has stopped.
 */
/**
 * The caption under the picture.
 *
 * Short on purpose. Anything that needs reading twice belongs on the "Why?"
 * screen, and Telegram truncates a caption over 1024 characters without saying
 * so — a verdict that gets cut in half is worse than no verdict.
 */
function blockerCaption(findings: Finding[], state: Severity): string {
  const blockers = findings.filter((f) => f.severity === "blocking");
  if (blockers.length === 0) {
    return state === "limiting"
      ? `🟡 <b>Running, with some mints skipped.</b> Tap Copy-mint → Why? for the details.`
      : `🟢 <b>Set up correctly.</b>`;
  }
  const first = blockers[0];
  return clamp(
    [
      `🔴 <b>${esc(first.title)}</b>`,
      first.fix ? `→ ${esc(first.fix)}` : "",
      blockers.length > 1
        ? `
<i>and ${blockers.length - 1} more — tap Copy-mint → Why?</i>`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  ).slice(0, 1000);
}

async function cmdDashboard(ctx: Context, force = false): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const loading = [
    `📊 <b>Dashboard</b>`,
    ``,
    `<i>reading ${session.wallets().length} wallet balances on ` +
      `${session.availableChains.length} chain(s)…</i>`,
  ].join("\n");

  // A button tap rewrites the message it came from; a typed command opens one.
  let messageId: number;
  if (ctx.callbackQuery?.message) {
    messageId = ctx.callbackQuery.message.message_id;
    // Editing to identical text is an error, which a double-tap on ↻ produces.
    await ctx.editMessageText(loading, { parse_mode: "HTML" }).catch(() => undefined);
  } else {
    const sent = await ctx.reply(loading, { parse_mode: "HTML" });
    messageId = sent.message_id;
  }

  const minFundedWei = gasReservation(config.gasLimit, config.maxFeePerGas);
  const chains: ChainReading[] = await Promise.all(
    session.availableChains.map(async (chain) => {
      const row: ChainReading = {
        key: chain.key,
        name: chain.name,
        symbol: chain.profile.nativeSymbol,
        minFundedWei,
      };
      try {
        return { ...row, balances: await session.balances(chain.key, force) };
      } catch {
        // One chain refusing to answer must not blank the card. It is reported
        // as unread — which is not the same claim as "these wallets are empty".
        return row;
      }
    })
  );

  // The same health check the "Why?" screen runs, so the two can never
  // disagree about whether the bot is working — which they would, eventually,
  // if the card worked its own verdict out separately.
  const findings = await currentFindings();
  const state = overallState(findings);
  const stats = collectDashboard({
    wallets: session.wallets(),
    funder: config.funder,
    chains,
    ledger: ledgerEntries(),
    targets: targets.list(),
    copyEnabled: session.copyEnabled,
    capDailyWei: config.capDailyWei,
  });

  const text = clamp(renderDashboard(stats, findings, state));

  // The picture first, the words as the safety net.
  //
  // Rasterising is a native dependency and a font away from failing, and on a
  // machine with neither this must still answer the question — so any throw
  // falls through to the text card rather than leaving the operator looking at
  // "reading balances…" forever.
  try {
    const readiness = await currentReadiness();
    const holdings = await walletRows();
    const png = await renderDashboardPng(
      buildDashboardSvg({
        stats,
        findings,
        state,
        chains: readiness,
        symbols: Object.fromEntries(
          session.availableChains.map((c) => [c.key, c.profile.nativeSymbol])
        ),
        targets: targetRows(),
        wallets: holdings.rows,
        emptyWallets: holdings.empty,
      })
    );
    await ctx.api.deleteMessage(chatId, messageId).catch(() => undefined);
    await ctx.api.sendPhoto(chatId, new InputFile(png, "dashboard.png"), {
      caption: blockerCaption(findings, state),
      parse_mode: "HTML",
      reply_markup: dashboardMenu(),
    });
    return;
  } catch {
    // fall through to the text card
  }

  try {
    await ctx.api.editMessageText(chatId, messageId, text, {
      parse_mode: "HTML",
      reply_markup: dashboardMenu(),
      link_preview_options: { is_disabled: true },
    });
  } catch {
    // The placeholder may have been deleted underneath us; send rather than
    // leave the operator looking at "reading balances…" forever.
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: dashboardMenu() });
  }
}

/**
 * Show a card, replacing the one that was tapped when there was one.
 *
 * A button that appends a new message instead of updating the one under your
 * thumb turns a three-tap fix into a screen of near-identical cards, which is
 * most of why the copy screens became unreadable.
 */
async function respond(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  const options = {
    parse_mode: "HTML" as const,
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  };
  if (ctx.callbackQuery?.message) {
    // Editing to identical text is an API error, which a double tap produces.
    const edited = await ctx.editMessageText(text, options).catch(() => undefined);
    if (edited !== undefined) return;
  }
  await ctx.reply(text, options);
}

/**
 * "Why isn't it buying anything?"
 *
 * The question this bot could not answer. Every fact was already on a screen
 * somewhere and no screen put them together, so a set-up that was one setting
 * away from working looked identical to one that was perfect — four green
 * lights and no mints. This gathers the same facts in one pass and says which
 * one is in the way.
 */
/**
 * Read the whole set-up once, one network at a time.
 *
 * Per chain, because the engine has always been per chain: each has its own
 * watcher, its own balances and its own wallet pool, and an empty Ethereum has
 * never actually stopped Robinhood from buying. Only the reporting pretended
 * otherwise, and it is what made "no funds" read as total failure.
 */
async function currentFindings(): Promise<Finding[]> {
  const wallets = session.wallets();
  const selector = config.copy.walletSelector;

  const chains: ChainReadiness[] = await Promise.all(
    session.availableChains.map(async (chain) => {
      const row = {
        key: chain.key,
        name: chain.name,
        watching: session.hasWatcher(chain.key),
      };
      try {
        const ctx = await session.tagContext(chain.key);
        // The funder is filtered out here for the same reason copy-mint filters
        // it out: it cannot mint. Counting its balance would report a network as
        // ready to buy when every wallet that is allowed to buy is empty.
        const matched = withoutProtected(resolveWallets(selector, wallets, ctx), ctx);
        const fundedHere = matched.filter((w: ManagedWallet) => {
          const balance = ctx.state.get(w.id)?.balanceWei;
          return balance !== undefined && balance >= ctx.minFundedWei;
        });
        return {
          ...row,
          read: true,
          funded: fundedHere.length,
          matched: matched.length,
        };
      } catch {
        // Unreadable is not empty, and must never be reported as though it were.
        return { ...row, read: false, ready: 0, funded: 0, matched: 0, unarmed: 0 };
      }
    })
  );

  // Whether the chosen set can reach imported wallets at all is a property of
  // the selector, not of any one chain — so it is asked once, against a context
  // that treats every wallet as fundable so only the selector decides.
  const anyCtx = await session.tagContextAnyChain();
  const matchedAnywhere = resolveWallets(selector, wallets, anyCtx);
  const imported = wallets.filter((w) => w.kind !== "derived");

  return diagnose({
    copyEnabled: session.copyEnabled,
    targets: targets.list(),
    chains,
    walletsTotal: wallets.length,
    selector,
    selectorExcludesImported:
      imported.length > 0 && !matchedAnywhere.some((w: ManagedWallet) => w.kind !== "derived"),
    importedTotal: imported.length,
    maxPriceWei: config.capMaxPriceWei,
    perEventWei: config.capPerEventWei,
    dailyWei: config.capDailyWei,
    dailySpentWei: spentSince(24, ["mint"], { autoOnly: true }),
    skips: tallySkips(),
    journal: summariseJournal(),
    minFundedWei: anyCtx.minFundedWei,
  });
}

/**
 * Readiness for one network, or all of them.
 *
 * Shares its arithmetic with the health check on purpose — two screens that
 * count "ready" differently is how an operator ends up trusting neither.
 */
async function readinessFor(chainKey?: string): Promise<NetworkStep[]> {
  const wallets = session.wallets();
  const selector = config.copy.walletSelector;
  const chains = chainKey
    ? session.availableChains.filter((c) => c.key === chainKey)
    : session.availableChains;

  return Promise.all(
    chains.map(async (chain) => {
      const base = {
        key: chain.key,
        name: chain.name,
        symbol: chain.profile.nativeSymbol,
        minFundedWei: gasReservation(config.gasLimit, config.maxFeePerGas),
      };
      try {
        const ctx = await session.tagContext(chain.key);
        const pool = resolveForAutoFire(selector, wallets, ctx);
        const matched = resolveWallets(selector, wallets, ctx);
        const funded = matched.filter((w: ManagedWallet) => {
          const balance = ctx.state.get(w.id)?.balanceWei;
          return balance !== undefined && balance >= ctx.minFundedWei;
        });
        const balances = await session.balances(chain.key);
        return {
          ...base,
          read: true,
          funderWei: balances.get(config.funder) ?? 0n,
          wallets: { total: wallets.length, matched: matched.length, funded: funded.length },
        };
      } catch {
        return {
          ...base,
          read: false,
          funderWei: 0n,
          wallets: { total: wallets.length, matched: 0, funded: 0 },
        };
      }
    })
  );
}

/**
 * The wallets, and what each holds where.
 *
 * Sorted richest first and cut to the ones holding something, because the
 * question this answers is "can it buy?" — and five hundred rows of zero is not
 * a wallet list, it is a wall. The empty remainder is counted, not listed, and
 * the CSV export stays the place to see all of them.
 */
async function walletRows(): Promise<{ rows: WalletRow[]; empty: number }> {
  const wallets = session.wallets().filter((w) => w.address !== config.funder);

  const perChain = new Map<string, Map<string, bigint>>();
  for (const chain of session.availableChains) {
    try {
      perChain.set(chain.key, await session.balances(chain.key));
    } catch {
      // Unreadable: the column shows "·" rather than a zero it cannot vouch for.
    }
  }

  const rows: WalletRow[] = wallets.map((wallet) => {
    const balances: Record<string, bigint> = {};
    let total = 0n;
    for (const [key, map] of perChain) {
      const held = map.get(wallet.address);
      if (held === undefined) continue;
      balances[key] = held;
      total += held;
    }
    return {
      address: wallet.address,
      kind: wallet.kind === "derived" ? "generated" : "imported",
      canPay: total > 0n,
      balances,
      totalWei: total,
    };
  });

  const holding = rows.filter((r) => r.totalWei > 0n).sort((a, b) => (b.totalWei > a.totalWei ? 1 : -1));
  return { rows: holding, empty: rows.length - holding.length };
}

function targetRows(): TargetRow[] {
  return targets.list().map((t) => ({
    address: t.address,
    label: t.label,
    copies: t.fires,
    follows: t.mintMode === "both" ? "any mint" : `${t.mintMode} only`,
  }));
}

/** The same per-network readiness the wizard shows, for the dashboard picture. */
async function currentReadiness(): Promise<ChainReadiness[]> {
  const steps = await readinessFor();
  return steps.map((s) => ({
    key: s.key,
    name: s.name,
    read: s.read,
    watching: session.hasWatcher(s.key),
    funded: s.wallets.funded,
    matched: s.wallets.matched,
  }));
}

async function cmdSetupCopy(ctx: Context): Promise<void> {
  const steps = await readinessFor();
  await respond(ctx, clamp(renderNetworkChoice(steps)), networkKeyboard(steps));
}

async function cmdSetupChain(ctx: Context, chainKey: string): Promise<void> {
  const [step] = await readinessFor(chainKey);
  if (!step) return cmdSetupCopy(ctx);
  await respond(
    ctx,
    clamp(renderReadiness(step, config.copy.walletSelector, session.copyEnabled)),
    readinessKeyboard(step, session.copyEnabled)
  );
}

async function cmdSetupWallets(ctx: Context, chainKey: string): Promise<void> {
  const [step] = await readinessFor(chainKey);
  if (!step) return cmdSetupCopy(ctx);
  await respond(
    ctx,
    clamp(renderWalletChoice(step, config.copy.walletSelector)),
    walletChoiceKeyboard(chainKey, config.copy.walletSelector)
  );
}

/** Set the wallet selector from inside the wizard, then show the effect at once. */
async function cmdSetupSelector(ctx: Context, payload: string): Promise<void> {
  const [chainKey, ...rest] = payload.split(":");
  const selector = rest.join(":");
  try {
    updateUserSettings({ copyWalletSelector: selector });
  } catch (err) {
    await fail(ctx, err);
    return;
  }
  config.copy.walletSelector = selector;
  await cmdSetupChain(ctx, chainKey);
}

async function cmdWhy(ctx: Context): Promise<void> {
  const findings = await currentFindings();
  const text = clamp(renderHealth(findings, overallState(findings)));
  await respond(ctx, text, healthMenu(findings));
}

/** The recorded history of what the watcher saw, misses included. */
async function cmdSignals(ctx: Context): Promise<void> {
  const text = clamp(renderSignals(recentSignals(12)));
  await respond(ctx, text, signalsMenu());
}

/**
 * Apply one remedy across every watched wallet at once.
 *
 * Only widening changes belong here. Nothing on this path narrows what the bot
 * follows or raises what it may spend — a one-tap button that increases
 * autonomous spending is not a convenience, it is a trap, and the price limits
 * stay where the operator put them deliberately.
 */
async function cmdFixAll(ctx: Context, what: string): Promise<void> {
  if (what !== "mode") return;

  const changed: string[] = [];
  for (const target of targets.list()) {
    if (target.mintMode === "both") continue;
    targets.setMintMode(target.address, "both");
    changed.push(target.address);
  }

  const text =
    changed.length === 0
      ? [`✅ <b>Already following every mint</b>`, ``, `No wallet needed changing.`].join("\n")
      : [
          `✅ <b>Now following every mint</b>`,
          ``,
          `${changed.length} watched ${changed.length === 1 ? "wallet" : "wallets"} will be copied ` +
            `whether the drop is free or paid.`,
          ``,
          `<i>Your price limit still applies — nothing will be bought above ` +
            `${eth(config.capMaxPriceWei)} ETH per NFT.</i>`,
        ].join("\n");

  await respond(ctx, text, backTo("a:why", "‹ Back to the health check"));
}

async function cmdStatus(ctx: Context): Promise<void> {
  const wallets = session.wallets();
  const reservation = gasReservation(config.gasLimit, config.maxFeePerGas);

  // Wallet identities are chain-independent; balances and nonce health are not.
  // Report the set once, then a row per chain.
  const derived = wallets.filter((w) => w.kind === "derived").length;
  const imported = wallets.length - derived;

  const lines: string[] = [
    `<b>Copymint</b>  <i>${session.availableChains.length} chain(s) live</i>`,
    ``,
    `<b>Wallets</b>  ${wallets.length}`,
    `  derived ${derived} · imported ${imported}`,
    `  autofire ${wallets.filter((w) => w.autoFire).length} · manual ${wallets.filter((w) => !w.autoFire).length}`,
    ``,
  ];

  for (const chain of session.availableChains) {
    const tagCtx = await session.tagContext(chain.key, true);
    const summary = summarise(wallets, tagCtx);
    const balances = await session.balances(chain.key);
    let total = 0n;
    for (const wallet of wallets) total += balances.get(wallet.address) ?? 0n;

    const c = summary.counts;
    const isDefault = chain.key === session.defaultChain;
    lines.push(
      `<b>${esc(chain.name)}</b>${isDefault ? " <i>(default)</i>" : ""}`,
      `  ${eth(total)} ETH · funded ${c.funded ?? 0} · unfunded ${c.unfunded ?? 0}` +
        (c.stuck ? ` · <b>stuck ${c.stuck}</b>` : ""),
      `  ${chain.rpc.endpoints.length} endpoint(s)` +
        (chain.rpc.verified ? " ✓" : " ⚠️ unverified") +
        (chain.rpc.endpoints.some((e) => e.kind === "sequencer") ? " · sequencer" : " · no sequencer"),
      ``
    );
  }

  lines.push(
    `armed threshold ${eth(reservation)} ETH/wallet`,
    `<i>(gasLimit ${config.gasLimit} × ${config.gas.maxFeeGwei} gwei)</i>`,
    ``,
    `<b>Your addresses</b> <i>(change NFT vault in Settings)</i>`,
    `  vault  <code>${esc(config.vault)}</code>`,
    `  funder <code>${esc(config.funder)}</code>`,
    ``,
    `<i>Commands detect the chain from the contract. Add</i> <code>on ethereum</code> <i>to force one.</i>`
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

const PAGE = 25;

/**
 * One page of wallets.
 *
 * Telegram's 4096-character cap is the binding constraint at 500 wallets, so
 * the list pages rather than truncating and the full set goes out as a CSV
 * (`/wallets csv`) where every column survives.
 */
async function cmdWallets(ctx: Context, offset = 0): Promise<void> {
  const selector = args(ctx)[0] ?? "all";
  if (selector === "csv") return cmdWalletsCsv(ctx);

  const chain = await chainFor(ctx);
  const matched = await select(selector, ctx, chain.key, true);
  if (!matched) return;

  const balances = await session.balances(chain.key);
  const start = Math.min(Math.max(0, offset), Math.max(0, matched.length - 1));
  const shown = matched.slice(start, start + PAGE);
  const lines = shown.map((w) => {
    const balance = balances.get(w.address) ?? 0n;
    const origin = w.kind === "derived" ? `d${w.index}` : "imp";
    return `<code>${origin.padEnd(5)}${short(w.address)}</code>  ${eth(balance, 4)}  ${
      w.autoFire ? "auto" : "manual"
    }`;
  });

  const text = [
    `<b>${matched.length} wallet(s)</b> matching <code>${esc(selector)}</code>`,
    `<i>${esc(chain.name)} balances · showing ${start + 1}–${start + shown.length}</i>`,
    ``,
    ...lines,
  ].join("\n");

  const keyboard = walletsPager(start, shown.length, matched.length, selector);
  // A page tap edits in place; a typed command starts a fresh message.
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      return;
    } catch {
      // Editing fails when the text is unchanged — fall through and send.
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

/**
 * Every wallet, every column, as a file.
 *
 * Balances are per chain, so each live chain gets its own column — this is the
 * one view that answers "what do I actually hold" across the whole set.
 */
async function cmdWalletsCsv(ctx: Context): Promise<void> {
  const wallets = session.wallets();
  if (wallets.length === 0) {
    await ctx.reply("No wallets yet — generate some first.");
    return;
  }

  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(`<b>Export</b>\n\nreading ${wallets.length} wallets across ${session.availableChains.length} chain(s)…`);

  const perChain = new Map<string, Map<string, bigint>>();
  for (const chain of session.availableChains) {
    perChain.set(chain.key, await session.balances(chain.key, true));
  }

  const columns = [
    { header: "index", value: (w: ManagedWallet) => (w.kind === "derived" ? String(w.index) : "") },
    { header: "kind", value: (w: ManagedWallet) => w.kind },
    { header: "address", value: (w: ManagedWallet) => w.address },
    { header: "label", value: (w: ManagedWallet) => w.label ?? "" },
    { header: "autofire", value: (w: ManagedWallet) => (w.autoFire ? "yes" : "no") },
    { header: "tags", value: (w: ManagedWallet) => w.tags.join(" ") },
    ...session.availableChains.map((chain) => ({
      header: `${chain.key}_eth`,
      value: (w: ManagedWallet) => eth(perChain.get(chain.key)?.get(w.address) ?? 0n, 8),
    })),
  ];

  const csv = toCsv(wallets, columns);
  await status.finish(`<b>Export</b>\n\n${wallets.length} wallets.`);
  await ctx.replyWithDocument(new InputFile(csv, `wallets-${Date.now()}.csv`), {
    caption: "Addresses and balances only — no private keys leave the server.",
  });
}

async function cmdGenerate(ctx: Context): Promise<void> {
  const count = Number(args(ctx)[0]);
  if (!Number.isInteger(count) || count < 1) {
    await ctx.reply("Usage: <code>/generate 500</code>", { parse_mode: "HTML" });
    return;
  }

  const before = session.store.derivedCount;
  const created = session.store.generate(count);

  await ctx.reply(
    [
      `<b>Derived ${created.length} wallets</b>`,
      ``,
      `indices ${before}–${session.store.derivedCount - 1}`,
      `first <code>${created[0].address}</code>`,
      `last  <code>${created[created.length - 1].address}</code>`,
      ``,
      `<i>Nothing new was written to disk — these come from the same mnemonic, so`,
      `your existing 12-word backup already covers them. They start unfunded.</i>`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
}

async function cmdAutoFire(ctx: Context): Promise<void> {
  const [selector, state] = args(ctx);
  if (!selector || (state !== "on" && state !== "off")) {
    await ctx.reply("Usage: <code>/autofire imported on</code>", { parse_mode: "HTML" });
    return;
  }
  // No chain named: `funded` means funded on any chain, not on a favourite one.
  const matched = await select(selector, ctx, undefined);
  if (!matched) return;

  for (const wallet of matched) session.store.setAutoFire(wallet.id, state === "on");

  const warning =
    state === "on" && matched.some((w) => w.kind === "imported")
      ? "\n\n⚠️ Imported wallets will now spend on copy signals without confirmation."
      : "";
  await ctx.reply(
    `Auto-fire <b>${state}</b> for ${matched.length} wallet(s).${warning}`,
    { parse_mode: "HTML" }
  );
}

async function cmdTag(ctx: Context, remove: boolean): Promise<void> {
  const [selector, tag] = args(ctx);
  if (!selector || !tag) {
    await ctx.reply(
      `Usage: <code>/${remove ? "untag" : "tag"} 0-99 alpha</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }
  // No chain named: `funded` means funded on any chain, not on a favourite one.
  const matched = await select(selector, ctx, undefined);
  if (!matched) return;

  for (const wallet of matched) {
    if (remove) session.store.removeTag(wallet.id, tag);
    else session.store.addTag(wallet.id, tag);
  }
  await ctx.reply(
    `${remove ? "Removed" : "Added"} <code>${esc(tag)}</code> ${remove ? "from" : "to"} ${matched.length} wallet(s).`,
    { parse_mode: "HTML" }
  );
}

async function cmdFund(ctx: Context): Promise<void> {
  const chain = await chainFor(ctx);
  const [selector, targetEth] = args(ctx);
  if (!selector || !targetEth) {
    await ctx.reply(
      "Usage: <code>/fund derived+0-99 0.002</code>\nTops each wallet <i>up to</i> that balance — only the shortfall is sent.",
      { parse_mode: "HTML" }
    );
    return;
  }

  let target: bigint;
  try {
    target = parseEther(targetEth);
  } catch {
    await ctx.reply("That is not a valid ETH amount.");
    return;
  }

  const matched = await select(selector, ctx, chain.key, true);
  if (!matched) return;

  const funderWallet = session.wallets().find((w) => w.address === config.funder);
  if (!funderWallet) {
    await ctx.reply(
      `The funder <code>${esc(config.funder)}</code> is not in the wallet store.\n` +
        `Import its key so the bot can send from it.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const balances = await session.balances(chain.key, true);
  const targets = matched
    .filter((w) => w.address !== config.funder)
    .map((w) => ({ id: w.id, address: w.address }));
  const plan = planFunding(shortfalls(targets, balances, target), config.maxFeePerGas);

  if (plan.transfers.length === 0) {
    await ctx.reply(`All ${matched.length} wallet(s) already hold ${targetEth} ETH.`);
    return;
  }

  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(
    [
      `<b>Funding ${plan.transfers.length} wallet(s)</b>`,
      ``,
      `to ${targetEth} ETH each`,
      `sending ${eth(plan.totalValue)} ETH`,
      `gas ceiling ${eth(plan.gasCost)} ETH`,
      ``,
      `signing…`,
    ].join("\n")
  );

  try {
    const result = await executeFunding(
      plan,
      {
        funder: session.signerFor(funderWallet.id),
        readUrl: chain.rpc.readUrl,
        endpoints: chain.rpc.endpoints,
        chainId: chain.chainId,
        maxFeePerGas: config.maxFeePerGas,
        maxPriorityFeePerGas: config.maxPriorityFeePerGas,
      },
      (done, total) =>
        status.update(
          `<b>Funding ${total} wallet(s)</b>\n\n${bar(done, total)}  ${done}/${total}\nsigning…`
        )
    );

    await status.finish(
      [
        `<b>Funding complete</b>`,
        ``,
        `${bar(result.accepted, result.dispatched)}  ${result.accepted}/${result.dispatched} accepted`,
        result.rejected > 0 ? `${result.rejected} rejected` : ``,
        `sent ${eth(plan.totalValue)} ETH`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (err) {
    await status.finish(`<b>Funding failed</b>\n\n${esc((err as Error).message)}`);
  }
}

/**
 * Where a sweep is allowed to send NFTs.
 *
 * The vault by default. `to <address>` overrides it, because "put everything in
 * one wallet" is the whole point of a sweep and the one wallet somebody wants
 * is not always the one in config.json.
 *
 * That is a real widening: the vault used to be settable only over SSH, so a
 * Telegram account alone could never name a destination. It is kept honest by
 * confirming the full address before anything moves, and by the fact that this
 * command already requires a whitelisted chat.
 */
function sweepDestination(ctx: Context): { to: string; label: string } | { error: string } {
  const words = args(ctx);
  const at = words.findIndex((w) => w.toLowerCase() === "to");
  if (at === -1) {
    if (!config.vault || config.vault === ZeroAddress) {
      return {
        error:
          "No destination. Set a vault over SSH, or say where to send it:\n" +
          "<code>/sweep all to 0x…</code>",
      };
    }
    return { to: config.vault, label: "vault" };
  }

  const raw = words[at + 1];
  if (!raw) return { error: "Say where to send it: <code>/sweep all to 0x…</code>" };
  try {
    const to = getAddress(raw);
    const own = session.wallets().find((w) => w.address.toLowerCase() === to.toLowerCase());
    return { to, label: own ? `your wallet ${own.id}` : "external wallet" };
  } catch {
    return { error: `That is not a valid address: <code>${esc(raw.slice(0, 60))}</code>` };
  }
}

async function cmdSweep(ctx: Context): Promise<void> {
  const [selector = "all", contractArg] = withoutKeywordPairs(args(ctx));

  const destination = sweepDestination(ctx);
  if ("error" in destination) {
    await ctx.reply(destination.error, { parse_mode: "HTML" });
    return;
  }

  const chain = await chainFor(ctx, contractArg);
  const matched = await select(selector, ctx, chain.key, true);
  if (!matched) return;

  // Where to look, taken from the ledger rather than from the whole chain.
  //
  // Each recorded mint gives a contract, the wallets it went to and the block
  // it happened in, which turns the search from "every block since we started"
  // into a few hundred blocks per mint. On this deployment that is the
  // difference between sixty requests and twenty thousand.
  const mine = new Set(matched.map((w) => w.id));
  const sites = new Map<string, MintSite>();
  for (const entry of ledgerEntries()) {
    if (entry.kind !== "mint" || entry.chainId !== chain.chainId || !entry.contract) continue;
    if (entry.fromBlock === undefined) continue;
    if (contractArg && entry.contract.toLowerCase() !== contractArg.toLowerCase()) continue;

    const owners = matched
      .filter((w) => mine.has(w.id) && entry.walletIds.includes(w.id))
      .map((w) => ({ id: w.id, address: w.address }));
    if (owners.length === 0) continue;

    const key = `${entry.contract.toLowerCase()}|${entry.fromBlock}`;
    const existing = sites.get(key);
    if (existing) {
      const seen = new Set(existing.owners.map((o) => o.id));
      for (const o of owners) if (!seen.has(o.id)) existing.owners.push(o);
    } else {
      sites.set(key, { contract: entry.contract, block: entry.fromBlock, owners });
    }
  }

  if (sites.size === 0) {
    await ctx.reply(
      "Nothing to scan — no recorded mints for those wallets on this chain.\n" +
        "Pass a contract explicitly: <code>/sweep all 0x…</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(`<b>Sweep</b>\n\nchecking ${sites.size} mint(s) on ${esc(chain.name)}…`);

  try {
    const holdings = await discoverMintedHoldings(chain.rpc.readUrl, [...sites.values()], {
      onProgress: (done, total) =>
        status.update(`<b>Sweep</b>\n\n${bar(done, total)}  checking ${done}/${total}`),
    });

    if (holdings.length === 0) {
      await status.finish(
        "<b>Sweep</b>\n\nNo NFTs found. Every token from those mints has either " +
          "already been moved, or the mint did not land."
      );
      return;
    }

    // Nothing that already sits at the destination needs moving, and a
    // self-transfer would burn gas to achieve nothing.
    const toMove = holdings.filter(
      (h) => h.owner.toLowerCase() !== destination.to.toLowerCase()
    );
    if (toMove.length === 0) {
      await status.finish(
        `<b>Sweep</b>\n\nAll ${holdings.length} NFT(s) are already in ` +
          `<code>${esc(destination.to)}</code>.`
      );
      return;
    }

    const owners = [...new Set(toMove.map((h) => h.ownerId))];
    await session.primeNonces(
      matched.filter((w) => owners.includes(w.id)),
      chain.key
    );
    status.update(
      `<b>Sweep</b>\n\nfound ${toMove.length} NFT(s) in ${owners.length} wallet(s) — reading names…`
    );

    // Names once per collection, not once per token — cached, and 279 tokens
    // are usually fewer than sixty collections. Worth the few seconds: "moved
    // 40 of 279" says nothing about what is actually moving.
    const names = new Map<string, string>();
    for (const contract of new Set(toMove.map((h) => h.contract))) {
      const name = await collectionName(chain.rpc.readUrl, contract).catch(() => undefined);
      if (name) names.set(contract.toLowerCase(), name);
    }
    const label = (contract: string): string =>
      names.get(contract.toLowerCase()) ?? short(contract);

    // Which collection each transfer belongs to, keyed the way dispatch ids are
    // built in sweepNfts ("<walletId>#<tokenId>").
    const collectionFor = new Map(toMove.map((h) => [`${h.ownerId}#${h.tokenId}`, h.contract]));

    const moved = new Map<string, number>();
    let settled = 0;

    const result = await sweepNfts(
      toMove,
      {
        signerFor: session.signerFor,
        vault: destination.to,
        chainId: chain.chainId,
        endpoints: chain.rpc.endpoints,
        maxFeePerGas: config.maxFeePerGas,
        maxPriorityFeePerGas: config.maxPriorityFeePerGas,
        nonceFor: (a: string) => session.nonceFor(a, chain.key),
        // Every tenth transfer, and always the last one. The card edits in
        // place so this never fills the chat, and a batch of ten is often
        // enough to add a new collection to the list — one per transfer would
        // be the same picture redrawn 279 times.
        onSettled: (outcome, done, total) => {
          settled = done;
          if (outcome.accepted) {
            const contract = collectionFor.get(outcome.id);
            if (contract) {
              const key = label(contract);
              moved.set(key, (moved.get(key) ?? 0) + 1);
            }
          }
          if (done % 10 !== 0 && done !== total) return;
          status.update(
            [
              `<b>Sweeping ${total} NFT(s)</b>`,
              ``,
              `${bar(done, total)}  ${done} of ${total} sent`,
              ``,
              ...[...moved.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([name, count]) => `  ✅ ${esc(name)} × ${count}`),
              moved.size > 10 ? `  …and ${moved.size - 10} more collection(s)` : ``,
            ]
              .filter(Boolean)
              .join("\n")
          );
        },
      },
      (done, total) =>
        status.update(`<b>Sweep</b>\n\n${bar(done, total)}  preparing ${done}/${total}`)
    );

    const failed = result.outcomes.filter((o) => !o.accepted);
    // Failures grouped by cause the same way the mint report does it, so the
    // reason arrives attached to the collections it stopped.
    const byReason = new Map<string, number>();
    for (const outcome of failed) {
      const reason = explainRejection(outcome.errors);
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }

    await status.finish(
      [
        result.accepted > 0
          ? `<b>✅ Swept ${result.accepted} NFT(s)</b>`
          : `<b>❌ Nothing could be moved</b>`,
        ``,
        `Sent to ${esc(destination.label)}`,
        `<code>${esc(destination.to)}</code>`,
        ``,
        result.accepted > 0 ? `<b>What moved</b>` : ``,
        ...[...moved.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([name, count]) => `  ${esc(name)} × ${count}`),
        moved.size > 20 ? `  …and ${moved.size - 20} more collection(s)` : ``,
        byReason.size > 0
          ? `\n<b>Did not move</b>\n` +
            [...byReason.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([reason, count]) => `  ${esc(reason)} — ${count}`)
              .join("\n")
          : ``,
        ``,
        `<i>ETH left in place — wallets stay armed for the next mint.</i>`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (err) {
    await status.finish(`<b>Sweep failed</b>\n\n${esc((err as Error).message)}`);
  }
}

/**
 * Reclaim ETH from the wallet set back to the funder.
 *
 * The counterpart to /fund, for when a campaign is over and the gas is better
 * off in one place than smeared across 500 wallets. It lands at the funder
 * address in that user's settings. Changing it requires an explicit
 * confirmation in the same private chat.
 */
async function cmdDrain(ctx: Context): Promise<void> {
  const selector = args(ctx)[0] ?? "all";
  const chain = await chainFor(ctx);
  const matched = await select(selector, ctx, chain.key, true);
  if (!matched) return;

  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(`<b>Reclaim ETH</b>\n\nreading ${matched.length} balances on ${esc(chain.name)}…`);

  try {
    const balances = await session.balances(chain.key, true);
    const plan = planEthSweep(
      matched.map((w) => ({ id: w.id, address: w.address })),
      balances,
      config.maxFeePerGas
    );

    if (plan.transfers.length === 0) {
      await status.finish(
        `<b>Reclaim ETH</b>\n\nNothing to reclaim — no wallet holds more than its own ` +
          `transfer cost (${eth(BigInt(TRANSFER_GAS) * config.maxFeePerGas)} ETH).`
      );
      return;
    }

    await session.primeNonces(matched, chain.key);
    status.update(
      `<b>Reclaim ETH</b>\n\n${plan.transfers.length} wallet(s), ${eth(plan.total)} ETH — signing…`
    );

    const result = await executeEthSweep(
      plan,
      {
        signerFor: session.signerFor,
        destination: config.funder,
        chainId: chain.chainId,
        endpoints: chain.rpc.endpoints,
        maxFeePerGas: config.maxFeePerGas,
        maxPriorityFeePerGas: config.maxPriorityFeePerGas,
        nonceFor: (a: string) => session.nonceFor(a, chain.key),
      },
      (done, total) =>
        status.update(`<b>Reclaim ETH</b>\n\n${bar(done, total)}  signing ${done}/${total}`)
    );

    await status.finish(
      [
        `<b>Reclaim complete</b>`,
        ``,
        `${bar(result.accepted, result.dispatched)}  ${result.accepted}/${result.dispatched} accepted`,
        result.rejected > 0 ? `${result.rejected} rejected` : ``,
        `${eth(plan.total)} ETH → funder <code>${esc(short(config.funder))}</code>`,
        plan.skipped.length > 0
          ? `\n<i>${plan.skipped.length} skipped — balance below its own gas cost.</i>`
          : ``,
        ``,
        `<i>Wallets are now unarmed. Fund them again before minting.</i>`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (err) {
    await status.finish(`<b>Reclaim failed</b>\n\n${esc((err as Error).message)}`);
  }
}

async function cmdMint(ctx: Context): Promise<void> {
  const parts = args(ctx);
  const [contract, qtyArg] = parts;
  if (!contract || !isAddress(contract)) {
    await ctx.reply(
      "Usage: <code>/mint 0xContract 1 [selector] [wait]</code>",
      { parse_mode: "HTML" }
    );
    return;
  }
  const quantity = Number(qtyArg ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    await ctx.reply("Quantity must be a positive whole number.");
    return;
  }

  const chain = await chainFor(ctx, contract);
  const rest = parts.slice(2);
  const waitForStart = rest.includes("wait");
  const selector = rest.find((p) => p !== "wait" && p !== "on" && p !== chain.key) ?? "derived+funded";

  const matched = await select(selector, ctx, chain.key, true);
  if (!matched) return;

  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(
    `<b>Public mint</b>\n\n<code>${esc(short(contract))}</code> × ${quantity}\n${matched.length} wallet(s) selected\n\nreading drop…`
  );

  let latest: MintReport | undefined;

  const render = (event: MintEvent): void => {
    switch (event.type) {
      case "plan":
        status.update(
          [
            `<b>Public mint</b>  <code>${esc(short(contract))}</code>`,
            ``,
            `price ${eth(event.plan.drop.mintPrice)} × ${quantity} = ${eth(event.plan.value)} ETH/wallet`,
            `cap ${event.plan.drop.maxTotalMintableByWallet || "unlimited"} per wallet`,
            event.live ? `stage <b>live</b>` : `stage opens ${event.startsAt.toISOString()}`,
            ``,
            `checking balances…`,
          ].join("\n")
        );
        break;
      case "funding":
        status.update(
          [
            `<b>Public mint</b>  <code>${esc(short(contract))}</code>`,
            ``,
            `${event.eligible} wallet(s) funded` +
              (event.underfunded.length > 0 ? ` · ${event.underfunded.length} short` : ""),
            `needs ${eth(event.requiredPerWallet)} ETH each`,
            ``,
            `signing…`,
          ].join("\n")
        );
        break;
      case "signing":
        status.update(
          `<b>Public mint</b>  <code>${esc(short(contract))}</code>\n\n${bar(
            event.done,
            event.total
          )}  signing ${event.done}/${event.total}`
        );
        break;
      case "armed":
        status.update(
          `<b>Public mint</b>  <code>${esc(short(contract))}</code>\n\n✓ ${
            event.total
          } tx armed in ${event.signMs.toFixed(0)}ms\nnothing left to compute at fire time`
        );
        break;
      case "waiting":
        status.update(
          `<b>Public mint</b>  <code>${esc(short(contract))}</code>\n\n⏳ holding — ${Math.round(
            event.msRemaining / 1000
          )}s to stage open`
        );
        break;
      case "dispatched":
        status.update(
          `<b>Public mint</b>  <code>${esc(short(contract))}</code>\n\n🚀 ${
            event.count
          } tx dispatched in ${event.ms.toFixed(0)}ms\nawaiting acceptance…`
        );
        break;
      case "receipts":
        status.update(
          [
            `<b>Public mint</b>  <code>${esc(short(contract))}</code>`,
            ``,
            `${bar(event.confirmed + event.reverted, event.total)}  ${
              event.confirmed + event.reverted
            }/${event.total}`,
            `✓ confirmed ${event.confirmed}`,
            event.reverted > 0 ? `✗ reverted ${event.reverted}` : ``,
            `· pending ${event.pending}`,
          ]
            .filter(Boolean)
            .join("\n")
        );
        break;
      case "done":
        latest = event.report;
        break;
    }
  };

  try {
    const report = await executePublicMint(
      {
        nftContract: getAddress(contract),
        quantity,
        wallets: matched,
        waitForStart,
        skipUnderfunded: true,
      },
      {
        readUrl: chain.rpc.readUrl,
        allRpcUrls: chain.rpc.allUrls,
        endpoints: chain.rpc.endpoints,
        chainId: chain.chainId,
        gasLimit: config.gasLimit,
        maxFeePerGas: config.maxFeePerGas,
        maxPriorityFeePerGas: config.maxPriorityFeePerGas,
        nonces: chain.nonces,
        signerFor: session.signerFor,
      },
      render
    );
    latest = report;

    const first = report.rows.find((r) => r.status === "confirmed");
    await status.finish(
      [
        `<b>Mint complete</b>  <code>${esc(short(contract))}</code>`,
        ``,
        `${bar(report.confirmed, report.attempted)}  ${report.confirmed}/${report.attempted} confirmed`,
        report.reverted > 0 ? `✗ reverted ${report.reverted}` : ``,
        report.pending > 0 ? `· still pending ${report.pending}` : ``,
        ``,
        `spent ${eth(report.totalValue)} ETH · dispatch ${report.dispatchMs.toFixed(0)}ms`,
        first ? `\n${txLink(chain.chainId, first.hash, "view a transaction")}` : ``,
        report.errorSummary.length > 0
          ? `\n<b>Failures</b>\n` +
            report.errorSummary
              .slice(0, 3)
              .map((e) => `  ${e.count}× ${esc(e.reason.slice(0, 90))}`)
              .join("\n")
          : ``,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (err) {
    await status.finish(`<b>Mint failed</b>\n\n${esc((err as Error).message)}`);
  }

  // Per-wallet detail can't fit in a message; it goes out as a file.
  if (latest && latest.rows.length > 0) {
    const csv = toCsv(latest.rows, [
      { header: "wallet", value: (r) => r.id },
      { header: "address", value: (r) => r.address },
      { header: "tx_hash", value: (r) => r.hash },
      { header: "status", value: (r) => r.status },
      { header: "block", value: (r) => r.block ?? "" },
      { header: "gas_used", value: (r) => r.gasUsed ?? "" },
    ]);
    await ctx.replyWithDocument(new InputFile(csv, `mint-${Date.now()}.csv`), {
      caption: `${latest.rows.length} wallet results`,
    });
  }
}

/**
 * Resolve an allowlist stage end to end: on-chain root, published list, and
 * which of our wallets can prove membership.
 *
 * Both /check and /allowlist go through here rather than sharing a cache. A
 * stale proof set would be indistinguishable from a fresh one right up to the
 * point where 500 transactions revert, and the resolution happens before the
 * stage opens anyway, so it costs nothing that matters.
 */
async function loadEligibility(
  chain: ChainContext,
  contract: string,
  explicitUri: string | undefined,
  wallets: ManagedWallet[]
): Promise<{ report: EligibilityReport; uri: string }> {
  const root = await fetchAllowListRoot(chain.rpc.readUrl, contract);
  if (BigInt(root) === BigInt(ZERO_ROOT)) {
    throw new AllowListError(
      "This contract has no allowlist root set on SeaDrop — there is no allowlist stage to mint."
    );
  }

  const uri = explicitUri ?? (await findAllowListUri(chain.rpc.readUrl, contract));
  if (!uri) {
    throw new AllowListError(
      "Found an allowlist root on chain but no AllowListUpdated event carrying the list URI.\n" +
        "Pass the URI explicitly: <code>/check 0xContract https://…</code>"
    );
  }

  const response = await fetch(toHttpUrl(uri));
  if (!response.ok) {
    throw new AllowListError(`Could not fetch the allowlist (HTTP ${response.status}) from ${uri}`);
  }

  const entries = parseAllowList(await response.json());
  const report = checkEligibility(
    wallets.map((w) => ({ id: w.id, address: w.address })),
    entries,
    root
  );
  return { report, uri };
}

async function cmdCheck(ctx: Context): Promise<void> {
  const [contract, uriArg] = args(ctx);
  if (!contract || !isAddress(contract)) {
    await ctx.reply(
      "Usage: <code>/check 0xContract [listUrl]</code>\nVerifies which of your wallets are on the allowlist.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const address = getAddress(contract);
  const chain = await chainFor(ctx, address);
  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(
    `<b>Allowlist check</b>\n\n<code>${esc(short(address))}</code>\nreading root and locating the list…`
  );

  try {
    const wallets = session.wallets();
    const { report, uri } = await loadEligibility(chain, address, uriArg, wallets);

    // Tag the eligible set so selectors can target it, and clear the tag from
    // wallets that no longer qualify.
    const tag = eligibilityTag(address);
    const eligibleIds = new Set(report.eligible.map((r) => r.id));
    for (const wallet of wallets) {
      if (eligibleIds.has(wallet.id)) session.store.addTag(wallet.id, tag);
      else if (wallet.tags.includes(tag)) session.store.removeTag(wallet.id, tag);
    }

    const ctxTags = await session.tagContext(chain.key, true);
    const fundedEligible = report.eligible.filter(
      (r) => (ctxTags.state.get(r.id)?.balanceWei ?? 0n) > 0n
    ).length;

    const params = report.eligible[0]?.mintParams;

    await status.finish(
      [
        `<b>Allowlist check</b>  <code>${esc(short(address))}</code>`,
        ``,
        report.rootMatched
          ? `✅ rebuilt root matches chain`
          : `⚠️ <b>rebuilt root does NOT match chain</b>`,
        `${report.entryCount} entries on the list`,
        ``,
        `<b>${report.eligible.length}</b> of your ${report.rows.length} wallets eligible`,
        `${fundedEligible} of those are funded`,
        params
          ? `\nprice ${eth(params.mintPrice)} ETH · cap ${params.maxTotalMintableByWallet}/wallet` +
            `\nwindow ${new Date(Number(params.startTime) * 1000).toISOString()}` +
            `\n    →  ${new Date(Number(params.endTime) * 1000).toISOString()}`
          : ``,
        ``,
        report.eligible.length > 0
          ? `Tagged <code>${esc(tag)}</code> — mint with:\n<code>/allowlist ${short(address)} 1 wait</code>`
          : `None of your wallets are on this list.`,
        !report.rootMatched && report.eligible.length === 0
          ? `\n<i>The root mismatch means the published file was parsed in a way that does not reproduce the on-chain tree. Proofs are withheld rather than guessed.</i>`
          : ``,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (err) {
    await status.finish(`<b>Allowlist check failed</b>\n\n${esc((err as Error).message)}`);
  }
}

async function cmdAllowList(ctx: Context): Promise<void> {
  const parts = args(ctx);
  const [contract, qtyArg] = parts;
  if (!contract || !isAddress(contract)) {
    await ctx.reply(
      "Usage: <code>/allowlist 0xContract 1 [selector] [wait]</code>",
      { parse_mode: "HTML" }
    );
    return;
  }
  const quantity = Number(qtyArg ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    await ctx.reply("Quantity must be a positive whole number.");
    return;
  }

  const address = getAddress(contract);
  const chain = await chainFor(ctx, address);
  const rest = parts.slice(2);
  const waitForStart = rest.includes("wait");
  const selector = rest.find((p) => p !== "wait" && p !== "on" && p !== chain.key);

  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(
    `<b>Allowlist mint</b>\n\n<code>${esc(short(address))}</code> × ${quantity}\nresolving proofs…`
  );

  let latest: AllowListMintReport | undefined;

  try {
    // Narrow to a selector first if one was given, so proofs are only built for
    // wallets that will actually be used.
    let pool = session.wallets();
    if (selector) {
      const tagCtx = await session.tagContext(chain.key, true);
      pool = resolveWallets(selector, pool, tagCtx);
      if (pool.length === 0) {
        await status.finish(`No wallets match <code>${esc(selector)}</code>.`);
        return;
      }
    }

    const { report } = await loadEligibility(chain, address, undefined, pool);
    if (report.eligible.length === 0) {
      await status.finish(
        `<b>Allowlist mint</b>\n\nNone of the selected wallets are on this list.` +
          (report.rootMatched ? `` : `\n\n⚠️ The rebuilt root did not match chain.`)
      );
      return;
    }

    status.update(
      `<b>Allowlist mint</b>  <code>${esc(short(address))}</code>\n\n${report.eligible.length} eligible wallet(s)\nreading stage…`
    );

    const render = (event: AllowListEvent): void => {
      switch (event.type) {
        case "stage":
          status.update(
            [
              `<b>Allowlist mint</b>  <code>${esc(short(address))}</code>`,
              ``,
              `price ${eth(event.params.mintPrice)} × ${quantity} = ${eth(event.params.mintPrice * BigInt(quantity))} ETH/wallet`,
              `cap ${event.params.maxTotalMintableByWallet} per wallet`,
              event.live ? `stage <b>live</b>` : `opens ${event.startsAt.toISOString()}`,
              ``,
              `checking balances…`,
            ].join("\n")
          );
          break;
        case "funding":
          status.update(
            `<b>Allowlist mint</b>  <code>${esc(short(address))}</code>\n\n${event.eligible} funded` +
              (event.underfunded.length > 0 ? ` · ${event.underfunded.length} short` : "") +
              `\nneeds ${eth(event.requiredPerWallet)} ETH each\n\nsigning…`
          );
          break;
        case "signing":
          status.update(
            `<b>Allowlist mint</b>  <code>${esc(short(address))}</code>\n\n${bar(event.done, event.total)}  signing ${event.done}/${event.total}`
          );
          break;
        case "armed":
          status.update(
            `<b>Allowlist mint</b>  <code>${esc(short(address))}</code>\n\n✓ ${event.total} tx armed in ${event.signMs.toFixed(0)}ms\n<i>proofs are public data, so everything is pre-signed —\nT-0 is socket writes only</i>`
          );
          break;
        case "waiting":
          status.update(
            `<b>Allowlist mint</b>  <code>${esc(short(address))}</code>\n\n⏳ holding — ${Math.round(event.msRemaining / 1000)}s to open`
          );
          break;
        case "dispatched":
          status.update(
            `<b>Allowlist mint</b>  <code>${esc(short(address))}</code>\n\n🚀 ${event.count} tx dispatched in ${event.ms.toFixed(0)}ms`
          );
          break;
        case "receipts":
          status.update(
            [
              `<b>Allowlist mint</b>  <code>${esc(short(address))}</code>`,
              ``,
              `${bar(event.confirmed + event.reverted, event.total)}  ${event.confirmed + event.reverted}/${event.total}`,
              `✓ confirmed ${event.confirmed}`,
              event.reverted > 0 ? `✗ reverted ${event.reverted}` : ``,
              `· pending ${event.pending}`,
            ]
              .filter(Boolean)
              .join("\n")
          );
          break;
        case "done":
          latest = event.report;
          break;
      }
    };

    const final = await executeAllowListMint(
      {
        nftContract: address,
        quantity,
        eligible: report.eligible,
        waitForStart,
        skipUnderfunded: true,
      },
      {
        readUrl: chain.rpc.readUrl,
        allRpcUrls: chain.rpc.allUrls,
        endpoints: chain.rpc.endpoints,
        chainId: chain.chainId,
        gasLimit: config.gasLimit,
        maxFeePerGas: config.maxFeePerGas,
        maxPriorityFeePerGas: config.maxPriorityFeePerGas,
        nonces: chain.nonces,
        signerFor: session.signerFor,
      },
      render
    );
    latest = final;

    const firstOk = final.rows.find((r) => r.status === "confirmed");
    await status.finish(
      [
        `<b>Allowlist mint complete</b>  <code>${esc(short(address))}</code>`,
        ``,
        `${bar(final.confirmed, final.attempted)}  ${final.confirmed}/${final.attempted} confirmed`,
        final.reverted > 0 ? `✗ reverted ${final.reverted}` : ``,
        final.pending > 0 ? `· pending ${final.pending}` : ``,
        ``,
        `spent ${eth(final.totalValue)} ETH · dispatch ${final.dispatchMs.toFixed(0)}ms`,
        firstOk ? `\n${txLink(chain.chainId, firstOk.hash, "view a transaction")}` : ``,
        final.errorSummary.length > 0
          ? `\n<b>Failures</b>\n` +
            final.errorSummary
              .slice(0, 3)
              .map((e) => `  ${e.count}× ${esc(e.reason.slice(0, 90))}`)
              .join("\n")
          : ``,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (err) {
    await status.finish(`<b>Allowlist mint failed</b>\n\n${esc((err as Error).message)}`);
  }

  if (latest && latest.rows.length > 0) {
    const csv = toCsv(latest.rows, [
      { header: "wallet", value: (r) => r.id },
      { header: "address", value: (r) => r.address },
      { header: "tx_hash", value: (r) => r.hash },
      { header: "status", value: (r) => r.status },
      { header: "block", value: (r) => r.block ?? "" },
      { header: "gas_used", value: (r) => r.gasUsed ?? "" },
    ]);
    await ctx.replyWithDocument(new InputFile(csv, `allowlist-${Date.now()}.csv`), {
      caption: `${latest.rows.length} wallet results`,
    });
  }
}

// ── OpenSea v2 (allowlist + signed + public, whichever you're eligible for) ──
//
// OpenSea returns finished calldata and picks the stage server-side from the
// minter's eligibility, so one command covers every gated stage. The endpoint
// refuses before a stage opens, which is why nothing here can be pre-fetched.

function requireApiKey(): string {
  const key = (process.env.OPENSEA_API_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "OPENSEA_API_KEY is not set. Get one at https://docs.opensea.io/reference/api-keys " +
        "and export it in the bot's environment."
    );
  }
  return key;
}

/**
 * Contract → collection slug, for whichever chain the contract actually lives on.
 *
 * The chain is passed in rather than read from config: this used to report the
 * configured default in its error, so a Robinhood contract failed with "not
 * recognised on base" and sent people looking for the wrong problem.
 */
async function resolveSlug(
  chain: ChainContext,
  contract: string,
  given: string | undefined
): Promise<string> {
  if (given && !given.startsWith("0x")) return given;

  if (!openSeaChainSlug(chain.chainId)) {
    throw new Error(
      `OpenSea has no chain mapping for ${chain.name} (chain id ${chain.chainId}), ` +
        `so a contract there cannot be looked up.\nPass the collection slug explicitly to mint anyway.`
    );
  }

  const slug = await slugForContract(requireApiKey(), chain.chainId, contract);
  if (!slug) {
    throw new Error(
      `OpenSea does not recognise ${contract} on ${chain.name}.\n` +
        "Pass the collection slug explicitly if you know it."
    );
  }
  return slug;
}

async function cmdProbe(ctx: Context): Promise<void> {
  const [contract, slugArg] = args(ctx);
  if (!contract || !isAddress(contract)) {
    await ctx.reply(
      "Usage: <code>/probe 0xContract [slug]</code>\nAsks OpenSea for calldata once, to see what it will hand out right now.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const address = getAddress(contract);
  const chain = await chainFor(ctx, address);
  const apiKey = requireApiKey();
  const slug = await resolveSlug(chain, address, slugArg);

  // On-chain signers tell us whether a signed stage exists at all — a useful
  // cross-check against whatever OpenSea reports.
  let signerNote = "";
  try {
    const signers = await fetchSigners(chain.rpc.readUrl, address);
    signerNote =
      signers.length > 0
        ? `${signers.length} registered signer(s) on chain — a signed stage exists`
        : "no registered signers on chain";
  } catch {
    signerNote = "could not read on-chain signers";
  }

  let stageLines: string[] = [];
  try {
    const drop = await fetchDrop(apiKey, slug);
    stageLines = drop.stages.map(
      (s) => `  ${stageIsLive(s) ? "▸" : "·"} ${esc(describeStage(s))}` +
        (s.price ? ` · ${esc(s.price)}` : "") +
        ` · max ${esc(s.max_per_wallet)}`
    );
    if (stageLines.length === 0) stageLines = ["  (no stages listed)"];
  } catch (err) {
    stageLines = [`  <i>${esc((err as Error).message)}</i>`];
  }

  const probeWallet = session.wallets().find((w) => w.kind === "derived");
  if (!probeWallet) {
    await ctx.reply("No wallets to probe with — run /generate first.");
    return;
  }

  const result = await probeIssuance(apiKey, slug, probeWallet.address, 1);

  await ctx.reply(
    [
      `<b>OpenSea probe</b>  <code>${esc(slug)}</code>`,
      `<code>${esc(short(address))}</code>`,
      ``,
      `<b>Stages</b>`,
      ...stageLines,
      ``,
      `<i>${esc(signerNote)}</i>`,
      ``,
      result.available
        ? `✅ <b>calldata issued now</b>\n<i>${esc(result.detail)}</i>`
        : `⏳ <b>no calldata</b> (${esc(result.kind ?? "unknown")})\n<i>${esc(result.detail)}</i>`,
      ``,
      result.available
        ? `Run <code>/fcfs ${short(address)} 1</code> to mint.`
        : `OpenSea refuses before a stage opens, so requests must go out at T-0.\nUse <code>/fcfs ${short(address)} 1 &lt;selector&gt; at HH:MM</code> to schedule.`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
}

async function cmdFcfs(ctx: Context): Promise<void> {
  const parts = args(ctx);
  const [contract, qtyArg] = parts;
  if (!contract || !isAddress(contract)) {
    await ctx.reply(
      [
        "Usage: <code>/fcfs 0xContract &lt;qty&gt; [selector] [wait] [at HH:MM]</code>",
        "",
        "Mints whichever stage OpenSea says you're eligible for — allowlist,",
        "signed or public. Times are UTC.",
        "",
        "<code>wait</code> holds until the stage actually opens and fires the",
        "instant it does. Without it a closed stage is simply refused.",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
    return;
  }

  const quantity = Number(qtyArg ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    await ctx.reply("Quantity must be a positive whole number.");
    return;
  }

  const address = getAddress(contract);
  const chain = await chainFor(ctx, address);
  const apiKey = requireApiKey();

  // "wait" holds until OpenSea actually starts issuing calldata, rather than
  // firing once and taking a refusal as the answer.
  const waitForOpen = parts.includes("wait");

  // "at HH:MM" schedules the burst; anything else is a wallet selector.
  const atIndex = parts.indexOf("at");
  let startAt: Date | undefined;
  if (atIndex !== -1 && parts[atIndex + 1]) {
    const [h, m] = parts[atIndex + 1].split(":").map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) {
      await ctx.reply("Time must look like <code>at 17:30</code> (UTC).", { parse_mode: "HTML" });
      return;
    }
    const when = new Date();
    when.setUTCHours(h, m, 0, 0);
    if (when.getTime() <= Date.now()) when.setUTCDate(when.getUTCDate() + 1);
    startAt = when;
  }
  // Whatever is left after the contract, the quantity and the timing keywords
  // is the wallet selector. Indexing into the unsliced array here used to make
  // "wait" and the clock time reachable as selectors.
  const selector =
    parts
      .slice(2)
      .find(
        (part, i, rest) =>
          part !== "at" &&
          part !== "wait" &&
          part !== "on" &&
          // The token after "at" is a time and the one after "on" is a chain —
          // neither is a wallet selector, and treating one as such would
          // silently mint from the wrong set.
          rest[i - 1] !== "at" &&
          rest[i - 1] !== "on" &&
          !/^\d{1,2}:\d{2}$/.test(part)
      ) ?? "derived+funded";

  const matched = await select(selector, ctx, chain.key, true);
  if (!matched) return;

  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(
    `<b>FCFS mint</b>\n\n<code>${esc(short(address))}</code> × ${quantity}\n${matched.length} wallet(s)\n\nresolving collection…`
  );

  let latest: OpenSeaMintReport | undefined;

  try {
    const slug = await resolveSlug(chain, address, undefined);

    // Read the stage price ahead of time. OpenSea refuses to issue calldata to
    // a wallet that cannot cover the mint plus gas, so knowing the price lets
    // underfunded wallets be dropped before the T-0 burst instead of consuming
    // rate limit on guaranteed rejections.
    let unitPriceHintWei: bigint | undefined;
    let stageLabel: string | undefined;
    try {
      const drop = await fetchDrop(apiKey, slug);
      const live = drop.stages.find(stageIsLive);

      // Holding needs to know when to start listening. The soonest stage that
      // has not opened yet is the one being waited for; if one is already live
      // there is nothing to wait for and the hold falls through immediately.
      const upcoming = drop.stages
        .filter((s) => Date.parse(s.start_time) > Date.now())
        .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))[0];

      const target = live ?? upcoming ?? drop.stages[0];
      if (target?.price) unitPriceHintWei = BigInt(target.price);
      if (target) stageLabel = describeStage(target);

      // An explicit "at" always wins — it is the operator overriding what
      // OpenSea published, which is the entire reason the option exists.
      if (waitForOpen && !startAt && !live && upcoming) {
        startAt = new Date(Date.parse(upcoming.start_time));
      }
    } catch {
      // Falls back to gas-only screening, which is still better than none.
    }

    status.update(
      `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n${matched.length} wallet(s) selected` +
        (stageLabel ? `\nstage ${esc(stageLabel)}` : "") +
        (unitPriceHintWei !== undefined ? `\nstage price ${eth(unitPriceHintWei)} ETH` : "") +
        (startAt
          ? `\n⏳ ${waitForOpen ? "holding for" : "firing at"} ${startAt.toISOString().slice(11, 16)} UTC`
          : waitForOpen
            ? `\n⏳ holding until OpenSea opens the stage`
            : "\nstarting now…")
    );

    const render = (event: OpenSeaMintEvent): void => {
      switch (event.type) {
        case "waiting":
          status.update(
            `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n⏳ holding — ${Math.round(event.msRemaining / 1000)}s\n<i>OpenSea won't issue calldata before the stage opens,\nso the fetch starts at T-0.</i>`
          );
          break;
        case "probing":
          status.update(
            [
              `<b>FCFS mint</b>  <code>${esc(slug)}</code>`,
              ``,
              `🔄 asking — attempt ${event.attempt}`,
              `${event.msPastOpen >= 0 ? "+" : ""}${Math.round(event.msPastOpen / 1000)}s vs published open`,
              ``,
              `<i>${esc(event.reason.slice(0, 120))}</i>`,
              `<i>One wallet is doing the asking, well inside the rate limit.</i>`,
            ].join("\n")
          );
          break;
        case "open":
          status.update(
            `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n🟢 <b>stage open</b> after ${event.attempts} ask(s) · waited ${(event.waitedMs / 1000).toFixed(1)}s\n\n${event.hadCalldata ? "fetching the rest…" : "fetching calldata…"}`
          );
          break;
        case "fetching":
          status.update(
            `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n${bar(event.done, event.total)}  calldata ${event.done}/${event.total}` +
              (event.failures > 0 ? `\n${event.failures} refused` : "")
          );
          break;
        case "fetched":
          status.update(
            `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n✓ ${event.ok} calldata in ${event.ms.toFixed(0)}ms` +
              (event.failed > 0 ? ` · ${event.failed} refused` : "") +
              `\nprice ${eth(event.unitPriceWei)} ETH each\n\ninspecting…`
          );
          break;
        case "inspected":
          status.update(
            `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n✓ ${event.ok} passed inspection` +
              (event.rejected.length > 0
                ? `\n✗ ${event.rejected.length} rejected — not signed`
                : "") +
              `\n\nsimulating…`
          );
          break;
        case "simulated":
          status.update(
            `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n✓ simulation passed · gas ${event.gasLimit}\n\nsigning…`
          );
          break;
        case "signing":
          status.update(
            `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n${bar(event.done, event.total)}  signing ${event.done}/${event.total}`
          );
          break;
        case "dispatched":
          status.update(
            `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n🚀 ${event.count} tx dispatched in ${event.ms.toFixed(0)}ms`
          );
          break;
        case "receipts":
          status.update(
            [
              `<b>FCFS mint</b>  <code>${esc(slug)}</code>`,
              ``,
              `${bar(event.confirmed + event.reverted, event.total)}  ${event.confirmed + event.reverted}/${event.total}`,
              `✓ confirmed ${event.confirmed}`,
              event.reverted > 0 ? `✗ reverted ${event.reverted}` : ``,
            ]
              .filter(Boolean)
              .join("\n")
          );
          break;
        case "done":
          latest = event.report;
          break;
      }
    };

    const final = await executeOpenSeaMint(
      {
        slug,
        nftContract: address,
        quantity,
        wallets: matched.map((w) => ({ id: w.id, address: w.address })),
        startAt,
        waitForOpen,
        skipUnderfunded: true,
        unitPriceHintWei,
      },
      {
        readUrl: chain.rpc.readUrl,
        allRpcUrls: chain.rpc.allUrls,
        endpoints: chain.rpc.endpoints,
        chainId: chain.chainId,
        gasLimit: config.gasLimit,
        maxFeePerGas: config.maxFeePerGas,
        maxPriorityFeePerGas: config.maxPriorityFeePerGas,
        nonces: chain.nonces,
        signerFor: session.signerFor,
        apiKey,
        maxUnitPriceWei: config.capMaxPriceWei,
        pacing: {
          concurrency: config.signed.concurrency,
          minDelayMs: config.signed.minDelayMs,
          maxRetries: config.signed.maxRetries,
        },
      },
      render
    );
    latest = final;

    const firstOk = final.rows.find((r) => r.status === "confirmed");
    await status.finish(
      [
        `<b>FCFS mint complete</b>  <code>${esc(slug)}</code>`,
        ``,
        `${bar(final.confirmed, final.attempted)}  ${final.confirmed}/${final.attempted} confirmed`,
        final.reverted > 0 ? `✗ reverted ${final.reverted}` : ``,
        final.pending > 0 ? `· pending ${final.pending}` : ``,
        ``,
        `${final.fetched}/${final.requested} wallets got calldata`,
        `spent ${eth(final.totalValue)} ETH · fetch ${final.fetchMs.toFixed(0)}ms · dispatch ${final.dispatchMs.toFixed(0)}ms`,
        firstOk ? `\n${txLink(chain.chainId, firstOk.hash, "view a transaction")}` : ``,
        final.fetchFailures.length > 0
          ? `\n<b>Refused</b>\n` +
            final.fetchFailures
              .slice(0, 3)
              .map((f) => `  ${esc(short(f.address))} — ${esc(f.reason.slice(0, 70))}`)
              .join("\n")
          : ``,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (err) {
    const detail =
      err instanceof OpenSeaApiError
        ? `${err.message}\n<i>${esc(err.body.slice(0, 200))}</i>`
        : esc((err as Error).message);
    await status.finish(`<b>FCFS mint failed</b>\n\n${detail}`);
  }

  if (latest && latest.rows.length > 0) {
    const csv = toCsv(latest.rows, [
      { header: "wallet", value: (r) => r.id },
      { header: "address", value: (r) => r.address },
      { header: "tx_hash", value: (r) => r.hash },
      { header: "status", value: (r) => r.status },
      { header: "block", value: (r) => r.block ?? "" },
      { header: "gas_used", value: (r) => r.gasUsed ?? "" },
    ]);
    await ctx.replyWithDocument(new InputFile(csv, `fcfs-${Date.now()}.csv`), {
      caption: `${latest.rows.length} wallet results`,
    });
  }
}

/** One phrase for the payer rule, used everywhere it is shown. */
function describePayer(payer: targets.PayerMode): string {
  return payer === "any" ? "anything minted to it" : "its own transactions only";
}

async function cmdWatch(ctx: Context): Promise<void> {
  const [address, tierArg, ...rest] = args(ctx);
  if (!address) {
    await ctx.reply(
      "Usage: <code>/watch 0xAlpha… high both any alpha-wallet</code>\n" +
        "Tiers: <code>high</code> <code>med</code> <code>low</code>. " +
        "Which mints: <code>both</code> (the default) · <code>free</code> ignores paid drops · <code>paid</code> ignores free ones. " +
        "Payer: <code>self</code> <code>any</code>.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const tier = targets.parseTier(tierArg, "low");

  // Mode, payer and label all arrive positionally and any of them may be
  // omitted, so each keyword is claimed from the remaining words rather than
  // read off a fixed index — otherwise "/watch 0x… high vault-wallet" would
  // parse the label as a filter and fail.
  const words = rest.filter((word): word is string => word !== undefined);
  const modeWord = words.find((w) => ["free", "paid", "both"].includes(w.toLowerCase()));
  const payerWord = words.find((w) => ["self", "any", "vault"].includes(w.toLowerCase()));
  const mintMode = targets.parseMintMode(modeWord, "both");
  const payer = targets.parsePayer(payerWord, "self");
  const label = words.filter((w) => w !== modeWord && w !== payerWord).join(" ") || undefined;

  const target = targets.add(address, tier, mintMode, label, payer);
  await session.retargetWatchers();

  const walletsPerFire = config.copy.tiers[tier];
  await ctx.reply(
    [
      `<b>Watching</b> <code>${esc(target.address)}</code>`,
      ``,
      `tier  <b>${tier}</b> → up to ${walletsPerFire} wallets per signal`,
      `copy  <b>${mintMode === "both" ? "free + paid" : `${mintMode} only`}</b>`,
      `from  <b>${describePayer(payer)}</b>`,
      label ? `label ${esc(label)}` : ``,
      ``,
      payer === "any"
        ? `<i>The payer is not checked — anything minted to this address is copied,` +
          ` including by wallets you have never seen. Caps bound the cost.</i>`
        : `<i>Mints somebody else paid for are ignored. If this is a vault that never` +
          ` sends its own mints, switch it to "any payer" in /targets.</i>`,
      ``,
      session.copyEnabled
        ? `Autonomous firing is <b>ON</b>.`
        : `Autonomous firing is <b>OFF</b> — signals will be reported only. Turn on with <code>/copy on</code>.`,
    ]
      .filter(Boolean)
      .join("\n"),
    { parse_mode: "HTML" }
  );
}

async function cmdUnwatch(ctx: Context): Promise<void> {
  const [address] = args(ctx);
  if (!address) {
    await ctx.reply("Usage: <code>/unwatch 0xAlpha…</code>", { parse_mode: "HTML" });
    return;
  }
  const removed = targets.remove(address);
  if (!removed) {
    await ctx.reply("That address was not being watched.");
    return;
  }
  await session.retargetWatchers();
  await ctx.reply(`Stopped watching <code>${esc(address)}</code>.`, { parse_mode: "HTML" });
}

async function cmdTargets(ctx: Context): Promise<void> {
  const list = targets.list();
  if (list.length === 0) {
    await ctx.reply(
      "No targets yet. Watch a wallet and its mints get mirrored.",
      { parse_mode: "HTML", reply_markup: targetsKeyboard([]) }
    );
    return;
  }

  const lines = list.map((t) => {
    const perFire = targets.walletsFor(t, config.copy.tiers);
    const recent = targets.firesInWindow(t.address, 3_600_000);
    return (
      `<code>${short(t.address)}</code>  →${perFire}w  ` +
      `<b>${t.mintMode}</b> · ${t.payer === "any" ? "🏦 any payer" : "👤 own tx"}` +
      ` · ${t.fires} fires${recent > 0 ? ` (${recent} this hour)` : ""}` +
      (t.label ? `  ${esc(t.label)}` : "")
    );
  });

  await ctx.reply(
    [
      `<b>${list.length} target(s)</b>`,
      session.copyEnabled ? `firing <b>ON</b>` : `firing <b>OFF</b>`,
      ``,
      ...lines,
      ``,
      `<i>Tap one to change what it copies, or to see what it actually mints.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: targetsKeyboard(list) }
  );
}

/**
 * One target's page.
 *
 * Everything that decides whether this address's mints get copied, in the order
 * the engine checks it, each line stating the setting rather than describing it
 * in prose. The point is that "why didn't it fire?" is answerable by reading
 * down the screen — and that every answer is one tap from being changed.
 */
async function showTarget(ctx: Context, address: string): Promise<void> {
  const target = targets.find(address);
  if (!target) {
    await ctx.reply("That address is no longer being watched.", {
      reply_markup: targetsKeyboard(targets.list()),
    });
    return;
  }

  const perFire = targets.walletsFor(target, config.copy.tiers);
  const ceiling = targets.maxPriceFor(target, config.capMaxPriceWei);
  const recent = targets.firesInWindow(target.address, 3_600_000);

  // What could actually fire right now, so a target that looks correctly
  // configured but has no wallets behind it says so here rather than at T-0.
  let poolNote = "";
  try {
    const ctxTags = await session.tagContextAnyChain();
    const pool = resolveForAutoFire(config.copy.walletSelector, session.wallets(), ctxTags);
    poolNote =
      pool.selected.length === 0
        ? `\n⚠️ <b>No wallet can fire</b> — armed and funded: 0.`
        : `\n${Math.min(perFire, pool.selected.length)} wallet(s) would fire · ${pool.selected.length} armed and funded`;
  } catch {
    // A chain that will not answer must not stop the page rendering.
  }

  await ctx.reply(
    [
      `🎯 <b>${esc(target.label ?? short(target.address))}</b>`,
      `<code>${esc(target.address)}</code>`,
      ``,
      `<code>copies    ${target.mintMode === "both" ? "free + paid" : `${target.mintMode} only`}</code>`,
      `<code>from      ${target.payer === "any" ? "anyone who mints to it" : "its own transactions"}</code>`,
      `<code>wallets   ${perFire}${target.walletCount === undefined ? ` (${target.tier} tier)` : " (set here)"}</code>`,
      `<code>up to     ${eth(ceiling)} ETH each${target.maxPriceEth === undefined ? " (global cap)" : " (set here)"}</code>`,
      `<code>fired     ${target.fires}${recent > 0 ? ` · ${recent} this hour` : ""}</code>`,
      poolNote,
      ``,
      session.copyEnabled ? `Copy-mint is <b>ON</b>.` : `⚠️ Copy-mint is <b>OFF</b> — nothing will fire.`,
      ``,
      `<i>Per-event ${eth(config.capPerEventWei)} and daily ${eth(config.capDailyWei)} ETH caps still apply on top.</i>`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    { parse_mode: "HTML", reply_markup: targetDetailKeyboard(target) }
  );
}

/**
 * What has this address actually minted, and would we have copied it?
 *
 * The question every "it isn't working" reduces to. Scanning is the slow part —
 * several eth_getLogs plus a receipt each — so the card is sent first and
 * edited when the answer lands.
 */
async function probeTargetActivity(ctx: Context, address: string): Promise<void> {
  const target = targets.find(address);
  if (!target) {
    await ctx.reply("That address is no longer being watched.");
    return;
  }

  const sent = await ctx.reply(
    `🔎 <b>${esc(short(target.address))}</b>\n\n<i>scanning ${session.availableChains.length} chain(s) for recent mints…</i>`,
    { parse_mode: "HTML" }
  );

  const reservation = gasReservation(config.gasLimit, config.maxFeePerGas);
  let poolSize = 0;
  try {
    const ctxTags = await session.tagContextAnyChain();
    poolSize = resolveForAutoFire(config.copy.walletSelector, session.wallets(), ctxTags)
      .selected.length;
  } catch {
    // Counted as zero, which the report then names as a blocker — the honest
    // reading when the balance could not be established.
  }

  const perChain = await Promise.all(
    session.availableChains.map(async (chain) => {
      try {
        const result = await probeTarget(chain.rpc.readUrl, target.address, {
          hours: 48,
          limit: 5,
        });
        return { chain, result };
      } catch (err) {
        return { chain, error: (err as Error).message };
      }
    })
  );

  const lines: string[] = [
    `🔎 <b>${esc(target.label ?? short(target.address))}</b>`,
    `<code>${esc(target.address)}</code>`,
    ``,
  ];

  // Blockers are collected across every mint seen, then reported once — the
  // same missing setting on five mints is one thing to fix, not five.
  const blockers = new Map<string, { remedy: string; reason: string }>();
  let mintsSeen = 0;
  let copyable = 0;

  for (const entry of perChain) {
    if ("error" in entry || !entry.result) {
      lines.push(`<b>${esc(entry.chain.name)}</b> — could not scan`);
      continue;
    }
    const { mints, hoursScanned } = entry.result;
    if (mints.length === 0) {
      lines.push(`<b>${esc(entry.chain.name)}</b> — nothing in the last ${hoursScanned}h`);
      continue;
    }

    lines.push(`<b>${esc(entry.chain.name)}</b> — ${mints.length} mint(s), last ${hoursScanned}h`);
    for (const mint of mints) {
      mintsSeen += 1;
      const assessment = assessMint(mint, {
        target,
        tiers: config.copy.tiers,
        globalMaxPriceWei: config.capMaxPriceWei,
        perEventWei: config.capPerEventWei,
        gasReservationWei: reservation,
        poolSize,
        copyEnabled: session.copyEnabled,
      });
      if (assessment.wouldCopy) copyable += 1;
      for (const blocker of assessment.blockers) {
        blockers.set(blocker.kind, { remedy: blocker.remedy, reason: blocker.reason });
      }

      const paidBy =
        mint.payer && mint.payer.toLowerCase() !== target.address.toLowerCase()
          ? ` · paid by ${short(mint.payer)}`
          : ` · its own tx`;
      lines.push(
        `  ${assessment.wouldCopy ? "✅" : "⛔"} <code>${short(mint.contract)}</code>  ` +
          `${mint.valueWei === 0n ? "free" : `${eth(mint.valueWei)} ETH`}` +
          `${mint.method ? ` · ${mint.method}` : ""}${paidBy}`
      );
      if (assessment.wouldCopy) {
        lines.push(`      <i>would fire ${assessment.walletCount} wallet(s)</i>`);
      }
    }
    lines.push(``);
  }

  if (mintsSeen === 0) {
    lines.push(
      ``,
      `<i>No mints found. This address may simply not have minted recently — copy-mint`,
      `fires on new mints as they happen, so an empty history is not a fault.</i>`
    );
  } else if (blockers.size === 0) {
    lines.push(`<b>✅ Nothing is blocking this target.</b>`, ``, `<i>${copyable} of ${mintsSeen} recent mint(s) would have been copied.</i>`);
  } else {
    lines.push(`<b>What is stopping a copy</b>`);
    for (const [, blocker] of blockers) {
      lines.push(`⛔ ${esc(blocker.reason)}`, `      → <i>${esc(blocker.remedy)}</i>`);
    }
  }

  const text = clamp(lines.join("\n"));
  try {
    await ctx.api.editMessageText(ctx.chat!.id, sent.message_id, text, {
      parse_mode: "HTML",
      reply_markup: targetDetailKeyboard(target),
      link_preview_options: { is_disabled: true },
    });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: targetDetailKeyboard(target) });
  }
}

async function saveTargetWallets(ctx: Context, address: string, value: string): Promise<void> {
  const target = targets.setWalletCount(
    address,
    value === "tier" ? undefined : Number(value)
  );
  clearFlow(ctx.chat!.id);
  const perFire = targets.walletsFor(target, config.copy.tiers);
  await ctx.reply(
    `<b>Wallets per fire</b> → <b>${perFire}</b>` +
      (target.walletCount === undefined ? ` <i>(back to the ${target.tier} tier)</i>` : ``),
    { parse_mode: "HTML" }
  );
  return showTarget(ctx, address);
}

async function saveTargetPrice(ctx: Context, address: string, value: string): Promise<void> {
  const target = targets.setMaxPrice(address, value === "global" ? undefined : value);
  clearFlow(ctx.chat!.id);
  const ceiling = targets.maxPriceFor(target, config.capMaxPriceWei);
  await ctx.reply(
    `<b>Price limit</b> → <b>${eth(ceiling)} ETH</b> per wallet` +
      (target.maxPriceEth === undefined ? ` <i>(back to the global cap)</i>` : ``),
    { parse_mode: "HTML" }
  );
  return showTarget(ctx, address);
}

async function cmdCopy(ctx: Context): Promise<void> {
  const [state] = args(ctx);
  if (state !== "on" && state !== "off") {
    await ctx.reply(
      `Copy-mint firing is currently <b>${session.copyEnabled ? "ON" : "OFF"}</b>.\nUsage: <code>/copy on</code> or <code>/copy off</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const enabled = state === "on";
  updateUserSettings({ copyEnabled: enabled });
  config.copy.enabled = enabled;
  session.copyEnabled = enabled;
  // Seal the live card off rather than leaving it updating above a message
  // that says firing has stopped.
  if (!enabled) clearFeed(currentRuntime().chatId);
  await ctx.reply(
    session.copyEnabled
      ? [
          `<b>Copy-mint ON</b>`,
          ``,
          `Signals from ${targets.list().length} target(s) will now spend without confirmation,`,
          `bounded by /caps.`,
          ``,
          `<i>This choice is saved for your account and remains ON after a restart.`,
          `Use Turn OFF or /copy off to stop autonomous firing.</i>`,
        ].join("\n")
      : `<b>Copy-mint OFF</b>\n\nSignals will be reported but nothing will fire.`,
    { parse_mode: "HTML" }
  );
}

async function cmdCaps(ctx: Context): Promise<void> {
  // The cap governs autonomous spending, so that is what this reports against.
  const spent = spentSince(24, ["mint"], { autoOnly: true });
  const spentByHand = spentSince(24, ["mint"]) - spent;
  const remaining = config.capDailyWei > spent ? config.capDailyWei - spent : 0n;
  const reservation = gasReservation(config.gasLimit, config.maxFeePerGas);

  await ctx.reply(
    [
      `<b>Spend caps</b>`,
      ``,
      `per event   ${eth(config.capPerEventWei)} ETH`,
      `max price   ${eth(config.capMaxPriceWei)} ETH per NFT`,
      `daily       ${eth(config.capDailyWei)} ETH`,
      ``,
      `<b>Last 24h</b>`,
      `${bar(Number(spent), Number(config.capDailyWei))}  ${eth(spent)} / ${eth(config.capDailyWei)} ETH`,
      `remaining   ${eth(remaining)} ETH` +
        (spentByHand > 0n
          ? `\n\n<i>Plus ${eth(spentByHand)} ETH you minted by hand, which is not` +
            `\ncharged against this cap.</i>`
          : ``),
      ``,
      `<i>Cost per wallet counts the ${eth(reservation)} ETH gas reservation as well as`,
      `the mint price — otherwise a free mint would look free and fire unbounded.</i>`,
      ``,
      `<i>Max price is the bait guard: an over-priced mint is rejected outright,`,
      `never trimmed. Budget limits trim instead of rejecting.</i>`,
      ``,
      `<b>Wallets that fire</b>  <code>${esc(config.copy.walletSelector)}</code>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: capsMenu() }
  );
}

/** Human name for each cap, used by the edit flow's prompts and confirmations. */
const CAP_LABELS: Record<"event" | "max" | "daily", string> = {
  max: "Max price per wallet",
  event: "Per-event cap",
  daily: "Daily cap",
};

async function askCapAmount(ctx: Context, kind: "event" | "max" | "daily"): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const flow = startFlow(chatId, "cap", "amount");
  flow.capKind = kind;

  const current =
    kind === "max"
      ? config.capMaxPriceWei
      : kind === "event"
        ? config.capPerEventWei
        : config.capDailyWei;

  const explain =
    kind === "max"
      ? `The most one wallet may pay for a single mint. Above this a signal is refused outright — it is the bait guard, and it never trims.`
      : kind === "event"
        ? `The most one copy signal may commit across all wallets. Too small and the set is trimmed to fewer wallets rather than refused.`
        : `The most copy-mint may commit in a rolling 24 hours. Mints you run by hand are not charged against it.`;

  await ctx.reply(
    [
      `<b>${CAP_LABELS[kind]}</b>`,
      ``,
      `now <b>${eth(current)} ETH</b>`,
      ``,
      `<i>${explain}</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: capAmountKeyboard(kind) }
  );
}

async function saveCap(
  ctx: Context,
  kind: "event" | "max" | "daily",
  value: string
): Promise<void> {
  const field = kind === "max" ? "maxPriceEth" : kind === "event" ? "perEventEth" : "dailyEth";
  const before =
    kind === "max"
      ? config.capMaxPriceWei
      : kind === "event"
        ? config.capPerEventWei
        : config.capDailyWei;

  let saved;
  try {
    saved = updateUserSettings({ caps: { [field]: value } });
  } catch (err) {
    // A rejected cap leaves the old one in place, which is the safe direction.
    await fail(ctx, err);
    return cmdCaps(ctx);
  }

  // The running config is read through a proxy per update, so the live session
  // picks this up on the next signal without a restart.
  config.caps = saved.caps!;
  config.capPerEventWei = parseEther(saved.caps!.perEventEth);
  config.capMaxPriceWei = parseEther(saved.caps!.maxPriceEth);
  config.capDailyWei = parseEther(saved.caps!.dailyEth);

  clearFlow(ctx.chat!.id);
  await ctx.reply(
    [
      `<b>${CAP_LABELS[kind]} updated</b>`,
      ``,
      `${eth(before)} → <b>${value} ETH</b>`,
      ``,
      `<i>In force from the next copy signal — no restart needed.</i>`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
  return cmdCaps(ctx);
}

async function showWalletSelector(ctx: Context): Promise<void> {
  const ctxTags = await session.tagContextAnyChain();
  const counts = (selector: string): string => {
    try {
      return String(resolveWallets(selector, session.wallets(), ctxTags).length);
    } catch {
      return "?";
    }
  };

  await ctx.reply(
    [
      `<b>Which wallets fire on a copy signal</b>`,
      ``,
      `now <code>${esc(config.copy.walletSelector)}</code>`,
      ``,
      `<i>Matching right now, across every chain:</i>`,
      `<code>derived+funded   ${counts("derived+funded").padStart(4)}</code>  generated wallets`,
      `<code>funded           ${counts("funded").padStart(4)}</code>  any funded wallet`,
      `<code>imported+funded  ${counts("imported+funded").padStart(4)}</code>  imported only`,
      ``,
      `<i>A wallet still has to be armed for auto-fire on top of matching this.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: walletSelectorMenu(config.copy.walletSelector) }
  );
}

async function saveWalletSelector(ctx: Context, selector: string): Promise<void> {
  try {
    updateUserSettings({ copyWalletSelector: selector });
  } catch (err) {
    await fail(ctx, err);
    return;
  }
  config.copy.walletSelector = selector;
  await ctx.reply(
    `<b>Copy-mint wallets set to</b> <code>${esc(selector)}</code>`,
    { parse_mode: "HTML" }
  );
  return showWalletSelector(ctx);
}

/**
 * Live copy-mint reporting. Never on the critical path — these fire after dispatch.
 *
 * Watch activity goes to a card that updates in place; only a result, which
 * means money moved, earns a message of its own. See copy-feed.ts for why.
 */
function renderCopyEvent(
  event: CopyEvent,
  chain: ChainContext,
  notify: (html: string) => void
): void {
  const feed = feedFor(bot, currentRuntime().chatId);

  switch (event.type) {
    case "signal":
      feed.countDetected();
      feed.push(
        `sig:${event.contract.toLowerCase()}`,
        `👁 mint ${contractLabel(event.contract)} · ${esc(chain.name)}`,
        `target ${esc(short(event.target))} · block ${event.block}`
      );
      break;
    case "skipped":
      feed.countSkipped();
      // Keyed on the reason, not the contract: forty "Already firing" skips in
      // a row are one fact, and reading it forty times obscures the rest.
      // The fix goes on the card, not just in the journal. A reason without a
      // remedy is the thing that made these unreadable — "Price above ceiling"
      // told nobody which number to change.
      feed.push(
        `skip:${event.reason}`,
        `⏭ ${esc(event.reason)}`,
        [event.detail ? esc(event.detail) : undefined, event.fix ? `→ ${esc(event.fix)}` : undefined]
          .filter(Boolean)
          .join("\n") || undefined
      );
      break;
    case "simulated":
      // Which rung did it matters more than the selector: "copying their exact
      // mint" and "their stage was closed to us, buying the public one" are
      // different purchases and the operator should never have to infer which.
      feed.push(
        `sim:${event.strategy}`,
        `✅ ${event.strategy === "public-stage" ? "Buying its public stage" : "Copying their mint"} · test run passed`,
        esc(event.how)
      );
      break;
    case "firing":
      feed.push(
        `fire:${event.walletCount}`,
        `🚀 firing ${event.walletCount} wallet(s) · ${eth(event.totalCommitWei)} ETH`,
        // Which wallet paid is the one fact that distinguishes a vault copy from
        // a normal one, and it is what an operator checks first if a copy looks
        // wrong. Only shown when it is not the target, since that is the news.
        [
          event.trimReason ? `trimmed by ${esc(event.trimReason)}` : undefined,
          event.paidBy ? `source paid by ${esc(short(event.paidBy))}` : undefined,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      );
      break;
    case "result": {
      // A result is history, not state — it goes out as its own message and
      // closes the rolling card so the two do not compete.
      feed.countFired(event.result.accepted);
      void feed.close();
      const r = event.result;
      notify(renderCopyResult(r, chain));
      break;
    }
  }
}

async function showWalletImport(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      `<b>Import an existing wallet</b>`,
      ``,
      `Choose a private key, or import the first account(s) from another BIP-39 seed phrase.`,
      ``,
      `<i>The secret message is deleted immediately after the bot reads it. Telegram`,
      `cloud chats are not end-to-end encrypted, and the VPS operator can access`,
      `wallets while the service is running. Imported wallets start manual-only.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: walletImportMenu() }
  );
}

async function beginWalletSecretImport(
  ctx: Context,
  kind: "key" | "seed",
  count = 1
): Promise<void> {
  const flow = startFlow(ctx.chat!.id, "importWallet", "secret");
  flow.importCount = kind === "seed" ? count : 0;
  await ctx.reply(
    [
      `<b>${kind === "seed" ? `Import ${count} seed account${count === 1 ? "" : "s"}` : "Import private key"}</b>`,
      ``,
      kind === "seed"
        ? `Send the 12- or 24-word BIP-39 seed phrase in your next message.`
        : `Send the 64-character private key in your next message.`,
      ``,
      `<b>Do not send this secret to anyone else.</b> This bot deletes the`,
      `message after reading it, but Telegram will still have transported it.`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: backTo("x", "✕ Cancel") }
  );
}

async function importWalletSecret(ctx: Context, flow: Flow, secret: string): Promise<void> {
  // Best-effort deletion happens before validation or any reply, so invalid
  // secrets do not linger in chat either.
  await ctx.deleteMessage().catch(() => undefined);
  try {
    const entries =
      (flow.importCount ?? 0) > 0
        ? importEntriesFromMnemonic(secret, flow.importCount!)
        : [{ privateKey: secret }];
    const result = session.store.importKeys(entries);
    clearFlow(ctx.chat!.id);

    await ctx.reply(
      [
        `<b>Wallet import complete</b>`,
        ``,
        `${result.added.length} added · ${result.duplicates.length} already present`,
        ...result.added.slice(0, 10).map((address) => `<code>${esc(address)}</code>`),
        result.added.length > 10 ? `…and ${result.added.length - 10} more` : ``,
        ``,
        `<i>Imported wallets are manual-only. Use Wallets → Auto-fire only if`,
        `you deliberately want them to spend on copy signals.</i>`,
      ]
        .filter(Boolean)
        .join("\n"),
      { parse_mode: "HTML", reply_markup: walletsMenu() }
    );
  } catch (err) {
    await ctx.reply(
      `⚠️ ${esc((err as Error).message)}\n\nThe secret message was deleted. Send it again, or tap Cancel.`,
      { parse_mode: "HTML", reply_markup: backTo("x", "✕ Cancel") }
    );
  }
}

async function cmdImportDocument(ctx: Context): Promise<void> {
  const document = ctx.message?.document;
  if (!document) return;

  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram did not return a file path.");

    const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download the file (HTTP ${response.status}).`);
    const contents = await response.text();

    const entries = readImportBlob(contents, currentRuntime().passphrase);
    const result = session.store.importKeys(entries);

    await ctx.reply(
      [
        `<b>Imported ${result.added.length} wallet(s)</b>`,
        ``,
        ...result.added.slice(0, 10).map((a) => `<code>${esc(a)}</code>`),
        result.added.length > 10 ? `…and ${result.added.length - 10} more` : ``,
        result.duplicates.length > 0 ? `\n${result.duplicates.length} already present.` : ``,
        ``,
        `<i>Imported wallets are manual-only. They will not fire on copy signals`,
        `until you run</i> <code>/autofire &lt;address&gt; on</code>.`,
      ]
        .filter(Boolean)
        .join("\n"),
      { parse_mode: "HTML" }
    );
  } catch (err) {
    await fail(ctx, err);
  }
}

// ── Per-user settings ─────────────────────────────────────────────────────

async function showUserSettings(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      `<b>Your settings</b>`,
      ``,
      `NFT vault`,
      config.vault === ZeroAddress ? `<i>Not set yet</i>` : `<code>${esc(config.vault)}</code>`,
      ``,
      `Funding wallet`,
      config.funder === ZeroAddress
        ? `<i>Created automatically with your wallet store</i>`
        : `<code>${esc(config.funder)}</code>`,
      ``,
      `<i>NFT sweeps go to the vault. ETH is funded from and reclaimed to your`,
      `derived funding wallet. Changing the vault never moves existing assets.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: settingsMenu(!isReady()) }
  );
}

async function beginDestinationChange(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  startFlow(chatId, "destination", "address");
  await ctx.reply(
    [
      `<b>Change NFT vault</b>`,
      ``,
      `Send the Ethereum/Base <code>0x…</code> address that should receive`,
      `your NFT sweeps. You will confirm it before it is saved.`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: backTo("cfg:menu", "✕ Cancel") }
  );
}

async function saveDestination(ctx: Context, value: string): Promise<void> {
  if (!isAddress(value)) {
    await ctx.reply("That NFT vault is invalid. Start again from Settings.");
    return;
  }
  const destination = getAddress(value);
  updateUserSettings({ destination });
  config.vault = destination;
  clearFlow(ctx.chat!.id);
  await ctx.reply(
    [
      `<b>NFT vault saved</b>`,
      ``,
      `<code>${esc(destination)}</code>`,
      ``,
      `<i>Future NFT sweeps use this address.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: settingsMenu(!isReady()) }
  );
}

// ── Button UI ─────────────────────────────────────────────────────────────

// ── First-run setup ───────────────────────────────────────────────────────
//
// The wallet store used to be created over SSH by `wallets.js init`, which put
// the recovery phrase on the terminal of whoever was deploying the box. Doing it
// from chat instead puts the phrase in front of the person who actually owns the
// wallets, and nobody else.
//
// The tradeoff is real and worth naming: a phrase shown in Telegram has crossed
// Telegram's servers, and cloud chats are not end-to-end encrypted. That is why
// the message carrying it is deleted on confirmation and, failing that, on a
// timer — and why the warning below is not skippable.

const PHRASE_TTL_MS = 10 * 60_000;
const pendingBurn = new Map<number, NodeJS.Timeout>();

const SETUP_HEADER = [
  `<b>Copymint — setup</b>`,
  ``,
  `No wallet store exists yet, so there is nothing to mint with.`,
  ``,
  `First set your NFT vault in Settings. Then create your own`,
  `encrypted wallet store and write down its recovery phrase.`,
  ``,
  `Creating one generates a 12-word recovery phrase and shows it to you <b>once</b>.`,
  `Have a pen ready before you tap.`,
].join("\n");

async function showSetup(ctx: Context): Promise<void> {
  // A store on disk while the session is still down means creation succeeded
  // but opening it did not — an RPC outage at exactly the wrong moment. The
  // phrase is already generated, so offering "create" again would only refuse.
  if (storeExists()) {
    await ctx.reply(
      [
        `<b>Store exists, session down</b>`,
        ``,
        `The wallet store was created, but no chain could be reached to bring`,
        `the bot online. Your recovery phrase is still valid — nothing is lost.`,
        ``,
        `Tap retry once the RPC endpoints are reachable.`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("↻ Retry", "s:retry") }
    );
    return;
  }
  await ctx.reply(SETUP_HEADER, { parse_mode: "HTML", reply_markup: setupMenu() });
}

async function beginSeedRestore(ctx: Context): Promise<void> {
  if (isReady() || storeExists()) {
    await ctx.reply(
      "A wallet store already exists. Use Wallets → Import wallet to merge accounts from another seed."
    );
    return;
  }
  if (config.vault === ZeroAddress) {
    await ctx.reply("Set your NFT vault before restoring a wallet store.", {
      reply_markup: settingsMenu(true),
    });
    return;
  }
  startFlow(ctx.chat!.id, "restore", "secret");
  await ctx.reply(
    [
      `<b>Restore an existing seed</b>`,
      ``,
      `Send your 12- or 24-word BIP-39 phrase in the next message. Its first`,
      `account becomes your funding wallet; you can derive the rest here.`,
      ``,
      `<b>The message will be deleted immediately after it is read.</b> Telegram`,
      `cloud chats are not end-to-end encrypted, so only continue if you accept`,
      `the hosted/custodial security tradeoff described in What is this?`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: backTo("s:cancel", "✕ Cancel") }
  );
}

async function restoreSeed(ctx: Context, phrase: string): Promise<void> {
  await ctx.deleteMessage().catch(() => undefined);
  try {
    initFromMnemonic(phrase, currentRuntime().passphrase);
  } catch (err) {
    await ctx.reply(
      `⚠️ ${esc((err as Error).message)}\n\nThe phrase message was deleted. Send it again, or tap Cancel.`,
      { parse_mode: "HTML", reply_markup: backTo("s:cancel", "✕ Cancel") }
    );
    return;
  }

  clearFlow(ctx.chat!.id);
  try {
    await startSession();
  } catch (err) {
    await ctx.reply(
      [
        `<b>Seed restored — session temporarily offline</b>`,
        ``,
        esc((err as Error).message),
        ``,
        `<i>The encrypted store is safe. Tap retry when the RPC is reachable.</i>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("↻ Retry", "s:retry") }
    );
    return;
  }

  await ctx.reply(
    [
      `<b>Existing seed restored</b>`,
      ``,
      `Funding wallet`,
      `<code>${esc(config.funder)}</code>`,
      ``,
      `<i>The phrase message was deleted. Generate any additional mint wallets`,
      `you want; they derive from the restored phrase.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: afterSetupMenu() }
  );
}

async function cmdSetupRetry(ctx: Context): Promise<void> {
  if (isReady()) {
    await ctx.reply("Already running.", {
      reply_markup: mainMenu(session.copyEnabled, targets.list().length),
    });
    return;
  }
  await startSession();
  await ctx.reply(`<b>Back up.</b>\n\n${session.wallets().length} wallets ready.`, {
    parse_mode: "HTML",
    reply_markup: afterSetupMenu(),
  });
}

async function cmdSetupExplain(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      `<b>What the store is</b>`,
      ``,
      `One 12-word BIP-39 phrase, encrypted on the server, from which every`,
      `wallet is derived. Deriving 500 wallets writes nothing new — they all`,
      `come out of those same 12 words, so one backup covers the whole set`,
      `however many you generate later.`,
      ``,
      `<b>What the phrase is worth</b>`,
      ``,
      `Anyone holding it controls every derived wallet, permanently. It is`,
      `shown once and the bot never displays it again. The encrypted server`,
      `copy can be opened by the running service or a server administrator who`,
      `has the master secret — this is a hosted, custodial bot.`,
      ``,
      `<b>Where it will appear</b>`,
      ``,
      `In this chat. Telegram cloud chats are not end-to-end encrypted, so the`,
      `phrase passes through Telegram's servers on the way to you. The message`,
      `is deleted once you confirm, and automatically after 10 minutes — but`,
      `deletion is a cleanup, not a guarantee about what Telegram retained.`,
      ``,
      `<i>If that is not acceptable, stop here and create the store over SSH`,
      `instead: </i><code>wallets.js init</code><i> prints it to a terminal and nothing`,
      `else.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: setupMenu() }
  );
}

async function cmdSetupWarn(ctx: Context): Promise<void> {
  if (isReady()) {
    await ctx.reply("A wallet store already exists — setup is done.", {
      reply_markup: mainMenu(session.copyEnabled, targets.list().length),
    });
    return;
  }
  if (config.vault === ZeroAddress) {
    await ctx.reply("Set your NFT vault before creating wallets.", {
      reply_markup: settingsMenu(true),
    });
    return;
  }
  await ctx.reply(
    [
      `<b>Before you tap</b>`,
      ``,
      `The next message contains your recovery phrase in plain text.`,
      ``,
      `· Write it on paper. Not a screenshot, not a note app.`,
      `· It is shown once and cannot be recovered afterwards.`,
      `· Anyone who reads it owns every wallet this bot derives.`,
      ``,
      `The message is deleted when you confirm, and after 10 minutes if you`,
      `don't. It still travelled through Telegram to reach you.`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: setupConfirm() }
  );
}

async function cmdSetupCreate(ctx: Context): Promise<void> {
  if (isReady() || storeExists()) {
    await ctx.reply("A wallet store already exists — refusing to overwrite it.");
    return;
  }
  if (config.vault === ZeroAddress) {
    await ctx.reply("Set your NFT vault before creating wallets.", {
      reply_markup: settingsMenu(true),
    });
    return;
  }

  // Each chat gets a key derived from the server master secret and its chat id,
  // so one user's encrypted files cannot be opened as another user's store.
  const secret = currentRuntime().passphrase;
  if (!secret) {
    await ctx.reply(
      "No passphrase is configured. Set <code>COPYMINT_PASSPHRASE</code> in " +
        "<code>/etc/copymint/env</code> and restart the service.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const phrase = initNew(secret);
  const chatId = ctx.chat!.id;

  const sent = await ctx.reply(
    [
      `🔐 <b>RECOVERY PHRASE — write this down now</b>`,
      ``,
      `<code>${esc(phrase)}</code>`,
      ``,
      `<i>Restores every derived wallet. Shown once. Tap it to copy, but paper`,
      `is what survives a lost phone.</i>`,
      ``,
      `<i>It does not back up imported keys — those live in imported.enc and`,
      `need their own backup.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: phraseWritten() }
  );

  // Backstop: an operator who wanders off must not leave the phrase on screen.
  pendingBurn.set(
    chatId,
    setTimeout(() => {
      pendingBurn.delete(chatId);
      void bot.api.deleteMessage(chatId, sent.message_id).catch(() => undefined);
    }, PHRASE_TTL_MS)
  );

  try {
    await startSession();
  } catch (err) {
    // The store is on disk and the phrase is in front of them; only the chain
    // resolution failed. Say so plainly rather than letting it read as a
    // failed creation they should retry from scratch.
    await ctx.reply(
      [
        `<b>Store created — but no chain could be reached.</b>`,
        ``,
        esc((err as Error).message),
        ``,
        `<i>Your phrase is valid and the store is saved. Fix the RPC endpoints`,
        `and tap retry — there is nothing to create again.</i>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("↻ Retry", "s:retry") }
    );
    return;
  }

  await ctx.reply(
    [
      `<b>Store created.</b>`,
      ``,
      `${session.availableChains.length} chain(s) live`,
      ``,
      `Your funding wallet`,
      `<code>${esc(config.funder)}</code>`,
      `<i>Send campaign ETH here; the bot disperses it to your mint wallets.</i>`,
      ``,
      `Generate the mint-wallet set next. It costs nothing and writes nothing`,
      `new — your phrase already covers the funding wallet and every mint wallet.`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: afterSetupMenu() }
  );
}

async function cmdSetupBurn(ctx: Context): Promise<void> {
  const chatId = ctx.chat!.id;
  const timer = pendingBurn.get(chatId);
  if (timer) {
    clearTimeout(timer);
    pendingBurn.delete(chatId);
  }
  await ctx.deleteMessage().catch(() => undefined);
}

/**
 * Open the store and start everything that depends on it.
 *
 * Called at boot when a store already exists, and again mid-life the moment
 * setup creates one — which is what lets the bot go from setup mode to fully
 * operational without a restart.
 */
async function startSession(): Promise<void> {
  const runtime = currentRuntime();
  runtime.session = await Session.open(runtime.config, runtime.passphrase);
  ensureFundingWallet();
  console.log(`  chat ${runtime.chatId}: ${session.wallets().length} wallets ready.`);
  for (const chain of session.availableChains) {
    console.log(
      `  ${chain.name}: ${chain.rpc.endpoints.map((e) => e.label).join(", ")}` +
        (chain.rpc.verified ? "" : "  (chain id unverified)")
    );
  }
  await startBackground();
}

function ensureFundingWallet(): ManagedWallet {
  const result = ensureUserFundingWallet(session.store, config.funder);
  if (result.needsConfigUpdate) {
    updateUserSettings({ funder: result.wallet.address });
    config.funder = result.wallet.address;
  }
  return result.wallet;
}

/**
 * Send something to the chat this runtime belongs to.
 *
 * Two rules learned the hard way, both from the same incident — copy-mint
 * buying an NFT every six minutes and saying nothing:
 *
 *   · `clamp` it. Telegram refuses anything over 4,096 characters, and a
 *     renderer that grows with the wallet store crosses that line without
 *     anyone deciding it should.
 *   · never swallow the rejection. A dropped notification must not break the
 *     pipeline, but a silent one is indistinguishable from a bot that never
 *     fired, which is exactly how the mystery lasted. It goes to the log.
 */
function notify(html: string): void {
  const chat = currentRuntime().chatId;
  const text = clamp(html);
  void bot.api
    .sendMessage(chat, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
    .catch((err) => {
      console.log(
        `  Telegram refused a notification for chat ${chat} (${text.length} chars): ` +
          `${(err as Error).message}`
      );
    });
}

/** Nonce hygiene and the copy-mint watcher — both need a live session. */
async function startBackground(): Promise<void> {
  session.startReconcile(30_000, (message, level) => {
    console.log(`  ${message}`);
    // "log" is infrastructure detail: it belongs in journalctl, not in a chat
    // window belonging to somebody who wants to know whether they got the NFT.
    if (level === "report") notify(`🔧 ${esc(message)}`);
  });

  // Telegram I/O happens only after bytes are on the wire.
  await session.startCopy(
    (event, chain) => renderCopyEvent(event, chain, notify),
    (message, level) => {
      console.log(`  ${message}`);
      if (level === "warn") notify(`⚠️ ${esc(message)}`);
    }
  );

  console.log(
    `  Copy-mint: ${targets.list().length} target(s), firing ${session.copyEnabled ? "ON" : "OFF"}.`
  );
}

function menuHeader(): string {
  const watched = targets.list().length;
  return [
    `<b>Copymint</b>`,
    ``,
    `${session.availableChains.length} chain(s) · ${session.wallets().length} wallets`,
    session.copyEnabled
      ? `copy-mint <b>ON</b> · ${watched} target(s)`
      : `copy-mint <b>OFF</b> · ${watched} target(s)`,
  ].join("\n");
}

async function showMenu(ctx: Context, which: string): Promise<void> {
  const watched = targets.list().length;
  const views: Record<string, { text: string; keyboard: ReturnType<typeof mainMenu> }> = {
    main: { text: menuHeader(), keyboard: mainMenu(session.copyEnabled, watched) },
    mint: {
      text: `<b>Mint</b>\n\n<i>Public reads the drop from chain. FCFS asks OpenSea for whatever stage you're eligible for.</i>`,
      keyboard: mintMenu(),
    },
    wallets: {
      text:
        `<b>Wallets</b>\n\n` +
        `<i>Generate from your main seed, or securely import an existing seed/private key. ` +
        `Imported wallets start manual-only. 📊 Dashboard counts how many are funded.</i>`,
      keyboard: walletsMenu(),
    },
    autofire: {
      text:
        `<b>Auto-fire</b>\n\n` +
        `<i>Armed wallets spend on a copy signal without asking. Imported wallets ` +
        `hold real value and stay manual until you say otherwise here.</i>`,
      keyboard: autoFireMenu(),
    },
    money: {
      text: `<b>Money</b>\n\n<i>Funding tops wallets up to a target. Sweeping moves NFTs to the vault and leaves gas in place. Reclaiming pulls the ETH back to the funder when a campaign is done.</i>`,
      keyboard: moneyMenu(),
    },
    copy: {
      text:
        `<b>Copy-mint</b>\n\n` +
        (session.copyEnabled
          ? `<b>ON</b> — signals from ${watched} target(s) will spend without confirmation, bounded by caps.`
          : `<b>OFF</b> — signals are reported but nothing fires.`) +
        `\n\n<i>Each target can copy free mints, paid mints, or both.</i>`,
      keyboard: copyMenu(session.copyEnabled),
    },
  };

  const view = views[which] ?? views.main;
  // Editing keeps one menu message rather than a growing stack of them.
  try {
    await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  } catch {
    await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  }
}

/**
 * Ask which chain, showing what the funder actually holds on each.
 *
 * Reading three balances costs three calls on a button press, which is cheap
 * against the alternative: these flows move money, and picking the chain by
 * default rather than by choice is how a transfer ends up on one where the
 * funder has nothing.
 */
async function askChain(ctx: Context, flow: Flow, title: string): Promise<void> {
  flow.step = "chain";

  const rows = await Promise.all(
    session.availableChains.map(async (chain) => {
      let balanceLabel: string | undefined;
      try {
        const wei = await rpcCall<string>(
          chain.rpc.readUrl,
          "eth_getBalance",
          [config.funder, "latest"],
          6_000
        );
        balanceLabel = `${eth(BigInt(wei))} ${chain.profile.nativeSymbol}`;
      } catch {
        // A chain that will not answer is still selectable; the command itself
        // reports the failure in more detail than a button label could.
        balanceLabel = "unreadable";
      }
      return { key: chain.key, name: chain.name, balanceLabel };
    })
  );

  await ctx.reply(
    [
      `<b>${title}</b>`,
      ``,
      `Which chain?`,
      ``,
      `<i>Balances shown are the funder's</i>`,
      `<code>${esc(short(config.funder))}</code>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: chainKeyboard(rows) }
  );
}

/**
 * Which chain to sweep, labelled with what is actually there.
 *
 * Not askChain: that one shows the funder's ETH, which says nothing about
 * where the NFTs are. The ledger knows how many mints landed on each chain,
 * and that is the number that decides which button to press — on this
 * deployment every NFT is on Robinhood while the configured chain is Base,
 * so a picker without these counts points at the wrong one.
 */
async function askSweepChain(ctx: Context, flow: Flow): Promise<void> {
  flow.step = "chain";

  const ledger = ledgerEntries();
  const rows = session.availableChains.map((chain) => {
    const mints = ledger.filter(
      (e) => e.kind === "mint" && e.chainId === chain.chainId && e.contract
    );
    const collections = new Set(mints.map((e) => e.contract!.toLowerCase())).size;
    return {
      key: chain.key,
      name: chain.name,
      balanceLabel:
        collections === 0
          ? "no mints recorded"
          : `${collections} collection${collections === 1 ? "" : "s"}`,
    };
  });

  await ctx.reply(
    [
      `<b>Sweep NFTs</b>`,
      ``,
      `Which network are the NFTs on?`,
      ``,
      `<i>Counts are collections this bot minted there.</i>`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: chainKeyboard(rows) }
  );
}

/**
 * Where the NFTs should end up.
 *
 * Offers the vault and the wallets that actually hold something on the chosen
 * chain, because "collect everything into one wallet" usually means one of
 * your own. Any other address can still be typed.
 */
async function askSweepDestination(ctx: Context, flow: Flow): Promise<void> {
  flow.step = "address";
  const chain = session.chain(flow.chain);

  // Wallets the ledger says minted on this chain — the plausible destinations,
  // and the ones somebody is most likely to want everything gathered into.
  const minted = new Set(
    ledgerEntries()
      .filter((e) => e.kind === "mint" && e.chainId === chain.chainId)
      .flatMap((e) => e.walletIds)
  );
  const candidates = session.wallets().filter((w) => minted.has(w.id));

  const keyboard = new InlineKeyboard();
  if (config.vault && config.vault !== ZeroAddress) {
    keyboard.text(`🏦 Vault — ${short(config.vault)}`, `sd:${config.vault}`).row();
  }
  for (const wallet of candidates.slice(0, 8)) {
    keyboard.text(`${wallet.id} — ${short(wallet.address)}`, `sd:${wallet.address}`).row();
  }
  keyboard.text("✕ Cancel", "x");

  await ctx.reply(
    [
      `<b>Sweep NFTs</b>  ·  ${esc(chain.name)}`,
      ``,
      `Which wallet should they all go to?`,
      ``,
      candidates.length > 0
        ? `<i>Wallets below are yours, and hold NFTs on this network.</i>`
        : `<i>No wallets here have minted anything yet.</i>`,
      ``,
      `Or send any address in your next message.`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

/** Move a flow to its next step, asking for whatever is still missing. */
async function advanceFlow(ctx: Context, flow: Flow): Promise<void> {
  const label =
    flow.kind === "mint" ? "Public mint" : flow.kind === "fcfs" ? "FCFS mint" : flow.kind;

  // Funding and draining carry no contract, so nothing else can tell them which
  // chain they are for. Asked first: the amount only means something once the
  // chain is known.
  if ((flow.kind === "fund" || flow.kind === "drain") && !flow.chain) {
    return askChain(ctx, flow, flow.kind === "fund" ? "Fund wallets" : "Reclaim ETH");
  }

  // Sweep asks two things, in the order they constrain each other: which chain
  // the NFTs are on, then which wallet they should end up in.
  if (flow.kind === "sweep") {
    if (!flow.chain) return askSweepChain(ctx, flow);
    if (!flow.address) return askSweepDestination(ctx, flow);

    flow.step = "ready";
    const destination = session
      .wallets()
      .find((w) => w.address.toLowerCase() === flow.address!.toLowerCase());
    await ctx.reply(
      [
        `<b>Sweep</b>  ·  ${esc(session.chain(flow.chain).name)}`,
        ``,
        `Move every NFT found in your wallets to:`,
        `<code>${esc(flow.address)}</code>`,
        destination
          ? `<i>your own wallet ${esc(destination.id)}</i>`
          : flow.address.toLowerCase() === config.vault.toLowerCase()
            ? `<i>your configured vault</i>`
            : `<i>⚠️ not one of your wallets — check this address carefully</i>`,
        ``,
        `<i>ETH is left in place so wallets stay armed.</i>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: simpleConfirm("Sweep") }
    );
    return;
  }

  // Draining has nothing else to collect — the chain was the missing piece.
  if (flow.kind === "drain") {
    flow.step = "ready";
    await ctx.reply(
      [
        `<b>Reclaim ETH</b>  ·  ${esc(session.chain(flow.chain).name)}`,
        ``,
        `Send the ETH in every wallet back to the funder:`,
        `<code>${esc(config.funder)}</code>`,
        ``,
        `<i>Each wallet keeps only its own transfer cost. This leaves the set`,
        `unarmed — fund again before minting.</i>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: simpleConfirm("Reclaim") }
    );
    return;
  }

  if (flow.kind === "watch") {
    if (!flow.contract) return;
    await ctx.reply(
      `<b>Watch</b>\n\n<code>${esc(flow.contract)}</code>\n\nHow much do you trust it? The tier sets how many wallets fire on its signals.`,
      { parse_mode: "HTML", reply_markup: tierKeyboard() }
    );
    return;
  }

  if (flow.kind === "fund") {
    if (!flow.amount) {
      await ctx.reply(
        [
          `<b>Fund</b>`,
          ``,
          `Top each wallet up to what balance?`,
          ``,
          `<i>Pick one, tap ✏️ for a custom amount, or just type one.</i>`,
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: amountKeyboard() }
      );
      return;
    }
    if (!flow.selector) {
      await ctx.reply(`<b>Fund</b>\n\nWhich wallets?`, {
        parse_mode: "HTML",
        reply_markup: selectorKeyboard(),
      });
      return;
    }
  }

  if (flow.kind === "mint" || flow.kind === "fcfs") {
    if (flow.quantity === undefined) {
      await ctx.reply(`<b>${label}</b>\n\n<code>${esc(flow.contract ?? "")}</code>\n\nHow many per wallet?`, {
        parse_mode: "HTML",
        reply_markup: quantityKeyboard(),
      });
      return;
    }
    if (!flow.selector) {
      await ctx.reply(`<b>${label}</b>\n\nWhich wallets?`, {
        parse_mode: "HTML",
        reply_markup: selectorKeyboard(),
      });
      return;
    }
  }

  // Everything gathered — state the cost and wait for a deliberate tap.
  flow.step = "ready";
  const chainName = flow.chain ? session.chain(flow.chain).name : undefined;
  await ctx.reply(
    [`<b>${label}</b>`, ``, describeFlow(flow, chainName), ``, `<i>Nothing is sent until you confirm.</i>`].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup:
        flow.kind === "mint" || flow.kind === "fcfs" ? confirmKeyboard() : simpleConfirm(),
    }
  );
}

async function executeFlow(ctx: Context, flow: Flow, waitForOpen: boolean): Promise<void> {
  const chatId = ctx.chat!.id;
  clearFlow(chatId);

  switch (flow.kind) {
    case "mint":
      return runWithArgs(
        ctx,
        [
          flow.contract!,
          String(flow.quantity),
          flow.selector!,
          ...(waitForOpen ? ["wait"] : []),
          ...(flow.chain ? ["on", flow.chain] : []),
        ],
        cmdMint
      );
    case "fcfs":
      // "wait" was silently dropped here, so the ⏳ button fired immediately and
      // a stage that had not opened yet refused every wallet at once.
      return runWithArgs(
        ctx,
        [
          flow.contract!,
          String(flow.quantity),
          flow.selector!,
          ...(waitForOpen ? ["wait"] : []),
          ...(flow.chain ? ["on", flow.chain] : []),
        ],
        cmdFcfs
      );
    case "check":
      return runWithArgs(ctx, [flow.contract!], cmdProbe);
    // `on <chain>` is the override chainFor already understands, so the chosen
    // chain reaches the command the same way a typed one would.
    case "fund":
      return runWithArgs(
        ctx,
        [flow.selector!, flow.amount!, ...(flow.chain ? ["on", flow.chain] : [])],
        cmdFund
      );
    case "sweep":
      return runWithArgs(
        ctx,
        ["all", ...(flow.chain ? ["on", flow.chain] : []), ...(flow.address ? ["to", flow.address] : [])],
        cmdSweep
      );
    case "drain":
      return runWithArgs(
        ctx,
        ["all", ...(flow.chain ? ["on", flow.chain] : [])],
        cmdDrain
      );
    case "watch":
      return runWithArgs(
        ctx,
        [flow.contract!, flow.tier ?? "low", flow.mintMode ?? "both", flow.payer ?? "self"],
        cmdWatch
      );
    case "destination":
      return;
  }
}

async function onCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  // Dismiss the client's spinner immediately; the work happens after.
  await ctx.answerCallbackQuery().catch(() => undefined);

  const [prefix, ...rest] = data.split(":");
  const payload = rest.join(":");

  // Setup buttons are the only ones that work before a store exists, and the
  // only ones that keep working through the transition.
  if (prefix === "s") {
    switch (payload) {
      case "explain":
        return cmdSetupExplain(ctx);
      case "warn":
        return cmdSetupWarn(ctx);
      case "restore":
        return beginSeedRestore(ctx);
      case "create":
        return cmdSetupCreate(ctx);
      case "burn":
        return cmdSetupBurn(ctx);
      case "retry":
        return cmdSetupRetry(ctx);
      case "cancel":
        clearFlow(chatId);
        return showSetup(ctx);
    }
    return;
  }

  // User settings remain available in first-run setup mode, before a wallet
  // store or Session exists.
  if (prefix === "cfg") {
    const [action, ...values] = rest;
    switch (action) {
      case "menu":
        clearFlow(chatId);
        return showUserSettings(ctx);
      case "destination":
        return beginDestinationChange(ctx);
      case "save":
        return saveDestination(ctx, values.join(":"));
    }
    return;
  }

  switch (prefix) {
    case "m":
      return showMenu(ctx, payload);

    case "a":
      switch (payload) {
        case "dash":
          return cmdDashboard(ctx);
        case "dash:refresh":
          return cmdDashboard(ctx, true);
        case "status":
          return cmdStatus(ctx);
        case "why":
          return cmdWhy(ctx);
        case "signals":
          return cmdSignals(ctx);
        case "wallets":
          return runWithArgs(ctx, ["all"], cmdWallets);
        case "balances":
          return runWithArgs(ctx, ["funded"], cmdWallets);
        case "csv":
          return cmdWalletsCsv(ctx);
        case "autofire":
          return runWithArgs(ctx, ["autofire"], cmdWallets);
        case "targets":
          return cmdTargets(ctx);
        case "caps":
          // Doubles as the cancel target for a cap edit, so the pending flow
          // must go — otherwise it swallows whatever is typed next.
          clearFlow(chatId);
          return cmdCaps(ctx);
        case "help":
          await ctx.reply(HELP, { parse_mode: "HTML" });
          return;
      }
      return;

    case "g":
      return runWithArgs(ctx, [payload], cmdGenerate);

    case "im": {
      const [kind, count] = rest;
      if (kind === "menu") return showWalletImport(ctx);
      if (kind === "key") return beginWalletSecretImport(ctx, "key");
      if (kind === "seed") return beginWalletSecretImport(ctx, "seed", Number(count) || 1);
      return;
    }

    case "c":
      return runWithArgs(ctx, [payload], cmdCopy);

    // One-tap remedies offered by the health check. They exist because the
    // setting that silenced this bot was four taps deep and had to be changed
    // on every watched wallet one at a time — a fix nobody was going to find,
    // let alone repeat nineteen times.
    case "fixall":
      return cmdFixAll(ctx, payload);

    // The guided set-up. Copy-mint needs four separate things true at once and
    // they lived on four screens; this is the one path that walks them.
    case "cs": {
      const parts = payload.split(":");
      const step = parts[0];
      const rest = parts.slice(1);
      if (step === "start") return cmdSetupCopy(ctx);
      if (step === "chain") return cmdSetupChain(ctx, rest.join(":"));
      if (step === "wallets") return cmdSetupWallets(ctx, rest.join(":"));
      if (step === "sel") return cmdSetupSelector(ctx, rest.join(":"));
      return cmdSetupCopy(ctx);
    }

    // Page through a wallet list. Stateless — the selector rides in the data.
    case "wp": {
      const [offset, ...selector] = rest;
      return runWithArgs(ctx, [selector.join(":") || "all"], (c) =>
        cmdWallets(c, Number(offset) || 0)
      );
    }

    case "f": {
      const [selector, state] = rest;
      return runWithArgs(ctx, [selector, state], cmdAutoFire);
    }

    case "uw":
      return runWithArgs(ctx, [payload], cmdUnwatch);

    case "tf": {
      const [modeValue, address] = rest;
      const mode = targets.parseMintMode(modeValue);
      const target = targets.setMintMode(address, mode);
      await ctx.reply(
        `<b>Copy filter updated</b>\n\n<code>${esc(short(target.address))}</code> → <b>${mode === "both" ? "free + paid" : `${mode} only`}</b>`,
        { parse_mode: "HTML", reply_markup: targetsKeyboard(targets.list()) }
      );
      return;
    }

    case "cap":
      return askCapAmount(ctx, payload as "event" | "max" | "daily");

    case "cv": {
      const [kind, value] = rest as ["event" | "max" | "daily", string];
      if (value === "custom") {
        const flow = startFlow(chatId, "cap", "amount");
        flow.capKind = kind;
        await ctx.reply(
          `<b>${CAP_LABELS[kind]}</b>\n\nSend the amount in ETH, like <code>0.02</code>.`,
          { parse_mode: "HTML", reply_markup: backTo("a:caps", "✕ Cancel") }
        );
        return;
      }
      return saveCap(ctx, kind, value);
    }

    case "sel": {
      clearFlow(chatId);
      if (payload === "menu") return showWalletSelector(ctx);
      return saveWalletSelector(ctx, payload);
    }

    case "tp": {
      const [payerValue, address] = rest;
      const payer = targets.parsePayer(payerValue);
      const target = targets.setPayer(address, payer);
      await ctx.reply(
        [
          `<b>Payer rule updated</b>`,
          ``,
          `<code>${esc(short(target.address))}</code> → <b>${describePayer(payer)}</b>`,
          ``,
          payer === "any"
            ? `<i>Anything minted to this address is now copied, whoever paid for it.` +
              ` Your spend caps are the only thing bounding what that can cost.</i>`
            : `<i>Only mints this address sends and pays for itself are copied.</i>`,
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return showTarget(ctx, address);
    }

    // ── One target's page ──
    case "tg":
      clearFlow(chatId);
      return showTarget(ctx, payload);

    case "tq":
      return probeTargetActivity(ctx, payload);

    case "tw": {
      const target = targets.find(payload);
      if (!target) return;
      await ctx.reply(
        [
          `<b>Wallets per fire</b>`,
          ``,
          `now <b>${targets.walletsFor(target, config.copy.tiers)}</b>`,
          ``,
          `<i>How many of your wallets mint when this target does. More wallets means`,
          `more of the drop and more spent — the per-event cap trims it if the total`,
          `would exceed ${eth(config.capPerEventWei)} ETH.</i>`,
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: targetWalletsKeyboard(payload) }
      );
      return;
    }

    case "twv": {
      const [value, address] = rest;
      if (value === "custom") {
        const flow = startFlow(chatId, "targetWallets", "amount");
        flow.address = address;
        await ctx.reply(
          `<b>Wallets per fire</b>\n\nSend a number between 1 and ${targets.MAX_WALLETS_PER_TARGET}.`,
          { parse_mode: "HTML", reply_markup: backTo(`tg:${address}`, "✕ Cancel") }
        );
        return;
      }
      return saveTargetWallets(ctx, address, value);
    }

    case "tpr": {
      const target = targets.find(payload);
      if (!target) return;
      await ctx.reply(
        [
          `<b>Price limit for this target</b>`,
          ``,
          `now <b>${eth(targets.maxPriceFor(target, config.capMaxPriceWei))} ETH</b> per wallet`,
          target.maxPriceEth === undefined ? `<i>(the global cap)</i>` : `<i>(set for this target)</i>`,
          ``,
          `<i>The most one wallet may pay for a single mint from this address. Above it`,
          `the signal is refused outright — this is the bait guard, and it never trims.</i>`,
          ``,
          `<i>Set it per target so a vault you trust can mint dearer drops without`,
          `raising the ceiling for every other address you watch.</i>`,
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: targetPriceKeyboard(payload) }
      );
      return;
    }

    case "tpv": {
      const [value, address] = rest;
      if (value === "custom") {
        const flow = startFlow(chatId, "targetPrice", "amount");
        flow.address = address;
        await ctx.reply(
          `<b>Price limit</b>\n\nSend the amount in ETH, like <code>0.02</code>.`,
          { parse_mode: "HTML", reply_markup: backTo(`tg:${address}`, "✕ Cancel") }
        );
        return;
      }
      return saveTargetPrice(ctx, address, value);
    }

    case "i": {
      const kind = payload as Flow["kind"];
      const flow = startFlow(chatId, kind, "contract");
      // Sweep, fund and drain carry no contract, so none of them can work out
      // which chain they mean. Sweep used to skip straight to a confirmation
      // and then fail inside the command with "this command needs a chain —
      // or run it from the menu, which asks", from the menu, which did not ask.
      if (kind === "sweep" || kind === "drain" || kind === "fund") {
        return advanceFlow(ctx, flow);
      }
      if (kind === "watch") {
        flow.step = "address";
        await ctx.reply(
          `<b>Watch a wallet</b>\n\nSend the address to mirror.`,
          { parse_mode: "HTML", reply_markup: backTo("m:copy", "✕ Cancel") }
        );
        return;
      }
      await ctx.reply(
        [
          `<b>${kind === "check" ? "Probe" : kind === "fcfs" ? "FCFS mint" : "Public mint"}</b>`,
          ``,
          `Send the contract address, or just paste the OpenSea link.`,
          ``,
          `<i>e.g. https://opensea.io/collection/omrevo</i>`,
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: backTo("m:mint", "✕ Cancel") }
      );
      return;
    }

    case "ch": {
      const flow = getFlow(chatId);
      if (!flow) {
        await ctx.reply("That selection expired — start again from the menu.");
        return;
      }
      try {
        // Validates the key and fails loudly if that chain never resolved,
        // rather than carrying an unusable name into the command.
        flow.chain = session.chain(payload).key;
      } catch (err) {
        await fail(ctx, err);
        return;
      }
      return advanceFlow(ctx, flow);
    }

    case "sd": {
      const flow = getFlow(chatId);
      if (!flow) {
        await ctx.reply("That selection expired — start again from the menu.");
        return;
      }
      try {
        flow.address = getAddress(payload);
      } catch {
        await ctx.reply("That destination is not a valid address.");
        return;
      }
      return advanceFlow(ctx, flow);
    }

    case "q": {
      const flow = getFlow(chatId);
      if (!flow) return;
      flow.quantity = Number(payload);
      return advanceFlow(ctx, flow);
    }

    case "w": {
      const flow = getFlow(chatId);
      if (!flow) return;
      flow.selector = payload;
      return advanceFlow(ctx, flow);
    }

    case "v": {
      const flow = getFlow(chatId);
      if (!flow) return;

      if (payload === "custom") {
        // Hand the flow back to onText, which already knows how to read an
        // amount — this only makes that path visible.
        flow.step = "amount";
        flow.amount = undefined;
        await ctx.reply(
          [
            `<b>Custom amount</b>`,
            ``,
            `Send the ETH balance to top each wallet up to.`,
            ``,
            `<i>A plain number, like</i> <code>0.0035</code><i>. Wallets already at or`,
            `above it are skipped, so only the shortfall is ever sent.</i>`,
          ].join("\n"),
          { parse_mode: "HTML", reply_markup: backTo("x", "✕ Cancel") }
        );
        return;
      }

      flow.amount = payload;
      return advanceFlow(ctx, flow);
    }

    case "t": {
      const flow = getFlow(chatId);
      if (!flow) return;
      flow.tier = payload;
      if (flow.kind === "watch") {
        await ctx.reply(
          `<b>Watch filter</b>\n\nWhich mints from this target should be copied?`,
          { parse_mode: "HTML", reply_markup: mintModeKeyboard() }
        );
        return;
      }
      return executeFlow(ctx, flow, false);
    }

    case "pm": {
      const flow = getFlow(chatId);
      if (!flow || flow.kind !== "watch") return;
      flow.mintMode = targets.parseMintMode(payload);
      await ctx.reply(
        [
          `<b>Whose transactions count?</b>`,
          ``,
          `<b>Only what it sends itself</b> — the safe default. Copies mints this`,
          `address paid for out of its own wallet.`,
          ``,
          `<b>Anything minted to it</b> — for a vault. Serious minters fire from`,
          `rotating throwaway wallets and credit one cold address, so the vault`,
          `never sends a mint of its own. Pick this and the payer is not checked:`,
          `anything minted <i>to</i> that address gets copied.`,
          ``,
          `<i>The catch — anyone can mint something to an address unbidden, so this`,
          `widens what can trigger a spend. Your caps are what bound it.</i>`,
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: payerKeyboard() }
      );
      return;
    }

    case "pa": {
      const flow = getFlow(chatId);
      if (!flow || flow.kind !== "watch") return;
      flow.payer = targets.parsePayer(payload);
      return executeFlow(ctx, flow, false);
    }

    case "go": {
      const flow = getFlow(chatId);
      if (!flow) {
        await ctx.reply("That selection expired — start again from the menu.");
        return;
      }
      return executeFlow(ctx, flow, payload === "wait");
    }

    case "x":
      clearFlow(chatId);
      await ctx.reply("Cancelled.", { reply_markup: mainMenu(session.copyEnabled, targets.list().length) });
      return;
  }
}

/** A plain message answers whatever the active flow asked for. */
async function onText(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const text = (ctx.message?.text ?? "").trim();
  if (chatId === undefined || text.startsWith("/")) return;

  const flow = getFlow(chatId);
  if (!flow) return;

  if (flow.step === "secret") {
    if (flow.kind === "restore") return restoreSeed(ctx, text);
    if (flow.kind === "importWallet") return importWalletSecret(ctx, flow, text);
    return;
  }

  if (flow.kind === "destination" && flow.step === "address") {
    if (!isAddress(text)) {
      await ctx.reply("That doesn't look like an address. Send a 0x… address, or tap Cancel.");
      return;
    }
    flow.address = getAddress(text);
    flow.step = "ready";
    await ctx.reply(
      [
        `<b>Confirm NFT vault</b>`,
        ``,
        `<code>${esc(flow.address)}</code>`,
        ``,
        `Future NFT sweeps will go here.`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: destinationConfirm(flow.address, !isReady()) }
    );
    return;
  }

  // A sweep destination typed by hand rather than picked off the keyboard.
  // Everything the buttons offer is already known-good, so this is the only
  // path that can name an address outside the wallet set — and the confirmation
  // advanceFlow builds says so in as many words before anything moves.
  if (flow.kind === "sweep" && flow.step === "address") {
    if (!isAddress(text)) {
      await ctx.reply("That doesn't look like an address. Send a 0x… address, or tap Cancel.");
      return;
    }
    flow.address = getAddress(text);
    return advanceFlow(ctx, flow);
  }

  // A wallet to mirror is an address and nothing else — a collection link here
  // would be a different kind of thing entirely, so it is not offered.
  if (flow.kind === "watch" && flow.step === "address") {
    if (!isAddress(text)) {
      await ctx.reply("That doesn't look like an address. Send a 0x… address, or tap Cancel.");
      return;
    }
    flow.contract = getAddress(text);
    flow.step = "ready";
    return advanceFlow(ctx, flow);
  }

  if (flow.step === "contract" || flow.step === "address") {
    let resolved;
    try {
      resolved = await resolveCollectionInput(
        text,
        (process.env.OPENSEA_API_KEY ?? "").trim() || undefined,
        config.chain
      );
    } catch (err) {
      await ctx.reply(
        [
          `⚠️ ${esc((err as Error).message)}`,
          ``,
          `<i>Any of these work:</i>`,
          `· the contract address, <code>0x</code> plus 40 hex characters`,
          `· the OpenSea link, <code>opensea.io/collection/…</code>`,
          `· the collection slug on its own`,
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    flow.contract = resolved.address;
    flow.step = "ready";

    // Work out the chain from where the code actually lives, and say so. The
    // same address deployed on two chains via CREATE2 is genuinely ambiguous,
    // and picking one silently is how a mint lands on the wrong network — so
    // that case asks instead.
    let detected: ChainContext | undefined;
    try {
      const found = await session.detectChain(resolved.address);
      if (found.ambiguous) {
        await ctx.reply(
          [
            `🔗 <b>${esc(resolved.name ?? short(resolved.address))}</b>`,
            `<code>${esc(resolved.address)}</code>`,
            ``,
            `<i>This address has code on more than one chain.</i>`,
          ].join("\n"),
          { parse_mode: "HTML" }
        );
        return askChain(ctx, flow, "Which network?");
      }
      detected = found.chain;
      flow.chain = found.chain.key;
    } catch (err) {
      await fail(ctx, err);
      return;
    }

    await ctx.reply(
      [
        `🔗 <b>${esc(resolved.name ?? resolved.slug ?? short(resolved.address))}</b>`,
        `<code>${esc(resolved.address)}</code>`,
        `<i>on ${esc(detected.name)}</i>`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
    return advanceFlow(ctx, flow);
  }

  // A cap is not a funding amount and must not borrow its ceiling — a 2 ETH
  // daily budget is ordinary, while 2 ETH *per wallet* is a fat-finger.
  if (flow.kind === "cap" && flow.step === "amount" && flow.capKind) {
    return saveCap(ctx, flow.capKind, text.trim());
  }

  // Per-target values, each validated by its own setter so a bad one reports
  // what was wrong with it rather than silently reverting to a default.
  if (flow.kind === "targetWallets" && flow.address) {
    const count = Number(text.trim());
    if (!Number.isInteger(count)) {
      await ctx.reply(
        `Send a whole number between 1 and ${targets.MAX_WALLETS_PER_TARGET}, or tap Cancel.`
      );
      return;
    }
    return saveTargetWallets(ctx, flow.address, String(count));
  }

  if (flow.kind === "targetPrice" && flow.address) {
    return saveTargetPrice(ctx, flow.address, text.trim());
  }

  if (flow.step === "amount") {
    const parsed = parseFundAmount(text, MAX_FUND_PER_WALLET_WEI);

    if (!parsed.ok) {
      switch (parsed.reason) {
        case "zero":
          await ctx.reply("Zero would fund nothing. Send an amount above 0, or tap Cancel.");
          return;
        case "too_large":
          await ctx.reply(
            [
              `⚠️ That is above the ${eth(MAX_FUND_PER_WALLET_WEI)} ETH per-wallet ceiling.`,
              ``,
              `<i>Funding tops up every selected wallet to that balance, so the amount`,
              `is multiplied by the size of the set. If you meant it, use</i>`,
              `<code>/fund &lt;selector&gt; &lt;eth&gt;</code><i> on a smaller selection.</i>`,
            ].join("\n"),
            { parse_mode: "HTML" }
          );
          return;
        default:
          await ctx.reply(
            "Send a plain ETH amount, like <code>0.002</code> — digits and one decimal point.",
            { parse_mode: "HTML" }
          );
          return;
      }
    }

    flow.amount = parsed.text;
    return advanceFlow(ctx, flow);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────

let bot: Bot;

async function main(): Promise<void> {
  // The root config supplies shared RPC, gas and policy defaults. Each private
  // chat receives a separate copy under users/<chatId>/ and changes only that.
  writeDefaultConfig();

  try {
    bootstrapConfig = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Environment first so systemd can start unattended; console otherwise.
  masterPassphrase = (process.env.COPYMINT_PASSPHRASE || "").trim();
  if (!masterPassphrase) {
    if (!process.stdin.isTTY) {
      console.error(
        "\n  No passphrase. Set COPYMINT_PASSPHRASE, or start with a terminal attached.\n"
      );
      process.exit(1);
    }
    masterPassphrase = await askPassphrase("  Store passphrase: ");
  }

  bot = new Bot(bootstrapConfig.telegramToken);

  // Every private chat is a user boundary. The state-path and runtime contexts
  // wrap the entire update, including timers and background work it creates.
  bot.use((ctx, next) => runForUser(ctx, next));

  // Setup gate. Until a store exists there is no session to operate on, so
  // nothing downstream may run — every route below can assume `session` is
  // live because this refuses everything except the setup buttons.
  bot.use(async (ctx, next) => {
    if (isReady()) return next();
    const callback = ctx.callbackQuery?.data ?? "";
    if (callback.startsWith("s:") || callback.startsWith("cfg:")) return next();
    if ((ctx.message?.text ?? "").startsWith("/settings")) return next();
    const chatId = ctx.chat?.id;
    if (
      chatId !== undefined &&
      ["destination", "restore"].includes(getFlow(chatId)?.kind ?? "")
    ) {
      return next();
    }
    // Only a callback update has a query to answer — asking otherwise throws
    // synchronously and would swallow the setup screen.
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
    await showSetup(ctx);
  });

  bot.command(["start", "menu"], (ctx) =>
    ctx.reply(menuHeader(), {
      parse_mode: "HTML",
      reply_markup: mainMenu(session.copyEnabled, targets.list().length),
    })
  );
  bot.command("settings", (ctx) => showUserSettings(ctx));
  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));
  bot.command("dashboard", (ctx) => cmdDashboard(ctx).catch((e) => fail(ctx, e)));
  bot.command("status", (ctx) => cmdStatus(ctx).catch((e) => fail(ctx, e)));
  bot.command("why", (ctx) => cmdWhy(ctx).catch((e) => fail(ctx, e)));
  bot.command("setup", (ctx) => cmdSetupCopy(ctx).catch((e) => fail(ctx, e)));
  bot.command("signals", (ctx) => cmdSignals(ctx).catch((e) => fail(ctx, e)));
  bot.command("wallets", (ctx) => cmdWallets(ctx).catch((e) => fail(ctx, e)));
  bot.command("import", (ctx) => showWalletImport(ctx).catch((e) => fail(ctx, e)));
  bot.command("generate", (ctx) => cmdGenerate(ctx).catch((e) => fail(ctx, e)));
  bot.command("autofire", (ctx) => cmdAutoFire(ctx).catch((e) => fail(ctx, e)));
  bot.command("tag", (ctx) => cmdTag(ctx, false).catch((e) => fail(ctx, e)));
  bot.command("untag", (ctx) => cmdTag(ctx, true).catch((e) => fail(ctx, e)));
  bot.command("fund", (ctx) => cmdFund(ctx).catch((e) => fail(ctx, e)));
  bot.command("sweep", (ctx) => cmdSweep(ctx).catch((e) => fail(ctx, e)));
  bot.command("drain", (ctx) => cmdDrain(ctx).catch((e) => fail(ctx, e)));
  bot.command("mint", (ctx) => cmdMint(ctx).catch((e) => fail(ctx, e)));
  bot.command("check", (ctx) => cmdCheck(ctx).catch((e) => fail(ctx, e)));
  bot.command("allowlist", (ctx) => cmdAllowList(ctx).catch((e) => fail(ctx, e)));
  bot.command("probe", (ctx) => cmdProbe(ctx).catch((e: unknown) => fail(ctx, e)));
  bot.command("fcfs", (ctx) => cmdFcfs(ctx).catch((e: unknown) => fail(ctx, e)));
  bot.command("watch", (ctx) => cmdWatch(ctx).catch((e) => fail(ctx, e)));
  bot.command("unwatch", (ctx) => cmdUnwatch(ctx).catch((e) => fail(ctx, e)));
  bot.command("targets", (ctx) => cmdTargets(ctx).catch((e) => fail(ctx, e)));
  bot.command("copy", (ctx) => cmdCopy(ctx).catch((e) => fail(ctx, e)));
  bot.command("caps", (ctx) => cmdCaps(ctx).catch((e) => fail(ctx, e)));
  bot.on("message:document", (ctx) => cmdImportDocument(ctx));
  bot.on("callback_query:data", (ctx) => onCallback(ctx).catch((e: unknown) => fail(ctx, e)));
  bot.on("message:text", (ctx) => onText(ctx).catch((e: unknown) => fail(ctx, e)));

  bot.catch((err) => console.error("  Bot error:", err.message));

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // Publish the "/" menu. Never fatal: a bot that cannot reach Telegram to
  // register its command list still works perfectly for anyone who types the
  // commands, and refusing to start over a cosmetic call would be absurd.
  try {
    await bot.api.setMyCommands(BOT_COMMANDS);
  } catch (err) {
    console.error(`  Could not publish the command menu: ${(err as Error).message}`);
  }

  console.log("  Multi-user bot running. Each private chat has isolated state.\n");
  void resumeStoredUsers().catch((err) =>
    console.error(`  Stored-user resume failed: ${(err as Error).message}`)
  );
  await bot.start();
}

async function shutdown(): Promise<void> {
  console.log("\n  Shutting down…");
  for (const pending of runtimePromises.values()) {
    try {
      const runtime = await pending;
      runtime.session?.stopCopy();
      runtime.session?.stopReconcile();
    } catch {
      // A runtime that never opened has no background work to stop.
    }
  }
  await bot?.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
