// Bot configuration, loaded from disk. Shared policy comes from the root
// config; each private chat gets its own copy and can persist its destination
// through an explicit, confirmed Telegram flow.

import { readFileSync, existsSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { getAddress, parseEther, parseUnits, formatEther, ZeroAddress } from "ethers";
import { CHAINS, resolveChain } from "../chains";
import { FILES, ensureStateDir } from "./paths";

export interface GasConfig {
  limit: number;
  maxFeeGwei: string;
  priorityGwei: string;
}

export interface CapsConfig {
  /** Hard ceiling on total ETH spent in a single autonomous event. */
  perEventEth: string;
  /** Reject any mint whose unit price exceeds this. */
  maxPriceEth: string;
  /** Rolling 24h autonomous spend ceiling. */
  dailyEth: string;
}

export interface CopyConfig {
  /** Master switch. When false the watcher reports signals but never fires. */
  enabled: boolean;
  /** Wallets fired per signal, by the target's trust tier. */
  tiers: { high: number; med: number; low: number };
  /** Two targets minting the same contract inside this window fire once. */
  dedupWindowSec: number;
  /** Ceiling on how often one target can trigger a fire. */
  maxFiresPerTargetPerHour: number;
  /** Base pool copy-mint draws from, before tier limits and safety rails. */
  walletSelector: string;
  /**
   * Mint the collection's own public stage when their calldata cannot be reused.
   *
   * On by default, and the difference between copying most drops and copying
   * almost none: a target minting through an allowlist or a signed stage
   * produces calldata locked to their address, and without this rung the whole
   * signal is thrown away even though the same collection is standing open to
   * anyone. Turn it off only to mirror strictly — same stage or nothing.
   */
  publicFallback?: boolean;
  /** WebSocket endpoint. Empty derives one from the read RPC, else polls. */
  wsUrl: string;
}

export interface AutoSweepConfig {
  /**
   * Move NFTs to the vault as soon as a copy-mint lands, without being asked.
   *
   * On by default, which is a deliberate exception to the rule that governs
   * `copy.enabled`. That switch turns on autonomous *spending* and must be a
   * decision. This one turns on autonomous *tidying* between two addresses the
   * same person already owns — it cannot buy anything, and the only cost is the
   * gas of a transfer the operator was going to make by hand anyway. Leaving it
   * off by default would mean the wallets that just spent money sit holding the
   * proceeds until somebody remembers.
   */
  enabled: boolean;
  /**
   * Seconds to wait for the mint receipts before giving up.
   *
   * The wait is not a guess at block time — it is a ceiling on how long to keep
   * asking. Robinhood answers in a second, Ethereum can take a minute when the
   * tip is low, and a transaction that never lands must not hold the sweep
   * queue open forever.
   */
  waitSec: number;
}

export interface SignedConfig {
  enabled: boolean;
  /**
   * OpenSea's mint-signature API is private and undocumented, so its endpoints
   * are supplied here rather than hardcoded. Capture them from a browser session
   * that mints on the target drop. Placeholders {address} {nonce} {contract}
   * {minter} {quantity} {chain} {chainId} are substituted into URLs.
   */
  api: {
    nonceUrl: string;
    loginUrl: string;
    signatureUrl: string;
    headers: Record<string, string>;
  };
  /** SIWE login message fields. */
  siwe: { domain: string; uri: string; statement: string };
  /** Request pacing — this is the defence against the rate-limit wall. */
  concurrency: number;
  minDelayMs: number;
  maxRetries: number;
}

export interface BotConfig {
  chain: string;
  /** Sweep destination. Changeable by this user's confirmed settings flow. */
  vault: string;
  /** The user's derived wallet that disperses and reclaims campaign funds. */
  funder: string;
  /** How many derived wallets stay funded for copy-mint. */
  hotSetSize: number;
  /**
   * Wallets checked per nonce-reconcile cycle.
   *
   * Each costs two RPC calls. Providers meter calls per second, so reconciling
   * 500 wallets at once would blow a 50/second plan and starve every other read.
   * A slice per cycle keeps the loop cheap; every wallet still comes round.
   */
  reconcileBatch: number;
  gas: GasConfig;
  caps: CapsConfig;
  copy: CopyConfig;
  autoSweep: AutoSweepConfig;
  signed: SignedConfig;
  /** Optional endpoint overrides; empty falls back to chains.ts + .env. */
  rpc: { read: string[]; send: string[] };
}

export interface ResolvedConfig extends BotConfig {
  telegramToken: string;
  chainId: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  capPerEventWei: bigint;
  capMaxPriceWei: bigint;
  capDailyWei: bigint;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Pull an explicit `on <chain>` out of a command's arguments.
 *
 * Shared by every command because the button flows now express their chosen
 * chain the same way a typed command does — appending `on <chain>` — so this
 * one parser decides what both mean. It is deliberately pure and tested:
 * a wiring slip here sends money to the chain the operator did not pick, which
 * is the failure the flow was changed to prevent.
 */
export function chainOverrideFrom(parts: string[]): string | undefined {
  const index = parts.indexOf("on");
  if (index === -1) return undefined;
  const value = parts[index + 1];
  return value && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

/**
 * Drop `on <chain>` and `to <address>` from an argument list.
 *
 * Both are read by name elsewhere — the chain by chainFor, the destination by
 * sweepDestination — and whatever is left is positional. Removing only one of
 * them left the other's keyword sitting in the contract slot, so
 * `/sweep all on robinhood` tried to look up a collection called "on".
 */
export function withoutKeywordPairs(parts: string[]): string[] {
  const drop = new Set<number>();
  parts.forEach((word, i) => {
    const key = word.toLowerCase();
    if (key === "on" || key === "to") {
      drop.add(i);
      if (i + 1 < parts.length) drop.add(i + 1);
    }
  });
  return parts.filter((_, i) => !drop.has(i));
}

export const DEFAULT_CONFIG: BotConfig = {
  chain: "base",
  // Setup sentinel. The Telegram flow refuses wallet creation until each user
  // confirms a real destination in their isolated settings.
  vault: ZeroAddress,
  funder: ZeroAddress,
  hotSetSize: 50,
  reconcileBatch: 100,
  gas: { limit: 250_000, maxFeeGwei: "2", priorityGwei: "0.05" },
  caps: { perEventEth: "0.10", maxPriceEth: "0.005", dailyEth: "0.50" },
  copy: {
    // Off by default. Turning on autonomous spending should be a decision,
    // not something that happens because a config file was created.
    enabled: false,
    // 0 = every wallet. The top tier means "follow this one properly", and a
    // store is funded so all of it fires together — capping that at 50 sat the
    // rest of the wallets out of every drop for no reason the operator chose.
    // The narrower tiers stay numbers, because that is what they are for.
    tiers: { high: 0, med: 20, low: 5 },
    dedupWindowSec: 60,
    maxFiresPerTargetPerHour: 3,
    // Every wallet, not just the generated-and-funded ones.
    //
    // The old default excluded imported wallets and required a balance read to
    // evaluate. On a real deployment that meant the money — which was entirely
    // in imported wallets — was unreachable, and the check cost ten seconds of
    // a one-block budget to reach that conclusion. Selecting broadly and
    // letting the node reject what it cannot pay for is both faster and what
    // an operator means by "copy with my wallets".
    walletSelector: "all",
    wsUrl: "",
  },
  autoSweep: { enabled: true, waitSec: 180 },
  signed: {
    enabled: false,
    api: { nonceUrl: "", loginUrl: "", signatureUrl: "", headers: {} },
    siwe: {
      domain: "opensea.io",
      uri: "https://opensea.io",
      statement: "Sign in to OpenSea",
    },
    // Conservative on purpose: 500 wallets arriving at once gets the IP
    // throttled or flagged. Raise only after watching real responses.
    concurrency: 3,
    minDelayMs: 400,
    maxRetries: 3,
  },
  rpc: { read: [], send: [] },
};

function requireAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(
      `config.json: "${field}" is required. Set it to an address you control.`
    );
  }
  try {
    return getAddress(value.trim());
  } catch {
    throw new ConfigError(`config.json: "${field}" is not a valid address: ${value}`);
  }
}

function requireAmount(value: unknown, field: string): bigint {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ConfigError(`config.json: "${field}" must be a decimal string, e.g. "0.05".`);
  }
  try {
    return parseEther(String(value));
  } catch {
    throw new ConfigError(`config.json: "${field}" is not a valid ETH amount: ${value}`);
  }
}

