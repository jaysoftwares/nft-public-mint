// What the thing we just bought is actually called.
//
// Every report used to identify a purchase by contract address — "copy-mint
// complete, 0x0d842ce4…" — which tells the person reading it nothing about
// what they now own. ERC-721 and ERC-1155 both commonly expose name(), so the
// answer is one eth_call away.
//
// Deliberately never on the firing path. This is called after dispatch, when
// the transactions are already on the wire and a round trip costs nothing that
// matters. A failure here returns undefined and the report falls back to the
// address, because a missing name must never delay or break a result.

import { rpcCall } from "./rpc";

/** keccak("name()")[0..4] */
const NAME_SELECTOR = "0x06fdde03";

/** Contract (lowercased) → name, or null for "asked, and it has none". */
const cache = new Map<string, string | null>();

/**
 * Decode an ABI-encoded string return value.
 *
 * Layout is offset, length, then the bytes padded to 32. Some older contracts
 * return a raw bytes32 instead of a proper string, so that shape is accepted
 * too — several real NFT collections still do this, and refusing them would
 * lose exactly the names most worth showing.
 */
export function decodeStringReturn(data: string): string | undefined {
  if (!data || data === "0x") return undefined;
  const body = data.slice(2);

  // bytes32: a single word, null-padded on the right.
  if (body.length === 64) {
    const raw = Buffer.from(body, "hex");
    const end = raw.indexOf(0);
    return clean(raw.subarray(0, end === -1 ? raw.length : end).toString("utf8"));
  }

  if (body.length < 128) return undefined;
  const offset = Number(BigInt("0x" + body.slice(0, 64)));
  // A sane offset is 32 bytes; anything wild means this is not a string return.
  if (!Number.isSafeInteger(offset) || offset < 32 || offset > 1024) return undefined;

  const lengthAt = offset * 2;
  if (body.length < lengthAt + 64) return undefined;
  const length = Number(BigInt("0x" + body.slice(lengthAt, lengthAt + 64)));
  // 200 bytes is far past any real collection name, and stops a malformed
  // length turning into a huge allocation.
  if (!Number.isSafeInteger(length) || length === 0 || length > 200) return undefined;

  const start = lengthAt + 64;
  if (body.length < start + length * 2) return undefined;
  return clean(Buffer.from(body.slice(start, start + length * 2), "hex").toString("utf8"));
}

/**
 * Strip control characters and collapse whitespace.
 *
 * The name comes from a stranger's contract and ends up in an HTML Telegram
 * message, so it is treated as hostile input. Markup escaping happens at the
 * render site as it does for every other value; this removes the characters
 * that would break the line itself — newlines smuggled into a name would
 * otherwise forge extra rows in the report.
 *
 * Written as a code-point filter rather than a regex because the escapes for
 * this range do not survive every editing path intact, and a silently mangled
 * character class here would strip the wrong things.
 */
function clean(text: string): string | undefined {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // C0 controls, DEL, and the C1 block.
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  }
  const trimmed = out.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed.slice(0, 60) : undefined;
}

/**
 * The collection's name, or undefined if it has none we could read.
 *
 * Cached for the process lifetime — a name does not change, and a watched
 * collection is then asked about once per drop rather than once per wallet.
 */
export async function collectionName(
  readUrl: string,
  contract: string,
  timeoutMs = 3_000
): Promise<string | undefined> {
  const key = contract.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached ?? undefined;

  try {
    const data = await rpcCall<string>(
      readUrl,
      "eth_call",
      [{ to: contract, data: NAME_SELECTOR }, "latest"],
      timeoutMs
    );
    const name = decodeStringReturn(data);
    cache.set(key, name ?? null);
    return name;
  } catch {
    // Not cached: a passing RPC failure must not mean this collection is
    // nameless for the rest of the process's life.
    return undefined;
  }
}
