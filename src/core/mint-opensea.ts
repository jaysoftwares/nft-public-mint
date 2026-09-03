// Minting through OpenSea's v2 API.
//
// OpenSea hands back finished calldata rather than parameters, which is
// convenient and also the reason this file exists: calldata from a third party
// is not something to sign blindly across 500 wallets. Two checks stand between
// the response and a signature.
//
//   Decode. Every SeaDrop entry point starts (nftContract, feeRecipient,
//   minterIfNotPayer, quantity, …), so the contract we asked about and the
//   wallet being credited are both readable straight out of the response. A
//   non-zero minterIfNotPayer that is not our wallet would mint to someone else
//   while we pay — the same failure copy-mint guards against.
//
//   Simulate. One eth_estimateGas from a real wallet proves the call would
//   actually succeed, and prices the gas limit as a side effect.
//
// Timing is the awkward part and it is not fixable here: OpenSea refuses to
// issue calldata before a stage opens, so the fetch cannot be moved off the
// critical path. What can be done is to have everything else ready — nonces
// primed, sockets warm, wallets checked — so the only work left at T-0 is the
// API round-trip, signing, and dispatch.

import { Interface, getAddress, formatEther, Wallet, HDNodeWallet } from "ethers";
import { SEADROP_ADDRESS } from "../seadrop-public";
import { NonceManager } from "./nonce-manager";
import {
  Endpoint,
  DispatchOutcome,
  dispatchOne,
  endpointTargets,
  prepareTx,
  PreparedTx,
  summariseErrors,
} from "./dispatcher";
import { FeeQuote, sampleFees } from "./fee-oracle";
import { fetchBalances, requiredPerWallet, shortfalls, Shortfall } from "./balances";
import { collectReceipts, sleepUntil, ReceiptRow } from "./mint-runtime";
import { simulate } from "./calldata";
import { warmSockets, rpcCall } from "./rpc";
import { record } from "./ledger";
import {
  MintCalldata,
  OpenSeaApiError,
  OpenSeaFailure,
  fetchMintCalldata,
  fetchDrop,
} from "./opensea-api";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * How far ahead of a booked fire to re-price gas and re-open the sockets.
 *
 * Long enough for both round trips to finish comfortably, short enough that the
 * base fee sampled is still the one the transaction will pay.
 */
const PREFIRE_LEAD_MS = 1_500;

// Every SeaDrop mint entry point shares its first four parameters, so one
// decoder covers public, allowlist and signed stages alike.
const SEADROP_HEADS = new Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
  "function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool) mintParams, bytes32[] proof)",
  "function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool) mintParams, uint256 salt, bytes signature)",
]);

export class OpenSeaMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenSeaMintError";
  }
}

export interface CalldataCheck {
  ok: boolean;
  method?: string;
  decodedContract?: string;
  creditedTo?: string;
  quantity?: number;
  reason?: string;
}

/**
 * Read back what a returned transaction would actually do.
 *
 * An unrecognised target or selector is reported, not rejected — OpenSea may
 * route a drop through something other than the SeaDrop singleton, and the
 * simulation still gates those. What is rejected outright is a call that would
 * credit a wallet other than the one paying.
 */
export function inspectCalldata(
  tx: MintCalldata,
  expectedContract: string,
  minter: string
): CalldataCheck {
  if (tx.to.toLowerCase() !== SEADROP_ADDRESS.toLowerCase()) {
    return {
      ok: true,
      reason: `target is ${tx.to}, not the SeaDrop singleton — relying on simulation alone`,
    };
  }

  let parsed;
  try {
    parsed = SEADROP_HEADS.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    return { ok: true, reason: "unrecognised SeaDrop selector — relying on simulation alone" };
  }
  if (!parsed) {
    return { ok: true, reason: "calldata did not decode — relying on simulation alone" };
  }

  const nftContract = String(parsed.args[0]);
  const minterIfNotPayer = String(parsed.args[2]);
  const quantity = Number(parsed.args[3]);

  if (getAddress(nftContract) !== getAddress(expectedContract)) {
    return {
      ok: false,
      method: parsed.name,
      decodedContract: nftContract,
      reason:
        `calldata mints ${nftContract} but we asked for ${expectedContract} — ` +
        "refusing rather than minting a different collection",
    };
  }

  // Zero means "credit msg.sender", which is what we want. Anything else must
  // be us, or we would be paying for someone else's NFT.
  const credited = minterIfNotPayer === ZERO ? minter : minterIfNotPayer;
  if (getAddress(credited) !== getAddress(minter)) {
    return {
      ok: false,
      method: parsed.name,
      creditedTo: minterIfNotPayer,
      reason:
        `calldata credits ${minterIfNotPayer}, not ${minter} — ` +
        "this would mint into another wallet at our expense",
    };
  }

  return {
    ok: true,
    method: parsed.name,
    decodedContract: nftContract,
    creditedTo: credited,
    quantity,
  };
}

