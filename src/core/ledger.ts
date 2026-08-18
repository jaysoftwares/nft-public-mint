// A local record of what the bot has done.
//
// Two jobs. It tells a sweep which blocks are worth scanning for holdings —
// without it, finding NFTs across 500 wallets means walking the whole chain.
// And it backs the rolling 24h spend cap that phase 2's autonomous path needs,
// which has to survive a restart or the cap resets every time the bot reboots.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { FILES, ensureStateDir } from "./paths";

export type LedgerKind = "mint" | "fund" | "sweep";

export interface LedgerEntry {
  ts: number;
  kind: LedgerKind;
  chainId: number;
  /** NFT contract for a mint; absent for funding and sweeps. */
  contract?: string;
  walletIds: string[];
  /** Total ETH committed, as a decimal-free wei string. */
  valueWei: string;
  /**
   * True when the bot spent this without a human in the loop.
   *
   * The rolling cap exists to bound what copy-mint can spend on its own. It
   * used to count every `mint` entry, so a single hand-driven /mint could
   * exhaust the day's autonomous allowance and copy-mint would go quiet with
   * "Daily budget exhausted" — a limit the operator never asked to be measured
   * against their own deliberate spending.
   */
  auto?: boolean;
  /** Earliest block a resulting transfer could appear in. */
  fromBlock?: number;
  note?: string;
}

interface LedgerFile {
  entries: LedgerEntry[];
}

const MAX_ENTRIES = 5000;

function read(): LedgerFile {
  const path = FILES.ledger();
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LedgerFile>;
    return { entries: parsed.entries ?? [] };
  } catch {
    // A corrupt ledger costs history, not money — start fresh rather than
    // refusing to boot.
    return { entries: [] };
  }
}

function write(file: LedgerFile): void {
  ensureStateDir();
  const trimmed: LedgerFile = { entries: file.entries.slice(-MAX_ENTRIES) };
  const path = FILES.ledger();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function record(entry: Omit<LedgerEntry, "ts">): void {
  const file = read();
  file.entries.push({ ...entry, ts: Date.now() });
  write(file);
}

export function entries(): LedgerEntry[] {
  return read().entries;
}

export interface SpendFilter {
  /**
   * Count only spending the bot decided on by itself. This is what the caps
   * govern; a mint the operator typed is their own decision and is not charged
   * against the autonomous allowance.
   */
  autoOnly?: boolean;
}

/** Total committed in the last `hours`, for the rolling autonomous spend cap. */
export function spentSince(
  hours: number,
  kinds: LedgerKind[] = ["mint"],
  filter: SpendFilter = {}
): bigint {
  const cutoff = Date.now() - hours * 3_600_000;
  return read()
    .entries.filter((e) => e.ts >= cutoff && kinds.includes(e.kind))
    .filter((e) => !filter.autoOnly || e.auto === true)
    .reduce((sum, e) => sum + BigInt(e.valueWei), 0n);
}

/**
 * The earliest block a sweep needs to scan. Returns undefined when nothing has
 * been minted, so the caller can fall back to a bounded recent window rather
 * than walking the chain from genesis.
 */
export function earliestMintBlock(chainId: number): number | undefined {
  const blocks = read()
    .entries.filter((e) => e.kind === "mint" && e.chainId === chainId && e.fromBlock !== undefined)
    .map((e) => e.fromBlock as number);
  return blocks.length > 0 ? Math.min(...blocks) : undefined;
}

/** Contracts this bot has minted on, newest first — the sweep's candidate list. */
export function mintedContracts(chainId: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...read().entries].reverse()) {
    if (entry.kind !== "mint" || entry.chainId !== chainId || !entry.contract) continue;
    const key = entry.contract.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry.contract);
  }
  return out;
}
