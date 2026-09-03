// Transaction dispatch at 500-wallet scale.
//
// The CLI's blastToAll() sends every transaction to every endpoint. That is the
// right shape for five wallets and the wrong one for five hundred: 500 × 3
// endpoints is 1,500 POSTs in a burst, and metered providers price
// eth_sendRawTransaction high enough that a free tier would take minutes to
// accept them all.
//
// On an OP-Stack chain the sequencer *is* the mempool, so extra endpoints buy
// redundancy against one host failing, not faster inclusion. Hence: every tx to
// the sequencer, plus exactly one backup provider chosen round-robin. Total
// requests fall from wallets × endpoints to wallets × 2, and no single metered
// provider sees more than wallets ÷ providers.

import { keccak256 } from "ethers";
import { post, hostOf } from "./rpc";

export type EndpointKind = "sequencer" | "provider";

export interface Endpoint {
  url: string;
  label: string;
  kind: EndpointKind;
}

export interface PreparedTx {
  id: string;
  address: string;
  /** Computed locally — no round-trip needed to know the hash. */
  hash: string;
  /** Fully serialised request body, built before the fire moment. */
  body: string;
}

export interface DispatchOutcome {
  id: string;
  address: string;
  hash: string;
  accepted: boolean;
  acceptedBy: string[];
  errors: string[];
}

export interface DispatchReport {
  outcomes: DispatchOutcome[];
  dispatchMs: number;
  accepted: number;
  rejected: number;
}

function labelFor(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("sequencer")) return `${hostOf(url)} (sequencer)`;
  if (lower.includes("alchemy")) return "alchemy";
  if (lower.includes("quicknode")) return "quicknode";
  if (lower.includes("infura")) return "infura";
  if (lower.includes("ankr")) return "ankr";
  if (lower.includes("publicnode")) return "publicnode";
  return hostOf(url);
}

/**
 * Sequencer endpoints are identified by hostname. Every OP-Stack chain in
 * chains.ts publishes one, and it is the only endpoint whose acceptance
 * actually decides inclusion.
 */
export function classifyEndpoints(urls: string[]): Endpoint[] {
  return urls.map((url) => ({
    url,
    label: labelFor(url),
    kind: url.toLowerCase().includes("sequencer") ? "sequencer" : "provider",
  }));
}

/** All compute done ahead of the fire moment: hash, JSON, byte length. */
export function prepareTx(id: string, address: string, rawTx: string): PreparedTx {
  return {
    id,
    address,
    hash: keccak256(rawTx),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: [rawTx],
      id: 1,
    }),
  };
}

/**
 * A node that already holds *this* transaction is a success, not a failure —
 * it is the same bytes arriving twice, which is exactly what fanning out to a
 * sequencer and a backup provider produces.
 *
 * "nonce too low" is a different animal and was wrongly counted here. It does
 * not mean the node has this transaction; it means that nonce was already
 * consumed by a *different* one, so ours was rejected and will never mine.
 * Counting it as accepted reported successful mints that never happened, and
 * skipped the nonce rollback that would have resynced the wallet.
 */
export function isBenign(message: string): boolean {
  return /already known|already exists|known transaction/i.test(message);
}

function targetsFor(index: number, sequencers: Endpoint[], providers: Endpoint[]): Endpoint[] {
  const targets = [...sequencers];
  if (providers.length > 0) targets.push(providers[index % providers.length]);
  // With no sequencer configured the providers are all we have, so fall back to
  // one provider rather than sending nothing.
  return targets.length > 0 ? targets : providers.slice(0, 1);
}

/**
 * Where the nth transaction of a burst should go.
 *
 * Exported because a pipelined mint no longer has the whole burst in hand when
 * it sends the first one — it fires each wallet the moment that wallet is ready
 * — but the sharding rule must stay identical either way, or one provider ends
 * up carrying every transaction.
 */
export function endpointTargets(index: number, endpoints: Endpoint[]): Endpoint[] {
  return targetsFor(
    index,
    endpoints.filter((e) => e.kind === "sequencer"),
    endpoints.filter((e) => e.kind === "provider")
  );
}

export interface DispatchOptions {
  timeoutMs?: number;
  /** Called once all bytes are on the wire, before any response is read. */
  onDispatched?: (count: number, ms: number) => void;
  /** Called as each transaction's responses settle. */
  onSettled?: (outcome: DispatchOutcome, done: number, total: number) => void;
}

/**
 * One transaction, to its shard of the endpoints.
 *
 * Every POST is created before the first await, so calling this in a loop still
 * puts the whole burst on the wire before any response is read — the property
 * dispatchAll was written for, now available to callers that build their burst
 * incrementally.
 */
