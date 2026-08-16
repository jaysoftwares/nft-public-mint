// Encryption for everything the bot holds at rest: the HD mnemonic, imported
// private keys, and the transfer blob produced by `npm run encrypt-keys`.
//
// scrypt + AES-256-GCM, both from node:crypto — no native module to compile,
// which matters because the operator builds on Windows and deploys on Linux.
//
// The same envelope format is used for all three, so a blob encrypted locally
// by the operator can be decrypted by the bot with the bot's own passphrase.

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

// N=2^17 puts key derivation around a second on a modern CPU. That is paid once
// at unlock, never in a mint path, so it is bought cheaply.
const KDF = {
  name: "scrypt" as const,
  N: 1 << 17,
  r: 8,
  p: 1,
  keyLen: 32,
  // scrypt needs 128 * N * r bytes; node's default 32MB cap is far too low.
  maxmem: 320 * 1024 * 1024,
};

export const ENVELOPE_VERSION = 1;

export interface Envelope {
  v: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number };
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptError";
  }
}

function deriveKey(passphrase: string, salt: Buffer, kdf: Envelope["kdf"]): Buffer {
  // NFKC keeps a passphrase typed on one platform usable on another.
  return scryptSync(passphrase.normalize("NFKC"), salt, KDF.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: KDF.maxmem,
  });
}

// Overwrite key material as soon as it is no longer needed. Node may still hold
// copies the GC hasn't reclaimed, so this reduces exposure rather than removing
// it — worth doing, not worth trusting absolutely.
export function wipe(buf: Buffer): void {
  buf.fill(0);
}

export function seal(plaintext: Buffer, passphrase: string): Envelope {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, KDF);

  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    // Bind the header to the ciphertext so a downgraded envelope won't verify.
    cipher.setAAD(Buffer.from(`copymint:v${ENVELOPE_VERSION}`, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      v: ENVELOPE_VERSION,
      kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p },
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };
  } finally {
    wipe(key);
  }
}

export function unseal(env: Envelope, passphrase: string): Buffer {
  if (env.v !== ENVELOPE_VERSION) {
    throw new DecryptError(
      `Unsupported envelope version ${env.v} — this build reads v${ENVELOPE_VERSION}.`
    );
  }
  if (env.kdf?.name !== "scrypt") {
    throw new DecryptError(`Unsupported key derivation "${env.kdf?.name}".`);
  }

  const salt = Buffer.from(env.salt, "base64");
  const iv = Buffer.from(env.iv, "base64");
  const key = deriveKey(passphrase, salt, env.kdf);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`copymint:v${env.v}`, "utf8"));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(env.ct, "base64")),
      decipher.final(),
    ]);
  } catch {
    // GCM failing to authenticate means a wrong passphrase or a tampered file,
    // and there is no way to tell which — so say both.
    throw new DecryptError(
      "Could not decrypt — wrong passphrase, or the file has been altered."
    );
  } finally {
    wipe(key);
  }
}

export function sealJson(value: unknown, passphrase: string): Envelope {
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  try {
    return seal(plain, passphrase);
  } finally {
    wipe(plain);
  }
}

export function unsealJson<T>(env: Envelope, passphrase: string): T {
  const plain = unseal(env, passphrase);
  try {
    return JSON.parse(plain.toString("utf8")) as T;
  } finally {
    wipe(plain);
  }
}

// A cheap structural check so a mistyped path fails with something readable
// instead of a JSON parse error deep inside unseal().
export function looksLikeEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<Envelope>;
  return (
    typeof e.v === "number" &&
    typeof e.salt === "string" &&
    typeof e.iv === "string" &&
    typeof e.tag === "string" &&
    typeof e.ct === "string"
  );
}
