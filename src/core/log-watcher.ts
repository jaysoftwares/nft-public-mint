// The 24/7 mint watcher.
//
// Detection is a log filter, not a mempool subscription — Base and Robinhood are
// OP-Stack rollups whose sequencers keep the mempool private, so a pending mint
// is invisible and block N+1 is the floor. Filtering Transfer with from = 0x0
// and to = a watched address gives both facts we need in one event: that a mint
// happened, and which contract it was on. No decoding required to detect.
//
// Two things make this survive weeks of uptime rather than hours:
//
//   Reconnect is not enough. A socket that drops for eight seconds silently
//   loses every mint in those four blocks, and nothing about the reconnected
//   stream reveals the hole. So the last seen block is tracked, and on every
//   reconnect the missed range is replayed through eth_getLogs before live
//   events resume.
//
//   A silent socket is indistinguishable from a quiet chain. Blocks arrive every
//   two seconds, so a stream with nothing on it for a minute is assumed dead and
//   torn down rather than trusted.

import { rpcCall } from "./rpc";

/** ERC-721 Transfer(address,address,uint256) — tokenId indexed, so 4 topics. */
export const ERC721_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** ERC-1155 TransferSingle(address,address,address,uint256,uint256). */
export const ERC1155_TRANSFER_SINGLE =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

const ZERO_TOPIC = `0x${"0".repeat(64)}`;

export interface LogEvent {
  /** The token contract that emitted the Transfer. */
  contract: string;
  topics: string[];
  transactionHash: string;
  blockNumber: number;
  /** Which watched address received the mint. */
  recipient: string;
  standard: "erc721" | "erc1155";
}

interface RawLog {
  address: string;
  topics: string[];
  transactionHash: string;
  blockNumber: string;
}

export interface WatcherOptions {
  wsUrl?: string;
  httpUrl: string;
  /** Watched addresses. Empty means the watcher idles rather than matching all. */
  targets: string[];
  onMint: (event: LogEvent) => void;
  onStatus: (message: string, level: "info" | "warn") => void;
  /** Polling cadence when no WebSocket endpoint is available. */
  pollIntervalMs?: number;
}

function padAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/**
 * Turn an HTTP endpoint into its WebSocket equivalent. Every major provider
 * serves both on the same host and path; the public sequencer does not, so a
 * failure here is expected and falls back to polling rather than being fatal.
 */
