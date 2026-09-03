// OpenSea v2 mint API.
//
// This replaces an earlier design of mine that assumed a SIWE login flow with
// per-wallet session tokens. That was wrong. The real API is far simpler:
//
//   POST https://api.opensea.io/api/v2/drops/{slug}/mint   { minter, quantity }
//   headers: X-API-KEY: <key>
//   → { to, data, value }
//
// One API key covers every wallet. There is no login, no session, no nonce
// challenge, and no signature to assemble locally — OpenSea returns finished
// calldata with the proof or signature already embedded, and picks the stage
// server-side from the minter's eligibility.
//
// Two consequences worth stating plainly.
//
// First, allowlist and signed stages stop being different problems. You ask for
// calldata as a given wallet and OpenSea answers with whatever that wallet is
// entitled to, so one code path covers both.
//
// Second — and this is the timing answer the design has been waiting on — the
// endpoint REFUSES before a stage opens, returning 404 or "not currently
// active". Signatures cannot be pre-fetched. The requests sit inside the
// critical path at T-0, which is exactly the constraint the pacing below exists
// to survive.

import { post } from "./rpc";

export const OPENSEA_API_BASE = "https://api.opensea.io/api/v2";

/** OpenSea's chain slugs, which differ from our chain keys in places. */
export const CHAIN_SLUGS: Record<number, string> = {
  1: "ethereum",
  // Ink. Verified live 2026-09-03: /chain/ink/contract/... answers with
  // ChainIdentifier(chainId=57073), so OpenSea resolves the slug even where it
  // has not indexed a given contract.
  57073: "ink",
  // Robinhood Chain. Verified live against the v2 API: /chain/robinhood/contract/…
  // answers 200, and the drop endpoint reports chain "robinhood". Omitting it
  // made every /fcfs on this chain fail at slug resolution rather than at mint.
  4663: "robinhood",
  10: "optimism",
  42161: "arbitrum",
  137: "matic",
  56: "bsc",
  43114: "avalanche",
  7777777: "zora",
  81457: "blast",
  33139: "ape_chain",
  360: "shape",
  2741: "abstract",
  130: "unichain",
  146: "soneium",
  480: "world_chain",
  1329: "sei",
  84532: "base_sepolia",
  11155111: "sepolia",
};

export type OpenSeaFailure =
  | "auth"
  | "not_live"
  | "minted_out"
  | "not_eligible"
  /** OpenSea checks the minter's balance before issuing calldata. */
  | "insufficient_balance"
  /**
   * The account itself is barred from trading — flagged, restricted or
   * sanctioned. Permanent for that address, and nothing to do with the stage.
   */
  | "account_restricted"
  | "rate_limited"
  | "server"
  | "unknown";

export class OpenSeaApiError extends Error {
  readonly kind: OpenSeaFailure;
  readonly status: number;
  readonly body: string;

  constructor(kind: OpenSeaFailure, message: string, status: number, body = "") {
    super(message);
    this.name = "OpenSeaApiError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }

  /** Worth trying again, as opposed to a permanent refusal for this wallet. */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "server";
  }
}

export interface OpenSeaStage {
  uuid: string;
  stage_type: string;
  label?: string;
  price?: string;
  price_currency_address?: string;
  start_time: string;
  end_time: string;
  max_per_wallet: string;
}

export interface OpenSeaDrop {
  collection_slug: string;
  collection_name?: string;
  chain: string;
  contract_address: string;
  drop_type: string;
  is_minting: boolean;
  opensea_url: string;
  stages: OpenSeaStage[];
  total_supply?: string;
  max_supply?: string;
}

export interface MintCalldata {
  to: string;
  data: string;
  value: bigint;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-KEY": apiKey,
  };
}

/**
 * Pull the human-readable part out of an error body.
 *
 * OpenSea returns JSON with the useful text under varying keys, and sometimes
 * plain text. Digging it out matters: the difference between "minted out",
 * "not eligible" and "stage not active" decides whether to retry, skip the
 * wallet, or abort the whole run.
 */
function summarise(body: string): string {
  if (!body) return "no detail given";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["detail", "message", "error", "errors", "reason", "title"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) return value.slice(0, 200);
      if (Array.isArray(value) && value.length > 0) return String(value[0]).slice(0, 200);
    }
    return JSON.stringify(parsed).slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

/** Map HTTP status and body text onto something the caller can act on. */
function classify(status: number, body: string): OpenSeaApiError {
  if (status === 401 || status === 403) {
    return new OpenSeaApiError("auth", `OpenSea rejected the API key (HTTP ${status}).`, status, body);
  }
  if (status === 429) {
    return new OpenSeaApiError("rate_limited", "OpenSea rate limited the request.", status, body);
  }
  if (status >= 500) {
    return new OpenSeaApiError("server", `OpenSea server error (HTTP ${status}).`, status, body);
  }
  if (status === 404) {
    return new OpenSeaApiError("not_live", "OpenSea has no live mint for that drop.", status, body);
  }
  // A barred account is permanent and address-specific. Observed live as
  // HTTP 400 "Account can not perform trading operations" on an exchange hot
  // wallet. It must be distinguished from a closed stage: retrying cannot fix
  // it, so a pre-open hold would otherwise spin out its whole grace period
  // against a wallet that was never going to be served.
  if (/can\s*not\s+perform\s+trading|cannot\s+perform\s+trading|account\s+(is\s+)?(restricted|blocked|suspended|disabled)|sanction/i.test(body)) {
    return new OpenSeaApiError(
      "account_restricted",
      `OpenSea will not serve this address: ${summarise(body)}`,
      status,
      body
    );
  }
  // Checked before the supply test: "insufficient balance" is about the wallet,
  // not the drop, and confusing the two would abort a whole run over one
  // underfunded wallet.
  if (/insufficient\s+balance|not\s+enough\s+(?:eth|funds|balance)/i.test(body)) {
    return new OpenSeaApiError(
      "insufficient_balance",
      `Minter cannot cover the mint: ${summarise(body)}`,
      status,
      body
    );
  }
  if (/minted\s+out|sold\s+out|fully\s+minted|supply|remaining|exceed/i.test(body)) {
    return new OpenSeaApiError("minted_out", `Supply exhausted: ${summarise(body)}`, status, body);
  }
  if (/not\s+currently\s+active|not\s+started|has\s+ended|inactive/i.test(body)) {
    return new OpenSeaApiError("not_live", `Stage not active: ${summarise(body)}`, status, body);
  }
  if (/eligib|allow\s*list|allowlist|not\s+permitted|denied|unauthorized\s+minter/i.test(body)) {
    return new OpenSeaApiError("not_eligible", `Not eligible: ${summarise(body)}`, status, body);
  }
  // Never swallow the body on an unrecognised refusal — the message OpenSea
  // returns is the only way to learn a case this classifier does not know yet.
  return new OpenSeaApiError(
    "unknown",
    `OpenSea refused the request (HTTP ${status}): ${summarise(body)}`,
    status,
    body
  );
}

