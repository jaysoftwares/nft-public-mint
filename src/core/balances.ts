// Balance reads, batched, plus the one piece of arithmetic that decides whether
// a wallet can mint at all.
//
// From the CLI's README: before a node will accept a transaction it checks the
// sender holds gasLimit × maxFee + value. That reservation — not the gas
// actually burned — is what a wallet must carry. At 500 wallets the difference
// is the whole capital question: a Base mint burns ~0.000008 ETH but reserves
// 0.0005 ETH at a 2 gwei ceiling, sixty times more.

import { BatchCall, rpcBatchChunked } from "./rpc";

export interface BalanceQuery {
  id: string;
  address: string;
}

export async function fetchBalances(
  readUrl: string,
  targets: BalanceQuery[]
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (targets.length === 0) return out;

  const calls: BatchCall[] = targets.map((t) => ({
    method: "eth_getBalance",
    params: [t.address, "latest"],
  }));
  const results = await rpcBatchChunked<string>(readUrl, calls);

  results.forEach((entry, i) => {
    if (entry.result !== undefined) out.set(targets[i].address, BigInt(entry.result));
  });
  return out;
}

/** What a wallet must hold for a node to accept the transaction at all. */
export function requiredPerWallet(
  gasLimit: number,
  maxFeePerGas: bigint,
  valueWei: bigint
): bigint {
  return BigInt(gasLimit) * maxFeePerGas + valueWei;
}

/** The reservation alone, with no mint price — the floor for an armed wallet. */
export function gasReservation(gasLimit: number, maxFeePerGas: bigint): bigint {
  return BigInt(gasLimit) * maxFeePerGas;
}

export interface Shortfall {
  id: string;
  address: string;
  balance: bigint;
  required: bigint;
  deficit: bigint;
}

/** Which wallets cannot cover the reservation, and by how much. */
export function shortfalls(
  targets: BalanceQuery[],
  balances: Map<string, bigint>,
  required: bigint
): Shortfall[] {
  const out: Shortfall[] = [];
  for (const target of targets) {
    const balance = balances.get(target.address) ?? 0n;
    if (balance < required) {
      out.push({
        id: target.id,
        address: target.address,
        balance,
        required,
        deficit: required - balance,
      });
    }
  }
  return out;
}
