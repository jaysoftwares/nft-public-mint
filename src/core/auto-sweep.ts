// Moving what a copy-mint just bought into the main wallet, without being asked.
//
// A copy-mint leaves NFTs scattered across however many wallets fired, and the
// only thing standing between them and the vault was somebody remembering to
// type /sweep. This closes that gap: the same transfer the sweep would make,
// made as soon as the mint is provably on chain.
//
// The hard part is "provably". dispatchAll returns when the nodes have accepted
// the transactions, which is not the same as mined and nowhere near the same as
// succeeded — an accepted mint can still revert, and a token that was never
// minted and a token already swept look identical from outside. So the sweep
// waits for receipts and reads the tokens straight out of them.
//
// Reading the receipts rather than re-scanning with eth_getLogs is deliberate.
// The receipt is the canonical record of the transaction we ourselves sent: it
// names the NFT contract (which is often not the contract we called — a SeaDrop
// mint routes through a separate minter), the token ids, and whether the whole
// thing reverted. It also costs one call per wallet instead of a log scan whose
// window has to be guessed, on a provider whose rate limit is the binding
// constraint everywhere else in this bot.

import { getAddress } from "ethers";
import { Holding, TRANSFER_TOPIC } from "./holdings";

/** How long to keep asking for receipts before giving up on a wallet. */
export const DEFAULT_WAIT_MS = 180_000;
/** Gap between receipt polls. Robinhood makes ~7 blocks a second; Ethereum, one per 12. */
export const DEFAULT_POLL_MS = 3_000;

export interface ReceiptLog {
  address: string;
  topics: string[];
}

export interface TxReceipt {
  /** "0x1" succeeded, "0x0" reverted. */
  status?: string;
  blockNumber?: string;
  logs?: ReceiptLog[];
}

/** One wallet's mint transaction, as the copy result reported it. */
export interface SentMint {
  id: string;
  address: string;
  hash: string;
}

function topicToAddress(topic: string): string {
  return getAddress(`0x${topic.slice(-40)}`);
}

/**
 * The ERC-721 tokens this receipt proves are now held by one of our wallets.
 *
 * Netted within the transaction rather than merely collected. A mint that lands
 * in our wallet and is forwarded on in the same call — which is what a router
 * or a referral contract does — leaves us holding nothing, and a sweep that
 * tried to move it would sign a transfer the chain rejects. Incoming sets,
 * outgoing clears, and whatever is left at the end of the log list is real.
 *
 * ERC-20 shares the Transfer topic and is excluded by topic count: ERC-721
 * indexes the token id, giving four topics, while ERC-20 carries the amount in
 * data and has three.
 */
export function tokensFromReceipt(
  receipt: TxReceipt,
  owners: { id: string; address: string }[]
): Holding[] {
  // A reverted mint emits nothing worth having, and a node that omits status
  // has told us nothing — in both cases the honest answer is no tokens, and the
  // ownerOf-backed /sweep is still there for anything this misses.
  if (receipt.status !== "0x1") return [];

  const mine = new Map(owners.map((o) => [o.address.toLowerCase(), o]));
  const held = new Map<string, Holding>();

  for (const log of receipt.logs ?? []) {
    if (!log?.topics || log.topics.length !== 4) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;

    let from: string;
    let to: string;
    let tokenId: string;
    try {
      from = topicToAddress(log.topics[1]).toLowerCase();
      to = topicToAddress(log.topics[2]).toLowerCase();
      tokenId = BigInt(log.topics[3]).toString();
    } catch {
      // A log that does not decode is not an ERC-721 transfer, whatever it is.
      continue;
    }

    const key = `${log.address.toLowerCase()}|${tokenId}`;
    const recipient = mine.get(to);
    if (recipient) {
      held.set(key, {
        contract: getAddress(log.address),
        tokenId,
        ownerId: recipient.id,
        owner: recipient.address,
      });
    } else if (mine.has(from)) {
      held.delete(key);
    }
  }

  return [...held.values()];
}

export interface CollectOptions {
  /** The transactions to wait on, one per wallet the nodes accepted. */
  sent: SentMint[];
  getReceipt(hash: string): Promise<TxReceipt | null>;
  waitMs?: number;
  pollMs?: number;
  /** Injected so the wait can be tested without one. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** Called after each polling round, for a progress card. */
  onProgress?(settled: number, total: number): void;
}

