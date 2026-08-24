// The watch list.
//
// Each target carries a trust tier, and the tier decides how many wallets fire
// on its signal — a wallet you half-trust is cheap to carry at five wallets and
// ruinous at fifty. Tiers are the throttle that makes watching ~50 addresses
// sane rather than reckless.
//
// Fire counts and timestamps live here too, because the cooldown that stops one
// spammy target draining a day's budget has to survive a restart.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getAddress, parseEther, formatEther } from "ethers";
import { stateDir, ensureStateDir } from "./paths";

export type Tier = "high" | "med" | "low";
export type MintMode = "free" | "paid" | "both";

/**
 * Whose transaction counts as this target minting.
 *
 * `self` — only mints the target sent and paid for itself.
 * `any`  — also mints another wallet paid for but credited to the target.
 *
 * The second exists because the address worth watching is often a vault, not a
 * hot wallet: a serious minter fires from rotating disposable wallets and
 * credits everything to one cold address, which is precisely what this bot
 * does. Watching that address under `self` sees every mint and copies none of
 * them, because the payer is never the address the NFT lands in.
 *
 * It is not the default, and should not be. Under `self` an attacker has to
 * persuade the target to mint their bait; under `any` they need only mint one
 * to the target's address, which anybody can do unbidden. What stands between
 * that and a drained wallet is the price ceiling, the per-event and daily caps,
 * and the rule in calldata.ts that a third-party-paid mint must name the target
 * in its calldata so the recipient can be rewritten to us.
 */
export type PayerMode = "self" | "any";

export const TIERS: Tier[] = ["high", "med", "low"];
export const MINT_MODES: MintMode[] = ["free", "paid", "both"];
export const PAYER_MODES: PayerMode[] = ["self", "any"];

export interface WatchTarget {
  address: string;
  tier: Tier;
  /** Which source transactions this target is allowed to trigger. */
  mintMode: MintMode;
  /** Whether a mint paid for by another wallet still counts as this target's. */
  payer: PayerMode;
  /**
   * Wallets to fire for this target, overriding the tier's shared number.
   *
   * Tiers were a shortcut for "how much do I trust this one", and three shared
   * numbers in a config file is a poor way to express that when the answer is
   * per address and the file is not reachable from a phone. The tier stays as
   * the default; this is the answer when there is one.
   */
  walletCount?: number;
  /**
   * Price ceiling for this target, as a decimal ETH string.
   *
   * Overrides caps.maxPriceEth for its own signals only. One global ceiling has
   * to be set for the least trusted address being watched, which makes it
   * useless for the most trusted one — a vault whose drops cost 0.011 cannot
   * share a ceiling with an unknown wallet that should never spend that much.
   * The per-event and daily caps still apply on top, so this widens what a
   * single mint may cost without widening what a day may.
   */
  maxPriceEth?: string;
  label?: string;
  addedAt: number;
  /** Total fires ever, for reporting. */
  fires: number;
  /** Timestamps of recent fires, trimmed to the cooldown window. */
  recentFires: number[];
}

interface TargetsFile {
  targets: WatchTarget[];
}

function file(): string {
  return join(stateDir(), "targets.json");
}

function read(): TargetsFile {
  if (!existsSync(file())) return { targets: [] };
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as Partial<TargetsFile>;
    return {
      targets: (parsed.targets ?? []).map((target) => ({
        ...target,
        // Migration for targets saved before the filter existed.
        mintMode: MINT_MODES.includes(target.mintMode) ? target.mintMode : "both",
        // Likewise, and it migrates to the strict value on purpose: a target
        // saved before this setting existed was configured under a rule that
        // only ever copied the target's own transactions, and a file upgrade
        // must not quietly widen what an operator agreed to.
        payer: PAYER_MODES.includes(target.payer) ? target.payer : "self",
      })),
    };
  } catch {
    return { targets: [] };
  }
}

function write(data: TargetsFile): void {
  ensureStateDir();
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file());
}

export class TargetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetsError";
  }
}