export interface OpenSeaMintDeps {
  readUrl: string;
  allRpcUrls: string[];
  endpoints: Endpoint[];
  chainId: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonces: NonceManager;
  signerFor(id: string): Wallet | HDNodeWallet;
  apiKey: string;
  /** Sanity ceiling on unit price — a guard against an unexpected response. */
  maxUnitPriceWei: bigint;
  pacing: { concurrency: number; minDelayMs: number; maxRetries: number; burstFirst: number };
  /**
   * Price gas from the chain rather than from config. Defaults to on; pass
   * false to sign with the configured numbers exactly, as this used to.
   */
  autoPrice?: boolean;
}

export interface OpenSeaMintRequest {
  slug: string;
  nftContract: string;
  quantity: number;
  wallets: { id: string; address: string }[];
  /** Wall-clock instant to begin fetching. Undefined starts immediately. */
  startAt?: Date;
  /**
   * Hold until the stage actually opens, rather than firing once at `startAt`.
   *
   * Without this a scheduled burst is a single shot: if the stage opens even a
   * second later than published — or the clocks disagree — every wallet gets
   * "not currently active" and the run is over. Holding turns a near miss into
   * a wait.
   */
  waitForOpen?: boolean;
  skipUnderfunded: boolean;
  /**
   * Stage price in wei, read from the drop detail before T-0.
   *
   * Used to screen out wallets that cannot pay *before* any API call is made.
   * OpenSea refuses underfunded minters with "Insufficient balance to mint" —
   * even on free drops, since gas still has to be covered — so fetching for
   * them spends rate limit on a guaranteed rejection at the exact moment rate
   * limit is scarcest.
   */
  unitPriceHintWei?: bigint;
}

/**
 * How the pre-open hold is paced.
 *
 * The endpoint refuses to issue calldata before a stage opens, so the only way
 * to start at the instant it does is to keep asking. The cost of asking is rate
 * limit, and rate limit is scarcest at exactly the moment it matters — spending
 * it on a countdown would leave none for the burst it exists to enable.
 *
 * The published start time does most of the work: while it is far away there is
 * nothing to learn, so the hold sleeps instead of polling. Probing only tightens
 * inside the lead window, and even then it is one request for one wallet, not a
 * fetch for all of them. At the tight cadence that is under two requests a
 * second against a documented budget several times larger — deliberately
 * conservative, because being throttled at T-0 costs the drop.
 *
 * The loose cadence outside the window is not redundant: a published start time
 * can move, and a stage that opens early would otherwise be missed entirely.
 */
