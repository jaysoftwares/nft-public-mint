// Making another wallet's mint safe to replay.
//
// Most mint calldata is not replayable verbatim, and the failure modes differ in
// how loudly they fail:
//
//   mintPublic(nft, feeRecipient, 0x0, qty)   credits msg.sender — replay works
//   mint(address to, uint qty)                SUCCEEDS, and mints to *them*
//   mintAllowList(..., merkleProof)           reverts, gas burned per wallet
//
// The middle case is the dangerous one: nothing looks broken, and you have just
// funded someone else's NFTs. So every occurrence of the target's address is
// rewritten to ours before anything is simulated.
//
// Substitution alone is not proof of safety, though — it only fixes the shape.
// The gate is eth_estimateGas from our own wallet, which reverts exactly when the
// real transaction would, and returns the gas the call actually needs as a side
// effect. One request answers both "is this safe" and "how much gas".

import { rpcCall } from "./rpc";

export interface Substitution {
  data: string;
  /** How many times the target's address appeared and was rewritten. */
  occurrences: number;
}

/**
 * Rewrite every byte-aligned occurrence of `target` to `replacement`.
 *
 * ABI-encoded addresses are left-padded into 32-byte words, so a genuine address
 * parameter always begins on a byte boundary. Restricting matches to even nibble
 * offsets avoids rewriting bytes that merely happen to span the same digits
 * inside a hash or proof.
 */
export function substituteAddress(
  data: string,
  target: string,
  replacement: string
): Substitution {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const needle = target.toLowerCase().replace(/^0x/, "");
  const value = replacement.toLowerCase().replace(/^0x/, "");

  if (needle.length !== 40 || value.length !== 40) {
    throw new Error("substituteAddress expects 20-byte addresses.");
  }

  const haystack = body.toLowerCase();
  let out = "";
  // Two positions, not one. `copied` tracks how much of the body has been
  // emitted; `searchFrom` walks ahead of it. Collapsing them loses the bytes
  // between a skipped match and the next one — silent calldata corruption.
  let copied = 0;
  let searchFrom = 0;
  let occurrences = 0;

  for (;;) {
    const index = haystack.indexOf(needle, searchFrom);
    if (index === -1) break;
    if (index % 2 !== 0) {
      // Not byte-aligned — cannot be an encoded address parameter.
      searchFrom = index + 1;
      continue;
    }
    out += body.slice(copied, index) + value;
    copied = index + 40;
    searchFrom = copied;
    occurrences += 1;
  }
  out += body.slice(copied);

  return { data: `0x${out}`, occurrences };
}

export function selectorOf(data: string): string {
  return data.slice(0, 10);
}

/** Does this calldata still mention an address it shouldn't? */
export function contains(data: string, address: string): boolean {
  return data.toLowerCase().includes(address.toLowerCase().replace(/^0x/, ""));
}

export interface SimulationRequest {
  from: string;
  to: string;
  data: string;
  value: bigint;
}

export interface SimulationOutcome {
  ok: boolean;
  /** Gas the call actually needs, straight from the node. */
  gasEstimate?: bigint;
  reason?: string;
}

/**
 * Simulate one representative transaction. A revert here aborts the whole event
 * at zero gas cost, which is the entire point — 500 reverting transactions is
 * the expensive way to learn the same thing.
 */
export async function simulate(
  readUrl: string,
  request: SimulationRequest,
  timeoutMs = 5_000
): Promise<SimulationOutcome> {
  const call = {
    from: request.from,
    to: request.to,
    data: request.data,
    value: `0x${request.value.toString(16)}`,
  };

  try {
    const hex = await rpcCall<string>(readUrl, "eth_estimateGas", [call, "latest"], timeoutMs);
    return { ok: true, gasEstimate: BigInt(hex) };
  } catch (err) {
    return { ok: false, reason: cleanRevert((err as Error).message) };
  }
}

