// Telegram bot entry point.
//
// Access control is two-layered, as designed. The chat-id whitelist keeps
// strangers out. The pinned vault and funder addresses in config.json keep a
// *compromised* account from being useful: every command below can move value
// only toward addresses that are unreachable from chat, so an attacker holding
// your Telegram session can waste gas and nothing else.
//
// The passphrase is never a chat command — it comes from the environment or the
// console at boot.

import { Bot, InputFile, Context } from "grammy";
import { isAddress, getAddress, parseEther } from "ethers";
import { config as loadEnv } from "dotenv";
import { loadConfig, ResolvedConfig, ConfigError } from "../core/config";
import { Session, ChainContext } from "./session";
import { ManagedWallet } from "../core/wallet-store";
import { readImportBlob } from "../core/wallet-store";
import { resolve as resolveWallets, summarise, SelectorError } from "../core/tags";
import { gasReservation, shortfalls } from "../core/balances";
import { planFunding, executeFunding } from "../core/funding";
import { discoverHoldings, sweepNfts, latestBlock } from "../core/holdings";
import { executePublicMint, MintEvent, MintReport } from "../core/mint-public";
import { earliestMintBlock, mintedContracts, spentSince } from "../core/ledger";
import * as targets from "../core/targets";
import { CopyEvent } from "../core/copy-mint";
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
  fetchDrop,
  probeIssuance,
  stageIsLive,
  describeStage,
  OpenSeaApiError,
} from "../core/opensea-api";
import {
  executeOpenSeaMint,
  OpenSeaMintEvent,
  OpenSeaMintReport,
} from "../core/mint-opensea";
import { StatusCard, esc, eth, bar, short, toCsv, txLink } from "./ui";
import { askPassphrase } from "../tools/tty";
import {
  Flow,
  startFlow,
  getFlow,
  clearFlow,
  mainMenu,
  mintMenu,
  walletsMenu,
  moneyMenu,
  copyMenu,
  quantityKeyboard,
  selectorKeyboard,
  tierKeyboard,
  amountKeyboard,
  confirmKeyboard,
  simpleConfirm,
  backTo,
  describeFlow,
} from "./menu";

loadEnv();

let session: Session;
let config: ResolvedConfig;

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