export const OPEN_POLL = {
  /** Stop sleeping and start probing this long before the published open. */
  leadMs: 5_000,
  /** Cadence inside the lead window, and after an unknown-time start. */
  tightMs: 600,
  /** Cadence while still far out — a guard against a start time that moves. */
  looseMs: 15_000,
  /** Never issue two probes closer together than this, whatever else says. */
  floorMs: 400,
  /** Give up this long after the stage was supposed to open. */
  graceMs: 180_000,
  /**
   * Timeout for a probe, and the ceiling it escalates to.
   *
   * Measured live at the 16:00Z open: the first probe hung and took the full
   * 8s default with it, so detection landed 9s after the stage opened rather
   * than inside a second. A probe is asking a yes/no question and is cheap to
   * repeat, so a hung one should be abandoned quickly rather than waited on.
   *
   * It escalates on consecutive timeouts because the opposite failure is worse:
   * if the endpoint is merely slow under load, a fixed short timeout would
   * abandon every attempt and never get an answer at all. Any answer resets it.
   */
  probeTimeoutMs: 2_500,
  maxProbeTimeoutMs: 8_000,
  /** Applied to the interval after a 429, and the ceiling it climbs to. */
  backoffFactor: 2,
  firstBackoffMs: 2_000,
  maxBackoffMs: 30_000,
  /**
   * How often to ask whether the drop still exists at all.
   *
   * The mint endpoint answers 404 both for a stage that has not opened and for
   * a drop that has finished, so probing alone cannot tell "wait" from "this is
   * over". Observed live: a drop sold its last tokens during an earlier stage,
   * so the stage being waited for never opened, and the hold spent 100 probes
   * across its full three-minute grace before giving up with a timeout rather
   * than a reason.
   *
   * The drop endpoint does distinguish them — it answers normally for an
   * unopened stage and 404s once the drop is gone — so one call every fifteen
   * seconds buys an accurate early exit for a fraction of the requests.
   */
  dropRecheckMs: 15_000,
};

/** Why a hold should stop waiting, or undefined to carry on. */
export async function dropEnded(apiKey: string, slug: string): Promise<string | undefined> {
  try {
    const drop = await fetchDrop(apiKey, slug);
    const total = Number(drop.total_supply ?? 0);
    const max = Number(drop.max_supply ?? 0);
    if (max > 0 && total >= max) return `the drop is minted out (${total}/${max})`;
    return undefined;
  } catch (err) {
    // Only a definitive "not here" ends the hold. A timeout or a 5xx says
    // nothing about the drop and must not cancel a wait that is otherwise fine.
    if (err instanceof OpenSeaApiError && err.status === 404) {
      return "OpenSea no longer lists this drop — it has ended or been removed";
    }
    return undefined;
  }
}

/**
 * What a refusal during the hold means for whether to keep waiting.
 *
 * `reachedOpenTime` is what makes this safe, and it is not a detail. A drop
 * usually has several stages, and OpenSea picks one server-side from the
 * minter's eligibility — so a probe sent while some *other* stage is live gets
 * a confident answer about that stage, not about the one being waited for. OMR
 * EVO had four stages with a holder claim live and the public sale still an
 * hour out; reading "not eligible" as "open" there would have fired the whole
 * set into a stage it could not mint, an hour early, and called it a day.
 *
 * So nothing observed before the target open time is conclusive. After it,
 * "not eligible" and "insufficient balance" are answers about a *wallet*, which
 * means the stage is answering: waiting longer will not change them, and the
 * burst should go ahead, since every wallet asks for itself and this prober's
 * verdict is not theirs.
 */
export function openSignal(
  kind: OpenSeaFailure | undefined,
  reachedOpenTime: boolean
): "open" | "wait" | "abort" {
  // Neither a rejected key nor a barred account is repaired by waiting, and
  // both are visible before the open — so they abort regardless of timing.
  // A restricted prober would otherwise spin out the whole grace period.
  if (kind === "auth" || kind === "account_restricted") return "abort";

  if (!reachedOpenTime) return "wait";

  switch (kind) {
    case "not_eligible":
    case "insufficient_balance":
      return "open";
    case "minted_out":
      return "abort";
    default:
      // not_live, rate_limited, server, unknown, or a transport error.
      return "wait";
  }
}

