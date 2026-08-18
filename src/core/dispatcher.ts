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

export interface DispatchOptions {
  timeoutMs?: number;
  /** Called once all bytes are on the wire, before any response is read. */
  onDispatched?: (count: number, ms: number) => void;
  /** Called as each transaction's responses settle. */
  onSettled?: (outcome: DispatchOutcome, done: number, total: number) => void;
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
  const inFlight = txs.map((tx, i) => {
    const targets = targetsFor(i, sequencers, providers);
    const posts = targets.map((ep) =>
      post(ep.url, tx.body, timeoutMs).then(
        (res) => ({ ep, res, err: null as Error | null }),
        (err: Error) => ({ ep, res: null, err })
      )
    );
    return { tx, posts };
  });

  const dispatchMs = Number(process.hrtime.bigint() - started) / 1e6;
  opts.onDispatched?.(txs.length, dispatchMs);

  let done = 0;
  const outcomes = await Promise.all(
    inFlight.map(async ({ tx, posts }) => {
      const settled = await Promise.all(posts);
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

      const outcome: DispatchOutcome = {
        id: tx.id,
        address: tx.address,
        hash: tx.hash,
        accepted: acceptedBy.length > 0,
        acceptedBy,
        errors,
      };
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
