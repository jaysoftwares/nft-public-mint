// How to copy a mint we just watched somebody else make.
//
// The engine used to know exactly one trick: take their calldata, rewrite their
// address to ours, send it. That works for a plain public mint and fails for
// everything else, and "everything else" turned out to be most of what the
// watched wallets actually do. A target minting through OpenSea's allowlist or
// signed stage produces calldata carrying a merkle proof or a server signature
// bound to *their* address. Rewrite the address and the proof no longer matches;
// the call reverts; the bot reported "the call is bound to the target's address
// (allowlist proof or signature), which cannot be replayed" and gave up.
//
// Which is where the complaint "it asks for eligibility even when it's a public
// mint" comes from. The stage the target used was gated. The same collection's
// *public* stage was open the whole time, and nothing tried it.
//
// So copying is a ladder, not a single move:
//
//   1. Replay      — rewrite their calldata. Cheapest and most faithful: same
//                    stage, same price, same quantity. Works whenever the call
//                    is not bound to their address.
//   2. Public stage — read the collection's public SeaDrop stage straight from
//                    chain and mint that instead. This is what the operator
//                    means by "copy what they mint": the collection is the
//                    signal, the gated stage was only how *they* got in.
//
// Rung 2 is not a fallback in the apologetic sense — for a gated drop it is the
// only path that exists for us, and it is exactly the path the CLI has always
// taken. It re-prices from chain rather than reusing theirs, so a free allowlist
// mint that costs 0.02 publicly is priced at 0.02 and met by the caps honestly.

import { buildReplay, ReplayError, simulate, isFundingRevert } from "./calldata";
import { fetchPublicDrop, resolveFeeRecipient, encodeMintPublic, SEADROP_ADDRESS, DropReadError } from "../seadrop-public";
import { Interface, formatEther } from "ethers";

/** The three SeaDrop entry points a watched wallet can arrive through. */
const SEADROP_MINTS = new Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
  "function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool) mintParams, bytes32[] proof)",
  "function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool) mintParams, uint256 salt, bytes signature)",
]);

export interface DecodedMint {
  method: "mintPublic" | "mintAllowList" | "mintSigned";
  nftContract: string;
  quantity: number;
  /** True when the stage is gated, so the calldata cannot survive a rewrite. */
  gated: boolean;
}

/**
 * Read quantity and stage type out of a SeaDrop call.
 *
 * Quantity is the part that matters most, and not for display. The price cap is
 * a per-NFT ceiling, but the only number to hand was the transaction's total
 * value — so a target buying three at 0.0065 presented as a single 0.0195 mint
 * and was rejected as "above ceiling" against a 0.005 limit it never breached.
 * The quantity is right there in the calldata; nothing had to be guessed.
 */
export function decodeSeaDropMint(to: string, data: string): DecodedMint | undefined {
  if (to.toLowerCase() !== SEADROP_ADDRESS.toLowerCase()) return undefined;
  try {
    const parsed = SEADROP_MINTS.parseTransaction({ data });
    if (!parsed) return undefined;
    const method = parsed.name as DecodedMint["method"];
    return {
      method,
      nftContract: String(parsed.args[0]),
      quantity: Math.max(1, Number(parsed.args[3])),
      gated: method !== "mintPublic",
    };
  } catch {
    return undefined;
  }
}

export type CopyStrategy = "replay" | "public-stage";

export interface CopyPlan {
  strategy: CopyStrategy;
  to: string;
  /** What one wallet pays, all in. */
  value: bigint;
  /** Calldata per wallet address. Identical for every wallet on the public rung. */
  dataFor: Map<string, string>;
  gasLimit: number;
  /** NFTs one wallet receives. */
  quantity: number;
  /** value ÷ quantity — the number the price ceiling is actually about. */
  unitPriceWei: bigint;
  addressBound: boolean;
  selector: string;
  /** One sentence, in plain English, on how this copy was built. */
  how: string;
}

/**
 * Both rungs failed, and this says which and why in words an operator can act
 * on. `fix` is the sentence that tells them what to change — the old errors
 * described the machine's difficulty and left the reader with nothing to do.
 */
export class CopyPlanError extends Error {
  readonly fix: string;
  constructor(message: string, fix: string) {
    super(message);
    this.name = "CopyPlanError";
    this.fix = fix;
  }
}

export interface PlanCopyArgs {
  readUrl: string;
  target: string;
  /** Where the target sent their mint. */
  to: string;
  originalData: string;
  /** What the target paid, in total. */
  value: bigint;
  /** The NFT contract the Transfer came from. */
  contract: string;
  wallets: { id: string; address: string }[];
  configuredGasLimit: number;
  requireAddressBound: boolean;
  /** Allows the public rung to be turned off for an operator who wants strict mirroring. */
  allowPublicFallback: boolean;
  /** Clock, injectable so the stage-window check is testable. */
  now?: number;
}

