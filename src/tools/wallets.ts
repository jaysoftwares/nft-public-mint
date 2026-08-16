// Local wallet-store management.
//
// Everything here is deliberately outside the bot: creating the store, seeing
// the mnemonic once, and reading addresses back are operations that should
// happen at a keyboard, not over a chat channel.
//
//   npm run wallets -- init            create config + a new store
//   npm run wallets -- restore         adopt an existing mnemonic
//   npm run wallets -- generate 500    extend the derived set
//   npm run wallets -- list [n]        show wallets
//   npm run wallets -- import <file>   merge a keys.enc blob
//   npm run wallets -- export <file>   write imported keys to a new blob

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  initNew,
  initFromMnemonic,
  unlock,
  storeExists,
  readImportBlob,
} from "../core/wallet-store";
import { writeDefaultConfig } from "../core/config";
import { FILES, stateDir } from "../core/paths";
import { askPassphrase, askText, askYesNo, closePrompts } from "./tty";

async function cmdInit(): Promise<void> {
  const configPath = writeDefaultConfig();
  console.log(`\n  State directory: ${stateDir()}`);
  console.log(`  Config:          ${configPath}`);

  if (storeExists()) {
    console.log(`  Wallet store:    already exists at ${FILES.seed()} — left untouched.\n`);
  } else {
    console.log("\n  Creating a new wallet store.");
    console.log("  The passphrase encrypts the mnemonic. There is no recovery if you lose it.\n");
    const passphrase = await askPassphrase("  New passphrase: ", true);
    const phrase = initNew(passphrase);

    console.log("\n  ┌─────────────────────────────────────────────────────────────┐");
    console.log("  │  RECOVERY PHRASE — write this down now, on paper.           │");
    console.log("  │  It restores every derived wallet. It is shown once.        │");
    console.log("  └─────────────────────────────────────────────────────────────┘\n");
    console.log(`    ${phrase}\n`);
    console.log("  Note: this does NOT back up imported keys. Those live in");
    console.log(`  ${FILES.imported()} and need their own backup.\n`);
    await askText("  Press Enter once you have written it down. ");
    // Clear the phrase off screen so it isn't left in scrollback. Only useful
    // on a terminal; skipped when output is piped or logged.
    if (process.stdout.isTTY) console.clear();
    console.log("\n  Stored.\n");
  }

  console.log("  Next: edit the config and set `vault`, `funder` and `telegram.allowedChatIds`.");
  console.log("  Those addresses are intentionally not settable from Telegram.\n");
}

async function cmdRestore(): Promise<void> {
  if (storeExists()) {
    console.log(`\n  A store already exists at ${FILES.seed()}. Move it aside first.\n`);
    return;
  }
  console.log("\n  Restore from an existing BIP-39 mnemonic.\n");
  const phrase = await askText("  Mnemonic: ");
  const passphrase = await askPassphrase("  New passphrase: ", true);
  initFromMnemonic(phrase, passphrase);
  writeDefaultConfig();
  console.log("\n  Restored. Run `npm run wallets -- generate <n>` to derive wallets.\n");
}

async function cmdGenerate(countArg: string | undefined): Promise<void> {
  const count = Number(countArg ?? 500);
  if (!Number.isInteger(count) || count < 1) {
    console.log("\n  Usage: npm run wallets -- generate <count>\n");
    return;
  }
  const store = unlock(await askPassphrase("  Passphrase: "));
  const before = store.derivedCount;
  const created = store.generate(count);
  console.log(`\n  Derived ${created.length} wallets (indices ${before}–${store.derivedCount - 1}).`);
  console.log(`  First: ${created[0].address}`);
  console.log(`  Last:  ${created[created.length - 1].address}`);
  console.log("\n  Nothing new was written to disk — only the count moved.\n");
}

async function cmdList(limitArg: string | undefined): Promise<void> {
  const limit = Number(limitArg ?? 20);
  const store = unlock(await askPassphrase("  Passphrase: "));
  const wallets = store.all();

  const derived = wallets.filter((w) => w.kind === "derived").length;
  const imported = wallets.filter((w) => w.kind === "imported").length;
  console.log(`\n  ${wallets.length} wallets — ${derived} derived, ${imported} imported\n`);

  for (const wallet of wallets.slice(0, limit)) {
    const origin = wallet.kind === "derived" ? `d:${wallet.index}`.padEnd(8) : "imported";
    const fire = wallet.autoFire ? "auto" : "manual";
    console.log(`    ${origin}  ${wallet.address}  ${fire}${wallet.label ? `  ${wallet.label}` : ""}`);
  }
  if (wallets.length > limit) console.log(`    … ${wallets.length - limit} more`);
  console.log();
}

async function cmdImport(file: string | undefined): Promise<void> {
  if (!file) {
    console.log("\n  Usage: npm run wallets -- import <keys.enc>\n");
    return;
  }
  const path = resolve(file);
  const passphrase = await askPassphrase("  Passphrase: ");
  const store = unlock(passphrase);
  const entries = readImportBlob(readFileSync(path, "utf8"), passphrase);
  const result = store.importKeys(entries);

  console.log(`\n  Imported ${result.added.length} wallet(s).`);
  for (const address of result.added) console.log(`    + ${address}`);
  if (result.duplicates.length > 0) {
    console.log(`  Skipped ${result.duplicates.length} already present.`);
  }
  console.log("\n  Imported wallets are manual-only: they will not fire on copy signals");
  console.log("  until enabled explicitly.\n");
}

async function cmdExport(file: string | undefined): Promise<void> {
  if (!file) {
    console.log("\n  Usage: npm run wallets -- export <out.enc>\n");
    return;
  }
  const store = unlock(await askPassphrase("  Passphrase: "));
  console.log("\n  Choose a passphrase for the exported file.\n");
  const exportPass = await askPassphrase("  Export passphrase: ", true);
  const envelope = store.exportImported(exportPass);
  const path = resolve(file);
  writeFileSync(path, JSON.stringify(envelope, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  console.log(`\n  Written: ${path}\n`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case "init":
      return cmdInit();
    case "restore":
      return cmdRestore();
    case "generate":
      return cmdGenerate(arg);
    case "list":
      return cmdList(arg);
    case "import":
      return cmdImport(arg);
    case "export":
      return cmdExport(arg);
    default:
      console.log(`
  Wallet store management

    npm run wallets -- init            create config + a new store
    npm run wallets -- restore         adopt an existing mnemonic
    npm run wallets -- generate 500    extend the derived set
    npm run wallets -- list [n]        show wallets
    npm run wallets -- import <file>   merge a keys.enc blob
    npm run wallets -- export <file>   write imported keys to a new blob

  State lives in ${stateDir()}
`);
  }
}

main()
  .then(() => closePrompts())
  .catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
