// JSON-RPC transport for the bot.
//
// Deliberately not `fetch`: dispatching 500 transactions means 500+ POSTs inside
// a few hundred milliseconds, and that needs an explicit keep-alive pool with a
// socket ceiling. node:http(s) Agents give that; the global fetch does not
// expose it. Sockets are also warmed before a mint so TLS handshakes happen
// while there is time to spare rather than at T-0.
//
// Batching matters just as much: reconciling 500 nonces is one POST carrying a
// 500-element array, not 500 round-trips.

import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

const AGENT_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 256,
  maxFreeSockets: 64,
  timeout: 30_000,
};

const httpsAgent = new https.Agent(AGENT_OPTS);
const httpAgent = new http.Agent(AGENT_OPTS);

function agentFor(url: URL): http.Agent | https.Agent {
  return url.protocol === "http:" ? httpAgent : httpsAgent;
}

export interface PostResult {
  status: number;
  text: string;
}

export class RpcError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** One POST with a pre-serialised body. The hot path calls this and nothing else. */
export function post(url: string, body: string, timeoutMs = 10_000): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new RpcError(`Malformed RPC url: ${url}`));
      return;
    }

    const lib = target.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        agent: agentFor(target),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          connection: "keep-alive",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new RpcError(`Timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

export function encodeCall(method: string, params: unknown[], id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params, id });
}

interface JsonRpcResponse<T> {
  id?: number;
  result?: T;
  error?: { code?: number; message?: string };
}

export async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[] = [],
  timeoutMs = 10_000
): Promise<T> {
  const res = await post(url, encodeCall(method, params), timeoutMs);
  let json: JsonRpcResponse<T>;
  try {
    json = JSON.parse(res.text) as JsonRpcResponse<T>;
  } catch {
    throw new RpcError(`HTTP ${res.status} from ${hostOf(url)} (non-JSON response)`);
  }
  if (json.error) throw new RpcError(json.error.message ?? "unknown RPC error", json.error.code);
  if (json.result === undefined) throw new RpcError(`Empty result for ${method}`);
  return json.result;
}

export interface BatchCall {
  method: string;
  params: unknown[];
}

export interface BatchEntry<T> {
  result?: T;
  error?: string;
}

/**
 * One POST carrying many calls. Providers cap batch size, so callers should keep
 * chunks modest — batchChunked() below does that for them.
 */
export async function rpcBatch<T>(
  url: string,
  calls: BatchCall[],
  timeoutMs = 15_000
): Promise<BatchEntry<T>[]> {
  if (calls.length === 0) return [];

  const body = JSON.stringify(
    calls.map((c, i) => ({ jsonrpc: "2.0", method: c.method, params: c.params, id: i }))
  );
  const res = await post(url, body, timeoutMs);

  let parsed: JsonRpcResponse<T>[];
  try {
    parsed = JSON.parse(res.text) as JsonRpcResponse<T>[];
  } catch {
    throw new RpcError(`HTTP ${res.status} from ${hostOf(url)} (non-JSON batch response)`);
  }
  if (!Array.isArray(parsed)) {
    const single = parsed as unknown as JsonRpcResponse<T>;
    throw new RpcError(single.error?.message ?? `Batch rejected by ${hostOf(url)}`);
  }

  // Responses may come back in any order; id is the only reliable index.
  const out: BatchEntry<T>[] = new Array(calls.length).fill(null).map(() => ({}));
  for (const entry of parsed) {
    const index = typeof entry.id === "number" ? entry.id : -1;
    if (index < 0 || index >= out.length) continue;
    out[index] = entry.error
      ? { error: entry.error.message ?? "unknown error" }
      : { result: entry.result };
  }
  return out;
}

/**
 * Batch limits vary wildly and are only discoverable by asking. Base's public
 * endpoint allows ten calls per batch; Alchemy allows hundreds. Rather than
 * pick a number that is wrong somewhere, this starts optimistically and shrinks
 * to whatever the endpoint actually permits — including reading the limit
 * straight out of the rejection when the provider states it.
 *
 * The default is deliberately conservative so a first run against a public node
 * works without configuration.
 */
/**
 * Per-second call budget, enforced per host.
 *
 * Providers meter individual calls, not HTTP requests — a 500-call batch spends
 * 500 units the instant it lands. Without a budget, one reconcile blows a
 * 50/second quota five times over and most of the batch comes back refused.
 * Throttling ahead of time is the fix; the retry logic below is the safety net.
 */
const DEFAULT_CALLS_PER_SEC = Number(process.env.RPC_MAX_CALLS_PER_SEC ?? 45);

const buckets = new Map<string, { tokens: number; last: number }>();

async function takeTokens(host: string, count: number, perSecond: number): Promise<void> {
  let bucket = buckets.get(host);
  if (!bucket) {
    bucket = { tokens: perSecond, last: Date.now() };
    buckets.set(host, bucket);
  }
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(perSecond, bucket.tokens + ((now - bucket.last) / 1000) * perSecond);
    bucket.last = now;
    // A batch larger than the whole budget can never be fully covered; let it
    // through once the bucket is full rather than deadlocking.
    if (bucket.tokens >= Math.min(count, perSecond)) {
      bucket.tokens -= count;
      return;
    }
    const deficit = Math.min(count, perSecond) - bucket.tokens;
    await sleep(Math.max(20, Math.ceil((deficit / perSecond) * 1000)));
  }
}

/** Rate limiting arrives two ways: a thrown batch error, or a per-entry error. */
function isRateLimit(message: string): boolean {
  return /request limit|rate limit|too many requests|-32007|429/i.test(message);
}

const MAX_ROUNDS = 6;

/**
 * Run many calls as batches, adapting to whatever the endpoint permits.
 *
 * Three failure modes are handled, and they are genuinely different:
 *
 *   The whole batch is rejected for being too large — shrink and retry.
 *   The whole batch is refused for rate — wait, then retry.
 *   The batch returns HTTP 200 with SOME entries carrying rate-limit errors.
 *
 * The third is the dangerous one, because nothing throws. Those entries simply
 * arrive with no result, and a caller that reads balances or nonces would treat
 * them as zero and act on it. They are collected and retried, and if any never
 * answer this throws rather than handing back a half-filled array.
 */
export async function rpcBatchChunked<T>(
  url: string,
  calls: BatchCall[],
  chunkSize = 200,
  timeoutMs = 15_000
): Promise<BatchEntry<T>[]> {
  if (calls.length === 0) return [];

  const host = hostOf(url);
  const perSecond = DEFAULT_CALLS_PER_SEC;
  const out: BatchEntry<T>[] = calls.map(() => ({}));
  let pending = calls.map((_, i) => i);
  let size = Math.max(1, chunkSize);

  for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round++) {
    const retry: number[] = [];

    for (let offset = 0; offset < pending.length; ) {
      const indices = pending.slice(offset, offset + size);
      await takeTokens(host, indices.length, perSecond);

      try {
        const results = await rpcBatch<T>(
          url,
          indices.map((i) => calls[i]),
          timeoutMs
        );
        results.forEach((entry, k) => {
          const index = indices[k];
          if (entry.result !== undefined) out[index] = entry;
          else if (entry.error && isRateLimit(entry.error)) retry.push(index);
          else out[index] = entry; // a real error belongs to the caller
        });
        offset += indices.length;
      } catch (err) {
        const message = (err as Error).message;
        if (isRateLimit(message)) {
          retry.push(...indices);
          offset += indices.length;
          continue;
        }
        const stated = statedBatchLimit(message);
        if (stated !== undefined && stated < size) {
          size = stated;
          continue; // same offset, smaller slice
        }
        if (size > 1) {
          size = Math.max(1, Math.floor(size / 2));
          continue;
        }
        throw err;
      }
    }

    pending = retry;
    if (pending.length > 0) {
      // Back off before the next round, and stop asking for so much at once.
      size = Math.max(1, Math.floor(size / 2));
      await sleep(Math.min(5_000, 400 * 2 ** round));
    }
  }

  if (pending.length > 0) {
    throw new RpcError(
      `${pending.length} of ${calls.length} calls to ${host} were rate limited and never answered ` +
        `after ${MAX_ROUNDS} rounds. Returning partial data here would make wallets look unfunded ` +
        `or unprimed, so this fails instead. Lower RPC_MAX_CALLS_PER_SEC (currently ${perSecond}) ` +
        `or raise the provider's limit.`
    );
  }
  return out;
}

/** e.g. "maximum 10 calls in 1 batch" — providers usually name their limit. */
function statedBatchLimit(message: string): number | undefined {
  const match = /max(?:imum)?\s+(?:of\s+)?(\d+)\s+(?:calls|requests|items)/i.exec(message);
  if (!match) return undefined;
  const limit = Number(match[1]);
  return Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a socket to every endpoint so the TLS handshake is already paid for.
 * Failures are ignored — this is an optimisation, never a gate.
 */
export async function warmSockets(urls: string[]): Promise<void> {
  await Promise.allSettled(
    urls.map((url) => rpcCall<string>(url, "eth_chainId", [], 5_000).catch(() => null))
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function destroyAgents(): void {
  httpsAgent.destroy();
  httpAgent.destroy();
}