export async function planCopy(args: PlanCopyArgs): Promise<CopyPlan> {
  const decoded = decodeSeaDropMint(args.to, args.originalData);
  const quantity = decoded?.quantity ?? 1;

  // ── Rung 1: replay their bytes ──
  //
  // Skipped outright for a stage we already know is gated. Attempting it would
  // burn an eth_estimateGas to be told what the selector said for free, and on
  // a live drop that round trip is the whole budget.
  let replayFailure: string | undefined;
  if (!decoded?.gated) {
    try {
      const replay = await buildReplay({
        readUrl: args.readUrl,
        target: args.target,
        to: args.to,
        originalData: args.originalData,
        value: args.value,
        wallets: args.wallets,
        configuredGasLimit: args.configuredGasLimit,
        requireAddressBound: args.requireAddressBound,
      });
      return {
        strategy: "replay",
        to: replay.to,
        value: replay.value,
        dataFor: replay.dataFor,
        gasLimit: replay.gasLimit,
        quantity,
        unitPriceWei: args.value / BigInt(quantity),
        addressBound: replay.addressBound,
        selector: replay.selector,
        how:
          quantity > 1
            ? `Copying their exact mint — ${quantity} NFTs per wallet, same stage, same price.`
            : `Copying their exact mint — same stage, same price.`,
      };
    } catch (err) {
      if (!(err instanceof ReplayError)) throw err;
      replayFailure = err.message;
    }
  } else {
    replayFailure =
      `They minted through the ${decoded.method === "mintSigned" ? "signed" : "allowlist"} ` +
      `stage, which is tied to their wallet and cannot be re-used by ours.`;
  }

  // ── Rung 2: the collection's own public stage ──
  if (!args.allowPublicFallback) {
    throw new CopyPlanError(
      `${replayFailure} Public-stage copying is switched off, so there is nothing else to try.`,
      "Turn on “also try the public stage” under Copy-mint to mint gated drops through their open stage instead."
    );
  }

  const nftContract = decoded?.nftContract ?? args.contract;
  let drop;
  try {
    drop = await fetchPublicDrop(args.readUrl, nftContract);
  } catch (err) {
    if (err instanceof DropReadError) {
      throw new CopyPlanError(
        `${replayFailure} The public stage could not be read: ${(err as Error).message}`,
        "This is an RPC problem, not a problem with the collection — it usually clears on its own."
      );
    }
    throw err;
  }

  if (!drop) {
    throw new CopyPlanError(
      `${replayFailure} This collection has no public stage on SeaDrop, so there is no open door for our wallets.`,
      "Nothing to change — this drop is allowlist-only, and only wallets on that list can mint it."
    );
  }

  const now = Math.floor((args.now ?? Date.now()) / 1000);
  if (drop.startTime > now) {
    throw new CopyPlanError(
      `${replayFailure} Its public stage has not opened yet — it starts ${new Date(drop.startTime * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      "Nothing to change — the public stage opens later, and the watcher will copy it then if they mint again."
    );
  }
  if (drop.endTime !== 0 && drop.endTime < now) {
    throw new CopyPlanError(
      `${replayFailure} Its public stage has already closed.`,
      "Nothing to change — the public window for this collection is over."
    );
  }

  const fee = await resolveFeeRecipient(args.readUrl, nftContract, drop.restrictFeeRecipients);
  if (!fee) {
    throw new CopyPlanError(
      `${replayFailure} Its public stage allows no fee recipient, so no valid mint can be built for it.`,
      "Nothing to change — the collection is configured in a way that blocks outside minters."
    );
  }

  // Never buy more than their stage allows, and never more than the target took.
  const perWallet = Math.max(1, Math.min(quantity, drop.maxTotalMintableByWallet || quantity));
  const data = encodeMintPublic(nftContract, fee.address, perWallet);
  const value = drop.mintPrice * BigInt(perWallet);

  // Simulate before broadcasting, exactly as the replay rung does. A public
  // stage that reads fine can still revert — sold out, or the wallet already at
  // its per-wallet cap — and learning that here costs nothing while learning it
  // at broadcast costs gas on every wallet.
  //
  // Several probes, not one, and for the same reason the replay rung takes
  // several: eth_estimateGas charges the caller, so a probe short of price plus
  // gas reverts with "insufficient funds" however open the stage is. Judging
  // the drop on the first wallet in the pool would report a perfectly live
  // collection as sold out on the strength of one empty wallet.
  const probes = args.wallets.slice(0, 3);
  let sim;
  let fundingFailures = 0;
  for (const probe of probes) {
    sim = await simulate(args.readUrl, { from: probe.address, to: SEADROP_ADDRESS, data, value });
    if (sim.ok) break;
    if (!isFundingRevert(sim.reason)) break;
    fundingFailures += 1;
  }
  if (!sim || !sim.ok) {
    // Same reasoning as the replay rung: a wallet being short is the node’s
    // decision at dispatch, for free, not ours to make here at the cost of the
    // whole drop.
    if (fundingFailures === probes.length) {
      const dataForAll = new Map<string, string>();
      for (const wallet of args.wallets) dataForAll.set(wallet.address, data);
      return {
        strategy: "public-stage",
        to: SEADROP_ADDRESS,
        value,
        dataFor: dataForAll,
        gasLimit: args.configuredGasLimit,
        quantity: perWallet,
        unitPriceWei: drop.mintPrice,
        addressBound: false,
        selector: data.slice(0, 10),
        how:
          "They used a wallet-locked stage we cannot re-use, so this mints the same " +
          "collection through its open public stage instead.",
      };
    }
    throw new CopyPlanError(
      `${replayFailure} Minting its public stage was tried instead and the test run failed: ${sim?.reason ?? "no reason given"}`,
      "Usually this means the drop has sold out, or it is limited to fewer per wallet than we asked for."
    );
  }

  const dataFor = new Map<string, string>();
  for (const wallet of args.wallets) dataFor.set(wallet.address, data);

  const gasLimit = Math.max(
    sim.gasEstimate ? Number((sim.gasEstimate * 13n) / 10n) : args.configuredGasLimit,
    args.configuredGasLimit
  );

  return {
    strategy: "public-stage",
    to: SEADROP_ADDRESS,
    value,
    dataFor,
    gasLimit,
    quantity: perWallet,
    unitPriceWei: drop.mintPrice,
    addressBound: false,
    selector: data.slice(0, 10),
    how:
      `They used a wallet-locked stage we cannot re-use, so this mints the same ` +
      `collection through its open public stage instead — ${perWallet} per wallet.`,
  };
}
