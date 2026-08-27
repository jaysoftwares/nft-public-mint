// What a drop actually is, before anybody commits to buying it.
//
// Scheduling a mint means agreeing to spend money at a moment you will not be
// watching, on a contract address you probably pasted from a link. The whole
// safety of that rests on being shown, first, what the thing is: its name, the
// chain it lives on, what one costs, how many there are and when it opens.
//
// Two sources answer that and neither answers all of it. The chain is
// authoritative about price and timing for a SeaDrop public stage — it is the
// code that will run — but knows nothing about a slug or a picture. OpenSea
// knows the name, the supply and the stages it gates itself, but publishes
// times that its own contract does not have to honour. So both are read, and
// where they disagree the chain wins and the disagreement is shown rather than
// hidden: a published time that the contract does not share is the single most
// useful thing a scheduler can point at.

import { formatEther } from "ethers";
import { rpcCall } from "./rpc";
import { decodeStringReturn } from "./collection-name";

/** `totalSupply()` and `maxSupply()` — both common, neither guaranteed. */
const TOTAL_SUPPLY = "0x18160ddd";
const MAX_SUPPLY = "0xd5abeb01";

export interface StageFacts {
  label: string;
  priceWei: bigint;
  /** Epoch ms. Absent when the source did not publish one. */
  startsAt?: number;
  endsAt?: number;
  perWallet?: number;
  live: boolean;
  source: "chain" | "opensea";
}

export interface ChainFacts {
  /** Null means "read fine, no SeaDrop public drop here" — not a failure. */
  stage: StageFacts | null;
  name?: string;
  totalSupply?: string;
  maxSupply?: string;
  error?: string;
}

export interface OpenSeaFacts {
  slug?: string;
  name?: string;
  totalSupply?: string;
  maxSupply?: string;
  openseaUrl?: string;
  isMinting?: boolean;
  stage?: StageFacts;
  /** Every stage, for the "and two more later" line. */
  stageCount?: number;
  error?: string;
}

export interface DropPreview {
  contract: string;
  chainKey: string;
  chainName: string;
  chainId: number;
  collection?: string;
  slug?: string;
  openseaUrl?: string;
  totalSupply?: string;
  maxSupply?: string;
  /** The stage worth showing: the live one, else the next one. */
  stage?: StageFacts;
  /** Which executor can actually buy this. */
  path: "public" | "fcfs" | "unknown";
  /** Things the operator should read before agreeing. */
  notes: string[];
}

export interface PreviewInput {
  contract: string;
  chainKey: string;
  chainName: string;
  chainId: number;
  chain: ChainFacts;
  opensea: OpenSeaFacts;
  now: number;
}

/**
 * Combine the two readings into the one card the operator sees.
 *
 * Pure, and separated from the fetching for exactly that reason: which source
 * wins, and what gets said when they disagree, is the judgement in this file
 * and the only part of it worth testing without a network.
 */