function cleanRevert(message: string): string {
  const match = /execution reverted:?\s*(.*)/i.exec(message);
  if (match && match[1]) return match[1].trim().slice(0, 200);
  return message.slice(0, 200);
}

export interface ReplayPlan {
  to: string;
  value: bigint;
  /** Calldata per wallet address, already rewritten. */
  dataFor: Map<string, string>;
  selector: string;
  /** True when the original embedded the target's address. */
  addressBound: boolean;
  gasLimit: number;
}

export interface BuildReplayArgs {
  readUrl: string;
  target: string;
  to: string;
  originalData: string;
  value: bigint;
  wallets: { id: string; address: string }[];
  /** Floor for the gas limit; the estimate wins when it is higher. */
  configuredGasLimit: number;
}

/**
 * How many wallets to try before concluding the pool, not the calldata, is the
 * problem. Each attempt is one eth_estimateGas and only happens on a failure,
 * so the happy path still costs exactly one call.
 */
const MAX_PROBES = 3;

/** A revert that is about the caller's balance, not about the call. */
export function isFundingRevert(reason: string | undefined): boolean {
  if (!reason) return false;
  return /insufficient funds|insufficient balance|gas required exceeds allowance/i.test(reason);
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

export async function buildReplay(args: BuildReplayArgs): Promise<ReplayPlan> {
  if (args.wallets.length === 0) throw new ReplayError("No wallets to build a replay for.");

  const dataFor = new Map<string, string>();
  let addressBound = false;

  for (const wallet of args.wallets) {
    const { data, occurrences } = substituteAddress(
      args.originalData,
      args.target,
      wallet.address
    );
    if (occurrences > 0) addressBound = true;

    // Belt and braces: if the target still appears after substitution, something
    // is encoded in a way we do not understand and the mint could land in their
    // wallet. Refuse rather than guess.
    if (contains(data, args.target)) {
      throw new ReplayError(
        "The target's address still appears in the calldata after substitution — refusing to replay."
      );
    }
    dataFor.set(wallet.address, data);
  }

  // Simulate from a wallet that can actually pay.
  //
  // eth_estimateGas charges the caller, so a probe wallet short of value + gas
  // reverts with "insufficient funds" no matter how replayable the call is —
  // and that used to abort the whole event as "not replayable" on the strength
  // of one empty wallet sitting first in the pool. A funding failure says
  // nothing about the calldata, so it moves on to the next candidate and is
  // only reported once every candidate gives the same answer.
  const probes = args.wallets.slice(0, MAX_PROBES);
  let outcome: SimulationOutcome | undefined;
  let fundingFailures = 0;

  for (const probe of probes) {
    outcome = await simulate(args.readUrl, {
      from: probe.address,
      to: args.to,
      data: dataFor.get(probe.address)!,
      value: args.value,
    });
    if (outcome.ok) break;
    if (!isFundingRevert(outcome.reason)) break;
    fundingFailures += 1;
  }

  if (!outcome || !outcome.ok) {
    if (fundingFailures === probes.length) {
      throw new ReplayError(
        `Every wallet tried is short of the ${args.value} wei mint price plus gas, so the ` +
          `simulation could not run. Top them up with /fund — the calldata itself was not rejected.`
      );
    }
    throw new ReplayError(
      `Simulation reverted — not firing. ${outcome?.reason ?? "no reason given"}` +
        (addressBound
          ? "\nThe call is bound to the target's address (allowlist proof or signature), which cannot be replayed."
          : "")
    );
  }

  // Estimates are exact for the simulated state; real inclusion happens a block
  // later against slightly different state, so leave headroom.
  const withHeadroom = outcome.gasEstimate
    ? Number((outcome.gasEstimate * 13n) / 10n)
    : args.configuredGasLimit;

  return {
    to: args.to,
    value: args.value,
    dataFor,
    selector: selectorOf(args.originalData),
    addressBound,
    gasLimit: Math.max(withHeadroom, args.configuredGasLimit),
  };
}
