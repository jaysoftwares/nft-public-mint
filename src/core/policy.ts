// Spend policy for the autonomous path.
//
// Copy-mint fires with no human in the loop — a confirmation step costs many
// blocks, so the caps *are* the product. The attack they exist for:
//
//   Someone notices you copy them. They deploy a worthless contract priced at
//   0.1 ETH, mint one, and your wallets buy the rest. The simulation passes
//   perfectly, because the mint genuinely succeeds. You bought their garbage.
//
// So price is checked before size. A unit price above the ceiling is rejected
// outright rather than trimmed, because an unusually expensive mint is a signal
// about quality, not a budgeting problem. Budget limits do trim: firing twenty
// wallets when fifty won't fit is better than firing none.
//
// Cost per wallet counts the gas reservation as well as the mint price,
// otherwise a free mint would look free and fire unbounded.

export interface PolicyCaps {
  perEventWei: bigint;
  maxPriceWei: bigint;
  dailyWei: bigint;
}

export interface PolicyInput {
  /** Mint price for one wallet's transaction, from the copied tx's value. */
  unitPriceWei: bigint;
  /** gasLimit × maxFee — reserved by the node whether or not it is spent. */
  gasReservationWei: bigint;
  requestedWallets: number;
  caps: PolicyCaps;
  spentLast24hWei: bigint;
  /** Fires by this target inside the cooldown window. */
  targetFiresInWindow: number;
  maxFiresPerWindow: number;
  /** This contract already triggered a fire inside the dedup window. */
  duplicateContract: boolean;
}

export type PolicyVerdict =
  | {
      allowed: true;
      walletCount: number;
      unitCostWei: bigint;
      totalCommitWei: bigint;
      trimmedFrom?: number;
      trimReason?: string;
    }
  | { allowed: false; reason: string; detail?: string };

export function evaluate(input: PolicyInput): PolicyVerdict {
  if (input.requestedWallets <= 0) {
    return { allowed: false, reason: "No eligible wallets" };
  }

  if (input.duplicateContract) {
    return {
      allowed: false,
      reason: "Already fired on this contract",
      detail: "Another watched target minted it moments ago.",
    };
  }

  if (input.targetFiresInWindow >= input.maxFiresPerWindow) {
    return {
      allowed: false,
      reason: "Target cooldown",
      detail: `${input.targetFiresInWindow} fires already in this window (max ${input.maxFiresPerWindow}).`,
    };
  }

  // Quality gate, checked before any trimming. Not a budget question.
  if (input.unitPriceWei > input.caps.maxPriceWei) {
    return {
      allowed: false,
      reason: "Price above ceiling",
      detail: `Unit price exceeds caps.maxPriceEth — this is the bait guard, and it does not trim.`,
    };
  }

  const unitCost = input.unitPriceWei + input.gasReservationWei;
  if (unitCost <= 0n) {
    return { allowed: false, reason: "Zero cost per wallet — refusing to act on that" };
  }

  let walletCount = input.requestedWallets;
  let trimReason: string | undefined;

  const perEventMax = Number(input.caps.perEventWei / unitCost);
  if (perEventMax < walletCount) {
    walletCount = perEventMax;
    trimReason = "per-event cap";
  }

  const dailyRemaining = input.caps.dailyWei - input.spentLast24hWei;
  if (dailyRemaining <= 0n) {
    return {
      allowed: false,
      reason: "Daily budget exhausted",
      detail: "Rolling 24h autonomous spend has reached caps.dailyEth.",
    };
  }
  const dailyMax = Number(dailyRemaining / unitCost);
  if (dailyMax < walletCount) {
    walletCount = dailyMax;
    trimReason = "daily budget";
  }

  if (walletCount <= 0) {
    return {
      allowed: false,
      reason: "Caps leave room for zero wallets",
      detail: `One wallet would commit more than the remaining allowance.`,
    };
  }

  return {
    allowed: true,
    walletCount,
    unitCostWei: unitCost,
    totalCommitWei: unitCost * BigInt(walletCount),
    trimmedFrom: walletCount < input.requestedWallets ? input.requestedWallets : undefined,
    trimReason,
  };
}