export function dispatchOne(
  tx: PreparedTx,
  targets: Endpoint[],
  timeoutMs = 15_000
): Promise<DispatchOutcome> {
  const posts = targets.map((ep) =>
    post(ep.url, tx.body, timeoutMs).then(
      (res) => ({ ep, res, err: null as Error | null }),
      (err: Error) => ({ ep, res: null, err })
    )
  );

  return Promise.all(posts).then((settled) => {
    const acceptedBy: string[] = [];
    const errors: string[] = [];

    for (const { ep, res, err } of settled) {
      if (err || !res) {
        errors.push(`${ep.label}: ${err?.message ?? "no response"}`);
        continue;
      }
      try {
        const json = JSON.parse(res.text) as {
          result?: string;
          error?: { message?: string };
        };
        if (json.result) {
          acceptedBy.push(ep.label);
        } else if (json.error) {
          const message = json.error.message ?? "unknown error";
          if (isBenign(message)) acceptedBy.push(`${ep.label} (already known)`);
          else errors.push(`${ep.label}: ${message}`);
        } else {
          errors.push(`${ep.label}: empty response`);
        }
      } catch {
        errors.push(`${ep.label}: HTTP ${res.status} (non-JSON)`);
      }
    }

    return {
      id: tx.id,
      address: tx.address,
      hash: tx.hash,
      accepted: acceptedBy.length > 0,
      acceptedBy,
      errors,
    };
  });
}

export async function dispatchAll(
  txs: PreparedTx[],
  endpoints: Endpoint[],
  opts: DispatchOptions = {}
): Promise<DispatchReport> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const sequencers = endpoints.filter((e) => e.kind === "sequencer");
  const providers = endpoints.filter((e) => e.kind === "provider");

  const started = process.hrtime.bigint();

  // Every request is initiated before anything is awaited — this loop is the
  // critical path and must not block on a response.
  const inFlight = txs.map((tx, i) =>
    dispatchOne(tx, targetsFor(i, sequencers, providers), timeoutMs)
  );

  const dispatchMs = Number(process.hrtime.bigint() - started) / 1e6;
  opts.onDispatched?.(txs.length, dispatchMs);

  let done = 0;
  const outcomes = await Promise.all(
    inFlight.map(async (pending) => {
      const outcome = await pending;
      done += 1;
      opts.onSettled?.(outcome, done, txs.length);
      return outcome;
    })
  );

  const accepted = outcomes.filter((o) => o.accepted).length;
  return {
    outcomes,
    dispatchMs,
    accepted,
    rejected: outcomes.length - accepted,
  };
}

/** Distinct failure reasons, for reporting without repeating the same line 400×. */
/**
 * One node rejection, in words the wallet's owner can act on.
 *
 * Nodes answer in their own dialects — "insufficient funds for gas * price +
 * value", "gas required exceeds allowance", "INSUFFICIENT_FUNDS" — and the raw
 * string went straight to the operator, who then had to know that the first of
 * those means "put some ETH in that wallet". Every branch here names the wallet's
 * problem, not the node's opinion of it.
 *
 * Anything unrecognised is returned trimmed rather than replaced: a wrong plain
 * sentence is worse than an accurate technical one.
 */
export function explainRejection(errors: string[]): string {
  const text = errors.join(" | ").toLowerCase();

  // Underscores as well as spaces: some sequencers answer with the bare enum
  // name (INSUFFICIENT_FUNDS) rather than a sentence, and that is exactly the
  // rejection an owner most needs translated.
  if (/insufficient[ _](funds|balance)|doesn't have enough funds/.test(text)) {
    return "Not enough ETH for gas";
  }
  if (/nonce too low|already used|nonce has already been used/.test(text)) {
    return "Nonce already used — another transaction got there first";
  }
  if (/replacement transaction underpriced|already have|same hash/.test(text)) {
    return "A transaction from this wallet was already in the queue";
  }
  if (/underpriced|fee too low|max fee per gas less than|tip too low/.test(text)) {
    return "Gas price too low for the network right now";
  }
  if (/execution reverted|revert/.test(text)) {
    return "The mint was rejected by the contract — usually sold out or not eligible";
  }
  if (/exceeds block gas limit|gas limit|intrinsic gas/.test(text)) {
    return "Gas limit rejected by the network";
  }
  if (/timeout|timed out|socket|econnreset|network|fetch failed/.test(text)) {
    return "The network did not answer in time";
  }
  if (/rate limit|too many requests|-32007|429/.test(text)) {
    return "The RPC provider rate-limited this send";
  }

  const first = errors[0]?.replace(/^[^:]+:\s*/, "").trim();
  return first && first.length > 0 ? first.slice(0, 120) : "Rejected without a reason";
}

export function summariseErrors(outcomes: DispatchOutcome[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.accepted) continue;
    for (const error of outcome.errors) {
      // Strip the endpoint label so the same underlying cause groups together.
      const reason = error.replace(/^[^:]+:\s*/, "");
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}
