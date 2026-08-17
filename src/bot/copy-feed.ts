// The copy-mint feed, as one message that keeps itself current.
//
// Every copy event used to be its own Telegram message. A watched wallet on a
// busy chain mints repeatedly, and each mint produced a detection plus a skip,
// so a quiet afternoon buried the chat under hundreds of near-identical cards —
// and the two lines that actually mattered were somewhere in the middle of it.
//
// The events themselves were right; publishing them as a transcript was not.
// Detections and skips are *state* — what the watcher is seeing right now — and
// state belongs in a card that updates in place. Only a result is a genuine
// event: money moved, it happened once, and it stays in the history where it
// can be scrolled back to.
//
// Three things keep the card readable:
//
//   · consecutive identical events collapse to "×N" rather than repeating,
//     which is what turns "Already firing" from forty lines into one;
//   · only the last few entries are kept, so the card has a fixed size;
//   · the card rotates after a while, so it does not end up scrolled far above
//     the conversation with no way to notice it changing.

import { Bot } from "grammy";
import { StatusCard, esc, short } from "./ui";

/** Entries shown at once. Enough for context, short enough to read at a glance. */
const WINDOW = 6;

/**
 * After this long, the next event starts a fresh card lower in the chat.
 * A card that never rotates eventually sits above a screenful of other
 * messages, updating where nobody is looking.
 */
const ROTATE_AFTER_MS = 10 * 60_000;

interface Entry {
  /** Consecutive entries sharing a key merge instead of repeating. */
  key: string;
  head: string;
  sub?: string;
  count: number;
  at: number;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

export class CopyFeed {
  private readonly bot: Bot;
  private readonly chatId: number;
  private card?: StatusCard;
  private opening?: Promise<void>;
  private openedAt = 0;
  private entries: Entry[] = [];
  private detected = 0;
  private skipped = 0;
  private fired = 0;

  constructor(bot: Bot, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  /** A watcher-level line — detection, skip, simulation, firing. */
  push(key: string, head: string, sub?: string): void {
    const last = this.entries[this.entries.length - 1];
    if (last && last.key === key) {
      last.count += 1;
      last.at = Date.now();
      last.sub = sub ?? last.sub;
    } else {
      this.entries.push({ key, head, sub, count: 1, at: Date.now() });
      if (this.entries.length > WINDOW) this.entries.shift();
    }
    void this.render();
  }

  countDetected(): void {
    this.detected += 1;
  }

  countSkipped(): void {
    this.skipped += 1;
  }

  countFired(n: number): void {
    this.fired += n;
  }

  /**
   * Close the card off and let the next event open a new one.
   *
   * Called when a result lands: the outcome goes out as its own message, and
   * the rolling card should stop competing with it.
   */
  async close(): Promise<void> {
    const card = this.card;
    this.card = undefined;
    this.opening = undefined;
    this.entries = [];
    if (card) await card.finish(this.text()).catch(() => undefined);
  }

  private text(): string {
    const lines = [`👁 <b>Copy-mint watch</b>`, ``];

    if (this.entries.length === 0) {
      lines.push(`<i>waiting for a signal…</i>`);
    } else {
      for (const entry of this.entries) {
        lines.push(
          `<code>${clock(entry.at)}</code>  ${entry.head}` + (entry.count > 1 ? ` <b>×${entry.count}</b>` : "")
        );
        if (entry.sub) lines.push(`      <i>${entry.sub}</i>`);
      }
    }

    lines.push(``);
    // The card is a single message, so Telegram's own timestamp is fixed at
    // whenever it was opened. The clock in here is the only live one, and it
    // has to say which clock it is — the bot runs on a VPS, not on the phone.
    lines.push(
      `<i>${this.detected} detected · ${this.skipped} skipped · ${this.fired} fired · times UTC</i>`
    );
    return lines.join("\n");
  }

  private async render(): Promise<void> {
    // Rotate a stale card so the live one stays near the bottom of the chat.
    if (this.card && Date.now() - this.openedAt > ROTATE_AFTER_MS) {
      const stale = this.card;
      this.card = undefined;
      this.opening = undefined;
      void stale.finish(`👁 <i>Copy-mint watch — continued below.</i>`).catch(() => undefined);
    }

    if (!this.card && !this.opening) {
      const card = new StatusCard(this.bot, this.chatId);
      this.opening = card
        .start(this.text())
        .then(() => {
          this.card = card;
          this.openedAt = Date.now();
        })
        .catch(() => undefined);
    }

    // A burst can arrive before the first send returns; those updates land on
    // the card once it exists rather than opening a second one.
    if (this.opening) await this.opening;
    this.card?.update(this.text());
  }
}

const feeds = new Map<number, CopyFeed>();

export function feedFor(bot: Bot, chatId: number): CopyFeed {
  let feed = feeds.get(chatId);
  if (!feed) {
    feed = new CopyFeed(bot, chatId);
    feeds.set(chatId, feed);
  }
  return feed;
}

/** Drop a chat's feed — used when its watchers stop. */
export function clearFeed(chatId: number): void {
  const feed = feeds.get(chatId);
  feeds.delete(chatId);
  void feed?.close().catch(() => undefined);
}

/** Formatting shared with the renderer, kept next to the card it feeds. */
export function contractLabel(contract: string): string {
  return `<code>${esc(short(contract))}</code>`;
}
