// Where the bot keeps state.
//
// Deliberately NOT inside the repo. This project lives under OneDrive on the
// operator's machine, and anything written there syncs to Microsoft's cloud —
// which is exactly what an encrypted seed must not do. os.homedir() sits above
// the OneDrive tree on Windows (C:\Users\<user>) and is a normal home on Linux.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

const stateContext = new AsyncLocalStorage<string>();

export function rootStateDir(): string {
  return process.env.COPYMINT_HOME || join(homedir(), ".copymint");
}

export function stateDir(): string {
  return stateContext.getStore() || rootStateDir();
}

export function userStateDir(chatId: number): string {
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    throw new Error(`Invalid private Telegram chat id: ${chatId}`);
  }
  return join(rootStateDir(), "users", String(chatId));
}

/** Users whose encrypted stores should resume background work after a reboot. */
export function storedUserChatIds(): number[] {
  const users = join(rootStateDir(), "users");
  if (!existsSync(users)) return [];
  return readdirSync(users, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter(
      (chatId) =>
        Number.isSafeInteger(chatId) &&
        chatId > 0 &&
        existsSync(join(users, String(chatId), "seed.enc"))
    )
    .sort((a, b) => a - b);
}

/** Keep every path lookup inside one Telegram user's isolated state tree. */
export function withStateDir<T>(dir: string, work: () => T): T {
  return stateContext.run(dir, work);
}

export function ensureStateDir(): string {
  const dir = stateDir();
  if (!existsSync(dir)) {
    // 0o700: owner only. A no-op on Windows, load-bearing on the VPS.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export const FILES = {
  config: () => join(stateDir(), "config.json"),
  seed: () => join(stateDir(), "seed.enc"),
  imported: () => join(stateDir(), "imported.enc"),
  meta: () => join(stateDir(), "meta.json"),
  ledger: () => join(stateDir(), "ledger.json"),
};