export function list(): WatchTarget[] {
  return read().targets;
}

export function addresses(): string[] {
  return read().targets.map((t) => t.address);
}

export function find(address: string): WatchTarget | undefined {
  const wanted = normalise(address).toLowerCase();
  return read().targets.find((t) => t.address.toLowerCase() === wanted);
}

export function add(
  address: string,
  tier: Tier,
  // Free unless the operator says otherwise. A target added without an explicit
  // answer must not start spending on its own — the standing instruction is
  // free-only, and every caller that means "any mint" passes "both" and says so.
  mintMode: MintMode = "free",
  label?: string,
  payer: PayerMode = "self"
): WatchTarget {
  const normalised = normalise(address);
  const data = read();

  const existing = data.targets.find(
    (t) => t.address.toLowerCase() === normalised.toLowerCase()
  );
  if (existing) {
    existing.tier = tier;
    existing.mintMode = mintMode;
    existing.payer = payer;
    if (label !== undefined) existing.label = label;
    write(data);
    return existing;
  }

  const target: WatchTarget = {
    address: normalised,
    tier,
    mintMode,
    payer,
    label,
    addedAt: Date.now(),
    fires: 0,
    recentFires: [],
  };
  data.targets.push(target);
  write(data);
  return target;
}

export function setMintMode(address: string, mintMode: MintMode): WatchTarget {
  const wanted = normalise(address).toLowerCase();
  const data = read();
  const target = data.targets.find((entry) => entry.address.toLowerCase() === wanted);
  if (!target) throw new TargetsError("That address is not being watched.");
  target.mintMode = mintMode;
  write(data);
  return target;
}

/** Free means the copied source transaction sent zero native ETH. */
export function allowsMint(target: Pick<WatchTarget, "mintMode">, valueWei: bigint): boolean {
  return (
    target.mintMode === "both" ||
    (target.mintMode === "free" && valueWei === 0n) ||
    (target.mintMode === "paid" && valueWei > 0n)
  );
}

/** Wallets that fire for this target — its own number, or the tier's. */
export function walletsFor(
  target: Pick<WatchTarget, "walletCount" | "tier">,
  tiers: Record<Tier, number>
): number {
  return target.walletCount ?? tiers[target.tier];
}

/** The price ceiling this target's signals are judged against. */
export function maxPriceFor(
  target: Pick<WatchTarget, "maxPriceEth">,
  globalMaxPriceWei: bigint
): bigint {
  if (!target.maxPriceEth) return globalMaxPriceWei;
  try {
    return parseEther(target.maxPriceEth);
  } catch {
    // A malformed override must not become "no ceiling at all".
    return globalMaxPriceWei;
  }
}

export const MAX_WALLETS_PER_TARGET = 500;

/** Fat-finger guard, same purpose as the one on the global caps. */
export const MAX_TARGET_PRICE_WEI = parseEther("10");

export function setWalletCount(address: string, count: number | undefined): WatchTarget {
  const wanted = normalise(address).toLowerCase();
  const data = read();
  const target = data.targets.find((entry) => entry.address.toLowerCase() === wanted);
  if (!target) throw new TargetsError("That address is not being watched.");

  if (count === undefined) {
    delete target.walletCount;
  } else {
    if (!Number.isInteger(count) || count < 1 || count > MAX_WALLETS_PER_TARGET) {
      throw new TargetsError(
        `Wallets per fire must be a whole number between 1 and ${MAX_WALLETS_PER_TARGET}.`
      );
    }
    target.walletCount = count;
  }
  write(data);
  return target;
}