export type OpenSeaMintEvent =
  | { type: "waiting"; msRemaining: number }
  | { type: "probing"; attempt: number; msPastOpen: number; reason: string }
  | { type: "open"; attempts: number; waitedMs: number; hadCalldata: boolean }
  | { type: "priced"; maxFeeWei: bigint; tipWei: bigint; source: string; ceilingTooLow: boolean }
  | { type: "fetching"; done: number; total: number; failures: number }
  | { type: "firing"; sent: number; accepted: number; total: number; msSinceOpen: number }
  | { type: "fetched"; ok: number; failed: number; ms: number; unitPriceWei: bigint }
  | { type: "inspected"; ok: number; rejected: { address: string; reason: string }[] }
  | { type: "simulated"; gasLimit: number }
  | { type: "funding"; eligible: number; underfunded: Shortfall[]; requiredPerWallet: bigint }
  | { type: "signing"; done: number; total: number }
  | { type: "dispatched"; count: number; ms: number; wallets: PreparedTx[] }
  | { type: "receipts"; confirmed: number; reverted: number; pending: number; total: number; rows: ReceiptRow[] }
  | { type: "done"; report: OpenSeaMintReport };

export interface OpenSeaMintReport {
  slug: string;
  contract: string;
  quantity: number;
  requested: number;
  fetched: number;
  attempted: number;
  accepted: number;
  confirmed: number;
  reverted: number;
  pending: number;
  unitPriceWei: bigint;
  totalValue: bigint;
  fetchMs: number;
  dispatchMs: number;
  rows: ReceiptRow[];
  fetchFailures: { address: string; reason: string }[];
  errorSummary: { reason: string; count: number }[];
}