export function deriveWsUrl(httpUrl: string): string | undefined {
  try {
    const url = new URL(httpUrl);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export class LogWatcher {
  private readonly opts: WatcherOptions;
  private socket?: WebSocket;
  private running = false;
  private reconnectAttempt = 0;
  private lastSeenBlock = 0;
  private lastMessageAt = 0;
  private heartbeat?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private subscriptionIds = new Set<string>();
  private nextRequestId = 1;
  private seenTx = new Set<string>();

  constructor(opts: WatcherOptions) {
    this.opts = opts;
  }

  get targets(): string[] {
    return this.opts.targets;
  }

  async start(): Promise<void> {
    this.running = true;
    this.lastSeenBlock = await this.currentBlock();

    if (this.opts.targets.length === 0) {
      this.opts.onStatus("Watcher idle — no targets. Add one with /watch.", "info");
      return;
    }

    if (this.opts.wsUrl && typeof WebSocket !== "undefined") {
      this.connect();
    } else {
      this.opts.onStatus(
        this.opts.wsUrl
          ? "No WebSocket support in this runtime — falling back to polling."
          : "No WebSocket endpoint — falling back to polling.",
        "warn"
      );
      this.startPolling();
    }
  }

  /** Rebuild subscriptions after the watch list changes. */
  async retarget(targets: string[]): Promise<void> {
    this.opts.targets = targets;
    if (!this.running) return;
    this.teardownSocket();
    this.stopPolling();
    await this.start();
  }

  stop(): void {
    this.running = false;
    this.teardownSocket();
    this.stopPolling();
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  // ── WebSocket path ──────────────────────────────────────────────────

  private connect(): void {
    if (!this.running || !this.opts.wsUrl) return;

    try {
      this.socket = new WebSocket(this.opts.wsUrl);
    } catch (err) {
      this.scheduleReconnect((err as Error).message);
      return;
    }

    this.socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.subscribe();
      void this.replayMissed();
      this.opts.onStatus(`Watching ${this.opts.targets.length} target(s).`, "info");
      this.startHeartbeat();
    });

    this.socket.addEventListener("message", (event) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(String(event.data));
    });

    this.socket.addEventListener("close", () => {
      if (this.running) this.scheduleReconnect("socket closed");
    });

    this.socket.addEventListener("error", () => {
      // 'close' always follows; reconnect is handled there to avoid doubling up.
    });
  }

  private subscribe(): void {
    this.subscriptionIds.clear();
    const padded = this.opts.targets.map(padAddress);

    // ERC-721: topics are [sig, from, to, tokenId].
    this.send({
      id: this.nextRequestId++,
      method: "eth_subscribe",
      params: ["logs", { topics: [ERC721_TRANSFER, ZERO_TOPIC, padded] }],
    });

    // ERC-1155 indexes operator/from/to, so `to` sits one position later and
    // needs its own subscription rather than a combined filter.
    this.send({
      id: this.nextRequestId++,
      method: "eth_subscribe",
      params: ["logs", { topics: [ERC1155_TRANSFER_SINGLE, null, ZERO_TOPIC, padded] }],
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", ...payload }));
  }

  private handleMessage(raw: string): void {
    let message: {
      id?: number;
      result?: unknown;
      method?: string;
      params?: { subscription?: string; result?: RawLog };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message.result === "string" && message.id !== undefined) {
      this.subscriptionIds.add(message.result);
      return;
    }

    if (message.method === "eth_subscription" && message.params?.result) {
      this.emit(message.params.result);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.running) return;
      // Blocks land every ~2s; a full minute of silence means the stream is dead
      // even though the socket still reports itself open.
      if (Date.now() - this.lastMessageAt > 60_000) {
        this.opts.onStatus("Stream silent for 60s — reconnecting.", "warn");
        this.teardownSocket();
        this.scheduleReconnect("heartbeat timeout");
      }
    }, 20_000);
    this.heartbeat.unref?.();
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running) return;
    this.teardownSocket();

    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.opts.onStatus(
      `Watcher disconnected (${reason}) — retry ${this.reconnectAttempt} in ${Math.round(delay / 1000)}s.`,
      "warn"
    );
    setTimeout(() => this.connect(), delay).unref?.();
  }

  private teardownSocket(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
    this.socket = undefined;
    this.subscriptionIds.clear();
  }

  // ── Polling fallback ────────────────────────────────────────────────

  private startPolling(): void {
    const interval = this.opts.pollIntervalMs ?? 750;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.replayMissed();
      } catch (err) {
        this.opts.onStatus(`Poll failed: ${(err as Error).message}`, "warn");
      }
      if (this.running) {
        this.pollTimer = setTimeout(() => void tick(), interval);
        this.pollTimer.unref?.();
      }
    };
    void tick();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  // ── Gap recovery ────────────────────────────────────────────────────

  /**
   * Replay anything between the last block we saw and the chain head. This is
   * what closes the hole a reconnect would otherwise leave, and it doubles as
   * the polling implementation.
   */
  private async replayMissed(): Promise<void> {
    const head = await this.currentBlock();
    if (head <= this.lastSeenBlock) return;

    const from = this.lastSeenBlock + 1;
    // A long outage could span thousands of blocks; anything older than a few
    // hundred is far too stale to act on, so cap the catch-up.
    const start = Math.max(from, head - 500);
    if (start > from) {
      this.opts.onStatus(
        `Skipped ${start - from} stale block(s) after a long gap — too old to copy.`,
        "warn"
      );
    }

    const padded = this.opts.targets.map(padAddress);
    const filters = [
      { topics: [ERC721_TRANSFER, ZERO_TOPIC, padded] },
      { topics: [ERC1155_TRANSFER_SINGLE, null, ZERO_TOPIC, padded] },
    ];

    for (const filter of filters) {
      const logs = await rpcCall<RawLog[]>(this.opts.httpUrl, "eth_getLogs", [
        {
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
          ...filter,
        },
      ]);
      for (const log of logs) this.emit(log);
    }

    this.lastSeenBlock = head;
  }

  private async currentBlock(): Promise<number> {
    return Number(BigInt(await rpcCall<string>(this.opts.httpUrl, "eth_blockNumber", [])));
  }

  // ── Emission ────────────────────────────────────────────────────────

  private emit(log: RawLog): void {
    const blockNumber = parseInt(log.blockNumber, 16);
    if (blockNumber > this.lastSeenBlock) this.lastSeenBlock = blockNumber;

    // A single transaction can mint several tokens, and gap recovery can replay
    // an event the live stream already delivered. Both collapse to one signal.
    if (this.seenTx.has(log.transactionHash)) return;
    this.seenTx.add(log.transactionHash);
    if (this.seenTx.size > 5000) {
      this.seenTx = new Set([...this.seenTx].slice(-2500));
    }

    const isErc1155 = log.topics[0]?.toLowerCase() === ERC1155_TRANSFER_SINGLE;
    const recipientTopic = isErc1155 ? log.topics[3] : log.topics[2];
    if (!recipientTopic) return;

    this.opts.onMint({
      contract: log.address,
      topics: log.topics,
      transactionHash: log.transactionHash,
      blockNumber,
      recipient: `0x${recipientTopic.slice(-40)}`,
      standard: isErc1155 ? "erc1155" : "erc721",
    });
  }
}