async function getJson<T>(url: string, apiKey: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, { headers: headers(apiKey), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw classify(res.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OpenSeaApiError("unknown", "OpenSea returned a non-JSON body.", res.status, text.slice(0, 200));
  }
}

/**
 * OpenSea's name for a chain, or undefined if we have no mapping for it.
 *
 * Callers need this separately from the lookup below: "OpenSea does not index
 * this chain" and "OpenSea has never seen this contract" are different failures
 * and deserve different messages. Conflating them sent people hunting for a
 * collection slug when the real problem was a missing entry in this table.
 */
export function openSeaChainSlug(chainId: number): string | undefined {
  return CHAIN_SLUGS[chainId];
}

/** Resolve a bare contract address to its OpenSea collection slug. */
export async function slugForContract(
  apiKey: string,
  chainId: number,
  contract: string
): Promise<string | undefined> {
  const chain = openSeaChainSlug(chainId);
  if (!chain) return undefined;
  try {
    const body = await getJson<{ collection?: string }>(
      `${OPENSEA_API_BASE}/chain/${chain}/contract/${contract.toLowerCase()}`,
      apiKey
    );
    return typeof body.collection === "string" ? body.collection : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchDrop(apiKey: string, slug: string): Promise<OpenSeaDrop> {
  return getJson<OpenSeaDrop>(`${OPENSEA_API_BASE}/drops/${encodeURIComponent(slug)}`, apiKey);
}

export function stageIsLive(stage: OpenSeaStage): boolean {
  const now = Date.now();
  const start = Date.parse(stage.start_time);
  const end = Date.parse(stage.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= now && now <= end;
}

export function describeStage(stage: OpenSeaStage): string {
  const kind = /public/i.test(stage.stage_type) || /public/i.test(stage.label ?? "")
    ? "public"
    : /signed/i.test(stage.stage_type)
      ? "signed"
      : "allowlist";
  return `${stage.label ?? stage.stage_type} (${kind})`;
}

/**
 * Ask OpenSea for one wallet's mint transaction.
 *
 * The body carries only minter and quantity. Adding stage_id, phase_id or
 * sale_type is rejected with HTTP 400 "Unknown field" — the stage is chosen
 * server-side from eligibility and is not selectable by the caller.
 */
export async function fetchMintCalldata(
  apiKey: string,
  slug: string,
  minter: string,
  quantity: number,
  timeoutMs = 8_000
): Promise<MintCalldata> {
  const url = `${OPENSEA_API_BASE}/drops/${encodeURIComponent(slug)}/mint`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ minter, quantity }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) throw classify(res.status, text);

  let body: { to?: string; data?: string; value?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new OpenSeaApiError("unknown", "Mint response was not JSON.", res.status, text.slice(0, 200));
  }

  if (typeof body.to !== "string" || typeof body.data !== "string") {
    throw new OpenSeaApiError(
      "unknown",
      "Mint response carried no calldata.",
      res.status,
      JSON.stringify(Object.keys(body))
    );
  }

  return {
    to: body.to,
    data: body.data,
    value: BigInt(body.value ?? "0"),
  };
}

/**
 * Probe whether the endpoint will hand out calldata right now.
 *
 * Cheap enough to run well before a drop. A `not_live` answer is the expected
 * one ahead of the stage and is not an error — it is the finding.
 */
export interface IssuanceProbe {
  available: boolean;
  kind?: OpenSeaFailure;
  detail: string;
  /** Raw response body, so an unclassified refusal is still diagnosable. */
  body?: string;
}

export async function probeIssuance(
  apiKey: string,
  slug: string,
  minter: string,
  quantity = 1
): Promise<IssuanceProbe> {
  try {
    await fetchMintCalldata(apiKey, slug, minter, quantity);
    return {
      available: true,
      detail: "Calldata was issued — this stage can be fetched and pre-signed now.",
    };
  } catch (err) {
    if (err instanceof OpenSeaApiError) {
      return {
        available: false,
        kind: err.kind,
        detail:
          err.kind === "not_live"
            ? `Not issued before the stage opens — requests must be made at T-0. (${err.message})`
            : err.message,
        body: err.body,
      };
    }
    return { available: false, detail: (err as Error).message };
  }
}

// Kept so a caller can confirm the base URL is reachable without a drop.
export async function ping(apiKey: string): Promise<boolean> {
  try {
    await post(`${OPENSEA_API_BASE}/collections?limit=1`, "", 5_000);
    return true;
  } catch {
    return false;
  }
}
