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
//   A log subscription is legitimately silent while the watched wallets do
//   nothing. A lightweight eth_blockNumber request probes that same socket, so
//   silence is only treated as a disconnect when the provider also ignores the
//   health checks.

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
  private heartbeatRequestIds = new Set<number>();
  private reconnectTimer?: NodeJS.Timeout;
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

    // A failed head read must not stop the watcher from coming up. The socket
    // and the polling loop both recover on their own, and gap recovery re-reads
    // the head every tick — whereas throwing here aborted startCopy() partway
    // through its chain loop, so one unreachable RPC left every chain after it
    // with no watcher at all and copy-mint silently watching nothing.
    try {
      this.lastSeenBlock = await this.currentBlock();
    } catch (err) {
      this.lastSeenBlock = 0;
      this.opts.onStatus(
        `Could not read the chain head at startup (${(err as Error).message}) — ` +
          `starting anyway and recovering on the first tick.`,
        "warn"
      );
    }

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
    this.clearReconnect();
    this.teardownSocket();
    this.stopPolling();
    await this.start();
  }

  stop(): void {
    this.running = false;
    this.clearReconnect();
    this.teardownSocket();
    this.stopPolling();
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  // ── WebSocket path ──────────────────────────────────────────────────

  private connect(): void {
    if (!this.running || !this.opts.wsUrl) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.opts.wsUrl);
      this.socket = socket;
    } catch (err) {
      this.scheduleReconnect((err as Error).message);
      return;
    }

    socket.addEventListener("open", () => {
      if (!this.running || this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.subscribe();
      void this.replayMissed();
      this.opts.onStatus(`Watching ${this.opts.targets.length} target(s).`, "info");
      this.startHeartbeat();
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      this.handleMessage(String(event.data));
    });

    socket.addEventListener("close", () => {
      // Closing a socket intentionally during retarget/heartbeat recovery must
      // not schedule a second reconnect from its later close event.
      if (this.running && this.socket === socket) {
        this.socket = undefined;
        this.scheduleReconnect("socket closed");
      }
    });

    socket.addEventListener("error", () => {
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

    if (message.id !== undefined && this.heartbeatRequestIds.delete(message.id)) {
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
      const silentFor = Date.now() - this.lastMessageAt;
      if (silentFor > 60_000) {
        this.opts.onStatus("WebSocket health check timed out — reconnecting.", "warn");
        this.teardownSocket();
        this.scheduleReconnect("heartbeat timeout");
        return;
      }

      // A watched-address log stream can be quiet for hours. Probe the
      // connection with ordinary JSON-RPC instead of mistaking quiet activity
      // for a dead socket. The response updates lastMessageAt in the listener.
      if (silentFor > 15_000) {
        const id = this.nextRequestId++;
        this.heartbeatRequestIds.add(id);
        this.send({ id, method: "eth_blockNumber", params: [] });
      }
    }, 20_000);
    this.heartbeat.unref?.();
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running || this.reconnectTimer) return;
    this.teardownSocket();

    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.opts.onStatus(
      `Watcher disconnected (${reason}) — retry ${this.reconnectAttempt} in ${Math.round(delay / 1000)}s.`,
      "warn"
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
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
    this.heartbeatRequestIds.clear();
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

    // A zero here means the startup head read failed, not that the chain is at
    // block zero — start from the head rather than replaying all of history.
    const from = this.lastSeenBlock === 0 ? head : this.lastSeenBlock + 1;
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
