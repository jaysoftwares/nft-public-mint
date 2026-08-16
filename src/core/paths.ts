// Where the bot keeps state.
//
// Deliberately NOT inside the repo. This project lives under OneDrive on the
// operator's machine, and anything written there syncs to Microsoft's cloud —
// which is exactly what an encrypted seed must not do. os.homedir() sits above
// the OneDrive tree on Windows (C:\Users\<user>) and is a normal home on Linux.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export function stateDir(): string {
  return process.env.COPYMINT_HOME || join(homedir(), ".copymint");
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
