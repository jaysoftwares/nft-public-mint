// Encrypt private keys locally, for transfer to the bot.
//
// This exists so a private key never has to travel through a chat message.
// Telegram would carry the plaintext to its servers and into message history on
// every synced device, and deleting the message afterwards does not recall any
// of that. Here the keys are encrypted before they leave the machine, and
// Telegram only ever carries a blob it cannot read.
//
//   npm run encrypt-keys            → writes ./keys.enc
//   npm run encrypt-keys -- out.enc → writes ./out.enc
//
// Use the same passphrase the bot unlocks with — that is what lets it decrypt
// the blob on arrival.

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";
import { sealJson } from "../core/crypto";
import { askHidden, askPassphrase, askYesNo, closePrompts } from "./tty";

interface KeyEntry {
  privateKey: string;
  label?: string;
}

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? "keys.enc");

  console.log("\n  Encrypt private keys for import\n");
  console.log("  Keys are read without echoing, encrypted here, and written to a file.");
  console.log("  Nothing is sent anywhere by this command.\n");

  if (existsSync(outPath)) {
    if (!(await askYesNo(`  ${outPath} exists. Overwrite?`, false))) {
      console.log("  Cancelled.");
      return;
    }
  }

  const entries: KeyEntry[] = [];
  const seen = new Set<string>();

  console.log("  Paste one private key per line. Blank line when done.\n");
  for (;;) {
    const raw = await askHidden(`  key ${entries.length + 1}: `);
    if (raw === "") break;

    let wallet: Wallet;
    try {
      wallet = new Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
    } catch {
      console.log("    Not a valid private key — skipped.");
      continue;
    }
    if (seen.has(wallet.address)) {
      console.log(`    ${wallet.address} already added — skipped.`);
      continue;
    }
    seen.add(wallet.address);
    entries.push({ privateKey: wallet.privateKey });
    // Echo the address so a mis-paste is caught here rather than at mint time.
    console.log(`    → ${wallet.address}`);
  }

  if (entries.length === 0) {
    console.log("\n  No keys entered. Nothing written.");
    return;
  }

  console.log(`\n  ${entries.length} key(s) read.`);
  console.log("  Use the passphrase the bot unlocks with — it needs to decrypt this.\n");
  const passphrase = await askPassphrase("  Passphrase: ", true);

  const envelope = sealJson({ keys: entries }, passphrase);
  writeFileSync(outPath, JSON.stringify(envelope, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  console.log(`\n  Written: ${outPath}`);
  console.log("  Upload that file to the bot as a document, then delete it here.\n");
}

main()
  .then(() => closePrompts())
  .catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