export function setMaxPrice(address: string, maxPriceEth: string | undefined): WatchTarget {
  const wanted = normalise(address).toLowerCase();
  const data = read();
  const target = data.targets.find((entry) => entry.address.toLowerCase() === wanted);
  if (!target) throw new TargetsError("That address is not being watched.");

  if (maxPriceEth === undefined) {
    delete target.maxPriceEth;
  } else {
    const text = String(maxPriceEth).trim().replace(/\s*eth$/i, "");
    if (!/^\d+(\.\d+)?$/.test(text)) {
      throw new TargetsError(`"${maxPriceEth}" is not a plain ETH amount like 0.02.`);
    }
    let wei: bigint;
    try {
      wei = parseEther(text);
    } catch {
      throw new TargetsError(`"${maxPriceEth}" is not a valid ETH amount.`);
    }
    if (wei <= 0n) {
      throw new TargetsError("A zero ceiling would refuse every mint from this target.");
    }
    if (wei > MAX_TARGET_PRICE_WEI) {
      throw new TargetsError(
        `That is above the ${formatEther(MAX_TARGET_PRICE_WEI)} ETH ceiling for a per-target ` +
          `price. Check the decimal point.`
      );
    }
    target.maxPriceEth = text;
  }
  write(data);
  return target;
}

export function setPayer(address: string, payer: PayerMode): WatchTarget {
  const wanted = normalise(address).toLowerCase();
  const data = read();
  const target = data.targets.find((entry) => entry.address.toLowerCase() === wanted);
  if (!target) throw new TargetsError("That address is not being watched.");
  target.payer = payer;
  write(data);
  return target;
}

/**
 * Did the right wallet send this transaction?
 *
 * Under `self` the sender must be the target. Under `any` the sender is not
 * checked at all — the log filter already established that the NFT was minted
 * *to* the target, and that is the fact the operator asked to copy.
 */
export function allowsPayer(
  target: Pick<WatchTarget, "payer" | "address">,
  from: string
): boolean {
  if (target.payer === "any") return true;
  return from.toLowerCase() === target.address.toLowerCase();
}

export function remove(address: string): boolean {
  const wanted = normalise(address).toLowerCase();
  const data = read();
  const before = data.targets.length;
  data.targets = data.targets.filter((t) => t.address.toLowerCase() !== wanted);
  if (data.targets.length === before) return false;
  write(data);
  return true;
}

/** Record a fire and trim the rolling window used by the cooldown check. */
export function recordFire(address: string, windowMs: number): void {
  const wanted = normalise(address).toLowerCase();
  const data = read();
  const target = data.targets.find((t) => t.address.toLowerCase() === wanted);
  if (!target) return;

  const now = Date.now();
  target.fires += 1;
  target.recentFires = [...target.recentFires, now].filter((ts) => now - ts < windowMs);
  write(data);
}

/** How many times this target has fired inside the rolling window. */
export function firesInWindow(address: string, windowMs: number): number {
  const target = find(address);
  if (!target) return 0;
  const now = Date.now();
  return target.recentFires.filter((ts) => now - ts < windowMs).length;
}

export function normalise(address: string): string {
  try {
    return getAddress(address.trim());
  } catch {
    throw new TargetsError(`"${address}" is not a valid address.`);
  }
}

export function parseTier(value: string | undefined, fallback: Tier = "low"): Tier {
  if (!value) return fallback;
  const lower = value.trim().toLowerCase();
  if ((TIERS as string[]).includes(lower)) return lower as Tier;
  throw new TargetsError(`Unknown tier "${value}". Use one of: ${TIERS.join(", ")}.`);
}

export function parseMintMode(
  value: string | undefined,
  fallback: MintMode = "both"
): MintMode {
  if (!value) return fallback;
  const lower = value.trim().toLowerCase();
  if ((MINT_MODES as string[]).includes(lower)) return lower as MintMode;
  throw new TargetsError(`Unknown mint filter "${value}". Use: free, paid, or both.`);
}

export function parsePayer(
  value: string | undefined,
  fallback: PayerMode = "self"
): PayerMode {
  if (!value) return fallback;
  const lower = value.trim().toLowerCase();
  if ((PAYER_MODES as string[]).includes(lower)) return lower as PayerMode;
  // "vault" reads better than "any" when typing, and says why you want it.
  if (lower === "vault") return "any";
  throw new TargetsError(`Unknown payer setting "${value}". Use: self or any.`);
}
