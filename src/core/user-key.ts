import { createHmac } from "node:crypto";

/** Derive a stable, distinct at-rest encryption key for one private chat. */
export function deriveUserPassphrase(master: string, chatId: number): string {
  if (!master.trim()) throw new Error("The server master passphrase is empty.");
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    throw new Error(`Invalid private Telegram chat id: ${chatId}`);
  }
  return createHmac("sha256", master)
    .update(`copymint-telegram-user:${chatId}`)
    .digest("hex");
}
