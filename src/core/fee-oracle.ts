// Live gas pricing.
//
// Every executor used to sign with two numbers taken straight out of
// config.json — maxFeeGwei "2" and priorityGwei "0.05" — sampled from nothing
// and never revisited. On a quiet chain that is invisible. In a contested block
// it decides the order you are put in, and being ordered after everybody who
// actually bid is indistinguishable from being slow.
//
// So the two configured numbers change meaning here rather than gaining
// company: `gas.maxFeeGwei` is the hard ceiling this bot may never bid past,
// `gas.priorityGwei` the floor it will never drop below, and what goes on the
// wire is sampled from the chain between the two. An operator who wants the old
// behaviour back sets `gas.autoPrice` to false and gets exactly it.
//
// Sampling never happens at T-0. Callers take a quote during pre-flight and, if
// they are holding for a stage, refresh it a second or two before the fire —
// never after, because a round trip spent pricing is a round trip not spent
// sending.

import { rpcCall } from "./rpc";

export interface FeeFloor {
  /** Hard ceiling on maxFeePerGas — `gas.maxFeeGwei`. */
  ceilingWei: bigint;
  /** Floor on the tip — `gas.priorityGwei`. */
  priorityFloorWei: bigint;
}

export interface FeeQuote {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFeeWei: bigint;
  source: "feeHistory" | "gasPrice" | "config";
  /**
   * The ceiling is below what the chain is already charging for inclusion.
   *
   * Worth surfacing rather than silently clamping: a transaction signed under
   * this cannot be mined at all, and the operator is the only one who can raise
   * the number.
   */
  ceilingTooLow: boolean;
}

/** Blocks of history to sample. Enough to survive one quiet block, cheap to fetch. */
const SAMPLE_BLOCKS = 5;

/** Percentile of the tips actually paid. High, because this bot is in a race. */
const PERCENTILE = 75;

/**
 * Headroom over the sampled tip.
 *
 * A drop pulls in bidders who are all reading the same recent history, so
 * matching the 75th percentile exactly is a good way to arrive alongside the
 * crowd rather than ahead of it. 1.5× is the smallest multiple that reliably
 * sorts above a tie.
 */
const TIP_BUMP_NUM = 3n;
const TIP_BUMP_DEN = 2n;

/**
 * Base fee can rise between the sample and the send — 12.5% per block on
 * EIP-1559, and a chain producing fifteen blocks in two seconds can climb a
 * long way inside a mint. Doubling is the usual allowance and costs nothing
 * when unused: base fee is refunded, only the tip is actually paid.
 */
const BASE_HEADROOM = 2n;

interface FeeHistory {
  baseFeePerGas?: string[];
  reward?: string[][];
}

function hexToBig(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Combine a sampled base fee and tip with the operator's bounds.
 *
 * Pure, so the clamping rules can be exercised without a chain: the ceiling
 * always wins, and when it wins hard enough to fall under the tip the tip comes
 * down with it — `maxPriorityFeePerGas > maxFeePerGas` is invalid under
 * EIP-1559 and every node rejects it outright.
 */
export function combineFees(baseFeeWei: bigint, sampledTipWei: bigint, floor: FeeFloor): FeeQuote {
  const bumped = (sampledTipWei * TIP_BUMP_NUM) / TIP_BUMP_DEN;
  let tip = bumped > floor.priorityFloorWei ? bumped : floor.priorityFloorWei;
  let maxFee = baseFeeWei * BASE_HEADROOM + tip;

  if (maxFee > floor.ceilingWei) maxFee = floor.ceilingWei;
  if (tip > maxFee) tip = maxFee;

  return {
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: tip,
    baseFeeWei,
    source: "feeHistory",
    ceilingTooLow: floor.ceilingWei < baseFeeWei,
  };
}

/**
 * What the chain is charging right now, bounded by what the operator allows.
 *
 * Never throws. A quote that cannot be sampled falls back to the configured
 * numbers, because a mint that fires at a stale price beats one that does not
 * fire at all.
 */
export async function sampleFees(
  readUrl: string,
  floor: FeeFloor,
  timeoutMs = 3_000
): Promise<FeeQuote> {
  try {
    const history = await rpcCall<FeeHistory>(
      readUrl,
      "eth_feeHistory",
      [`0x${SAMPLE_BLOCKS.toString(16)}`, "latest", [PERCENTILE]],
      timeoutMs
    );

    // The array carries one more entry than blocks requested: the last is the
    // *next* block's base fee, which is the one this transaction will pay.
    const bases = history.baseFeePerGas ?? [];
    const baseFee = hexToBig(bases[bases.length - 1]);

    // Take the strongest recent tip rather than the newest. One quiet block in
    // the sample would otherwise price the whole burst as though the chain were
    // idle, seconds before it is anything but.
    let tip = 0n;
    for (const row of history.reward ?? []) {
      const value = hexToBig(row?.[0]);
      if (value > tip) tip = value;
    }

    if (baseFee > 0n || tip > 0n) return combineFees(baseFee, tip, floor);
  } catch {
    // fall through to gasPrice
  }

  try {
    const legacy = hexToBig(await rpcCall<string>(readUrl, "eth_gasPrice", [], timeoutMs));
    if (legacy > 0n) {
      // eth_gasPrice already includes a tip the node thinks is competitive, so
      // it is treated as the whole price rather than as a base to build on.
      const quote = combineFees(legacy, floor.priorityFloorWei, floor);
      return { ...quote, source: "gasPrice" };
    }
  } catch {
    // fall through to config
  }

  return {
    maxFeePerGas: floor.ceilingWei,
    maxPriorityFeePerGas: floor.priorityFloorWei,
    baseFeeWei: 0n,
    source: "config",
    ceilingTooLow: false,
  };
}

/** One line for the operator, in gwei, without dragging in a formatter. */
export function describeFees(quote: FeeQuote): string {
  const gwei = (wei: bigint): string => {
    const whole = wei / 1_000_000_000n;
    const frac = (wei % 1_000_000_000n).toString().padStart(9, "0").slice(0, 3).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  };
  return (
    `${gwei(quote.maxPriorityFeePerGas)} gwei tip / ${gwei(quote.maxFeePerGas)} gwei cap ` +
    `(base ${gwei(quote.baseFeeWei)}, ${quote.source})`
  );
}
