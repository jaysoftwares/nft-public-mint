// Finding what the wallet set holds, and moving it to the vault.
//
// There is no indexer here, so holdings come from Transfer logs: every token
// received by one of our addresses, minus every token sent back out. That is
// exact for ERC-721 and needs nothing but eth_getLogs.
//
// The scan is bounded by the ledger. Blindly walking the chain for 500 addresses
// would be enormous; the ledger knows which contracts this bot minted and the
// block it happened in, so a sweep looks only where tokens could actually be.
//
// ERC-20 shares the Transfer topic with ERC-721 and is filtered out by topic
// count: ERC-721 indexes tokenId, giving four topics, while ERC-20 carries the
// amount in data and has three.

import { Interface, zeroPadValue, getAddress } from "ethers";
import { rpcCall, rpcBatchChunked } from "./rpc";
import { Endpoint, prepareTx, dispatchAll, DispatchOutcome } from "./dispatcher";
import { Wallet, HDNodeWallet } from "ethers";

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** ERC-721 transfers cost well under this; the ceiling only gates acceptance. */
export const NFT_TRANSFER_GAS = 120_000;

const ERC721 = new Interface([
  "function transferFrom(address from, address to, uint256 tokenId)",
]);

export interface HoldingTarget {
  id: string;
  address: string;
}

export interface Holding {
  contract: string;
  tokenId: string;
  ownerId: string;
  owner: string;
}

interface RawLog {
  address: string;
  topics: string[];
  blockNumber: string;
}

function topicToAddress(topic: string): string {
  return getAddress(`0x${topic.slice(-40)}`);
}

export async function latestBlock(readUrl: string): Promise<number> {
  return Number(BigInt(await rpcCall<string>(readUrl, "eth_blockNumber", [])));
}

