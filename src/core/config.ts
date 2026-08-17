// Bot configuration, loaded from disk. Shared policy comes from the root
// config; each private chat gets its own copy and can persist its destination
// through an explicit, confirmed Telegram flow.

import { readFileSync, existsSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { getAddress, parseEther, parseUnits, ZeroAddress } from "ethers";
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
  /** WebSocket endpoint. Empty derives one from the read RPC, else polls. */
  wsUrl: string;
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
    tiers: { high: 50, med: 20, low: 5 },
    dedupWindowSec: 60,
    maxFiresPerTargetPerHour: 3,
    walletSelector: "derived+funded",
    wsUrl: "",
  },
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
}

/**
 * Persist the narrow settings surface that one Telegram user may change.
 *
 * Everything else in config.json remains SSH-only. Writing through a sibling
 * temporary file keeps a crash from leaving half-written JSON behind.
 */
export function updateUserSettings(update: UserSettingsUpdate): {
  destination?: string;
  funder?: string;
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

  const result: { destination?: string; funder?: string } = {};

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

  if (result.destination === undefined && result.funder === undefined) {
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
