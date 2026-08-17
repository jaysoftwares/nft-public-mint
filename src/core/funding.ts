// Moving ETH into the wallet set, and dust back out.
//
// Funding tops wallets up to a target rather than sending a flat amount to
// everyone: after a mint the set is unevenly drained, and blanket funding either
// overshoots the wallets that still hold a balance or undershoots the ones that
// spent. Only the deficit is sent.
//
// All transfers originate from the single funder address pinned in config.json,
// which means one nonce sequence and no cross-wallet coordination. They are
// signed as a block and dispatched together — there is no latency pressure here,
// but the same sharded dispatcher is used so no provider gets a 500-request
// burst.

import { Wallet, HDNodeWallet, formatEther, parseEther } from "ethers";
import { Endpoint, dispatchAll, prepareTx, DispatchOutcome } from "./dispatcher";
import { BalanceQuery, Shortfall } from "./balances";
import { rpcCall } from "./rpc";

/** A plain ETH transfer costs exactly this much gas — never more. */
export const TRANSFER_GAS = 21_000;

export type FundAmount =
  | { ok: true; wei: bigint; text: string }
  | { ok: false; reason: "empty" | "malformed" | "zero" | "too_large" };

/**
 * Read a hand-typed funding target.
 *
 * Separate from the buttons because a typed amount is the one that can be
 * wrong. Funding tops every selected wallet *up to* this balance, so the figure
 * is multiplied by the size of the set — across 500 wallets a misplaced decimal
 * is a three-order-of-magnitude mistake, and no later screen states the total
 * in a way that would catch it.
 *
 * Deliberately tolerant of how people write amounts and strict about what the
 * number means: a stray "ETH", a leading Ξ or surrounding spaces are stripped,
 * while zero and anything above `maxWei` are refused outright rather than
 * carried forward to be confirmed.
 */
export function parseFundAmount(raw: string, maxWei: bigint): FundAmount {
  const cleaned = raw
    .trim()
    .replace(/^Ξ/, "")
    .replace(/\s*(eth|ether)$/i, "")
    .replace(/\s+/g, "");

  if (cleaned.length === 0) return { ok: false, reason: "empty" };
  if (!/^\d*\.?\d+$/.test(cleaned)) return { ok: false, reason: "malformed" };

  let wei: bigint;
  try {
    wei = parseEther(cleaned);
  } catch {
    // More decimal places than wei can represent.
    return { ok: false, reason: "malformed" };
  }

  if (wei === 0n) return { ok: false, reason: "zero" };
  if (wei > maxWei) return { ok: false, reason: "too_large" };

  return { ok: true, wei, text: cleaned };
}

export interface FundingPlan {
  transfers: { id: string; address: string; amount: bigint }[];
  totalValue: bigint;
  gasCost: bigint;
  totalCost: bigint;
}

export function planFunding(shortfallList: Shortfall[], maxFeePerGas: bigint): FundingPlan {
  const transfers = shortfallList.map((s) => ({
    id: s.id,
    address: s.address,
    amount: s.deficit,
  }));
  const totalValue = transfers.reduce((sum, t) => sum + t.amount, 0n);
  const gasCost = BigInt(transfers.length) * BigInt(TRANSFER_GAS) * maxFeePerGas;
  return { transfers, totalValue, gasCost, totalCost: totalValue + gasCost };
}

export interface FundingDeps {
  funder: Wallet | HDNodeWallet;
  readUrl: string;
  endpoints: Endpoint[];
  chainId: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface FundingResult {
  dispatched: number;
  accepted: number;
  rejected: number;
  outcomes: DispatchOutcome[];
}

export class FundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingError";
  }
}

