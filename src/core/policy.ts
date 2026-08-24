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
  /**
   * NFTs one wallet receives for that price. Defaults to one.
   *
   * Load-bearing, because the ceiling below is a per-NFT judgement and the only
   * figure to hand was the whole transaction's value. A target buying three at
   * 0.0065 arrived as a single 0.0195 "unit price" and was turned away against
   * a 0.005 limit it had not actually broken — the bot refusing a cheap mint
   * and reporting it as an expensive one. The quantity is in the calldata; see
   * decodeSeaDropMint in copy-plan.ts.
   */
  quantity?: number;
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
      /** What one wallet must be holding: the mint price plus a gas reservation. */
      unitCostWei: bigint;
      /**
       * What one wallet actually spends on the drop — no gas.
       *
       * This is the number the ledger records and the daily cap measures. They
       * used to record `unitCostWei`, which made every free mint appear in the
       * ledger at the gas reservation and read as a paid one. Fifty-seven of
       * sixty-four entries looked like purchases and were free.
       */
      unitSpendWei: bigint;
      totalCommitWei: bigint;
      trimmedFrom?: number;
      trimReason?: string;
    }
  | {
      allowed: false;
      reason: string;
      detail?: string;
      /**
       * The setting to change, named in the operator's words.
       *
       * A refusal that explains only itself leaves the reader with nothing to
       * do about it. Every rejection here is a number somebody chose, so every
       * rejection can say which number and where to change it.
       */
      fix?: string;
    };

/** Wei → a short decimal string, for messages meant to be read rather than parsed. */
function eth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function evaluate(input: PolicyInput): PolicyVerdict {
  if (input.requestedWallets <= 0) {
    return { allowed: false, reason: "No eligible wallets" };
  }

  if (input.duplicateContract) {
    return {
      allowed: false,
      reason: "Already copied this collection a moment ago",
      detail: "Another watched wallet minted the same collection just now and we already bought it.",
      fix: "Working as intended — this stops one drop being bought twice.",
    };
  }

  if (input.targetFiresInWindow >= input.maxFiresPerWindow) {
    return {
      allowed: false,
      reason: "This wallet has hit its hourly limit",
      detail: `Already copied ${input.targetFiresInWindow} of their mints this hour, and the limit is ${input.maxFiresPerWindow}.`,
      fix: "Raise “mints copied per wallet per hour” under Copy-mint if you want to follow them more closely.",
    };
  }

  // Quality gate, checked before any trimming, and per NFT rather than per
  // transaction — buying five of something cheap is not the same event as
  // buying one of something expensive, and only the second one is the bait this
  // guard exists for.
  const quantity = Math.max(1, input.quantity ?? 1);
  const pricePerNft = input.unitPriceWei / BigInt(quantity);
  if (pricePerNft > input.caps.maxPriceWei) {
    return {
      allowed: false,
      reason: "Too expensive",
      detail:
        `That mint costs ${eth(pricePerNft)} ETH per NFT` +
        (quantity > 1 ? ` (${eth(input.unitPriceWei)} ETH for ${quantity})` : "") +
        `, and your limit is ${eth(input.caps.maxPriceWei)} ETH per NFT.`,
      fix: `Raise “max price per NFT” under Copy-mint → Spending limits to at least ${eth(pricePerNft)} ETH if you want mints like this one.`,
    };
  }

  // Two different numbers, and conflating them is what stopped every wallet
  // firing.
  //
  // `unitSpend` is money leaving for the drop. `unitCost` is what a wallet must
  // be holding to take part, which includes a gas reservation it already owns
  // and mostly gets back — gas is only charged for a transaction that lands,
  // and it is bounded by the gas settings, not by a budget.
  //
  // The spending caps used to be measured against `unitCost`, so a FREE mint
  // was billed 0.0005 ETH a wallet against a 0.0014 per-event cap and exactly
  // two wallets were allowed to mint. Ten funded wallets, a free drop, nothing
  // to spend, and eight of them sat it out — the operator funds these wallets
  // precisely so they all fire at once. Caps bound spending; a free mint spends
  // nothing, so it is not trimmed at all.
  const unitSpend = input.unitPriceWei;
  const unitCost = unitSpend + input.gasReservationWei;
  if (unitCost <= 0n) {
    return { allowed: false, reason: "Zero cost per wallet — refusing to act on that" };
  }

  let walletCount = input.requestedWallets;
  let trimReason: string | undefined;
  const dailyRemaining = input.caps.dailyWei - input.spentLast24hWei;

  if (unitSpend > 0n) {
    const perEventMax = Number(input.caps.perEventWei / unitSpend);
    if (perEventMax < walletCount) {
      walletCount = perEventMax;
      trimReason = "per-event cap";
    }

    if (dailyRemaining <= 0n) {
      return {
        allowed: false,
        reason: "Out of budget for today",
        detail: `The bot has spent its ${eth(input.caps.dailyWei)} ETH daily allowance on copies in the last 24 hours.`,
        fix: "Raise “daily spending limit” under Copy-mint → Spending limits, or wait for the 24 hours to roll over.",
      };
    }
    const dailyMax = Number(dailyRemaining / unitSpend);
    if (dailyMax < walletCount) {
      walletCount = dailyMax;
      trimReason = "daily budget";
    }
  }

  if (walletCount <= 0) {
    // Which of the two limits bit is the whole question here — they have
    // different fixes and the operator cannot tell them apart from "zero".
    // Only reachable on a mint that costs money — a free one is never trimmed —
    // so the number quoted is the mint price, not the gas the wallet already
    // holds. Quoting the gas here sent people to raise a spending limit over a
    // cost that was never spending.
    const blocker = input.caps.perEventWei < dailyRemaining ? "per-mint" : "daily";
    return {
      allowed: false,
      reason: "Your spending limit is smaller than one wallet's share",
      detail:
        `One wallet would spend ${eth(unitSpend)} ETH on this mint, which is more than the ` +
        `${blocker === "per-mint" ? `${eth(input.caps.perEventWei)} ETH per-mint limit` : `${eth(dailyRemaining)} ETH left in today's budget`}.`,
      fix:
        blocker === "per-mint"
          ? `Raise “spend per mint” under Copy-mint → Spending limits to at least ${eth(unitSpend)} ETH.`
          : `Raise “daily spending limit”, or wait for the 24 hours to roll over.`,
    };
  }

  return {
    allowed: true,
    walletCount,
    unitCostWei: unitCost,
    unitSpendWei: unitSpend,
    totalCommitWei: unitCost * BigInt(walletCount),
    trimmedFrom: walletCount < input.requestedWallets ? input.requestedWallets : undefined,
    trimReason,
  };
}
