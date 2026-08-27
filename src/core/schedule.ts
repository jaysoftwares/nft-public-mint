// Mints booked in advance.
//
// A drop opens at a published minute and is gone in the next one, which makes
// "be at your phone at 15:00 UTC" the actual requirement of every command in
// this bot until now. /fcfs could already hold until a time, but only for as
// long as the handler that started it stayed alive: a restart, a deploy or a
// dropped connection silently cancelled it, and nothing said so.
//
// This is the durable version. A booking is a file, not a promise in memory:
// it survives a restart, it can be listed and cancelled, and the runner picks
// it up again from disk.
//
// The time parsing is the part worth being pedantic about. "at 3" is a real
// thing somebody types when they mean 15:00 and a mint fired twelve hours late
// costs gas and buys nothing, so every accepted format here is unambiguous and
// everything else is refused by name rather than guessed at.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { stateDir, ensureStateDir } from "./paths";

/**
 * Which machinery does the buying.
 *
 * `public` reads the SeaDrop public drop straight off the chain, so everything
 * — plan, balances, signatures — is done before the stage opens and T-0 is
 * nothing but socket writes. `fcfs` goes through OpenSea, which refuses to
 * issue calldata before a stage opens and therefore cannot be pre-signed; its
 * T-0 is a fetch. `auto` picks the first that is actually available, which is
 * what somebody who pasted a link and a time meant.
 */
export type MintPath = "auto" | "public" | "fcfs";

export type ScheduleStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "missed";

export const MINT_PATHS: MintPath[] = ["auto", "public", "fcfs"];

export interface ScheduledMint {
  id: string;
  contract: string;
  chainKey: string;
  chainId: number;
  /** OpenSea collection slug, when one was resolved at booking time. */
  slug?: string;
  collection?: string;
  quantity: number;
  selector: string;
  path: MintPath;
  /** Epoch ms, UTC. */
  fireAt: number;
  createdAt: number;
  status: ScheduleStatus;
  finishedAt?: number;
  /** One line describing how it went, kept so /scheduled can show history. */
  outcome?: string;
  /**
   * Facts captured when it was booked, so the list renders without a network.
   *
   * Deliberately a snapshot rather than a live read: a list that has to reach
   * three chains and OpenSea to draw itself is a list that fails to draw.
   */
  priceWei?: string;
  supply?: string;
  maxSupply?: string;
  stage?: string;
}

interface ScheduleFile {
  mints: ScheduledMint[];
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

/** How many finished bookings to keep for history before dropping the oldest. */
const KEEP_FINISHED = 30;
/** A booking cannot be made closer to now than this — there is arming to do. */
export const MIN_LEAD_MS = 20_000;
/** Nor further out than this. Beyond a month it is a note, not a schedule. */
export const MAX_LEAD_MS = 32 * 24 * 3_600_000;

function file(): string {
  return join(stateDir(), "schedule.json");
}

function read(): ScheduleFile {
  if (!existsSync(file())) return { mints: [] };
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as Partial<ScheduleFile>;
    return { mints: parsed.mints ?? [] };
  } catch {
    // A corrupt schedule costs bookings, not money. Starting empty beats
    // refusing to boot, and the operator finds out at the next /scheduled.
    return { mints: [] };
  }
}

function write(data: ScheduleFile): void {
  ensureStateDir();
  // Finished bookings are history and must not grow without bound; pending
  // ones are commitments and are never trimmed however many there are.
  const pending = data.mints.filter((m) => m.status === "pending" || m.status === "running");
  const finished = data.mints
    .filter((m) => m.status !== "pending" && m.status !== "running")
    .sort((a, b) => (a.finishedAt ?? a.fireAt) - (b.finishedAt ?? b.fireAt))
    .slice(-KEEP_FINISHED);

  const merged = [...pending, ...finished].sort((a, b) => a.fireAt - b.fireAt);
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mints: merged }, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, file());
}

export function newId(): string {
  return randomBytes(3).toString("hex");
}

export function list(): ScheduledMint[] {
  return read().mints.sort((a, b) => a.fireAt - b.fireAt);
}