function requireGwei(value: unknown, field: string): bigint {
  try {
    return parseUnits(String(value), "gwei");
  } catch {
    throw new ConfigError(`config.json: "${field}" is not a valid gwei amount: ${value}`);
  }
}

/**
 * The auto-sweep wait, clamped rather than validated.
 *
 * A wait is not a safety limit — nothing about a wrong one spends money — so
 * refusing to boot over it would be the wrong trade. But a hand-edited zero
 * would give up before the first poll and make auto-sweep look broken, and a
 * hand-edited hour would hold a queue slot open for one dead transaction. Both
 * are pulled back into a range where the feature still works.
 */
const MIN_SWEEP_WAIT_SEC = 10;
const MAX_SWEEP_WAIT_SEC = 900;

function sweepWaitSec(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_CONFIG.autoSweep.waitSec;
  return Math.min(MAX_SWEEP_WAIT_SEC, Math.max(MIN_SWEEP_WAIT_SEC, Math.round(seconds)));
}

export function writeDefaultConfig(): string {
  return writeConfigIfMissing(DEFAULT_CONFIG);
}

export function writeConfigIfMissing(config: BotConfig): string {
  ensureStateDir();
  const path = FILES.config();
  if (existsSync(path)) return path;
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

export interface UserSettingsUpdate {
  /** User-controlled NFT sweep destination. */
  destination?: string;
  /** Bot-controlled derived wallet used to disperse and reclaim ETH. */
  funder?: string;
  /** Explicit Telegram copy-mint kill-switch choice. */
  copyEnabled?: boolean;
  /**
   * Autonomous spend caps, as decimal ETH strings.
   *
   * These were SSH-only, on the reasoning that a limit on unattended spending
   * should not be one tap away. That reasoning assumed the operator had a
   * shell — and on a hosted bot the person whose wallets these are usually does
   * not. The cap then stops being a considered decision and becomes whichever
   * number shipped as the default, unreachable by the only person it binds.
   */
  caps?: { perEventEth?: string; maxPriceEth?: string; dailyEth?: string };
  /** Which wallets copy-mint may draw on. */
  copyWalletSelector?: string;
  /**
   * Whether a finished copy-mint moves itself to the vault.
   *
   * Chat-settable for the same reason the caps are: the person whose wallets
   * these are usually has no shell, and a setting they cannot reach is not a
   * choice they made. It cannot buy anything or name a new destination — it
   * only decides whether the vault they already confirmed is used automatically.
   */
  autoSweep?: boolean;
}

/**
 * Ceiling on any single cap set from chat.
 *
 * Not a policy about how much anyone should spend — a guard against a misplaced
 * decimal point, which is the realistic way a cap gets set to a hundred times
 * what was meant. Editing config.json by hand is still unbounded.
 */
export const MAX_CAP_WEI = parseEther("10");

/**
 * Persist the narrow settings surface that one Telegram user may change.
 *
 * Everything else in config.json remains SSH-only. Writing through a sibling
 * temporary file keeps a crash from leaving half-written JSON behind.
 */
/** A cap value that is a real, positive, sanely-sized ETH amount. */
export function parseCapAmount(value: string, field: string): string {
  const text = String(value).trim().replace(/\s*eth$/i, "");
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new ConfigError(`"${field}" must be a plain ETH amount like 0.02 — got "${value}".`);
  }
  let wei: bigint;
  try {
    wei = parseEther(text);
  } catch {
    throw new ConfigError(`"${field}" is not a valid ETH amount: ${value}`);
  }
  if (wei <= 0n) {
    throw new ConfigError(`"${field}" must be above zero — a zero cap stops every mint.`);
  }
  if (wei > MAX_CAP_WEI) {
    throw new ConfigError(
      `"${field}" of ${text} ETH is above the ${formatEther(MAX_CAP_WEI)} ETH ceiling for a ` +
        `cap set from chat. Check the decimal point.`
    );
  }
  return text;
}