async function select(
  selector: string,
  ctx: Context,
  chainKey: string,
  force = false
): Promise<ManagedWallet[] | null> {
  try {
    const tagCtx = await session.tagContext(chainKey, force);
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
  const onIndex = parts.indexOf("on");
  if (onIndex !== -1 && parts[onIndex + 1]) {
    return session.chain(parts[onIndex + 1]);
  }
  if (contract && isAddress(contract)) {
    try {
      return (await session.detectChain(contract)).chain;
    } catch {
      // No code anywhere, or every probe failed — fall back to the default so
      // the command can report a more specific error than "unknown chain".
    }
  }
  return session.chain();
}

// ── Commands ──────────────────────────────────────────────────────────────

const HELP = `<b>Copymint</b>

<b>Wallets</b>
/status — set overview, balances, nonce health
/wallets [selector] — list matching wallets
/generate &lt;n&gt; — derive n more wallets
/autofire &lt;selector&gt; on|off — autonomous firing per wallet
/tag &lt;selector&gt; &lt;tag&gt; · /untag &lt;selector&gt; &lt;tag&gt;

<b>Money</b>
/fund &lt;selector&gt; &lt;eth&gt; — top wallets up to a target balance
/sweep [selector] [contract] — move NFTs to the vault, leave gas

<b>Minting</b>
/mint &lt;contract&gt; &lt;qty&gt; [selector] [wait] — public SeaDrop mint
/check &lt;contract&gt; [listUrl] — who's on the allowlist
/allowlist &lt;contract&gt; &lt;qty&gt; [selector] [wait] — FCFS allowlist mint

<b>FCFS via OpenSea</b> <i>(needs OPENSEA_API_KEY)</i>
/probe &lt;contract&gt; — stages, and what OpenSea will issue now
/fcfs &lt;contract&gt; &lt;qty&gt; [selector] [at HH:MM] — allowlist/signed/public,
whichever you're eligible for. Times are UTC.

<b>Copy-mint</b>
/watch &lt;address&gt; [high|med|low] [label] — mirror a wallet's mints
/unwatch &lt;address&gt; · /targets — manage the watch list
/copy on|off — autonomous firing kill switch
/caps — spend limits and today's usage

<b>Selectors</b>
<code>all</code> <code>derived</code> <code>imported</code> <code>funded</code> <code>stuck</code> <code>autofire</code> <code>manual</code>
<code>0-99</code> index range · <code>0x…</code> address · <code>+</code> and · <code>,</code> or · <code>!</code> not

Import keys by uploading a <code>keys.enc</code> file made with <code>npm run encrypt-keys</code>.`;

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
    `<b>Destinations</b> <i>(config only, not settable here)</i>`,
    `  vault  <code>${esc(config.vault)}</code>`,
    `  funder <code>${esc(config.funder)}</code>`,
    ``,
    `<i>Commands detect the chain from the contract. Add</i> <code>on ethereum</code> <i>to force one.</i>`
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function cmdWallets(ctx: Context): Promise<void> {
  const chain = await chainFor(ctx);
  const selector = args(ctx)[0] ?? "all";
  const matched = await select(selector, ctx, chain.key, true);
  if (!matched) return;

  const balances = await session.balances();
  const shown = matched.slice(0, 25);
  const lines = shown.map((w) => {
    const balance = balances.get(w.address) ?? 0n;
    const origin = w.kind === "derived" ? `d${w.index}` : "imp";
    return `<code>${origin.padEnd(5)}${short(w.address)}</code>  ${eth(balance, 4)}  ${
      w.autoFire ? "auto" : "manual"
    }`;
  });

  await ctx.reply(
    [
      `<b>${matched.length} wallet(s)</b> matching <code>${esc(selector)}</code>`,
      ``,
      ...lines,
      matched.length > shown.length ? `\n…and ${matched.length - shown.length} more` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    { parse_mode: "HTML" }
  );
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
  const chain = await chainFor(ctx);
  const [selector, state] = args(ctx);
  if (!selector || (state !== "on" && state !== "off")) {
    await ctx.reply("Usage: <code>/autofire imported on</code>", { parse_mode: "HTML" });
    return;
  }
  const matched = await select(selector, ctx, chain.key);
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
  const chain = await chainFor(ctx);
  const [selector, tag] = args(ctx);
  if (!selector || !tag) {
    await ctx.reply(
      `Usage: <code>/${remove ? "untag" : "tag"} 0-99 alpha</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }
  const matched = await select(selector, ctx, chain.key);
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

async function cmdSweep(ctx: Context): Promise<void> {
  const [selector = "all", contractArg] = args(ctx);
  const chain = await chainFor(ctx, contractArg);
  const matched = await select(selector, ctx, chain.key, true);
  if (!matched) return;

  const contracts = contractArg
    ? [getAddress(contractArg)]
    : mintedContracts(chain.chainId);

  if (contracts.length === 0) {
    await ctx.reply(
      "Nothing to scan — this bot has no recorded mints on this chain.\n" +
        "Pass a contract explicitly: <code>/sweep all 0x…</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(`<b>Sweep</b>\n\nscanning ${contracts.length} contract(s)…`);

  try {
    const head = await latestBlock(chain.rpc.readUrl);
    // Bound the scan: the ledger knows when we first minted, so there is no
    // reason to walk the chain further back than that.
    const from = earliestMintBlock(chain.chainId) ?? Math.max(0, head - 50_000);

    const holdings = await discoverHoldings(
      chain.rpc.readUrl,
      matched.map((w) => ({ id: w.id, address: w.address })),
      {
        fromBlock: from,
        toBlock: head,
        contracts,
        onProgress: (done, total) =>
          status.update(`<b>Sweep</b>\n\n${bar(done, total)}  scanning ${done}/${total}`),
      }
    );

    if (holdings.length === 0) {
      await status.finish("<b>Sweep</b>\n\nNo NFTs found in the selected wallets.");
      return;
    }

    await session.primeNonces(matched, chain.key);
    status.update(`<b>Sweep</b>\n\nfound ${holdings.length} NFT(s) — signing…`);

    const result = await sweepNfts(
      holdings,
      {
        signerFor: session.signerFor,
        vault: config.vault,
        chainId: chain.chainId,
        endpoints: chain.rpc.endpoints,
        maxFeePerGas: config.maxFeePerGas,
        maxPriorityFeePerGas: config.maxPriorityFeePerGas,
        nonceFor: (a: string) => session.nonceFor(a, chain.key),
      },
      (done, total) =>
        status.update(`<b>Sweep</b>\n\n${bar(done, total)}  signing ${done}/${total}`)
    );

    await status.finish(
      [
        `<b>Sweep complete</b>`,
        ``,
        `${bar(result.accepted, result.dispatched)}  ${result.accepted}/${result.dispatched} accepted`,
        result.rejected > 0 ? `${result.rejected} rejected` : ``,
        `→ vault <code>${esc(short(config.vault))}</code>`,
        ``,
        `<i>ETH left in place — wallets stay armed.</i>`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (err) {
    await status.finish(`<b>Sweep failed</b>\n\n${esc((err as Error).message)}`);
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

async function resolveSlug(chainId: number, contract: string, given: string | undefined): Promise<string> {
  if (given && !given.startsWith("0x")) return given;
  const slug = await slugForContract(requireApiKey(), chainId, contract);
  if (!slug) {
    throw new Error(
      `OpenSea does not recognise ${contract} on ${config.chain}.\n` +
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
  const slug = await resolveSlug(chain.chainId, address, slugArg);

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
        "Usage: <code>/fcfs 0xContract &lt;qty&gt; [selector] [at HH:MM]</code>",
        "",
        "Mints whichever stage OpenSea says you're eligible for — allowlist,",
        "signed or public. Times are UTC.",
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
  const selector =
    parts.slice(2).find((p, i) => p !== "at" && parts[i + 1] !== p && !/^\d{1,2}:\d{2}$/.test(p)) ??
    "derived+funded";

  const matched = await select(selector, ctx, chain.key, true);
  if (!matched) return;

  const status = new StatusCard(bot, ctx.chat!.id);
  await status.start(
    `<b>FCFS mint</b>\n\n<code>${esc(short(address))}</code> × ${quantity}\n${matched.length} wallet(s)\n\nresolving collection…`
  );

  let latest: OpenSeaMintReport | undefined;

  try {
    const slug = await resolveSlug(chain.chainId, address, undefined);

    // Read the stage price ahead of time. OpenSea refuses to issue calldata to
    // a wallet that cannot cover the mint plus gas, so knowing the price lets
    // underfunded wallets be dropped before the T-0 burst instead of consuming
    // rate limit on guaranteed rejections.
    let unitPriceHintWei: bigint | undefined;
    try {
      const drop = await fetchDrop(apiKey, slug);
      const live = drop.stages.find(stageIsLive) ?? drop.stages[0];
      if (live?.price) unitPriceHintWei = BigInt(live.price);
    } catch {
      // Falls back to gas-only screening, which is still better than none.
    }

    status.update(
      `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n${matched.length} wallet(s) selected` +
        (unitPriceHintWei !== undefined ? `\nstage price ${eth(unitPriceHintWei)} ETH` : "") +
        (startAt ? `\n⏳ firing at ${startAt.toISOString().slice(11, 16)} UTC` : "\nstarting now…")
    );

    const render = (event: OpenSeaMintEvent): void => {
      switch (event.type) {
        case "waiting":
          status.update(
            `<b>FCFS mint</b>  <code>${esc(slug)}</code>\n\n⏳ holding — ${Math.round(event.msRemaining / 1000)}s\n<i>OpenSea won't issue calldata before the stage opens,\nso the fetch starts at T-0.</i>`
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

async function cmdWatch(ctx: Context): Promise<void> {
  const [address, tierArg, ...labelParts] = args(ctx);
  if (!address) {
    await ctx.reply(
      "Usage: <code>/watch 0xAlpha… high alpha-wallet</code>\nTiers: <code>high</code> <code>med</code> <code>low</code> — they set how many wallets fire.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const tier = targets.parseTier(tierArg, "low");
  const label = labelParts.join(" ") || undefined;
  const target = targets.add(address, tier, label);
  await session.retargetWatchers();

  const walletsPerFire = config.copy.tiers[tier];
  await ctx.reply(
    [
      `<b>Watching</b> <code>${esc(target.address)}</code>`,
      ``,
      `tier <b>${tier}</b> → up to ${walletsPerFire} wallets per signal`,
      label ? `label ${esc(label)}` : ``,
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
      "No targets. Add one with <code>/watch 0xAlpha… high</code>.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const lines = list.map((t) => {
    const perFire = config.copy.tiers[t.tier];
    const recent = targets.firesInWindow(t.address, 3_600_000);
    return (
      `<code>${short(t.address)}</code>  <b>${t.tier}</b> →${perFire}w  ` +
      `${t.fires} fires${recent > 0 ? ` (${recent} this hour)` : ""}` +
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
      `<i>Cooldown: max ${config.copy.maxFiresPerTargetPerHour}/target/hour · dedup ${config.copy.dedupWindowSec}s</i>`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
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

  session.copyEnabled = state === "on";
  await ctx.reply(
    session.copyEnabled
      ? [
          `<b>Copy-mint ON</b>`,
          ``,
          `Signals from ${targets.list().length} target(s) will now spend without confirmation,`,
          `bounded by /caps.`,
          ``,
          `<i>This does not survive a restart — after a reboot the bot returns to`,
          `whatever copy.enabled says in config.json.</i>`,
        ].join("\n")
      : `<b>Copy-mint OFF</b>\n\nSignals will be reported but nothing will fire.`,
    { parse_mode: "HTML" }
  );
}

async function cmdCaps(ctx: Context): Promise<void> {
  const spent = spentSince(24, ["mint"]);
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
      `remaining   ${eth(remaining)} ETH`,
      ``,
      `<i>Cost per wallet counts the ${eth(reservation)} ETH gas reservation as well as`,
      `the mint price — otherwise a free mint would look free and fire unbounded.</i>`,
      ``,
      `<i>Max price is the bait guard: an over-priced mint is rejected outright,`,
      `never trimmed. Budget limits trim instead of rejecting.</i>`,
      ``,
      `Edit these in config.json — they are not settable from here.`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
}

/** Live copy-mint reporting. Never on the critical path — these fire after dispatch. */
function renderCopyEvent(
  event: CopyEvent,
  chain: ChainContext,
  notify: (html: string) => void
): void {
  switch (event.type) {
    case "signal":
      notify(
        `👁 <b>Mint detected</b>\n` +
          `target <code>${esc(short(event.target))}</code>\n` +
          `contract <code>${esc(short(event.contract))}</code>\n` +
          `block ${event.block} · ${esc(chain.name)}`
      );
      break;
    case "skipped":
      notify(
        `⏭ <b>Skipped</b> — ${esc(event.reason)}\n` +
          `<code>${esc(short(event.contract))}</code>` +
          (event.detail ? `\n<i>${esc(event.detail)}</i>` : "")
      );
      break;
    case "simulated":
      notify(
        `✅ <b>Simulation passed</b>\n` +
          `selector <code>${esc(event.selector)}</code> · gas ${event.gasLimit}` +
          (event.addressBound
            ? `\n<i>Calldata embedded the target's address — rewritten to ours.</i>`
            : "")
      );
      break;
    case "firing":
      notify(
        `🚀 <b>Firing ${event.walletCount} wallet(s)</b>\n` +
          `committing ${eth(event.totalCommitWei)} ETH` +
          (event.trimReason ? `\n<i>trimmed by ${esc(event.trimReason)}</i>` : "")
      );
      break;
    case "result": {
      const r = event.result;
      notify(
        [
          `<b>Copy-mint complete</b>`,
          ``,
          `${bar(r.accepted, r.walletCount)}  ${r.accepted}/${r.walletCount} accepted`,
          r.rejected > 0 ? `${r.rejected} rejected` : ``,
          ``,
          `contract <code>${esc(short(r.contract))}</code>`,
          `price ${eth(r.unitPriceWei)} ETH · committed ${eth(r.totalCommitWei)} ETH`,
          `signal → dispatch <b>${r.elapsedMs.toFixed(0)}ms</b> (block budget 2000ms)`,
          r.hashes.find((h) => h.accepted)
            ? `\n${txLink(chain.chainId, r.hashes.find((h) => h.accepted)!.hash, "view transaction")}`
            : ``,
          r.errorSummary.length > 0
            ? `\n<b>Failures</b>\n` +
              r.errorSummary
                .slice(0, 2)
                .map((e) => `  ${e.count}× ${esc(e.reason.slice(0, 80))}`)
                .join("\n")
            : ``,
        ]
          .filter(Boolean)
          .join("\n")
      );
      break;
    }
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

    const entries = readImportBlob(contents, passphrase);
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

// ── Button UI ─────────────────────────────────────────────────────────────

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
      text: `<b>Wallets</b>\n\n<i>Generating more costs nothing — they come from the same seed phrase you already wrote down.</i>`,
      keyboard: walletsMenu(),
    },
    money: {
      text: `<b>Money</b>\n\n<i>Funding tops wallets up to a target. Sweeping moves NFTs to the vault and leaves gas in place.</i>`,
      keyboard: moneyMenu(),
    },
    copy: {
      text:
        `<b>Copy-mint</b>\n\n` +
        (session.copyEnabled
          ? `<b>ON</b> — signals from ${watched} target(s) will spend without confirmation, bounded by caps.`
          : `<b>OFF</b> — signals are reported but nothing fires.`),
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

/** Move a flow to its next step, asking for whatever is still missing. */
async function advanceFlow(ctx: Context, flow: Flow): Promise<void> {
  const label =
    flow.kind === "mint" ? "Public mint" : flow.kind === "fcfs" ? "FCFS mint" : flow.kind;

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
      await ctx.reply(`<b>Fund</b>\n\nTop each wallet up to what balance?`, {
        parse_mode: "HTML",
        reply_markup: amountKeyboard(),
      });
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
  await ctx.reply(
    [`<b>${label}</b>`, ``, describeFlow(flow), ``, `<i>Nothing is sent until you confirm.</i>`].join("\n"),
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
        [flow.contract!, String(flow.quantity), flow.selector!, ...(waitForOpen ? ["wait"] : [])],
        cmdMint
      );
    case "fcfs":
      return runWithArgs(ctx, [flow.contract!, String(flow.quantity), flow.selector!], cmdFcfs);
    case "check":
      return runWithArgs(ctx, [flow.contract!], cmdProbe);
    case "fund":
      return runWithArgs(ctx, [flow.selector!, flow.amount!], cmdFund);
    case "sweep":
      return runWithArgs(ctx, ["all"], cmdSweep);
    case "watch":
      return runWithArgs(ctx, [flow.contract!, flow.tier ?? "low"], cmdWatch);
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

  switch (prefix) {
    case "m":
      return showMenu(ctx, payload);

    case "a":
      switch (payload) {
        case "status":
          return cmdStatus(ctx);
        case "wallets":
          return runWithArgs(ctx, ["all"], cmdWallets);
        case "balances":
          return runWithArgs(ctx, ["funded"], cmdWallets);
        case "targets":
          return cmdTargets(ctx);
        case "caps":
          return cmdCaps(ctx);
        case "help":
          await ctx.reply(HELP, { parse_mode: "HTML" });
          return;
      }
      return;

    case "g":
      return runWithArgs(ctx, [payload], cmdGenerate);

    case "c":
      return runWithArgs(ctx, [payload], cmdCopy);

    case "i": {
      const kind = payload as Flow["kind"];
      const flow = startFlow(chatId, kind, kind === "sweep" ? "ready" : "contract");
      if (kind === "sweep") {
        await ctx.reply(
          `<b>Sweep</b>\n\nMove every NFT found in your wallets to the vault:\n<code>${esc(config.vault)}</code>\n\n<i>ETH is left in place so wallets stay armed.</i>`,
          { parse_mode: "HTML", reply_markup: simpleConfirm("Sweep") }
        );
        return;
      }
      if (kind === "fund") {
        flow.step = "amount";
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
        `<b>${kind === "check" ? "Probe" : kind === "fcfs" ? "FCFS mint" : "Public mint"}</b>\n\nSend the contract address.`,
        { parse_mode: "HTML", reply_markup: backTo("m:mint", "✕ Cancel") }
      );
      return;
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
      flow.amount = payload;
      return advanceFlow(ctx, flow);
    }

    case "t": {
      const flow = getFlow(chatId);
      if (!flow) return;
      flow.tier = payload;
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

  if (flow.step === "contract" || flow.step === "address") {
    if (!isAddress(text)) {
      await ctx.reply("That doesn't look like an address. Send a 0x… address, or tap Cancel.");
      return;
    }
    flow.contract = getAddress(text);
    flow.step = "ready";
    return advanceFlow(ctx, flow);
  }

  if (flow.step === "amount") {
    if (!/^\d*\.?\d+$/.test(text)) {
      await ctx.reply("Send a plain ETH amount, like 0.002.");
      return;
    }
    flow.amount = text;
    return advanceFlow(ctx, flow);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────

let bot: Bot;
let passphrase: string;

async function main(): Promise<void> {
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Environment first so systemd can start unattended; console otherwise.
  passphrase = (process.env.COPYMINT_PASSPHRASE || "").trim();
  if (!passphrase) {
    if (!process.stdin.isTTY) {
      console.error(
        "\n  No passphrase. Set COPYMINT_PASSPHRASE, or start with a terminal attached.\n"
      );
      process.exit(1);
    }
    passphrase = await askPassphrase("  Store passphrase: ");
  }

  console.log("  Unlocking store and deriving wallets…");
  session = await Session.open(config, passphrase);
  console.log(`  ${session.wallets().length} wallets ready.`);
  for (const chain of session.availableChains) {
    console.log(
      `  ${chain.name}: ${chain.rpc.endpoints.map((e) => e.label).join(", ")}` +
        (chain.rpc.verified ? "" : "  (chain id unverified)")
    );
  }

  bot = new Bot(config.telegramToken);

  // Whitelist. Everything below this line is unreachable from any other chat.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !config.telegram.allowedChatIds.includes(chatId)) {
      console.warn(`  Rejected message from chat ${chatId}`);
      return;
    }
    await next();
  });

  bot.command(["start", "menu"], (ctx) =>
    ctx.reply(menuHeader(), {
      parse_mode: "HTML",
      reply_markup: mainMenu(session.copyEnabled, targets.list().length),
    })
  );
  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));
  bot.command("status", (ctx) => cmdStatus(ctx).catch((e) => fail(ctx, e)));
  bot.command("wallets", (ctx) => cmdWallets(ctx).catch((e) => fail(ctx, e)));
  bot.command("generate", (ctx) => cmdGenerate(ctx).catch((e) => fail(ctx, e)));
  bot.command("autofire", (ctx) => cmdAutoFire(ctx).catch((e) => fail(ctx, e)));
  bot.command("tag", (ctx) => cmdTag(ctx, false).catch((e) => fail(ctx, e)));
  bot.command("untag", (ctx) => cmdTag(ctx, true).catch((e) => fail(ctx, e)));
  bot.command("fund", (ctx) => cmdFund(ctx).catch((e) => fail(ctx, e)));
  bot.command("sweep", (ctx) => cmdSweep(ctx).catch((e) => fail(ctx, e)));
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

  // Nonce hygiene runs off the critical path and reports to the first allowed chat.
  const noticeChat = config.telegram.allowedChatIds[0];
  const notify = (html: string): void => {
    void bot.api
      .sendMessage(noticeChat, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
      .catch(() => {
        /* a dropped notification must never break the pipeline */
      });
  };

  session.startReconcile(30_000, (message) => {
    console.log(`  ${message}`);
    notify(`🔧 ${esc(message)}`);
  });

  // Copy-mint watcher. Telegram I/O happens only after bytes are on the wire.
  await session.startCopy(
    (event, chain) => renderCopyEvent(event, chain, notify),
    (message, level) => {
      console.log(`  ${message}`);
      if (level === "warn") notify(`⚠️ ${esc(message)}`);
    }
  );

  const watchCount = targets.list().length;
  console.log(
    `  Copy-mint: ${watchCount} target(s), firing ${session.copyEnabled ? "ON" : "OFF"}.`
  );

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  console.log("  Bot running.\n");
  await bot.start();
}

async function shutdown(): Promise<void> {
  console.log("\n  Shutting down…");
  session?.stopCopy();
  session?.stopReconcile();
  await bot?.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