export function mergePreview(input: PreviewInput): DropPreview {
  const notes: string[] = [];
  const chainStage = input.chain.stage;
  const seaStage = input.opensea.stage;

  // The chain is what will execute, so it decides the path and the price.
  const path: DropPreview["path"] = chainStage
    ? "public"
    : input.opensea.slug
      ? "fcfs"
      : "unknown";

  const stage = chainStage ?? seaStage;

  if (chainStage && seaStage?.startsAt !== undefined && chainStage.startsAt !== undefined) {
    const driftMs = Math.abs(seaStage.startsAt - chainStage.startsAt);
    // A minute of drift is two clocks; ten is two different stages, and firing
    // at the published one would hit a contract that is still closed.
    if (driftMs > 60_000) {
      notes.push(
        `OpenSea publishes ${new Date(seaStage.startsAt).toISOString().slice(11, 16)} UTC but the ` +
          `contract opens at ${new Date(chainStage.startsAt).toISOString().slice(11, 16)} UTC. ` +
          `The contract is what runs.`
      );
    }
  }

  if (chainStage && seaStage && chainStage.priceWei !== seaStage.priceWei) {
    notes.push(
      `OpenSea lists ${formatEther(seaStage.priceWei)} ETH; the contract charges ` +
        `${formatEther(chainStage.priceWei)} ETH. You pay the contract's price.`
    );
  }

  if (!chainStage && !seaStage) {
    notes.push(
      "No open or upcoming stage found on either the contract or OpenSea. The drop may not be " +
        "configured yet, in which case book it and the runner will read it again at T-0."
    );
  }

  if (chainStage && chainStage.endsAt !== undefined && chainStage.endsAt < input.now) {
    notes.push("The contract's public stage has already closed.");
  }

  if (path === "fcfs") {
    notes.push(
      "No SeaDrop public stage on this contract, so this goes through OpenSea — which refuses " +
        "to issue calldata before the stage opens, so the request itself happens at T-0."
    );
  }

  if (path === "unknown") {
    // Not a refusal. A drop worth booking is usually one you heard about before
    // its stage existed, so this is the normal state of the interesting case —
    // it just means the path is decided later, from the chain, rather than now.
    notes.push(
      "Neither a SeaDrop public drop nor an OpenSea collection resolves yet. Booking it is " +
        "still fine: the runner reads the chain again before firing and uses whichever path " +
        "exists then. If neither does, it reports that instead of spending."
    );
  }

  if (input.chain.error) notes.push(`Chain read: ${input.chain.error}`);
  if (input.opensea.error) notes.push(`OpenSea: ${input.opensea.error}`);

  return {
    contract: input.contract,
    chainKey: input.chainKey,
    chainName: input.chainName,
    chainId: input.chainId,
    // The on-chain name() is the contract's own answer and cannot be renamed by
    // a marketplace listing, so it wins where both exist.
    collection: input.chain.name ?? input.opensea.name,
    slug: input.opensea.slug,
    openseaUrl: input.opensea.openseaUrl,
    totalSupply: input.chain.totalSupply ?? input.opensea.totalSupply,
    maxSupply: input.chain.maxSupply ?? input.opensea.maxSupply,
    stage,
    path,
    notes,
  };
}

/**
 * The stage a scheduler cares about: the one that is open, else the next one.
 *
 * A drop with five past stages and one to come should show the one to come.
 * Sorting by start and taking the first future entry does that; a live stage
 * short-circuits it, because if it is buyable right now that is the news.
 */
export function pickStage(stages: StageFacts[], now: number): StageFacts | undefined {
  const live = stages.find(
    (s) =>
      (s.startsAt === undefined || s.startsAt <= now) && (s.endsAt === undefined || s.endsAt > now)
  );
  if (live) return { ...live, live: true };

  const upcoming = stages
    .filter((s) => s.startsAt !== undefined && s.startsAt > now)
    .sort((a, b) => (a.startsAt as number) - (b.startsAt as number))[0];
  if (upcoming) return { ...upcoming, live: false };

  return stages[0];
}

/**
 * Total minted and the cap, when the contract will say.
 *
 * Both calls are optional extras: plenty of perfectly good ERC-721s implement
 * neither, and a missing supply is a blank line on a card rather than a reason
 * to fail a preview. Errors are swallowed for that reason and no other.
 */
export async function readSupply(
  readUrl: string,
  contract: string
): Promise<{ totalSupply?: string; maxSupply?: string }> {
  const call = async (selector: string): Promise<string | undefined> => {
    try {
      const result = await rpcCall<string>(readUrl, "eth_call", [
        { to: contract, data: selector },
        "latest",
      ]);
      if (!result || result === "0x" || result.length < 66) return undefined;
      return BigInt(result.slice(0, 66)).toString();
    } catch {
      return undefined;
    }
  };

  const [totalSupply, maxSupply] = await Promise.all([call(TOTAL_SUPPLY), call(MAX_SUPPLY)]);
  return { totalSupply, maxSupply };
}

/** The contract's own name(), used when it has one worth showing. */
export async function readName(readUrl: string, contract: string): Promise<string | undefined> {
  try {
    const result = await rpcCall<string>(readUrl, "eth_call", [
      { to: contract, data: "0x06fdde03" },
      "latest",
    ]);
    return decodeStringReturn(result);
  } catch {
    return undefined;
  }
}