export async function executeFunding(
  plan: FundingPlan,
  deps: FundingDeps,
  onProgress?: (done: number, total: number) => void
): Promise<FundingResult> {
  if (plan.transfers.length === 0) {
    return { dispatched: 0, accepted: 0, rejected: 0, outcomes: [] };
  }

  const balanceHex = await rpcCall<string>(deps.readUrl, "eth_getBalance", [
    deps.funder.address,
    "latest",
  ]);
  const funderBalance = BigInt(balanceHex);

  if (funderBalance < plan.totalCost) {
    throw new FundingError(
      `Funder ${deps.funder.address} holds ${formatEther(funderBalance)} ETH but this needs ` +
        `${formatEther(plan.totalCost)} ETH ` +
        `(${formatEther(plan.totalValue)} to send + ${formatEther(plan.gasCost)} gas ceiling).`
    );
  }

  const startNonce = Number(
    BigInt(
      await rpcCall<string>(deps.readUrl, "eth_getTransactionCount", [
        deps.funder.address,
        "pending",
      ])
    )
  );

  const prepared = [];
  for (let i = 0; i < plan.transfers.length; i++) {
    const transfer = plan.transfers[i];
    const raw = await deps.funder.signTransaction({
      to: transfer.address,
      value: transfer.amount,
      data: "0x",
      nonce: startNonce + i,
      gasLimit: TRANSFER_GAS,
      maxFeePerGas: deps.maxFeePerGas,
      maxPriorityFeePerGas: deps.maxPriorityFeePerGas,
      type: 2,
      chainId: deps.chainId,
    });
    prepared.push(prepareTx(transfer.id, transfer.address, raw));
    onProgress?.(i + 1, plan.transfers.length);
  }

  const report = await dispatchAll(prepared, deps.endpoints);
  return {
    dispatched: prepared.length,
    accepted: report.accepted,
    rejected: report.rejected,
    outcomes: report.outcomes,
  };
}

export interface SweepEthPlan {
  transfers: { id: string; address: string; amount: bigint }[];
  total: bigint;
  skipped: { address: string; balance: bigint; reason: string }[];
}

/**
 * Reclaim ETH, leaving each wallet exactly its own transfer cost behind.
 *
 * A wallet cannot send its full balance: the node reserves gasLimit × maxFee up
 * front, so the transfer value has to be balance − 21000 × maxFee. Wallets that
 * cannot cover even that are skipped rather than attempted.
 */
export function planEthSweep(
  targets: BalanceQuery[],
  balances: Map<string, bigint>,
  maxFeePerGas: bigint
): SweepEthPlan {
  const cost = BigInt(TRANSFER_GAS) * maxFeePerGas;
  const transfers: SweepEthPlan["transfers"] = [];
  const skipped: SweepEthPlan["skipped"] = [];

  for (const target of targets) {
    const balance = balances.get(target.address) ?? 0n;
    if (balance <= cost) {
      if (balance > 0n) {
        skipped.push({
          address: target.address,
          balance,
          reason: "balance below its own transfer cost",
        });
      }
      continue;
    }
    transfers.push({ id: target.id, address: target.address, amount: balance - cost });
  }

  return {
    transfers,
    total: transfers.reduce((sum, t) => sum + t.amount, 0n),
    skipped,
  };
}

export interface EthSweepDeps {
  signerFor: (id: string) => Wallet | HDNodeWallet;
  /** Where the reclaimed ETH lands — the funder, so it can be redeployed. */
  destination: string;
  chainId: number;
  endpoints: Endpoint[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonceFor: (address: string) => number;
}

/**
 * Sign each planned transfer, without sending anything.
 *
 * The mirror image of funding: there, one funder signs many transfers and the
 * nonces are a single sequence; here every wallet signs exactly one, so each
 * takes its own current nonce and no sequencing is needed.
 *
 * Split out from dispatch so the signing can be checked offline — a sweep that
 * signs from the wrong wallet or to the wrong destination is a silent way to
 * lose the set's entire balance, and that deserves a test that never touches a
 * network.
 */
export async function signEthSweep(
  plan: SweepEthPlan,
  deps: EthSweepDeps,
  onProgress?: (done: number, total: number) => void
): Promise<ReturnType<typeof prepareTx>[]> {
  const prepared = [];
  for (let i = 0; i < plan.transfers.length; i++) {
    const transfer = plan.transfers[i];
    const raw = await deps.signerFor(transfer.id).signTransaction({
      to: deps.destination,
      value: transfer.amount,
      data: "0x",
      nonce: deps.nonceFor(transfer.address),
      gasLimit: TRANSFER_GAS,
      maxFeePerGas: deps.maxFeePerGas,
      maxPriorityFeePerGas: deps.maxPriorityFeePerGas,
      type: 2,
      chainId: deps.chainId,
    });
    prepared.push(prepareTx(transfer.id, transfer.address, raw));
    onProgress?.(i + 1, plan.transfers.length);
  }
  return prepared;
}

export async function executeEthSweep(
  plan: SweepEthPlan,
  deps: EthSweepDeps,
  onProgress?: (done: number, total: number) => void
): Promise<FundingResult> {
  if (plan.transfers.length === 0) {
    return { dispatched: 0, accepted: 0, rejected: 0, outcomes: [] };
  }

  const prepared = await signEthSweep(plan, deps, onProgress);
  const report = await dispatchAll(prepared, deps.endpoints);
  return {
    dispatched: prepared.length,
    accepted: report.accepted,
    rejected: report.rejected,
    outcomes: report.outcomes,
  };
}
