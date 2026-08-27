// Who is allowed to talk to this bot.
//
// Every private chat is otherwise a new user: the first message creates a state
// directory, a config and a setup screen. That is the correct behaviour for a
// bot anyone may use and the wrong one for this deployment, where the operator
// holds three people's wallets and nobody else should be able to so much as
// open the menu.
//
// The list lives in the environment, not in config.json. config.json is
// per-user and writable through the settings flow, so an allowlist stored there
// could be edited by the very accounts it binds. The environment file is root's
// (/etc/copymint/env, 0640) and reachable only over SSH — the same rule the
// bot token already follows.

/** The environment key holding the comma-separated list of allowed chat ids. */
export const ALLOWED_CHATS_ENV = "COPYMINT_ALLOWED_CHATS";

export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessError";
  }
}

/**
 * Parse the allowlist.
 *
 * Strict on purpose. A typo in this value is not a cosmetic problem: a dropped
 * digit locks the real owner out, and an entry that silently parses to NaN
 * would widen the list to nobody while looking full. Anything that is not a
 * plain positive integer is refused by name, with the offending text quoted.
 *
 * Group and channel ids are negative in Telegram. They are rejected here rather
 * than ignored, because a group id in this list means somebody meant to grant
 * access to a group — and wallets in a shared chat is precisely what the
 * private-chat rule exists to prevent.
 */
export function parseAllowedChats(raw: string | undefined): number[] {
  const text = (raw ?? "").trim();
  if (text === "") return [];

  const seen = new Set<number>();
  for (const token of text.split(/[\s,;]+/).filter((part) => part.length > 0)) {
    if (token.startsWith("-")) {
      throw new AccessError(
        `${ALLOWED_CHATS_ENV}: "${token}" is a group or channel id. This bot only works in ` +
          `private chats, so only positive user chat ids belong here.`
      );
    }
    if (!/^\d+$/.test(token)) {
      throw new AccessError(
        `${ALLOWED_CHATS_ENV}: "${token}" is not a chat id. Expected digits only, ` +
          `separated by commas — for example 2101670897,6540926563.`
      );
    }
    const id = Number(token);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new AccessError(`${ALLOWED_CHATS_ENV}: "${token}" is not a usable chat id.`);
    }
    seen.add(id);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * The gate itself.
 *
 * Deliberately a closed set with no "empty means everyone" escape hatch. An
 * allowlist that opens up when it is missing fails in the direction that hands
 * strangers a wallet, and the one thing this must never do quietly is the
 * dangerous thing. Boot refuses to start on an empty list instead; see
 * `describeMissingList`.
 */
export class AccessList {
  private readonly allowed: Set<number>;

  constructor(chatIds: number[]) {
    this.allowed = new Set(chatIds);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AccessList {
    return new AccessList(parseAllowedChats(env[ALLOWED_CHATS_ENV]));
  }

  get size(): number {
    return this.allowed.size;
  }

  ids(): number[] {
    return [...this.allowed].sort((a, b) => a - b);
  }

  allows(chatId: number | undefined): boolean {
    return chatId !== undefined && this.allowed.has(chatId);
  }
}

/**
 * What to print when the list is missing, including the ids already on disk.
 *
 * The operator is being asked for chat ids, which are the one piece of Telegram
 * trivia nobody knows by heart. The users this deployment already has are
 * sitting in the state directory, so the error hands them over ready to paste
 * rather than making somebody go and find them.
 */
export function describeMissingList(existing: number[]): string {
  const suggestion =
    existing.length > 0
      ? `\n  The chats that already have state here are:\n\n    ${ALLOWED_CHATS_ENV}=${existing.join(",")}\n`
      : `\n  No chat has state here yet. Message the bot once from each account you want to\n` +
        `  allow, read the id out of the "Blocked chat <id>" line in the log, then set it.\n`;

  return (
    `\n  ${ALLOWED_CHATS_ENV} is not set, so nobody is allowed to use this bot.\n` +
    `\n  Set it in the bot's environment (on the VPS: /etc/copymint/env) to the private\n` +
    `  chat ids that may use it, separated by commas, then restart.\n` +
    suggestion
  );
}

/**
 * Should this blocked chat be told, or only logged?
 *
 * A refusal that answers every message hands a stranger a working oracle and
 * spends the bot's own rate limit doing it. Answering none of them leaves a
 * legitimate user — a fourth colleague, an account that changed id — staring at
 * silence. One reply per chat per hour is enough for a person to understand
 * they are not on the list, and cheap enough that a flood costs nothing.
 */
export const DENIAL_REPLY_INTERVAL_MS = 3_600_000;

export class DenialThrottle {
  private readonly lastReply = new Map<number, number>();

  constructor(private readonly intervalMs: number = DENIAL_REPLY_INTERVAL_MS) {}

  /** True when this chat should get the "not authorised" line right now. */
  shouldReply(chatId: number, now: number = Date.now()): boolean {
    const previous = this.lastReply.get(chatId);
    if (previous !== undefined && now - previous < this.intervalMs) return false;
    this.lastReply.set(chatId, now);
    // A blocked chat that keeps knocking must not grow this map without bound.
    if (this.lastReply.size > 1000) {
      for (const [id, at] of this.lastReply) {
        if (now - at >= this.intervalMs) this.lastReply.delete(id);
      }
    }
    return true;
  }
}
