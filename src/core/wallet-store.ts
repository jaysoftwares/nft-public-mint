// The wallet store: 500+ HD-derived wallets plus any imported keys.
//
// Three files, split by what they contain rather than by what they are for:
//
//   seed.enc      encrypted BIP-39 mnemonic — the whole derived set, in 12 words
//   imported.enc  encrypted private keys that cannot be re-derived from anything
//   meta.json     plaintext, no secrets: labels, auto-fire flags, manual tags
//
// The split is the backup story. Twelve words restore every derived wallet; they
// restore nothing that was imported, which is why imported keys get their own
// file and their own export path. Losing imported.enc loses those wallets.
//
// Auto-fire defaults differ by origin and that is deliberate: derived wallets are
// disposable and fire on copy signals, imported wallets hold real value and stay
// out of the autonomous path until explicitly opted in.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { HDNodeWallet, Mnemonic, Wallet, getAddress, isAddress } from "ethers";
import {
  Envelope,
  sealJson,
  unsealJson,
  looksLikeEnvelope,
  DecryptError,
} from "./crypto";
import { FILES, ensureStateDir } from "./paths";

/** Account-level node; individual wallets are children of this. */
export const ACCOUNT_PATH = "m/44'/60'/0'/0";

export type WalletKind = "derived" | "imported";

export interface ManagedWallet {
  /** Stable identifier: "d:<index>" for derived, "i:<address>" for imported. */
  id: string;
  address: string;
  kind: WalletKind;
  /** Derivation index — derived wallets only. */
  index?: number;
  label?: string;
  autoFire: boolean;
  /** Operator-assigned tags. Automatic tags are computed in tags.ts. */
  tags: string[];
}

interface SeedFile {
  mnemonic: string;
}

interface ImportedFile {
  keys: { privateKey: string; label?: string }[];
}

interface DerivedMeta {
  label?: string;
  autoFire?: boolean;
  tags?: string[];
}

interface ImportedMeta {
  address: string;
  label?: string;
  autoFire?: boolean;
  tags?: string[];
}

interface MetaFile {
  derivedCount: number;
  accountPath: string;
  derived: Record<string, DerivedMeta>;
  imported: ImportedMeta[];
}

const EMPTY_META: MetaFile = {
  derivedCount: 0,
  accountPath: ACCOUNT_PATH,
  derived: {},
  imported: [],
};

export class WalletStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletStoreError";
  }
}