export interface ScanOptions {
  fromBlock: number;
  toBlock: number;
  /** Restrict to these NFT contracts. Strongly recommended — far cheaper. */
  contracts?: string[];
  /** Providers cap log ranges; 2000 is safe nearly everywhere. */
  blockChunk?: number;
  /** Topic filters have practical size limits, so addresses are chunked too. */
  addressChunk?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Every ERC-721 currently held by the given wallets.
 *
 * Received and sent are tracked separately and netted at the end, so a token
 * minted and later moved out does not show up as still held.
 */
export async function discoverHoldings(
  readUrl: string,
  targets: HoldingTarget[],
  opts: ScanOptions
): Promise<Holding[]> {
  if (targets.length === 0) return [];

  const blockChunk = opts.blockChunk ?? 2000;
  const addressChunk = opts.addressChunk ?? 50;
  const byAddress = new Map(targets.map((t) => [t.address.toLowerCase(), t]));

  // contract|tokenId -> owning address, or null once it leaves the set.
  const owned = new Map<string, string | null>();

  const addressGroups: string[][] = [];
  for (let i = 0; i < targets.length; i += addressChunk) {
    addressGroups.push(targets.slice(i, i + addressChunk).map((t) => zeroPadValue(t.address, 32)));
  }

  const ranges: [number, number][] = [];
  for (let from = opts.fromBlock; from <= opts.toBlock; from += blockChunk) {
    ranges.push([from, Math.min(from + blockChunk - 1, opts.toBlock)]);
  }

  const totalRequests = ranges.length * addressGroups.length * 2;
  let done = 0;

  for (const [from, to] of ranges) {
    for (const group of addressGroups) {
      // Incoming: our address in the `to` position.
      const incoming = await getLogs(readUrl, {
        fromBlock: from,
        toBlock: to,
        contracts: opts.contracts,
        topics: [TRANSFER_TOPIC, null, group],
      });
      opts.onProgress?.(++done, totalRequests);

      // Outgoing: our address in the `from` position.
      const outgoing = await getLogs(readUrl, {
        fromBlock: from,
        toBlock: to,
        contracts: opts.contracts,
        topics: [TRANSFER_TOPIC, group],
      });
      opts.onProgress?.(++done, totalRequests);

      for (const log of incoming) {
        if (log.topics.length !== 4) continue; // ERC-20, not ERC-721
        const to721 = topicToAddress(log.topics[2]).toLowerCase();
        if (!byAddress.has(to721)) continue;
        owned.set(`${log.address.toLowerCase()}|${BigInt(log.topics[3]).toString()}`, to721);
      }

      for (const log of outgoing) {
        if (log.topics.length !== 4) continue;
        const from721 = topicToAddress(log.topics[1]).toLowerCase();
        if (!byAddress.has(from721)) continue;
        owned.set(`${log.address.toLowerCase()}|${BigInt(log.topics[3]).toString()}`, null);
      }
    }
  }

  const holdings: Holding[] = [];
  for (const [key, owner] of owned) {
    if (!owner) continue;
    const [contract, tokenId] = key.split("|");
    const target = byAddress.get(owner);
    if (!target) continue;
    holdings.push({
      contract: getAddress(contract),
      tokenId,
      ownerId: target.id,
      owner: target.address,
    });
  }
  return holdings;
}

/**
 * Providers reject on response *size*, not block count — so the usable range
 * depends on how busy those blocks were, not on a fixed number.
 *
 * Except when they also cap the range outright: QuickNode's Robinhood endpoint
 * answers "eth_getLogs is limited to a 10,000 range", which matched none of
 * these patterns and so was thrown instead of being split. A sweep that asked
 * for one block too many failed outright rather than halving and succeeding.
 */
function isTooLarge(message: string): boolean {
  return /too large|too many results|response size|query returned more than|limit exceeded|limited to a [\d,]+ range|exceeds? the max/i.test(
    message
  );
}

/**
 * QuickNode occasionally answers HTTP 200 with neither `result` nor `error`,
 * which rpc.ts surfaces as "Empty result for …". It is transient and the same
 * request succeeds immediately afterwards.
 *
 * Worth retrying here specifically because a sweep is not on any critical path
 * and the alternative is telling somebody their NFTs could not be found when
 * the truth is one packet went missing. Seen live while tracing this module.
 */
function isTransient(message: string): boolean {
  return /empty result|timed out|timeout|socket|ECONNRESET|fetch failed|502|503|504/i.test(message);
}

/** keccak("ownerOf(uint256)")[0..4] */
const OWNER_OF = "0x6352211e";

/**
 * One mint the ledger recorded: which contract, into which wallets, and the
 * block the signal came from.
 */
export interface MintSite {
  contract: string;
  /** The block the mint was triggered from. Ours lands at or shortly after it. */
  block: number;
  owners: HoldingTarget[];
}

export interface MintScanOptions {
  /**
   * How far past the recorded block to look.
   *
   * A copy-mint records the block of the *signal*, and our own transaction
   * lands a block or two later — more if the network was slow. Robinhood makes
   * roughly seven blocks a second, so 8000 blocks is about twenty minutes of
   * chain: far past any mint that was going to land.
   */
  forward?: number;
  /**
   * How far *before* the recorded block to look.
   *
   * Not symmetry for its own sake — the two kinds of mint record the block at
   * opposite ends of the work. A copy-mint stores the signal's block, before
   * ours lands. A manual mint calls currentBlock() *after* dispatching, so its
   * recorded block is already past the mint. Measured on this deployment: a
   * manual mint sat nine blocks behind its recorded block, and a forward-only
   * window missed all ten wallets involved while finding every copy-mint
   * correctly — the kind of gap that looks like "the sweep works" until
   * somebody counts.
   */
  back?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Find what we hold by asking the ledger where to look, then asking the chain
 * who owns it.
 *
 * The full-range scan below cannot be used at this deployment's size. It walks
 * every block since the first mint for every wallet: 1.9 million blocks, 500
 * addresses, two directions — twenty thousand eth_getLogs calls and the better
 * part of an hour, which is why a sweep never finished.
 *
 * Nothing about that work was necessary. The ledger already records the exact
 * contract, wallets and block of every mint this bot made, so the search is a
 * few hundred blocks around each one — about sixty requests here. Ownership is
 * then confirmed with ownerOf rather than by netting incoming against outgoing
 * logs, which is both cheaper and strictly more accurate: it reflects the chain
 * as it is now, including tokens already swept and mints that were accepted by
 * the node and then reverted.
 */
export async function discoverMintedHoldings(
  readUrl: string,
  sites: MintSite[],
  opts: MintScanOptions = {}
): Promise<Holding[]> {
  if (sites.length === 0) return [];
  // Kept under the 10,000-block ceiling QuickNode enforces, so one site is
  // still one request.
  const forward = opts.forward ?? 8000;
  const back = opts.back ?? 1000;

  // contract|tokenId -> the wallets that might hold it.
  const candidates = new Map<string, { contract: string; tokenId: string }>();
  let done = 0;

  for (const site of sites) {
    const logs = await getLogs(readUrl, {
      fromBlock: Math.max(0, site.block - back),
      toBlock: site.block + forward,
      contracts: [site.contract],
      // Only the wallets this contract was minted into — usually one, so the
      // topic filter stays small however many wallets the store has.
      topics: [TRANSFER_TOPIC, null, site.owners.map((o) => zeroPadValue(o.address, 32))],
    });

    for (const log of logs) {
      if (log.topics.length !== 4) continue; // ERC-20 shares the topic
      const tokenId = BigInt(log.topics[3]).toString();
      candidates.set(`${log.address.toLowerCase()}|${tokenId}`, {
        contract: getAddress(log.address),
        tokenId,
      });
    }
    opts.onProgress?.(++done, sites.length);
  }

  return confirmOwnership(readUrl, [...candidates.values()], sites.flatMap((s) => s.owners));
}

/**
 * Ask the contract who owns each token, and keep the ones that are ours.
 *
 * This is the step that makes the result trustworthy. Logs say a token arrived;
 * only ownerOf says it is still here. A token already swept, sold, or never
 * actually minted because the transaction reverted after being accepted all
 * look identical in the receiving logs and different here.
 */
export async function confirmOwnership(
  readUrl: string,
  tokens: { contract: string; tokenId: string }[],
  targets: HoldingTarget[]
): Promise<Holding[]> {
  if (tokens.length === 0) return [];
  const byAddress = new Map(targets.map((t) => [t.address.toLowerCase(), t]));

  const results = await rpcBatchChunked<string>(
    readUrl,
    tokens.map((t) => ({
      method: "eth_call",
      params: [
        { to: t.contract, data: OWNER_OF + BigInt(t.tokenId).toString(16).padStart(64, "0") },
        "latest",
      ],
    }))
  );

  const held: Holding[] = [];
  results.forEach((entry, i) => {
    // A revert here means the token does not exist — a mint that never landed.
    if (!entry?.result || entry.result === "0x" || entry.result.length < 66) return;
    const owner = getAddress(`0x${entry.result.slice(-40)}`).toLowerCase();
    const target = byAddress.get(owner);
    if (!target) return; // Someone else's now, or never ours.
    held.push({
      contract: tokens[i].contract,
      tokenId: tokens[i].tokenId,
      ownerId: target.id,
      owner: target.address,
    });
  });
  return held;
}

/**
 * Fetch logs, splitting the range in half whenever the provider says the
 * response is too big.
 *
 * A fixed chunk cannot be right: the same 2000 blocks are fine on a quiet
 * stretch and rejected across a busy mint. Halving on rejection adapts to the
 * actual density instead of guessing at it.
 */
async function getLogs(
  readUrl: string,
  params: {
    fromBlock: number;
    toBlock: number;
    contracts?: string[];
    topics: (string | string[] | null)[];
  }
): Promise<RawLog[]> {
  const build = (from: number, to: number): Record<string, unknown> => {
    const filter: Record<string, unknown> = {
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      topics: params.topics,
    };
    if (params.contracts && params.contracts.length > 0) {
      filter.address = params.contracts.length === 1 ? params.contracts[0] : params.contracts;
    }
    return filter;
  };

  const fetchRange = async (from: number, to: number, attempt = 0): Promise<RawLog[]> => {
    try {
      return await rpcCall<RawLog[]>(readUrl, "eth_getLogs", [build(from, to)], 30_000);
    } catch (err) {
      const message = (err as Error).message;
      if (isTooLarge(message) && to > from) {
        const mid = Math.floor((from + to) / 2);
        const [left, right] = await Promise.all([
          fetchRange(from, mid),
          fetchRange(mid + 1, to),
        ]);
        return [...left, ...right];
      }
      // Bounded, and only for the failures that pass on their own. A wrong
      // filter or a dead endpoint must still fail on the first attempt rather
      // than three times as slowly.
      if (isTransient(message) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        return fetchRange(from, to, attempt + 1);
      }
      throw new Error(`eth_getLogs failed for blocks ${from}-${to}: ${message}`);
    }
  };

  return fetchRange(params.fromBlock, params.toBlock);
}

export function encodeTransferFrom(from: string, to: string, tokenId: string): string {
  return ERC721.encodeFunctionData("transferFrom", [from, to, BigInt(tokenId)]);
}

export interface NftSweepDeps {
  signerFor(id: string): Wallet | HDNodeWallet;
  vault: string;
  chainId: number;
  endpoints: Endpoint[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonceFor(address: string): number;
}

export interface NftSweepResult {
  dispatched: number;
  accepted: number;
  rejected: number;
  outcomes: DispatchOutcome[];
  gasCeiling: bigint;
}

/**
 * Move every discovered token to the vault.
 *
 * ETH is deliberately left in place — the wallets stay armed for the next copy
 * signal instead of needing a refunding round-trip. Each wallet keeps its own
 * nonce sequence, so a wallet holding several tokens signs several transactions
 * in order.
 */
export async function sweepNfts(
  holdings: Holding[],
  deps: NftSweepDeps,
  onProgress?: (done: number, total: number) => void
): Promise<NftSweepResult> {
  if (holdings.length === 0) {
    return { dispatched: 0, accepted: 0, rejected: 0, outcomes: [], gasCeiling: 0n };
  }

  const nonces = new Map<string, number>();
  const prepared = [];

  for (let i = 0; i < holdings.length; i++) {
    const holding = holdings[i];
    const signer = deps.signerFor(holding.ownerId);

    let nonce = nonces.get(holding.owner);
    if (nonce === undefined) nonce = deps.nonceFor(holding.owner);
    nonces.set(holding.owner, nonce + 1);

    const raw = await signer.signTransaction({
      to: holding.contract,
      data: encodeTransferFrom(holding.owner, deps.vault, holding.tokenId),
      value: 0n,
      nonce,
      gasLimit: NFT_TRANSFER_GAS,
      maxFeePerGas: deps.maxFeePerGas,
      maxPriorityFeePerGas: deps.maxPriorityFeePerGas,
      type: 2,
      chainId: deps.chainId,
    });

    prepared.push(prepareTx(`${holding.ownerId}#${holding.tokenId}`, holding.owner, raw));
    onProgress?.(i + 1, holdings.length);
  }

  const report = await dispatchAll(prepared, deps.endpoints);
  return {
    dispatched: prepared.length,
    accepted: report.accepted,
    rejected: report.rejected,
    outcomes: report.outcomes,
    gasCeiling: BigInt(prepared.length) * BigInt(NFT_TRANSFER_GAS) * deps.maxFeePerGas,
  };
}
