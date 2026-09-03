// Shared machinery for every mint path: public, allowlist and signed.
//
// All three do the same thing after dispatch — poll receipts in batches until
// they settle — and all three hold for a stage start the same way. Keeping one
// copy means a fix to the timing loop applies everywhere rather than to
// whichever file was edited most recently.

import { rpcBatchChunked } from "./rpc";

export interface ReceiptRow {
  id: string;
  address: string;
  hash: string;
  status: "confirmed" | "reverted" | "pending";
  block?: number;
  gasUsed?: number;
}

interface RawReceipt {
  blockNumber: string;
  gasUsed: string;
  status: string;
}

export type ReceiptProgress = (
  confirmed: number,
  reverted: number,
  pending: number,
  total: number,
  rows: ReceiptRow[]
) => void;

/**
 * Poll for receipts, batched into one request per round rather than one per
 * transaction — 500 wallets would otherwise mean 500 requests per poll.
 */
export async function collectReceipts(
  readUrl: string,
  outcomes: { id: string; address: string; hash: string }[],
  onProgress: ReceiptProgress,
  timeoutMs = 90_000
): Promise<ReceiptRow[]> {
  const rows = new Map<string, ReceiptRow>();
  for (const outcome of outcomes) {
    rows.set(outcome.hash, {
      id: outcome.id,
      address: outcome.address,
      hash: outcome.hash,
      status: "pending",
    });
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = [...rows.values()].filter((r) => r.status === "pending").map((r) => r.hash);
    if (pending.length === 0) break;

    const results = await rpcBatchChunked<RawReceipt | null>(
      readUrl,
      pending.map((hash) => ({ method: "eth_getTransactionReceipt", params: [hash] }))
    );

    results.forEach((entry, i) => {
      const receipt = entry.result;
      if (!receipt) return;
      const row = rows.get(pending[i]);
      if (!row) return;
      row.status = receipt.status === "0x1" ? "confirmed" : "reverted";
      row.block = parseInt(receipt.blockNumber, 16);
      row.gasUsed = parseInt(receipt.gasUsed, 16);
    });

    const all = [...rows.values()];
    onProgress(
      all.filter((r) => r.status === "confirmed").length,
      all.filter((r) => r.status === "reverted").length,
      all.filter((r) => r.status === "pending").length,
      all.length,
      all
    );

    if (all.every((r) => r.status !== "pending")) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  return [...rows.values()];
}

/**
 * Hold until a wall-clock instant.
 *
 * setTimeout's resolution is not trustworthy at the granularity that decides a
 * contested stage, so the last stretch is handed to setImmediate instead —
 * burning a few milliseconds of event loop to avoid oversleeping the open.
 */
export function sleepUntil(targetMs: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      const remaining = targetMs - Date.now();
      if (remaining <= 0) return resolve();
      if (remaining > 50) setTimeout(tick, Math.min(remaining - 20, 1000));
      else setImmediate(tick);
    };
    tick();
  });
}