// Write via temp + rename so a crash mid-write can't leave a truncated store.
function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function readEnvelope(path: string, what: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new WalletStoreError(`${what} at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!looksLikeEnvelope(parsed)) {
    throw new WalletStoreError(`${what} at ${path} is not an encrypted envelope.`);
  }
  return parsed;
}

function readMeta(): MetaFile {
  const path = FILES.meta();
  if (!existsSync(path)) return { ...EMPTY_META, derived: {}, imported: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MetaFile>;
    return {
      derivedCount: parsed.derivedCount ?? 0,
      accountPath: parsed.accountPath ?? ACCOUNT_PATH,
      derived: parsed.derived ?? {},
      imported: parsed.imported ?? [],
    };
  } catch (err) {
    throw new WalletStoreError(`meta.json is corrupt: ${(err as Error).message}`);
  }
}

function writeMeta(meta: MetaFile): void {
  ensureStateDir();
  atomicWrite(FILES.meta(), JSON.stringify(meta, null, 2) + "\n");
}

export function storeExists(): boolean {
  return existsSync(FILES.seed());
}

/** Create a brand new store. Returns the mnemonic — show it once, then forget it. */
export function initNew(passphrase: string): string {
  if (storeExists()) {
    throw new WalletStoreError(
      `A wallet store already exists at ${FILES.seed()}. Refusing to overwrite it — ` +
        "move it aside first if you genuinely want a new one."
    );
  }
  const wallet = Wallet.createRandom();
  const phrase = wallet.mnemonic?.phrase;
  if (!phrase) throw new WalletStoreError("Failed to generate a mnemonic.");
  writeSeed(phrase, passphrase);
  writeMeta({ ...EMPTY_META, derived: {}, imported: [] });
  return phrase;
}

/** Adopt an existing mnemonic (restoring a backup, or reusing one you hold). */
export function initFromMnemonic(phrase: string, passphrase: string): void {
  if (storeExists()) {
    throw new WalletStoreError(
      `A wallet store already exists at ${FILES.seed()}. Refusing to overwrite it.`
    );
  }
  const normalised = phrase.trim().replace(/\s+/g, " ");
  if (!Mnemonic.isValidMnemonic(normalised)) {
    throw new WalletStoreError(
      "That is not a valid BIP-39 mnemonic — check the word count and spelling."
    );
  }
  writeSeed(normalised, passphrase);
  writeMeta({ ...EMPTY_META, derived: {}, imported: [] });
}

function writeSeed(phrase: string, passphrase: string): void {
  ensureStateDir();
  const env = sealJson({ mnemonic: phrase } satisfies SeedFile, passphrase);
  atomicWrite(FILES.seed(), JSON.stringify(env, null, 2) + "\n");
}

export interface ImportEntry {
  privateKey: string;
  label?: string;
}

export interface ImportResult {
  added: string[];
  duplicates: string[];
}

/**
 * Turn the first accounts from another BIP-39 phrase into import entries.
 * The phrase itself is never persisted; only the selected private keys are
 * merged into imported.enc by UnlockedStore.importKeys().
 */
export function importEntriesFromMnemonic(phrase: string, count: number): ImportEntry[] {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new WalletStoreError("Import count must be between 1 and 100 accounts.");
  }
  const normalised = phrase.trim().replace(/\s+/g, " ");
  if (!Mnemonic.isValidMnemonic(normalised)) {
    throw new WalletStoreError(
      "That is not a valid BIP-39 mnemonic — check the word count and spelling."
    );
  }
  const account = HDNodeWallet.fromPhrase(normalised, undefined, ACCOUNT_PATH);
  return Array.from({ length: count }, (_, index) => ({
    privateKey: account.deriveChild(index).privateKey,
    label: `seed import ${index}`,
  }));
}

/**
 * An unlocked store. Holds live signers in memory for the process lifetime;
 * nothing here is written back except metadata and the imported key file.
 */
export class UnlockedStore {
  private readonly passphrase: string;
  private meta: MetaFile;
  private accountNode: HDNodeWallet;
  private derivedCache = new Map<number, HDNodeWallet>();
  private imported: { wallet: Wallet; label?: string }[];

  constructor(passphrase: string, mnemonic: string, meta: MetaFile, imported: ImportedFile) {
    this.passphrase = passphrase;
    this.meta = meta;
    this.accountNode = HDNodeWallet.fromPhrase(mnemonic, undefined, meta.accountPath);
    this.imported = imported.keys.map((k) => ({
      wallet: new Wallet(k.privateKey),
      label: k.label,
    }));
  }

  get derivedCount(): number {
    return this.meta.derivedCount;
  }

  /** Derive (and cache) the wallet at an index. ~1ms each, so 500 costs ~0.5s once. */
  private derived(index: number): HDNodeWallet {
    let w = this.derivedCache.get(index);
    if (!w) {
      w = this.accountNode.deriveChild(index);
      this.derivedCache.set(index, w);
    }
    return w;
  }

  /** Warm the derivation cache up front so no mint path pays for it. */
  primeDerivation(onProgress?: (done: number, total: number) => void): void {
    const total = this.meta.derivedCount;
    for (let i = 0; i < total; i++) {
      this.derived(i);
      if (onProgress && (i + 1) % 50 === 0) onProgress(i + 1, total);
    }
    if (onProgress && total > 0) onProgress(total, total);
  }

  all(): ManagedWallet[] {
    const out: ManagedWallet[] = [];

    for (let i = 0; i < this.meta.derivedCount; i++) {
      const m = this.meta.derived[String(i)] ?? {};
      out.push({
        id: `d:${i}`,
        address: this.derived(i).address,
        kind: "derived",
        index: i,
        label: m.label,
        // Derived wallets are disposable — autonomous firing is the default.
        autoFire: m.autoFire ?? true,
        tags: m.tags ?? [],
      });
    }

    for (const entry of this.imported) {
      const address = entry.wallet.address;
      const m = this.meta.imported.find((x) => x.address === address);
      out.push({
        id: `i:${address}`,
        address,
        kind: "imported",
        label: m?.label ?? entry.label,
        // Imported wallets hold real value — opt in explicitly, never by default.
        autoFire: m?.autoFire ?? false,
        tags: m?.tags ?? [],
      });
    }

    return out;
  }

  byId(id: string): ManagedWallet | undefined {
    return this.all().find((w) => w.id === id);
  }

  /** The signing key for a wallet id. Throws rather than returning undefined. */
  signer(id: string): HDNodeWallet | Wallet {
    if (id.startsWith("d:")) {
      const index = Number(id.slice(2));
      if (!Number.isInteger(index) || index < 0 || index >= this.meta.derivedCount) {
        throw new WalletStoreError(`No derived wallet at index ${index}.`);
      }
      return this.derived(index);
    }
    if (id.startsWith("i:")) {
      const address = id.slice(2);
      const found = this.imported.find((e) => e.wallet.address === address);
      if (!found) throw new WalletStoreError(`No imported wallet ${address}.`);
      return found.wallet;
    }
    throw new WalletStoreError(`Unrecognised wallet id "${id}".`);
  }

  /** Extend the derived set. Nothing new is stored — only the count moves. */
  generate(count: number): ManagedWallet[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new WalletStoreError("Count must be a positive whole number.");
    }
    if (count > 5000) {
      throw new WalletStoreError("Refusing to derive more than 5000 at once.");
    }
    const from = this.meta.derivedCount;
    this.meta.derivedCount += count;
    writeMeta(this.meta);

    const created: ManagedWallet[] = [];
    for (let i = from; i < this.meta.derivedCount; i++) {
      created.push({
        id: `d:${i}`,
        address: this.derived(i).address,
        kind: "derived",
        index: i,
        autoFire: true,
        tags: [],
      });
    }
    return created;
  }

  importKeys(entries: ImportEntry[]): ImportResult {
    const added: string[] = [];
    const duplicates: string[] = [];
    // Include derived addresses too. Importing the same signer under two ids
    // would let two commands race the same nonce and corrupt both operations.
    const existing = new Set(this.all().map((wallet) => wallet.address));
    // Validate the complete submission before mutating memory or disk.
    const validated = entries.map((entry) => {
      const key = entry.privateKey.trim();
      try {
        return {
          wallet: new Wallet(key.startsWith("0x") ? key : `0x${key}`),
          label: entry.label,
        };
      } catch {
        throw new WalletStoreError(
          "That is not a valid private key. Nothing was imported."
        );
      }
    });

    for (const { wallet, label } of validated) {
      if (existing.has(wallet.address)) {
        duplicates.push(wallet.address);
        continue;
      }
      existing.add(wallet.address);
      this.imported.push({ wallet, label });
      this.meta.imported.push({
        address: wallet.address,
        label,
        autoFire: false,
        tags: [],
      });
      added.push(wallet.address);
    }

    if (added.length > 0) {
      this.persistImported();
      writeMeta(this.meta);
    }
    return { added, duplicates };
  }

  private persistImported(): void {
    ensureStateDir();
    const payload: ImportedFile = {
      keys: this.imported.map((e) => ({ privateKey: e.wallet.privateKey, label: e.label })),
    };
    const env = sealJson(payload, this.passphrase);
    atomicWrite(FILES.imported(), JSON.stringify(env, null, 2) + "\n");
  }

  setAutoFire(id: string, enabled: boolean): void {
    if (id.startsWith("d:")) {
      const key = id.slice(2);
      this.meta.derived[key] = { ...(this.meta.derived[key] ?? {}), autoFire: enabled };
    } else {
      const address = id.slice(2);
      const entry = this.meta.imported.find((x) => x.address === address);
      if (!entry) throw new WalletStoreError(`No imported wallet ${address}.`);
      entry.autoFire = enabled;
    }
    writeMeta(this.meta);
  }

  setLabel(id: string, label: string | undefined): void {
    if (id.startsWith("d:")) {
      const key = id.slice(2);
      this.meta.derived[key] = { ...(this.meta.derived[key] ?? {}), label };
    } else {
      const address = id.slice(2);
      const entry = this.meta.imported.find((x) => x.address === address);
      if (!entry) throw new WalletStoreError(`No imported wallet ${address}.`);
      entry.label = label;
    }
    writeMeta(this.meta);
  }

  addTag(id: string, tag: string): void {
    const clean = tag.trim().toLowerCase();
    if (!clean) return;
    const current = new Set(this.tagsFor(id));
    current.add(clean);
    this.writeTags(id, [...current]);
  }

  removeTag(id: string, tag: string): void {
    const clean = tag.trim().toLowerCase();
    this.writeTags(id, this.tagsFor(id).filter((t) => t !== clean));
  }

  private tagsFor(id: string): string[] {
    if (id.startsWith("d:")) return this.meta.derived[id.slice(2)]?.tags ?? [];
    return this.meta.imported.find((x) => x.address === id.slice(2))?.tags ?? [];
  }

  private writeTags(id: string, tags: string[]): void {
    if (id.startsWith("d:")) {
      const key = id.slice(2);
      this.meta.derived[key] = { ...(this.meta.derived[key] ?? {}), tags };
    } else {
      const address = id.slice(2);
      const entry = this.meta.imported.find((x) => x.address === address);
      if (!entry) throw new WalletStoreError(`No imported wallet ${address}.`);
      entry.tags = tags;
    }
    writeMeta(this.meta);
  }

  /** Export imported keys, re-sealed under a passphrase of your choosing. */
  exportImported(exportPassphrase: string): Envelope {
    const payload: ImportedFile = {
      keys: this.imported.map((e) => ({ privateKey: e.wallet.privateKey, label: e.label })),
    };
    return sealJson(payload, exportPassphrase);
  }
}

export function unlock(passphrase: string): UnlockedStore {
  if (!storeExists()) {
    throw new WalletStoreError(
      `No wallet store at ${FILES.seed()}. Create one with \`npm run wallets -- init\`.`
    );
  }

  const seed = unsealJson<SeedFile>(readEnvelope(FILES.seed(), "seed.enc"), passphrase);
  if (!seed.mnemonic || !Mnemonic.isValidMnemonic(seed.mnemonic)) {
    throw new WalletStoreError("seed.enc decrypted, but does not contain a valid mnemonic.");
  }

  let imported: ImportedFile = { keys: [] };
  if (existsSync(FILES.imported())) {
    imported = unsealJson<ImportedFile>(readEnvelope(FILES.imported(), "imported.enc"), passphrase);
  }

  return new UnlockedStore(passphrase, seed.mnemonic, readMeta(), imported);
}

