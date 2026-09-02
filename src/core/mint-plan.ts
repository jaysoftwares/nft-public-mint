// What can be minted here, by which of your wallets, and when.
//
// The bot could already mint three different ways — a SeaDrop public stage read
// off the chain, a SeaDrop allowlist proved against a merkle root, and whatever
// OpenSea decides a wallet is entitled to — and each one was a separate command
// with its own argument order. Choosing between them was the operator's job, at
// the moment a stage was opening, from memory.
//
// This is the model behind a single screen that makes that choice instead: every
// stage either source can see, in one list, with a verdict per wallet against
// each. It is deliberately pure — no network, no Telegram — because the decisions
// worth getting right are all here: which stage a refusal actually condemns, and
// which stage to arm when several are live.
//
// The one rule that matters most: a refusal from a stage that has not opened yet
// says nothing about the wallet. OpenSea will not build a transaction for an
// upcoming phase however entitled the minter is, so treating that "no" as
// ineligibility hides exactly the allowlist places somebody bought a wallet for.

import type { OpenSeaFailure } from "./opensea-api";

export type StageKind = "public" | "allowlist" | "signed";

/**
 * Who told us about this stage.
 *
 * It decides the executor, not just the provenance: `chain` stages are readable
 * and pre-signable ahead of the open, `opensea` stages cannot be fetched until
 * the stage is live and therefore have to be raced at T-0.
 */
export type StageSource = "chain" | "opensea";

export interface MintStage {
  /**
   * Short, stable handle used in Telegram callback data.
   *
   * Callback payloads cap at 64 bytes, which a uuid plus a prefix already
   * strains, so stages are addressed by position — `c0` for the chain's own,
   * `o0`, `o1`… for OpenSea's, in the order they were merged.
   */
  key: string;
  label: string;
  kind: StageKind;
  source: StageSource;
  priceWei: bigint;
  /** Epoch ms. Absent when the source published none. */
  startsAt?: number;
  endsAt?: number;
  perWallet?: number;
}

export type StageState = "live" | "upcoming" | "ended";

/**
 * A stage with no times at all counts as live.
 *
 * That is the shape of a bare ERC-721 whose sale is a boolean the contract keeps
 * to itself: there is nothing to wait for and nothing to have missed, so the
 * only useful reading is "try it". A stage with a start and no end stays live
 * once it opens, which is what an open-ended public mint is.
 */
export function stageState(stage: MintStage, now: number): StageState {
  if (stage.endsAt !== undefined && stage.endsAt <= now) return "ended";
  if (stage.startsAt !== undefined && stage.startsAt > now) return "upcoming";
  return "live";
}

export function isLive(stage: MintStage, now: number): boolean {
  return stageState(stage, now) === "live";
}

// ── Eligibility ───────────────────────────────────────────────────────────

/**
 * One wallet's standing against one stage.
 *
 * `unknown` is a real answer and not a failure — it is what an unopened gated
 * stage can honestly say — so it is never rendered as a refusal.
 */
export type Eligibility =
  | "eligible"
  | "ineligible"
  | "minted_out"
  | "underfunded"
  | "restricted"
  | "checking"
  | "unknown";

/** Verdicts that mean this wallet can be fired at this stage. */
export function canFire(verdict: Eligibility | undefined): boolean {
  return verdict === "eligible";
}

/**
 * Verdicts that will not change by asking again.
 *
 * Used to decide what is worth re-probing: a wallet OpenSea has barred, or a
 * drop that is sold out, is a settled fact and spending rate limit on it takes
 * budget away from the wallets whose answer might actually move.
 */
export function isSettled(verdict: Eligibility | undefined): boolean {
  return verdict === "eligible" || verdict === "minted_out" || verdict === "restricted";
}

export interface IssuanceVerdict {
  available: boolean;
  kind?: OpenSeaFailure;
}

/**
 * Turn OpenSea's answer into a verdict about this wallet.
 *
 * The `live` argument is the whole subtlety. OpenSea's mint endpoint refuses to
 * build a transaction for a stage that has not opened, and it does not always
 * refuse with a reason that names the stage — so a refusal collected before the
 * open is evidence about the clock, not about the minter. Reading it as
 * ineligibility is how a wallet that is genuinely on the allowlist gets painted
 * ❌ on the one screen the operator uses to decide which wallets to fund.
 *
 * Three answers survive that rule, because none of them is about timing:
 * exhausted supply, a wallet that cannot cover the mint, and an address OpenSea
 * has barred from trading outright.
 */