export function pending(): ScheduledMint[] {
  return list().filter((m) => m.status === "pending" || m.status === "running");
}

export function find(id: string): ScheduledMint | undefined {
  const wanted = id.trim().toLowerCase();
  return read().mints.find((m) => m.id === wanted);
}

export function add(mint: Omit<ScheduledMint, "id" | "createdAt" | "status">): ScheduledMint {
  const data = read();
  const entry: ScheduledMint = {
    ...mint,
    id: newId(),
    createdAt: Date.now(),
    status: "pending",
  };
  data.mints.push(entry);
  write(data);
  return entry;
}

export function update(id: string, patch: Partial<ScheduledMint>): ScheduledMint | undefined {
  const data = read();
  const entry = data.mints.find((m) => m.id === id);
  if (!entry) return undefined;
  Object.assign(entry, patch);
  write(data);
  return entry;
}

export function cancel(id: string): ScheduledMint | undefined {
  const entry = find(id);
  if (!entry) return undefined;
  if (entry.status !== "pending") return entry;
  return update(id, { status: "cancelled", finishedAt: Date.now(), outcome: "cancelled" });
}

export function remove(id: string): boolean {
  const data = read();
  const before = data.mints.length;
  data.mints = data.mints.filter((m) => m.id !== id);
  if (data.mints.length === before) return false;
  write(data);
  return true;
}

/**
 * Hand back bookings that were mid-flight when the process ended.
 *
 * "running" means a runner owns it, and the runner is a timer in a process. If
 * that process is gone the claim is stale, and without this the booking sits in
 * a status nothing looks at — never fired, never buried, invisible to both
 * `due` and the operator's expectation that something would happen. Returning
 * them to pending puts them back under the ordinary rules, which will either
 * fire them if their moment is still ahead or bury them if it is not.
 *
 * Called once when a runner starts, never during one: a live runner's claim is
 * not stale.
 */
export function reclaimRunning(): ScheduledMint[] {
  const data = read();
  const stale = data.mints.filter((m) => m.status === "running");
  if (stale.length === 0) return [];
  for (const entry of stale) entry.status = "pending";
  write(data);
  return stale;
}

/**
 * Bookings close enough to now that the runner should start preparing.
 *
 * `leadMs` is preparation time, not slack: resolving wallets, priming nonces,
 * reading the drop and signing five hundred transactions all have to happen
 * before T-0 or the whole point of scheduling is lost.
 */
export function due(nowMs: number, leadMs: number): ScheduledMint[] {
  return list().filter((m) => m.status === "pending" && m.fireAt - nowMs <= leadMs);
}

/**
 * A booking whose moment passed while the bot was not running.
 *
 * Fired late rather than skipped only inside `graceMs`. Beyond that a mint is
 * not merely late, it is a different decision: the drop is minutes or hours
 * old, the price and the supply are not what was agreed to, and firing anyway
 * spends money on something nobody chose. It is reported instead.
 */
export function missed(nowMs: number, graceMs: number): ScheduledMint[] {
  return list().filter((m) => m.status !== "done" && m.status !== "cancelled" && m.status !== "failed" && m.status !== "missed" && nowMs - m.fireAt > graceMs);
}

// ── Time ──────────────────────────────────────────────────────────────────

const RELATIVE = /^in\s+(.+)$/i;
const DURATION_PART = /(\d+)\s*([smhd])/gi;
const HH_MM = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ tT](\d{1,2}):(\d{2})(?::(\d{2}))?Z?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Turn what somebody typed into an instant, or refuse it.
 *
 * Every accepted form is unambiguous. "at 3" is not accepted, and that is the
 * point: it means 03:00 to a clock and 15:00 to the person typing it, and the
 * two are twelve hours and one missed drop apart. Times with no date are UTC
 * and roll to tomorrow if today's has passed, which is the only reading of
 * "at 09:00" typed at ten in the morning that is ever useful.
 */