interface Fetched {
  id: string;
  address: string;
  tx: MintCalldata;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Wait for the stage to start answering, then hand back the calldata that
 * proved it.
 *
 * One wallet does the asking. Probing with all of them would multiply the rate
 * limit spend by the size of the set for no extra information — the endpoint is
 * either issuing calldata or it is not, and that is a property of the stage.
 *
 * Returns the prober's calldata on success, or undefined when the stage turned
 * out to be open but had nothing to give this particular wallet (not eligible,
 * or unable to pay). That is still a green light: the burst goes ahead and each
 * wallet gets its own answer.
 */
export async function holdUntilOpen(
  req: OpenSeaMintRequest,
  deps: OpenSeaMintDeps,
  prober: { id: string; address: string },
  emit: (event: OpenSeaMintEvent) => void
): Promise<Fetched | undefined> {
  const startedAt = Date.now();
  const openAt = req.startAt?.getTime();
  const deadline = (openAt ?? startedAt) + OPEN_POLL.graceMs;

  let attempts = 0;
  let backoffMs = 0;
  let probeTimeoutMs = OPEN_POLL.probeTimeoutMs;
  let lastReason = "waiting for the stage to open";

  // Fail before the wait, not after it. A drop that is already gone would
  // otherwise be discovered only once the grace period expired — potentially
  // twenty minutes of sleeping followed by three of probing, to conclude
  // something that was knowable at the start.
  const goneAtStart = await dropEnded(deps.apiKey, req.slug);
  if (goneAtStart) {
    throw new OpenSeaMintError(`Nothing to wait for — ${goneAtStart}.`);
  }
  let lastDropCheck = Date.now();

  for (;;) {
    const now = Date.now();

    if (now > deadline) {
      throw new OpenSeaMintError(
        `The stage never opened. Gave up ${Math.round((now - (openAt ?? startedAt)) / 1000)}s ` +
          `after the published start, having asked ${attempts} time(s).\n` +
          `Last answer: ${lastReason}`
      );
    }

    // While the open is still far off there is nothing to learn from asking, so
    // this sleeps rather than spending requests on a countdown.
    const untilOpen = openAt === undefined ? 0 : openAt - now;
    if (untilOpen > OPEN_POLL.leadMs) {
      emit({ type: "waiting", msRemaining: untilOpen });
      await sleep(Math.min(untilOpen - OPEN_POLL.leadMs, OPEN_POLL.looseMs));
      continue;
    }

    // Without a published time there is nothing to be early relative to, so any
    // answer counts. With one, only answers from the open onwards do.
    const reachedOpenTime = openAt === undefined || now >= openAt;

    // Past the open and still being refused: ask whether there is still a drop
    // to wait for. Only from here, because before the open a refusal is
    // expected and carries no suggestion that anything is wrong.
    if (reachedOpenTime && now - lastDropCheck >= OPEN_POLL.dropRecheckMs) {
      lastDropCheck = now;
      const gone = await dropEnded(deps.apiKey, req.slug);
      if (gone) {
        throw new OpenSeaMintError(
          `Stopped waiting after ${Math.round((now - (openAt ?? startedAt)) / 1000)}s — ${gone}.\n` +
            `Last answer from the mint endpoint: ${lastReason}`
        );
      }
    }

    attempts += 1;
    try {
      // Calldata in hand means a stage is live, eligible and priced for this
      // wallet — even if it is not the one that was being waited for. That is a
      // mint the operator asked for, and maxUnitPriceWei still gates the cost.
      const tx = await fetchMintCalldata(
        deps.apiKey,
        req.slug,
        prober.address,
        req.quantity,
        probeTimeoutMs
      );
      emit({
        type: "open",
        attempts,
        waitedMs: Date.now() - startedAt,
        hadCalldata: true,
      });
      return { id: prober.id, address: prober.address, tx };
    } catch (err) {
      const apiError = err instanceof OpenSeaApiError ? err : undefined;
      lastReason = apiError?.message ?? (err as Error).message;
      const signal = openSignal(apiError?.kind, reachedOpenTime);

      if (signal === "abort") throw apiError ?? err;

      if (signal === "open") {
        emit({ type: "open", attempts, waitedMs: Date.now() - startedAt, hadCalldata: false });
        return undefined;
      }

      // A timeout is not an answer, so the next attempt waits a little longer
      // for one. Anything the endpoint actually said resets the patience.
      if (apiError === undefined && /abort|timeout/i.test(lastReason)) {
        probeTimeoutMs = Math.min(OPEN_POLL.maxProbeTimeoutMs, Math.round(probeTimeoutMs * 1.6));
      } else {
        probeTimeoutMs = OPEN_POLL.probeTimeoutMs;
      }

      // Only a throttle earns a longer gap. Backing off on "not currently
      // active" would walk the cadence away from the open it is waiting for.
      if (apiError?.kind === "rate_limited") {
        backoffMs = Math.min(
          OPEN_POLL.maxBackoffMs,
          backoffMs === 0 ? OPEN_POLL.firstBackoffMs : backoffMs * OPEN_POLL.backoffFactor
        );
      } else {
        backoffMs = 0;
      }

      const nextInMs = Math.max(OPEN_POLL.floorMs, backoffMs || OPEN_POLL.tightMs);
      emit({
        type: "probing",
        attempt: attempts,
        msPastOpen: openAt === undefined ? Date.now() - startedAt : Date.now() - openAt,
        reason: lastReason,
      });
      await sleep(nextInMs);
    }
  }
}

export async function executeOpenSeaMint(
  req: OpenSeaMintRequest,
  deps: OpenSeaMintDeps,
  emit: (event: OpenSeaMintEvent) => void
): Promise<OpenSeaMintReport> {
  if (req.wallets.length === 0) throw new OpenSeaMintError("No wallets selected.");

  // Everything that can be done before T-0 is done before T-0. The API call is
  // the only thing that genuinely cannot move.
  await warmSockets(deps.allRpcUrls);
  await deps.nonces.prime(req.wallets);

  // ── Screen out wallets OpenSea would refuse anyway ──
  //
  // Done here, before the hold, so the T-0 burst carries only wallets that can
  // actually mint. The estimate uses the configured gas limit; the real one
  // comes back from simulation later and is usually smaller.
  const preflightRequired = requiredPerWallet(
    deps.gasLimit,
    deps.maxFeePerGas,
    (req.unitPriceHintWei ?? 0n) * BigInt(req.quantity)
  );
  const preflightBalances = await fetchBalances(deps.readUrl, req.wallets);
  const preflightShort = shortfalls(req.wallets, preflightBalances, preflightRequired);
  const affordable = req.wallets.filter((w) => !preflightShort.some((s) => s.id === w.id));

  emit({
    type: "funding",
    eligible: affordable.length,
    underfunded: preflightShort,
    requiredPerWallet: preflightRequired,
  });

  if (preflightShort.length > 0 && !req.skipUnderfunded) {
    throw new OpenSeaMintError(
      `${preflightShort.length} of ${req.wallets.length} wallets hold less than ` +
        `${formatEther(preflightRequired)} ETH. OpenSea refuses underfunded minters outright, ` +
        "so they would be rejected rather than merely failing later."
    );
  }
  if (affordable.length === 0) {
    throw new OpenSeaMintError(
      `Every wallet holds less than ${formatEther(preflightRequired)} ETH. ` +
        "OpenSea will not issue calldata to a wallet that cannot cover the mint and its gas — " +
        "fund them first."
    );
  }

  // ── Hold for the stage ──
  //
  // Two modes. Scheduled-only sleeps to the instant and fires once, which is
  // right when the time is known to be right. Holding keeps asking until the
  // endpoint actually answers, which is right when it might not be.
  //
  // Either way the last stretch before the fire belongs to two jobs that must
  // not happen at T-0: pricing gas from the chain, and re-opening the sockets.
  // The agent's keep-alive is fifteen seconds, so a hold of any real length
  // leaves every connection closed and would otherwise spend the opening
  // moment of the drop on TLS handshakes.
  let fees: FeeQuote = {
    maxFeePerGas: deps.maxFeePerGas,
    maxPriorityFeePerGas: deps.maxPriorityFeePerGas,
    baseFeeWei: 0n,
    source: "config",
    ceilingTooLow: false,
  };

  const reprice = async (): Promise<void> => {
    if (deps.autoPrice !== false) {
      fees = await sampleFees(deps.readUrl, {
        ceilingWei: deps.maxFeePerGas,
        priorityFloorWei: deps.maxPriorityFeePerGas,
      });
    }
    emit({
      type: "priced",
      maxFeeWei: fees.maxFeePerGas,
      tipWei: fees.maxPriorityFeePerGas,
      source: fees.source,
      ceilingTooLow: fees.ceilingTooLow,
    });
    await warmSockets(deps.allRpcUrls);
  };

  await reprice();

  let seeded: Fetched | undefined;
  if (req.waitForOpen) {
    seeded = await holdUntilOpen(req, deps, affordable[0], emit);
  } else if (req.startAt && req.startAt.getTime() > Date.now()) {
    const fireAt = req.startAt.getTime();
    emit({ type: "waiting", msRemaining: fireAt - Date.now() });
    // Re-price and re-warm on the near side of the fire, then sleep the rest.
    if (fireAt - Date.now() > PREFIRE_LEAD_MS) {
      await sleepUntil(fireAt - PREFIRE_LEAD_MS);
      await reprice();
    }
    await sleepUntil(fireAt);
  }

  // ── Fetch, sign and fire, one wallet at a time, all at once ──
  //
  // This used to be four phases with a barrier between each: fetch every
  // wallet's calldata, inspect every response, simulate one, then sign and
  // dispatch the lot. Every wallet therefore waited for the slowest, and on
  // 2026-09-02 that cost a drop outright — the collection sold out two seconds
  // after opening while the seventh wallet's calldata request had not yet been
  // allowed to start, and the run ended having sent nothing at all.
  //
  // So there is no barrier now. A wallet that has its calldata is inspected,
  // simulated, signed and put on the wire immediately, while its neighbours are
  // still waiting on OpenSea. The first transaction leaves at roughly the
  // latency of a single API call rather than at the sum of all of them.
  const fetchStart = process.hrtime.bigint();
  const firedFrom = Date.now();
  const fetched: Fetched[] = [];
  const fetchFailures: { address: string; reason: string }[] = [];
  const rejected: { address: string; reason: string }[] = [];
  const prepared: PreparedTx[] = [];
  const outcomes: DispatchOutcome[] = [];

  // Settled by whichever wallet simulates first; the rest reuse it rather than
  // each paying a round trip to learn the same number.
  let gasLimit = deps.gasLimit;
  let gasLimitSettled = false;

  // The price ceiling is the one failure that must stop every wallet, not just
  // its own — it exists to catch a drop that is not what was booked.
  let priceAbort: string | undefined;
  let unitPrice = req.unitPriceHintWei ?? 0n;

  // Endpoint sharding is by send order, so it is claimed at the send rather
  // than fixed up front: the burst no longer exists as an array beforehand.
  let shard = 0;
  let dispatchStarted = 0n;
  let dispatchEnded = 0n;

  const jobs: { id: string; address: string; tx?: MintCalldata }[] = affordable.map((w) =>
    seeded && w.id === seeded.id
      ? { id: w.id, address: w.address, tx: seeded.tx }
      : { id: w.id, address: w.address }
  );
  // A wallet whose calldata the probe already fetched goes first — it can be on
  // the wire before anyone else has finished asking.
  jobs.sort((a, b) => (b.tx ? 1 : 0) - (a.tx ? 1 : 0));

  let cursor = 0;
  let lastStart = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (priceAbort) return;
      const index = cursor++;
      if (index >= jobs.length) return;
      const job = jobs[index];

      // ── Calldata ──
      let tx = job.tx;
      if (!tx) {
        // Pacing protects a per-minute rate budget, and spending that budget
        // evenly is precisely wrong for a race decided in the first seconds.
        // The opening wallets go together; the tail is paced as it always was.
        if (index >= deps.pacing.burstFirst) {
          const slot = Math.max(Date.now(), lastStart + deps.pacing.minDelayMs);
          lastStart = slot;
          const wait = slot - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }

        let attempt = 0;
        for (;;) {
          try {
            tx = await fetchMintCalldata(deps.apiKey, req.slug, job.address, req.quantity);
            break;
          } catch (err) {
            const apiError = err instanceof OpenSeaApiError ? err : undefined;
            attempt += 1;
            if (!apiError?.retryable || attempt > deps.pacing.maxRetries) {
              fetchFailures.push({
                address: job.address,
                reason: apiError?.message ?? (err as Error).message,
              });
              break;
            }
            const base = apiError.kind === "rate_limited" ? 1500 : 400;
            await new Promise((r) => setTimeout(r, Math.min(20_000, base * 2 ** (attempt - 1))));
          }
        }
        if (!tx) {
          done += 1;
          continue;
        }
      }

      fetched.push({ id: job.id, address: job.address, tx });

      // ── Price ──
      //
      // OpenSea prices the stage; take it from the response rather than
      // guessing. Over the ceiling stops the whole run, because a price that is
      // not the booked one means this is not the drop that was agreed to.
      const unit = tx.value / BigInt(req.quantity || 1);
      unitPrice = unit;
      if (unit > deps.maxUnitPriceWei) {
        priceAbort =
          `Unit price ${formatEther(unit)} ETH exceeds the ` +
          `${formatEther(deps.maxUnitPriceWei)} ETH ceiling in caps.maxPriceEth. ` +
          "Nothing further was sent — raise the cap if this is expected.";
        return;
      }

      // ── Inspect ──
      const check = inspectCalldata(tx, req.nftContract, job.address);
      if (!check.ok) {
        rejected.push({ address: job.address, reason: check.reason ?? "failed inspection" });
        done += 1;
        continue;
      }

      // ── Simulate ──
      //
      // Per wallet, and fatal only to that wallet. A single shared probe used
      // to gate the entire batch: when it reverted — sold out, or that one
      // address not eligible — every other wallet was abandoned unsent, however
      // healthy. One revert is now one wallet.
      const sim = await simulate(deps.readUrl, {
        from: job.address,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      if (!sim.ok) {
        rejected.push({
          address: job.address,
          reason: `simulation reverted — ${sim.reason ?? "no reason given"}`,
        });
        done += 1;
        continue;
      }
      if (!gasLimitSettled && sim.gasEstimate) {
        gasLimit = Math.max(Number((sim.gasEstimate * 13n) / 10n), deps.gasLimit);
        gasLimitSettled = true;
        emit({ type: "simulated", gasLimit });
      }

      // ── Sign and fire ──
      //
      // No balance re-read here on purpose. Pre-flight already screened every
      // wallet against the configured gas limit and the stage price, and a
      // second batched read at this point would put a round trip between the
      // calldata and the wire for no outcome the node will not tell us anyway.
      const raw = await deps.signerFor(job.id).signTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        nonce: deps.nonces.next(job.address),
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        type: 2,
        chainId: deps.chainId,
      });
      const ptx = prepareTx(job.id, job.address, raw);
      prepared.push(ptx);

      if (dispatchStarted === 0n) dispatchStarted = process.hrtime.bigint();
      const outcome = await dispatchOne(ptx, endpointTargets(shard++, deps.endpoints));
      dispatchEnded = process.hrtime.bigint();
      outcomes.push(outcome);
      if (!outcome.accepted) deps.nonces.rollback(job.address);

      done += 1;
      emit({
        type: "firing",
        sent: outcomes.length,
        accepted: outcomes.filter((o) => o.accepted).length,
        total: jobs.length,
        msSinceOpen: Date.now() - firedFrom,
      });
      emit({ type: "fetching", done, total: jobs.length, failures: fetchFailures.length });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(deps.pacing.concurrency, Math.max(1, jobs.length))) },
      () => worker()
    )
  );

  const fetchMs = Number(process.hrtime.bigint() - fetchStart) / 1e6;

  if (priceAbort && outcomes.length === 0) throw new OpenSeaMintError(priceAbort);
  if (fetched.length === 0) {
    throw new OpenSeaMintError(
      `No calldata obtained for any of ${req.wallets.length} wallet(s).\n` +
        (fetchFailures[0]?.reason ?? "")
    );
  }
  if (prepared.length === 0) {
    throw new OpenSeaMintError(
      `Nothing could be sent. ${
        rejected[0]?.reason ?? fetchFailures[0]?.reason ?? "every wallet was refused"
      }`
    );
  }

  emit({
    type: "fetched",
    ok: fetched.length,
    failed: fetchFailures.length,
    ms: fetchMs,
    unitPriceWei: unitPrice,
  });
  emit({ type: "inspected", ok: prepared.length, rejected });

  const accepted = outcomes.filter((o) => o.accepted).length;
  const report = {
    outcomes,
    accepted,
    rejected: outcomes.length - accepted,
    dispatchMs: dispatchStarted === 0n ? 0 : Number(dispatchEnded - dispatchStarted) / 1e6,
  };
  emit({ type: "dispatched", count: prepared.length, ms: report.dispatchMs, wallets: prepared });

  const totalValue = unitPrice * BigInt(req.quantity) * BigInt(report.accepted);
  if (report.accepted > 0) {
    record({
      kind: "mint",
      chainId: deps.chainId,
      contract: req.nftContract,
      walletIds: report.outcomes.filter((o) => o.accepted).map((o) => o.id),
      quantity: req.quantity,
      valueWei: totalValue.toString(),
      fromBlock: await currentBlock(deps.readUrl),
      note: `opensea ${req.slug}`,
    });
  }

  const rows = await collectReceipts(
    deps.readUrl,
    report.outcomes.filter((o) => o.accepted),
    (confirmed, reverted, pending, total, rows) =>
      emit({ type: "receipts", confirmed, reverted, pending, total, rows })
  );
  for (const outcome of report.outcomes) {
    if (outcome.accepted) continue;
    rows.push({ id: outcome.id, address: outcome.address, hash: outcome.hash, status: "reverted" });
  }

  const final: OpenSeaMintReport = {
    slug: req.slug,
    contract: req.nftContract,
    quantity: req.quantity,
    requested: req.wallets.length,
    fetched: fetched.length,
    attempted: prepared.length,
    accepted: report.accepted,
    confirmed: rows.filter((r) => r.status === "confirmed").length,
    reverted: rows.filter((r) => r.status === "reverted").length,
    pending: rows.filter((r) => r.status === "pending").length,
    unitPriceWei: unitPrice,
    totalValue,
    fetchMs,
    dispatchMs: report.dispatchMs,
    rows,
    fetchFailures: [...fetchFailures, ...rejected],
    errorSummary: summariseErrors(report.outcomes),
  };
  emit({ type: "done", report: final });
  return final;
}

async function currentBlock(readUrl: string): Promise<number | undefined> {
  try {
    return Number(BigInt(await rpcCall<string>(readUrl, "eth_blockNumber", [])));
  } catch {
    return undefined;
  }
}