/**
 * Read a transfer blob produced by `npm run encrypt-keys`. Same envelope format,
 * so the operator encrypts locally with the bot's passphrase and only ciphertext
 * ever crosses Telegram.
 */
export function readImportBlob(contents: string, passphrase: string): ImportEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new WalletStoreError("That file is not JSON — expected a keys.enc envelope.");
  }
  if (!looksLikeEnvelope(parsed)) {
    throw new WalletStoreError(
      "That file is not an encrypted envelope. Produce it with `npm run encrypt-keys` — " +
        "never send a raw private key through chat."
    );
  }
  let payload: ImportedFile;
  try {
    payload = unsealJson<ImportedFile>(parsed, passphrase);
  } catch (err) {
    if (err instanceof DecryptError) {
      throw new WalletStoreError(
        `${err.message} The blob must be encrypted with the same passphrase the bot was unlocked with.`
      );
    }
    throw err;
  }
  if (!Array.isArray(payload.keys) || payload.keys.length === 0) {
    throw new WalletStoreError("The blob decrypted but contains no keys.");
  }
  return payload.keys;
}

/** Discard a store. Used only by tooling; the bot never calls this. */
export function destroyStore(): void {
  for (const path of [FILES.seed(), FILES.imported(), FILES.meta()]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

export function isValidAddress(value: string): boolean {
  return isAddress(value);
}

export function normaliseAddress(value: string): string {
  return getAddress(value.trim());
}
