// "Which collection?" — answered by whatever the operator has to hand.
//
// The bot used to demand a bare 0x address at every contract prompt, which is
// the one thing nobody has in their clipboard during a drop. What they have is
// the OpenSea tab they are watching. Pasting it got "That doesn't look like an
// address", and by the time the address had been dug out of the page the stage
// had moved on.
//
// So the prompt accepts what people actually paste: a collection URL, an item
// URL, a bare slug, or an address. Parsing is offline and total — it never
// touches the network, and anything it cannot classify is reported as such
// rather than guessed at, because guessing a contract address spends money at
// the wrong place.

import { isAddress, getAddress } from "ethers";
import { resolveSlug } from "../slug-resolver";

export type CollectionInput =
  /** A contract address, ready to use. */
  | { kind: "address"; address: string; chainHint?: string }
  /** An OpenSea slug that still needs a lookup to become an address. */
  | { kind: "slug"; slug: string }
  | { kind: "invalid" };

/**
 * OpenSea slugs are lowercase alphanumeric with hyphens. Requiring a letter
 * somewhere keeps a mistyped number or a bare token id from being taken for a
 * collection name.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;

function looksLikeSlug(text: string): boolean {
  // A mistyped address must not fall through to being read as a collection
  // name. Anything starting 0x was an attempt at an address, and a truncated
  // one silently resolving to some unrelated drop is how the wrong contract
  // gets minted.
  if (text.startsWith("0x")) return false;
  return SLUG.test(text) && /[a-z]/.test(text);
}

/**
 * Pull the meaningful part out of an OpenSea URL.
 *
 * Handles the shapes the site actually produces:
 *
 *   opensea.io/collection/<slug>              (and /overview, /items, /activity)
 *   opensea.io/item/<chain>/<contract>/<id>
 *   opensea.io/assets/<chain>/<contract>/<id>  (the older form, still linked)
 *
 * A chain segment in the URL is kept as a hint rather than an instruction: the
 * bot detects the chain from on-chain code, and a hint only breaks ties.
 */
function fromUrl(text: string): CollectionInput | undefined {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (!/(^|\.)opensea\.io$/i.test(url.hostname)) return undefined;

  const parts = url.pathname.split("/").filter((p) => p.length > 0);

  const collectionAt = parts.indexOf("collection");
  if (collectionAt !== -1 && parts[collectionAt + 1]) {
    const slug = decodeURIComponent(parts[collectionAt + 1]).toLowerCase();
    return looksLikeSlug(slug) ? { kind: "slug", slug } : { kind: "invalid" };
  }

  for (const key of ["item", "assets", "asset"]) {
    const at = parts.indexOf(key);
    if (at === -1) continue;
    // Either <key>/<chain>/<contract>/<id> or <key>/<contract>/<id>.
    const [a, b] = [parts[at + 1], parts[at + 2]];
    if (b && isAddress(b)) return { kind: "address", address: getAddress(b), chainHint: a };
    if (a && isAddress(a)) return { kind: "address", address: getAddress(a) };
  }

  return { kind: "invalid" };
}

/** Classify a pasted string without touching the network. */
export function parseCollectionInput(raw: string): CollectionInput {
  const text = raw.trim();
  if (text.length === 0) return { kind: "invalid" };

  // Read off both forms before any narrowing: ethers' isAddress is a type guard
  // over `string`, so testing it here would leave `text` as `never` below.
  const bare = text.toLowerCase();

  if (isAddress(text)) return { kind: "address", address: getAddress(text) };

  if (/opensea\.io/i.test(bare)) {
    const parsed = fromUrl(text);
    if (parsed) return parsed;
  }

  // A bare slug, typed rather than pasted.
  if (looksLikeSlug(bare)) return { kind: "slug", slug: bare };

  return { kind: "invalid" };
}

export interface ResolvedCollection {
  address: string;
  /** OpenSea's chain name, when the lookup supplied one. */
  chain?: string;
  /** Collection name, for confirming out loud that this is the right drop. */
  name?: string;
  slug?: string;
}

export class CollectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionInputError";
  }
}

/**
 * Turn anything the operator pasted into a contract address.
 *
 * Only the slug branch costs a request. An address answers instantly, which
 * matters because this sits in front of a mint.
 */
export async function resolveCollectionInput(
  raw: string,
  apiKey?: string,
  preferredChain?: string
): Promise<ResolvedCollection> {
  const parsed = parseCollectionInput(raw);

  switch (parsed.kind) {
    case "address":
      return { address: parsed.address, chain: parsed.chainHint };

    case "slug": {
      const info = await resolveSlug(parsed.slug, apiKey, preferredChain);
      if (!isAddress(info.contractAddress)) {
        throw new CollectionInputError(
          `OpenSea returned an unusable contract for "${parsed.slug}".`
        );
      }
      return {
        address: getAddress(info.contractAddress),
        chain: info.chain,
        name: info.name,
        slug: parsed.slug,
      };
    }

    case "invalid":
      throw new CollectionInputError(
        "Send a contract address, an OpenSea collection link, or the collection slug."
      );
  }
}
