// Telegram rendering.
//
// Two constraints shape everything here. A message caps at 4,096 characters, so
// 500 transaction hashes (~35,000 characters) can never be shown inline — detail
// goes out as a CSV attachment instead. And editing a message more than about
// once a second earns 429s, so live progress is coalesced: updates overwrite a
// pending buffer and the newest text wins when the window opens.
//
// HTML parse mode rather than MarkdownV2 — addresses and error strings are full
// of characters MarkdownV2 requires escaping, and one missed escape breaks the
// whole message.

import { Bot } from "grammy";
import { formatEther } from "ethers";
import { explorerTx } from "../chains";

/** Telegram tolerates roughly one edit per second per chat before 429s. */
const EDIT_INTERVAL_MS = 1100;
const MAX_MESSAGE = 4000;

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function eth(wei: bigint, places = 5): string {
  const value = Number(formatEther(wei));
  if (value === 0) return "0";
  if (value < 0.00001) return "<0.00001";
  return value.toFixed(places).replace(/0+$/, "").replace(/\.$/, "");
}

export function bar(done: number, total: number, width = 16): string {
  if (total <= 0) return "░".repeat(width);
  const filled = Math.min(width, Math.round((done / total) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Cut a message down to something Telegram will accept.
 *
 * The cut lands on a line boundary on purpose. Slicing mid-line can land in
 * the middle of `<code>` or an `<a href=…>`, and Telegram answers a broken tag
 * with the same 400 it gives an over-long message — so a naive truncation
 * turns "too long" into "still rejected, now for a second reason". Every
 * renderer here opens and closes its tags on one line, so a line boundary is
 * always a safe place to stop.
 */
export function clamp(text: string): string {
  if (text.length <= MAX_MESSAGE) return text;
  const cut = text.slice(0, MAX_MESSAGE - 40);
  const boundary = cut.lastIndexOf("\n");
  return `${boundary > 0 ? cut.slice(0, boundary) : cut}\n…(truncated)`;
}

/**
 * A single message that edits in place.
 *
 * Callers push updates freely; this decides when they actually go out. The
 * pending text is always the latest, so a burst collapses to one edit rather
 * than a queue of stale ones.
 */
export class StatusCard {
  private readonly bot: Bot;
  private readonly chatId: number;
  private messageId?: number;
  private pending?: string;
  private lastSent = "";
  private lastEditAt = 0;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(bot: Bot, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  async start(text: string): Promise<void> {
    const message = await this.bot.api.sendMessage(this.chatId, clamp(text), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    this.messageId = message.message_id;
    this.lastSent = text;
    this.lastEditAt = Date.now();
  }

  update(text: string): void {
    if (this.closed || this.messageId === undefined) return;
    this.pending = text;

    const since = Date.now() - this.lastEditAt;
    if (since >= EDIT_INTERVAL_MS) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, EDIT_INTERVAL_MS - since);
      this.timer.unref?.();
    }
  }

  private async flush(): Promise<void> {
    if (this.messageId === undefined || this.pending === undefined) return;
    const text = this.pending;
    this.pending = undefined;

    // Telegram rejects an edit that changes nothing.
    if (text === this.lastSent) return;

    this.lastEditAt = Date.now();
    this.lastSent = text;
    try {
      await this.bot.api.editMessageText(this.chatId, this.messageId, clamp(text), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch {
      // A dropped progress frame is not worth failing a mint over.
    }
  }

  /** Final render, sent regardless of the throttle. */
  async finish(text: string, keyboard?: unknown): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.closed = true;
    if (this.messageId === undefined) {
      await this.start(text);
      return;
    }
    try {
      await this.bot.api.editMessageText(this.chatId, this.messageId, clamp(text), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard as never } : {}),
      });
    } catch {
      await this.bot.api.sendMessage(this.chatId, clamp(text), { parse_mode: "HTML" });
    }
  }
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): Buffer {
  const escapeCell = (cell: string | number): string => {
    const text = String(cell);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((c) => escapeCell(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(c.value(row))).join(","));
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

export function txLink(chainId: number, hash: string, label?: string): string {
  return `<a href="${explorerTx(chainId, hash)}">${esc(label ?? short(hash))}</a>`;
}
