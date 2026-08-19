// What does this watched address actually mint, and would we copy it?
//
// Every "it isn't working" in this project's life has come down to a setting
// disagreeing with a target's real behaviour, and that disagreement was only
// ever discoverable from a terminal: scan the chain, decode a transaction,
// compare against a config file nobody could read from a phone. The operator
// saw a bot that watched and never fired, with no way to ask why.
//
// So the question gets answered where it is asked. This replays the watcher's
// own log filters over recent history, decodes what it finds, and runs each
// mint past the same rules the engine uses — the payer rule, the free/paid
// filter, the price ceiling, the wallet pool. What comes back is not advice: it
// is "this exact mint would have fired N wallets", or the named setting that
// stopped it.
//
// It reuses the engine's predicates rather than restating them, because a
// report that drifts from the code is worse than no report at all.

import { rpcCall } from "./rpc";
import { ERC721_TRANSFER, ERC1155_TRANSFER_SINGLE } from "./log-watcher";
import { WatchTarget, allowsMint, allowsPayer, walletsFor, maxPriceFor, Tier } from "./targets";

const ZERO_TOPIC = `0x${"0".repeat(64)}`;

/** SeaDrop entry points, so a report can name the method rather than a hash. */
const SELECTORS: Record<string, string> = {
  "0x161ac21f": "mintPublic",
  "0x4300a4e6": "mintAllowList",
  "0x4b61cd6f": "mintSigned",
};

export interface ObservedMint {
  contract: string;
  transactionHash: string;
  blockNumber: number;
  /** Who sent and paid for it — not necessarily the target. */
  payer: string;
  valueWei: bigint;
  selector: string;
  method?: string;
  standard: "erc721" | "erc1155";
  /** Unix ms, when the block header was readable. */
  at?: number;
}

interface RawLog {
  address: string;
  topics: string[];
  transactionHash: string;
  blockNumber: string;
}

function padAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

const hex = (value: number): string => `0x${value.toString(16)}`;

/**
 * How many blocks cover a stretch of wall-clock time on this chain.
 *
 * Block times differ by two orders of magnitude across the chains this bot
 * watches — 12s on Ethereum, 2s on Base, 0.1s on Robinhood — so a fixed block
 * count means "three days" on one chain and "half an hour" on another. That is
 * exactly how a scan comes back empty and gets read as "this address never
 * mints". Measured rather than assumed, because a chain can change it.
 */
export async function blocksForHours(
  readUrl: string,
  head: number,
  hours: number
): Promise<{ blocks: number; secondsPerBlock: number }> {
  const sample = Math.min(2000, Math.max(1, head - 1));
  const [recent, older] = await Promise.all([
    rpcCall<{ timestamp: string } | null>(readUrl, "eth_getBlockByNumber", [hex(head), false]),
    rpcCall<{ timestamp: string } | null>(readUrl, "eth_getBlockByNumber", [
      hex(head - sample),
      false,
    ]),
  ]);
  if (!recent || !older) return { blocks: Math.round((hours * 3600) / 12), secondsPerBlock: 12 };

  const span = Number(BigInt(recent.timestamp) - BigInt(older.timestamp));
  const secondsPerBlock = span > 0 ? span / sample : 12;
  return {
    blocks: Math.max(1, Math.round((hours * 3600) / secondsPerBlock)),
    secondsPerBlock,
  };
}

export interface ProbeOptions {
  hours: number;
  /** Stop once this many mints are found; the newest are what matter. */
  limit: number;
  /** Blocks per eth_getLogs call, shrunk adaptively when a provider objects. */
  chunk?: number;
  /** Total eth_getLogs calls to spend, so a quiet chain cannot run forever. */
  maxCalls?: number;
}

export interface ProbeResult {
  mints: ObservedMint[];
  /** Wall-clock hours the scan actually covered. */
  hoursScanned: number;
  blocksScanned: number;
  /** True when the budget ran out before the whole window was covered. */
  truncated: boolean;
}

/**
 * Find mints credited to `address`, newest first, using the watcher's filters.
 *
 * A hit here is a signal copy-mint would have been handed; a miss is one it
 * never had. That equivalence is the point — anything else would report on a
 * different question than the one being asked.
 */