export interface CollectResult {
  tokens: Holding[];
  /** Transactions that made it into a block and succeeded. */
  mined: number;
  /** Mined and reverted — accepted by the node, rejected by the contract. */
  reverted: number;
  /** Still not in a block when the wait ran out. */
  pending: number;
  waitedMs: number;
}

/**
 * Wait for the mint transactions to land, and return what they minted.
 *
 * Every wallet is polled until it has a receipt or the wait expires; there is no
 * early exit on the first one, because the wallets fire together and a result
 * that swept only the fastest would be worse than not sweeping at all — the
 * rest would sit unswept with nobody told.
 *
 * A receipt that never arrives is reported as pending rather than treated as a
 * failure. The transaction may still land after this gives up, which is exactly
 * what the manual /sweep is for, and saying "pending" is what tells the owner
 * that is the right next step.
 */
export async function collectMintedTokens(opts: CollectOptions): Promise<CollectResult> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const started = now();
  const outstanding = new Map(opts.sent.map((tx) => [tx.hash, tx]));
  const tokens: Holding[] = [];
  let mined = 0;
  let reverted = 0;

  while (outstanding.size > 0) {
    for (const [hash, tx] of [...outstanding]) {
      let receipt: TxReceipt | null;
      try {
        receipt = await opts.getReceipt(hash);
      } catch {
        // A read that failed is not an answer about the transaction. Leave it
        // outstanding and ask again on the next round.
        continue;
      }
      if (!receipt) continue;

      outstanding.delete(hash);
      if (receipt.status === "0x1") {
        mined++;
        tokens.push(...tokensFromReceipt(receipt, [tx]));
      } else {
        reverted++;
      }
    }

    opts.onProgress?.(opts.sent.length - outstanding.size, opts.sent.length);
    if (outstanding.size === 0) break;
    if (now() - started >= waitMs) break;
    await sleep(pollMs);
  }

  return {
    tokens,
    mined,
    reverted,
    pending: outstanding.size,
    waitedMs: now() - started,
  };
}

/**
 * Everything standing between a finished copy-mint and a sweep.
 *
 * Separated from the doing so the reasons can be tested and, more importantly,
 * *said*. "Auto-sweep did nothing" is the failure this whole feature is prone
 * to, and each of these is a different fix.
 */
export type SkipReason =
  | { kind: "disabled" }
  | { kind: "no-destination" }
  | { kind: "nothing-accepted" }
  | { kind: "already-there"; count: number };

export interface SweepDecision {
  proceed: boolean;
  skip?: SkipReason;
  /** Wallets whose transactions are worth waiting on. */
  sent: SentMint[];
}

export interface DecideInput {
  enabled: boolean;
  destination: string;
  /** The zero address doubles as "no vault set yet" throughout this bot. */
  zeroAddress: string;
  hashes: { id: string; address: string; hash: string; accepted: boolean }[];
}

/**
 * Decide whether a finished copy is worth sweeping, before spending a single
 * RPC call on it.
 *
 * The destination check is not a formality. `vault` is the zero address until
 * the owner confirms one, and a transfer to the zero address is a burn — the
 * one mistake in this file that could not be undone.
 */
export function decideSweep(input: DecideInput): SweepDecision {
  if (!input.enabled) return { proceed: false, skip: { kind: "disabled" }, sent: [] };

  const destination = (input.destination ?? "").trim();
  if (destination === "" || destination.toLowerCase() === input.zeroAddress.toLowerCase()) {
    return { proceed: false, skip: { kind: "no-destination" }, sent: [] };
  }

  const accepted = input.hashes.filter((h) => h.accepted);
  if (accepted.length === 0) {
    return { proceed: false, skip: { kind: "nothing-accepted" }, sent: [] };
  }

  // A wallet that already is the destination has nothing to move, and a
  // self-transfer would burn gas to achieve exactly nothing.
  const sent = accepted.filter((h) => h.address.toLowerCase() !== destination.toLowerCase());
  if (sent.length === 0) {
    return { proceed: false, skip: { kind: "already-there", count: accepted.length }, sent: [] };
  }

  return {
    proceed: true,
    sent: sent.map((h) => ({ id: h.id, address: h.address, hash: h.hash })),
  };
}
