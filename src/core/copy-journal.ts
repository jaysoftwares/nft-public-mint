// What the watcher saw, and what came of it.
//
// Copy-mint's whole output used to be a Telegram card that collapsed repeats,
// kept six lines, and rotated itself every ten minutes. Live, that is the right
// shape — it is state, not history. But it meant that by the time somebody
// asked "why has this never fired?", every answer had already scrolled away.
// Nineteen watched wallets sat at fires: 0 with no record anywhere of the
// signals that had been seen and dropped, or of why.
//
// So every signal is written down: what was detected, what was decided, and —
// the part that was missing entirely — what the operator could change to make
// the next one land. Small file, capped, plain English, survives restarts.
//
// The reasons here are deliberately not the engine's internal vocabulary.
// "Price above ceiling" is accurate and tells a reader nothing; "they paid
// 0.0195 ETH per wallet and your limit is 0.005" tells them the number to
// change and what to change it to.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stateDir, ensureStateDir } from "./paths";

export type SignalOutcome = "fired" | "skipped" | "failed";

export interface SignalRecord {
  ts: number;
  chainId: number;
  chainName: string;
  target: string;
  contract: string;
  txHash: string;
  block: number;
  outcome: SignalOutcome;
  /** One line, plain English: what happened. */
  what: string;
  /** One line, plain English: what to change, when there is something. */
  fix?: string;
  /** Set when we fired. */
  walletsFired?: number;
  walletsAccepted?: number;
  spentWei?: string;
  strategy?: string;
}

interface JournalFile {
  signals: SignalRecord[];
}

/**
 * Enough to answer "what happened overnight" without the file ever mattering
 * for disk. A busy chain produces a few hundred signals a day at most.
 */
const MAX_SIGNALS = 400;

function path(): string {
  return join(stateDir(), "copy-journal.json");
}

function read(): JournalFile {
  const file = path();
  if (!existsSync(file)) return { signals: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<JournalFile>;
    return { signals: parsed.signals ?? [] };
  } catch {
    // History is nice to have; refusing to boot over it is not.
    return { signals: [] };
  }
}

function write(file: JournalFile): void {
  ensureStateDir();
  const trimmed: JournalFile = { signals: file.signals.slice(-MAX_SIGNALS) };
  const target = path();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
}

export function recordSignal(record: Omit<SignalRecord, "ts">): void {
  const file = read();
  file.signals.push({ ...record, ts: Date.now() });
  write(file);
}

export function recentSignals(limit = 20): SignalRecord[] {
  return read().signals.slice(-limit).reverse();
}

export function allSignals(): SignalRecord[] {
  return read().signals;
}

export interface SkipTally {
  /** The `what` line, with its numbers stripped so repeats group together. */
  reason: string;
  count: number;
  lastAt: number;
  fix?: string;
  example: SignalRecord;
}

/**
 * Group the misses by cause, commonest first.
 *
 * Numbers are stripped from the key so "they paid 0.0195" and "they paid 0.031"
 * count as one cause rather than two — the operator has one thing to fix, and a
 * list that says so once is worth more than a list that says so forty times.
 */
export function tallySkips(withinMs = 7 * 24 * 60 * 60 * 1000): SkipTally[] {
  const cutoff = Date.now() - withinMs;
  const groups = new Map<string, SkipTally>();

  for (const signal of read().signals) {
    if (signal.ts < cutoff) continue;
    if (signal.outcome === "fired") continue;
    const key = signal.what.replace(/[\d.]+/g, "#");
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (signal.ts > existing.lastAt) {
        existing.lastAt = signal.ts;
        existing.example = signal;
        existing.reason = signal.what;
      }
    } else {
      groups.set(key, {
        reason: signal.what,
        count: 1,
        lastAt: signal.ts,
        fix: signal.fix,
        example: signal,
      });
    }
  }

  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

export interface JournalSummary {
  seen: number;
  fired: number;
  skipped: number;
  lastSignalAt?: number;
  lastFireAt?: number;
}

export function summarise(withinMs = 7 * 24 * 60 * 60 * 1000): JournalSummary {
  const cutoff = Date.now() - withinMs;
  const signals = read().signals.filter((s) => s.ts >= cutoff);
  const fired = signals.filter((s) => s.outcome === "fired");
  return {
    seen: signals.length,
    fired: fired.length,
    skipped: signals.length - fired.length,
    lastSignalAt: signals[signals.length - 1]?.ts,
    lastFireAt: fired[fired.length - 1]?.ts,
  };
}