export function parseWhen(input: string, now: number = Date.now()): number {
  const text = input.trim().replace(/\s+/g, " ");
  if (text === "") throw new ScheduleError("Say when: a time like 15:30, or 2026-08-29 15:30.");

  const relative = RELATIVE.exec(text);
  if (relative) {
    const body = relative[1].replace(/\s+/g, "");
    DURATION_PART.lastIndex = 0;
    let ms = 0;
    let matched = false;
    let consumed = 0;
    let part: RegExpExecArray | null;
    while ((part = DURATION_PART.exec(body)) !== null) {
      matched = true;
      consumed += part[0].length;
      const value = Number(part[1]);
      const unit = part[2].toLowerCase();
      ms +=
        value *
        (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    }
    // A trailing "in 30x" must not quietly parse as 30 seconds of nothing.
    if (!matched || consumed !== body.length) {
      throw new ScheduleError(
        `"${input.trim()}" is not a duration. Try <code>in 45m</code>, <code>in 2h</code> or <code>in 1h30m</code>.`
      );
    }
    return requireSane(now + ms, now);
  }

  // Epoch, in seconds or milliseconds. Useful because it is exactly what a
  // drop page's countdown script contains when somebody goes looking.
  if (/^\d{10}$/.test(text)) return requireSane(Number(text) * 1000, now);
  if (/^\d{13}$/.test(text)) return requireSane(Number(text), now);

  const dateTime = DATE_TIME.exec(text);
  if (dateTime) {
    const [, y, mo, d, h, mi, s] = dateTime;
    const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
    if (Number.isNaN(at)) throw new ScheduleError(`"${input.trim()}" is not a real date and time.`);
    requireRealDate(Number(y), Number(mo), Number(d), Number(h), Number(mi), input);
    return requireSane(at, now);
  }

  if (DATE_ONLY.test(text)) {
    throw new ScheduleError(
      `"${input.trim()}" has no time of day. A drop opens at a minute, not a date — ` +
        `try <code>${text} 15:00</code>.`
    );
  }

  const clock = HH_MM.exec(text);
  if (clock) {
    const h = Number(clock[1]);
    const mi = Number(clock[2]);
    const s = Number(clock[3] ?? 0);
    if (h > 23 || mi > 59 || s > 59) {
      throw new ScheduleError(`"${input.trim()}" is not a time on a 24-hour clock (UTC).`);
    }
    const today = new Date(now);
    let at = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
      h,
      mi,
      s
    );
    // Today's 09:00 typed at ten in the morning means tomorrow's.
    if (at <= now) at += 86_400_000;
    return requireSane(at, now);
  }

  throw new ScheduleError(
    `"${input.trim()}" is not a time I can read. Use <code>15:30</code> (UTC today or tomorrow), ` +
      `<code>2026-08-29 15:30</code>, or <code>in 45m</code>.`
  );
}

/** Catch 2026-02-30, which Date.UTC silently rolls forward into March. */
function requireRealDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  input: string
): void {
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    at.getUTCFullYear() !== year ||
    at.getUTCMonth() !== month - 1 ||
    at.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    throw new ScheduleError(`"${input.trim()}" is not a real date and time.`);
  }
}

function requireSane(at: number, now: number): number {
  if (!Number.isFinite(at)) throw new ScheduleError("That is not a time.");
  if (at - now < MIN_LEAD_MS) {
    if (at <= now) {
      throw new ScheduleError(
        `That moment has already passed. Times are UTC — it is ${new Date(now)
          .toISOString()
          .slice(11, 16)} UTC now.`
      );
    }
    throw new ScheduleError(
      `That is only ${Math.round((at - now) / 1000)}s away. A scheduled mint needs at least ` +
        `${MIN_LEAD_MS / 1000}s to read the drop, check funding and sign. Mint it now instead.`
    );
  }
  if (at - now > MAX_LEAD_MS) {
    throw new ScheduleError("That is more than a month away — closer to a reminder than a mint.");
  }
  return at;
}

/** "in 2h 14m", for a card that has to say how long is left without a clock. */
export function untilText(ms: number): string {
  if (ms <= 0) return "now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** "2026-08-29 15:30 UTC" — one format everywhere, so two screens never disagree. */
export function whenText(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