export function updateUserSettings(update: UserSettingsUpdate): {
  destination?: string;
  funder?: string;
  copyEnabled?: boolean;
  caps?: BotConfig["caps"];
  copyWalletSelector?: string;
  autoSweep?: boolean;
} {
  const path = FILES.config();
  if (!existsSync(path)) {
    throw new ConfigError(`No config at ${path}.`);
  }

  let raw: BotConfig;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as BotConfig;
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${(err as Error).message}`);
  }

  const result: {
    destination?: string;
    funder?: string;
    copyEnabled?: boolean;
    caps?: BotConfig["caps"];
    copyWalletSelector?: string;
    autoSweep?: boolean;
  } = {};

  if (update.destination !== undefined) {
    try {
      const destination = getAddress(update.destination.trim());
      raw.vault = destination;
      result.destination = destination;
    } catch {
      throw new ConfigError(`That is not a valid Ethereum address: ${update.destination}`);
    }
  }

  if (update.funder !== undefined) {
    try {
      const funder = getAddress(update.funder.trim());
      raw.funder = funder;
      result.funder = funder;
    } catch {
      throw new ConfigError(`That is not a valid funding-wallet address: ${update.funder}`);
    }
  }

  if (update.copyEnabled !== undefined) {
    if (typeof update.copyEnabled !== "boolean") {
      throw new ConfigError("Copy-mint state must be on or off.");
    }
    raw.copy = {
      ...DEFAULT_CONFIG.copy,
      ...(raw.copy ?? {}),
      tiers: { ...DEFAULT_CONFIG.copy.tiers, ...(raw.copy?.tiers ?? {}) },
      enabled: update.copyEnabled,
    };
    result.copyEnabled = update.copyEnabled;
  }

  if (update.caps !== undefined) {
    const merged = { ...DEFAULT_CONFIG.caps, ...(raw.caps ?? {}) };
    for (const field of ["perEventEth", "maxPriceEth", "dailyEth"] as const) {
      const supplied = update.caps[field];
      if (supplied !== undefined) merged[field] = parseCapAmount(supplied, `caps.${field}`);
    }
    // The bait guard must stay inside the per-event allowance, or it is not a
    // guard: a ceiling above what one event may spend can never be the binding
    // limit, and the operator would be looking at a number that does nothing.
    if (parseEther(merged.maxPriceEth) > parseEther(merged.perEventEth)) {
      throw new ConfigError(
        `A max price of ${merged.maxPriceEth} ETH is above the ${merged.perEventEth} ETH ` +
          `per-event cap, which would make it meaningless. Raise the per-event cap first.`
      );
    }
    raw.caps = merged;
    result.caps = merged;
  }

  if (update.copyWalletSelector !== undefined) {
    const selector = update.copyWalletSelector.trim();
    if (selector.length === 0) throw new ConfigError("A wallet selector cannot be empty.");
    raw.copy = {
      ...DEFAULT_CONFIG.copy,
      ...(raw.copy ?? {}),
      tiers: { ...DEFAULT_CONFIG.copy.tiers, ...(raw.copy?.tiers ?? {}) },
      walletSelector: selector,
    };
    result.copyWalletSelector = selector;
  }

  if (update.autoSweep !== undefined) {
    if (typeof update.autoSweep !== "boolean") {
      throw new ConfigError("Auto-sweep must be on or off.");
    }
    raw.autoSweep = {
      ...DEFAULT_CONFIG.autoSweep,
      ...(raw.autoSweep ?? {}),
      enabled: update.autoSweep,
    };
    result.autoSweep = update.autoSweep;
  }

  if (
    result.destination === undefined &&
    result.funder === undefined &&
    result.copyEnabled === undefined &&
    result.caps === undefined &&
    result.copyWalletSelector === undefined &&
    result.autoSweep === undefined
  ) {
    throw new ConfigError("No user setting was supplied.");
  }

  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(raw, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (err) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw err;
  }

  return result;
}

export function loadConfig(): ResolvedConfig {
  const path = FILES.config();
  if (!existsSync(path)) {
    throw new ConfigError(
      `No config at ${path}. Run the deployment setup to write shared defaults.`
    );
  }

  let raw: BotConfig;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as BotConfig;
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${(err as Error).message}`);
  }

  const merged: BotConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    gas: { ...DEFAULT_CONFIG.gas, ...(raw.gas ?? {}) },
    caps: { ...DEFAULT_CONFIG.caps, ...(raw.caps ?? {}) },
    copy: {
      ...DEFAULT_CONFIG.copy,
      ...(raw.copy ?? {}),
      tiers: { ...DEFAULT_CONFIG.copy.tiers, ...(raw.copy?.tiers ?? {}) },
    },
    autoSweep: {
      enabled: raw.autoSweep?.enabled ?? DEFAULT_CONFIG.autoSweep.enabled,
      waitSec: sweepWaitSec(raw.autoSweep?.waitSec),
    },
    signed: {
      ...DEFAULT_CONFIG.signed,
      ...(raw.signed ?? {}),
      api: { ...DEFAULT_CONFIG.signed.api, ...(raw.signed?.api ?? {}) },
      siwe: { ...DEFAULT_CONFIG.signed.siwe, ...(raw.signed?.siwe ?? {}) },
    },
    rpc: { ...DEFAULT_CONFIG.rpc, ...(raw.rpc ?? {}) },
  };

  const chain = resolveChain(merged.chain);
  if (!chain) {
    throw new ConfigError(
      `config.json: unknown chain "${merged.chain}". Known: ${CHAINS.map((c) => c.key).join(", ")}`
    );
  }

  // The token belongs in the environment, not in a file that gets read, copied
  // and pasted while debugging.
  const telegramToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!telegramToken) {
    throw new ConfigError(
      "TELEGRAM_BOT_TOKEN is not set. Export it in the bot's environment — it does not belong in config.json."
    );
  }

  const maxFeePerGas = requireGwei(merged.gas.maxFeeGwei, "gas.maxFeeGwei");
  const maxPriorityFeePerGas = requireGwei(merged.gas.priorityGwei, "gas.priorityGwei");
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw new ConfigError(
      `config.json: gas.priorityGwei (${merged.gas.priorityGwei}) exceeds gas.maxFeeGwei (${merged.gas.maxFeeGwei}). ` +
        "That is invalid under EIP-1559 and every node will reject it."
    );
  }

  return {
    ...merged,
    vault: requireAddress(merged.vault, "vault"),
    funder: requireAddress(merged.funder, "funder"),
    telegramToken,
    chainId: chain.chainId,
    gasLimit: Number(merged.gas.limit) || 250_000,
    maxFeePerGas,
    maxPriorityFeePerGas,
    capPerEventWei: requireAmount(merged.caps.perEventEth, "caps.perEventEth"),
    capMaxPriceWei: requireAmount(merged.caps.maxPriceEth, "caps.maxPriceEth"),
    capDailyWei: requireAmount(merged.caps.dailyEth, "caps.dailyEth"),
  };
}
