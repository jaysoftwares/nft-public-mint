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
import { getAddress } from "ethers";
import { stateDir, ensureStateDir } from "./paths";

export type Tier = "high" | "med" | "low";

export const TIERS: Tier[] = ["high", "med", "low"];

export interface WatchTarget {
  address: string;
  tier: Tier;
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
    return { targets: parsed.targets ?? [] };
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

export function add(address: string, tier: Tier, label?: string): WatchTarget {
  const normalised = normalise(address);
  const data = read();

  const existing = data.targets.find(
    (t) => t.address.toLowerCase() === normalised.toLowerCase()
  );
  if (existing) {
    existing.tier = tier;
    if (label !== undefined) existing.label = label;
    write(data);
    return existing;
  }

  const target: WatchTarget = {
    address: normalised,
    tier,
    label,
    addedAt: Date.now(),
    fires: 0,
    recentFires: [],
  };
  data.targets.push(target);
  write(data);
  return target;
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