export function classifyIssuance(probe: IssuanceVerdict, live: boolean): Eligibility {
  if (probe.available) return "eligible";

  switch (probe.kind) {
    case "minted_out":
      return "minted_out";
    case "insufficient_balance":
      return "underfunded";
    case "account_restricted":
      return "restricted";
    case "not_eligible":
      // Address-specific, but only trustworthy once OpenSea has actually had
      // the chance to build the transaction and declined.
      return live ? "ineligible" : "unknown";
    default:
      // not_live, rate_limited, server, auth, unknown — all say nothing about
      // whether this wallet is on the list.
      return "unknown";
  }
}

/** The merkle allowlist answers for every wallet at once, and is authoritative. */
export function classifyProof(onList: boolean): Eligibility {
  return onList ? "eligible" : "ineligible";
}

// ── Stage assembly ────────────────────────────────────────────────────────

export interface ChainStageFacts {
  kind: StageKind;
  label: string;
  priceWei: bigint;
  startsAt?: number;
  endsAt?: number;
  perWallet?: number;
}

export interface OpenSeaStageFacts {
  label: string;
  kind: StageKind;
  priceWei: bigint;
  startsAt?: number;
  endsAt?: number;
  perWallet?: number;
}

export interface StageSet {
  stages: MintStage[];
  /** Disagreements worth showing before anybody agrees to spend. */
  notes: string[];
}

/** More than a minute apart is two different stages, not two clocks. */
const DRIFT_TOLERANCE_MS = 60_000;

/**
 * One list from both readings, with the chain winning where they overlap.
 *
 * The contract is the code that will run, so where it publishes a public stage
 * that is the public stage — OpenSea's copy of it is dropped rather than shown
 * twice, and any disagreement about price or opening time is stated instead of
 * silently resolved. A published time the contract does not share is the single
 * most useful thing this screen can point at: firing at the announced minute
 * against a contract that opens later buys nothing and pays gas for the
 * privilege.
 *
 * Gated stages are never deduplicated. A SeaDrop allowlist proved against an
 * on-chain root and an OpenSea presale are different doors with different
 * executors, and the operator may well be through one and not the other.
 */
export function buildStages(input: {
  chain?: ChainStageFacts[];
  openSea?: OpenSeaStageFacts[];
}): StageSet {
  const notes: string[] = [];
  const stages: MintStage[] = [];

  const chainStages = input.chain ?? [];
  chainStages.forEach((facts, index) => {
    stages.push({ key: `c${index}`, source: "chain", ...facts });
  });

  const chainPublic = chainStages.find((s) => s.kind === "public");

  (input.openSea ?? []).forEach((facts, index) => {
    if (chainPublic && facts.kind === "public") {
      if (facts.priceWei !== chainPublic.priceWei) {
        notes.push(
          `OpenSea lists this public stage at ${weiText(facts.priceWei)} ETH; the contract ` +
            `charges ${weiText(chainPublic.priceWei)} ETH. You pay the contract's price.`
        );
      }
      if (
        facts.startsAt !== undefined &&
        chainPublic.startsAt !== undefined &&
        Math.abs(facts.startsAt - chainPublic.startsAt) > DRIFT_TOLERANCE_MS
      ) {
        notes.push(
          `OpenSea publishes an opening time the contract does not share ` +
            `(${clockText(facts.startsAt)} vs ${clockText(chainPublic.startsAt)} UTC). ` +
            `The contract is what runs.`
        );
      }
      return;
    }
    stages.push({ key: `o${index}`, source: "opensea", ...facts });
  });

  return { stages, notes };
}