export async function probeTarget(
  readUrl: string,
  address: string,
  options: ProbeOptions
): Promise<ProbeResult> {
  const head = Number(BigInt(await rpcCall<string>(readUrl, "eth_blockNumber", [])));
  const { blocks, secondsPerBlock } = await blocksForHours(readUrl, head, options.hours);
  const floor = Math.max(0, head - blocks);
  const padded = padAddress(address);

  const filters = [
    { standard: "erc721" as const, topics: [ERC721_TRANSFER, ZERO_TOPIC, padded] },
    { standard: "erc1155" as const, topics: [ERC1155_TRANSFER_SINGLE, null, ZERO_TOPIC, padded] },
  ];

  let chunk = options.chunk ?? 20_000;
  let callsLeft = options.maxCalls ?? 120;
  const found: ObservedMint[] = [];
  let lowest = head;
  let truncated = false;

  // Newest first: walk backwards from the head so the limit keeps the mints
  // that matter rather than whichever the scan happened to reach first.
  for (const filter of filters) {
    let to = head;
    while (to > floor && found.length < options.limit) {
      if (callsLeft <= 0) {
        truncated = true;
        break;
      }
      const from = Math.max(floor, to - chunk + 1);
      callsLeft -= 1;
      try {
        const logs = await rpcCall<RawLog[]>(
          readUrl,
          "eth_getLogs",
          [{ fromBlock: hex(from), toBlock: hex(to), topics: filter.topics }],
          20_000
        );
        for (const log of logs) {
          found.push({
            contract: log.address,
            transactionHash: log.transactionHash,
            blockNumber: parseInt(log.blockNumber, 16),
            payer: "",
            valueWei: 0n,
            selector: "",
            standard: filter.standard,
          });
        }
        lowest = Math.min(lowest, from);
        to = from - 1;
      } catch (err) {
        // Providers reject on response size rather than block count, so a
        // failure is a reason to ask for less, not to give up.
        if (chunk > 200) {
          chunk = Math.floor(chunk / 4);
          continue;
        }
        truncated = true;
        break;
      }
    }
  }

  // One transaction can emit several Transfers; they are one mint.
  const byTx = new Map<string, ObservedMint>();
  for (const mint of found) {
    if (!byTx.has(mint.transactionHash)) byTx.set(mint.transactionHash, mint);
  }
  const unique = [...byTx.values()]
    .sort((a, b) => b.blockNumber - a.blockNumber)
    .slice(0, options.limit);

  // Fill in payer, price and method — the facts the settings are judged on.
  await Promise.all(
    unique.map(async (mint) => {
      try {
        const tx = await rpcCall<{ from: string; value: string; input: string } | null>(
          readUrl,
          "eth_getTransactionByHash",
          [mint.transactionHash],
          8_000
        );
        if (!tx) return;
        mint.payer = tx.from;
        mint.valueWei = BigInt(tx.value);
        mint.selector = tx.input.slice(0, 10);
        mint.method = SELECTORS[mint.selector];
      } catch {
        // A transaction the node will not return leaves the mint listed with
        // what the log already proved, rather than dropping it from the report.
      }
    })
  );

  return {
    mints: unique,
    hoursScanned: Math.round(((head - lowest) * secondsPerBlock) / 3600),
    blocksScanned: head - lowest,
    truncated,
  };
}

// ── Would we have copied it? ──────────────────────────────────────────

export interface AssessmentInput {
  target: WatchTarget;
  tiers: Record<Tier, number>;
  globalMaxPriceWei: bigint;
  perEventWei: bigint;
  gasReservationWei: bigint;
  /** Armed and funded wallets available right now. */
  poolSize: number;
  copyEnabled: boolean;
}

export type BlockerKind =
  | "copyOff"
  | "payer"
  | "mintMode"
  | "price"
  | "pool"
  | "perEvent"
  | "signature";

export interface Blocker {
  kind: BlockerKind;
  /** What stopped it, in one line. */
  reason: string;
  /** The setting to change, phrased as an action. */
  remedy: string;
}

export interface Assessment {
  wouldCopy: boolean;
  /** Wallets that would actually fire, once caps have trimmed. */
  walletCount: number;
  blockers: Blocker[];
}

/**
 * Judge one observed mint against the settings, using the engine's own rules.
 *
 * Reports every blocker rather than the first, because fixing one and finding
 * another is the loop this is meant to end.
 */
export function assessMint(mint: ObservedMint, input: AssessmentInput): Assessment {
  const { target } = input;
  const blockers: Blocker[] = [];

  if (!input.copyEnabled) {
    blockers.push({
      kind: "copyOff",
      reason: "Copy-mint is switched off, so nothing fires.",
      remedy: "Turn copy-mint ON.",
    });
  }

  if (mint.payer && !allowsPayer(target, mint.payer)) {
    blockers.push({
      kind: "payer",
      reason: `Paid by ${mint.payer.slice(0, 10)}…, not the target itself.`,
      remedy: 'Set this target to "any payer".',
    });
  }

  if (!allowsMint(target, mint.valueWei)) {
    blockers.push({
      kind: "mintMode",
      reason:
        mint.valueWei > 0n
          ? "It is a paid mint and this target is set to free only."
          : "It is a free mint and this target is set to paid only.",
      remedy: 'Set the filter to "free + paid".',
    });
  }

  const ceiling = maxPriceFor(target, input.globalMaxPriceWei);
  if (mint.valueWei > ceiling) {
    blockers.push({
      kind: "price",
      reason: `It costs more than this target's price ceiling.`,
      remedy: "Raise the price limit for this target.",
    });
  }

  // mintSigned binds a signature to the minter, so the calldata cannot be
  // replayed from another wallet by anyone — no setting changes that.
  if (mint.method === "mintSigned") {
    blockers.push({
      kind: "signature",
      reason: "It is a signature-gated mint, bound to the minter's address.",
      remedy: "Nothing to change — use /fcfs for signed drops.",
    });
  }

  if (input.poolSize <= 0) {
    blockers.push({
      kind: "pool",
      reason: "No wallet is both armed for auto-fire and funded.",
      remedy: "Fund the wallets, or change which wallets fire.",
    });
  }

  const unitCost = mint.valueWei + input.gasReservationWei;
  const wanted = Math.min(walletsFor(target, input.tiers), Math.max(0, input.poolSize));
  const affordable =
    unitCost > 0n ? Number(input.perEventWei / unitCost) : wanted;
  const walletCount = Math.max(0, Math.min(wanted, affordable));

  if (input.poolSize > 0 && walletCount === 0) {
    blockers.push({
      kind: "perEvent",
      reason: "The per-event cap leaves room for zero wallets at this price.",
      remedy: "Raise the per-event cap.",
    });
  }

  return { wouldCopy: blockers.length === 0 && walletCount > 0, walletCount, blockers };
}