function weiText(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function clockText(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

// ── Choosing which stage to arm ───────────────────────────────────────────

/**
 * The stage this card should be pointing at.
 *
 * A live stage somebody is provably eligible for wins, cheapest first — that is
 * the one that can be fired this second. Failing that, a live stage nobody has
 * been refused from, because "unknown" on an open stage is worth a try and
 * being narrowed to public by an inconclusive probe is how an allowlist place
 * goes unused. Only then does it look forward, to the soonest upcoming stage
 * with an eligible wallet, and finally to the soonest stage of any kind.
 *
 * Never returns an ended stage unless every stage has ended, in which case
 * there is nothing else to show.
 */
export function pickStage(
  stages: MintStage[],
  now: number,
  verdictOf: (stage: MintStage) => Eligibility | undefined
): MintStage | undefined {
  if (stages.length === 0) return undefined;

  const open = stages.filter((s) => stageState(s, now) === "live");
  const ahead = stages
    .filter((s) => stageState(s, now) === "upcoming")
    .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));

  const byPrice = (list: MintStage[]): MintStage[] =>
    list.slice().sort((a, b) => (a.priceWei < b.priceWei ? -1 : a.priceWei > b.priceWei ? 1 : 0));

  const liveEligible = byPrice(open.filter((s) => canFire(verdictOf(s))));
  if (liveEligible[0]) return liveEligible[0];

  const liveOpen = byPrice(
    open.filter((s) => {
      const verdict = verdictOf(s);
      return verdict === undefined || verdict === "unknown" || verdict === "checking";
    })
  );
  if (liveOpen[0]) return liveOpen[0];

  const aheadEligible = ahead.find((s) => canFire(verdictOf(s)));
  if (aheadEligible) return aheadEligible;

  if (ahead[0]) return ahead[0];
  if (open[0]) return open[0];
  return stages[0];
}

// ── Selections ────────────────────────────────────────────────────────────

export interface WalletFacts {
  id: string;
  balanceWei?: bigint;
}

export interface SelectionSummary {
  selected: number;
  eligible: number;
  unknown: number;
  refused: number;
  funded: number;
  short: number;
  requiredPerWalletWei: bigint;
  totalWei: bigint;
}

/**
 * What the operator is about to agree to, counted rather than described.
 *
 * The two failure modes this exists to surface are the ones that produce a
 * screen full of green and a mint that buys nothing: wallets that are eligible
 * but cannot cover the price plus gas, and a total that is not the per-wallet
 * price the card has been showing all along. `0.008 ETH` and `0.008 × 120
 * wallets` are very different agreements.
 */
export function summariseSelection(
  wallets: WalletFacts[],
  verdicts: Map<string, Eligibility | undefined>,
  requiredPerWalletWei: bigint
): SelectionSummary {
  let eligible = 0;
  let unknown = 0;
  let refused = 0;
  let funded = 0;
  let short = 0;

  for (const wallet of wallets) {
    const verdict = verdicts.get(wallet.id);
    if (canFire(verdict)) eligible++;
    else if (verdict === undefined || verdict === "unknown" || verdict === "checking") unknown++;
    else refused++;

    // An unread balance is not a shortfall — the funding check inside each
    // executor is authoritative, and guessing here would strike wallets off the
    // list for the crime of not having been polled yet.
    if (wallet.balanceWei === undefined) continue;
    if (wallet.balanceWei >= requiredPerWalletWei) funded++;
    else short++;
  }

  return {
    selected: wallets.length,
    eligible,
    unknown,
    refused,
    funded,
    short,
    requiredPerWalletWei,
    totalWei: requiredPerWalletWei * BigInt(wallets.length),
  };
}

// ── Paging ────────────────────────────────────────────────────────────────

export interface Page<T> {
  items: T[];
  offset: number;
  pageSize: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * One screenful of a five-hundred-wallet list.
 *
 * An offset past the end is clamped rather than refused: the set shrinks under
 * the card whenever a wallet is imported or the filter changes, and a page
 * button that answers with an empty screen reads as a broken bot.
 */
export function paginate<T>(items: T[], offset: number, pageSize: number): Page<T> {
  const size = Math.max(1, pageSize);
  const start = items.length === 0 ? 0 : Math.min(Math.max(0, offset), Math.max(0, items.length - 1));
  const aligned = Math.floor(start / size) * size;
  return {
    items: items.slice(aligned, aligned + size),
    offset: aligned,
    pageSize: size,
    total: items.length,
    hasPrev: aligned > 0,
    hasNext: aligned + size < items.length,
  };
}
