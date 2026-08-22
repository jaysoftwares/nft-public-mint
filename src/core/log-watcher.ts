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
//
// The fallback to polling has to be real, not just intended. deriveWsUrl only
// rewrites a scheme, so it hands back a wss:// URL for any https:// RPC whether
// or not that host speaks WebSocket — and most public ones do not:
// mainnet.base.org answers the upgrade with 405, and both Robinhood endpoints
// answer 400. The watcher therefore connected, was closed, and reconnected
// forever, never once reaching the polling branch that exists for exactly this
// case. Copy-mint sat there reporting "Watching 1 target" and detecting
// nothing. An endpoint that closes without ever confirming a subscription is
// now treated as one that cannot do this, and polling takes over for good.

import { rpcCall, hostOf } from "./rpc";

/** ERC-721 Transfer(address,address,uint256) — tokenId indexed, so 4 topics. */
export const ERC721_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** ERC-1155 TransferSingle(address,address,address,uint256,uint256). */
export const ERC1155_TRANSFER_SINGLE =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

const ZERO_TOPIC = `0x${"0".repeat(64)}`;

/**
 * Failed connections tolerated before concluding the host cannot serve
 * WebSocket. Three is enough to ride out a restart or a brief outage without
 * spending days reconnecting to an endpoint that will never answer.
 */
const MAX_DEAD_CONNECTS = 3;

/** Polling cadence when push delivery is unavailable. */
const DEFAULT_POLL_MS = 750;

/**
 * How long a connection gets to produce a confirmed subscription.
 *
 * Without this a socket that neither opens nor errors — a host that accepts the
 * TCP connection and then says nothing — left the watcher permanently silent,
 * with no reconnect and not one status message to say so. The heartbeat cannot
 * cover it because the heartbeat only starts once the socket opens.
 */
const SUBSCRIBE_TIMEOUT_MS = 15_000;

/**
 * Attempts at reading the chain head before giving up on a gap replay.
 *
 * The head read gates the whole catch-up, so a single flaky answer costing the
 * replay is a poor trade — but this runs on reconnect, so it cannot retry for
 * long either.
 */
const HEAD_READ_ATTEMPTS = 3;
const HEAD_RETRY_MS = 250;

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
  /** A subscription was confirmed on the current socket. */
  private subscribed = false;
  /** A subscription was confirmed at least once, ever, on this endpoint. */
  private wsEverWorked = false;
  /** Connections that closed without ever confirming a subscription. */
  private deadConnects = 0;
  /** Set once this endpoint has proved it cannot serve WebSocket. */
  private wsUnavailable = false;
  private polling = false;
  private connectTimer?: NodeJS.Timeout;
  /** Retires in-flight polling ticks when the loop is stopped or restarted. */
  private pollGeneration = 0;

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

    if (this.opts.wsUrl && typeof WebSocket !== "undefined" && !this.wsUnavailable) {
      this.connect();
    } else {
      if (!this.wsUnavailable) {
        this.opts.onStatus(
          this.opts.wsUrl
            ? "No WebSocket support in this runtime — falling back to polling."
            : "No WebSocket endpoint — falling back to polling.",
          "warn"
        );
      }
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
    if (!this.running || !this.opts.wsUrl || this.wsUnavailable) return;

    this.subscribed = false;
    // Whichever of error/close arrives first owns the failure; the other is
    // ignored. They are not reliably paired — a rejected upgrade fires `error`
    // and never fires `close` at all.
    let settled = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.opts.wsUrl);
      this.socket = socket;
    } catch (err) {
      // A constructor that throws is as dead as one that closes — count it the
      // same way, or a malformed endpoint loops forever at the backoff ceiling.
      this.deadConnects += 1;
      if (!this.wsEverWorked && this.deadConnects >= MAX_DEAD_CONNECTS) {
        this.fallBackToPolling(`${this.opts.wsUrl} could not be opened (${(err as Error).message})`);
        return;
      }
      this.scheduleReconnect((err as Error).message);
      return;
    }

    this.connectTimer = setTimeout(() => {
      if (!this.running || this.socket !== socket || this.subscribed) return;
      this.socket = undefined;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      this.onDeadConnection(`no subscription within ${SUBSCRIBE_TIMEOUT_MS / 1000}s`);
    }, SUBSCRIBE_TIMEOUT_MS);
    this.connectTimer.unref?.();

    socket.addEventListener("open", () => {
      if (!this.running || this.socket !== socket) return;
      // Deliberately not resetting reconnectAttempt here. A host that rejects
      // the upgrade still opens and closes, so resetting on `open` pinned the
      // backoff at "retry 1 in 1s" forever and hammered the endpoint once a
      // second. The counter resets when a subscription is confirmed, which is
      // the first point the connection has proved it is worth anything.
      this.lastMessageAt = Date.now();
      this.subscribe();
      // Fire-and-forget, so a rejection here has nowhere to go — and an
      // unhandled rejection exits the process outright under Node 22. A single
      // empty eth_blockNumber reply from the provider took the whole bot down
      // this way, on a path that runs on every reconnect. start() already
      // guards the same head read and the polling tick already catches this;
      // the socket path was the one place that did not.
      void this.replayMissed().catch((err) => {
        this.opts.onStatus(`Gap replay failed: ${(err as Error).message}`, "warn");
      });
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
      if (!this.running || this.socket !== socket || settled) return;
      settled = true;
      this.socket = undefined;
      this.onDeadConnection("socket closed");
    });

    socket.addEventListener("error", () => {
      // A rejected upgrade — 400 or 405, which is what every non-WebSocket RPC
      // answers — fires this and then nothing at all. Waiting for a `close`
      // that never comes is what left the watcher silently dead: no reconnect,
      // no fallback, no status message, and copy-mint detecting nothing while
      // still reporting itself as watching.
      if (!this.running || this.socket !== socket || settled) return;
      settled = true;
      this.socket = undefined;
      this.onDeadConnection("connection refused by the endpoint");
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
      // This is the point the connection has proved itself: the provider
      // accepted a log subscription and will deliver events on it.
      if (!this.subscribed) {
        this.subscribed = true;
        this.wsEverWorked = true;
        this.clearConnectTimer();
        this.reconnectAttempt = 0;
        this.deadConnects = 0;
        this.opts.onStatus(`Watching ${this.opts.targets.length} target(s).`, "info");
      }
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

  /**
   * A connection ended without becoming useful.
   *
   * Once that has happened a few times running and the endpoint has never once
   * worked, it is not a flaky connection — the host does not serve WebSocket,
   * and reconnecting to it forever is what left copy-mint detecting nothing.
   */
  private onDeadConnection(reason: string): void {
    this.clearConnectTimer();

    if (!this.subscribed && !this.wsEverWorked) {
      this.deadConnects += 1;
      if (this.deadConnects >= MAX_DEAD_CONNECTS) {
        this.fallBackToPolling(
          `${hostOf(this.opts.wsUrl!)} failed ${this.deadConnects} connections without ever ` +
            `accepting a log subscription (${reason}), so it does not serve WebSocket`
        );
        return;
      }
    }

    this.scheduleReconnect(reason);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  /**
   * Give up on WebSocket for this endpoint and poll instead.
   *
   * Permanent for the life of the watcher, including across retarget: whether
   * a host serves WebSocket is a property of the host, not of this connection,
   * so retrying it on every watch-list change would restore the same loop.
   */
  private fallBackToPolling(reason: string): void {
    this.wsUnavailable = true;
    this.clearReconnect();
    this.teardownSocket();
    this.opts.onStatus(
      `${reason}. Switching to polling every ${this.opts.pollIntervalMs ?? DEFAULT_POLL_MS}ms — ` +
        `copy-mint keeps working. Set WS_URL_<CHAIN> to a provider that does (Alchemy, ` +
        `QuickNode, publicnode) to get back to push delivery.`,
      "warn"
    );
    this.startPolling();
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
    this.clearConnectTimer();
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
    // One loop per watcher. Without this guard a retarget landing while a tick
    // was awaiting its eth_getLogs left the old loop running alongside the new
    // one, and each reported its own view of the gap — which is how the same
    // chain announced two different stale-block counts in the same minute.
    if (this.polling) return;
    this.polling = true;

    const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    const generation = ++this.pollGeneration;

    const tick = async (): Promise<void> => {
      if (!this.running || generation !== this.pollGeneration) return;
      try {
        await this.replayMissed();
      } catch (err) {
        this.opts.onStatus(`Poll failed: ${(err as Error).message}`, "warn");
      }
      if (this.running && generation === this.pollGeneration) {
        this.pollTimer = setTimeout(() => void tick(), interval);
        this.pollTimer.unref?.();
      }
    };
    void tick();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    // Retires any tick already awaiting a response, so it cannot re-arm itself
    // after the loop was told to stop.
    this.pollGeneration += 1;
    this.polling = false;
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

  /**
   * The chain head, retried — because everything downstream of it is skipped
   * when it fails.
   *
   * One attempt used to be all it got, and a single transient answer from the
   * provider ("Empty result for eth_blockNumber", seen roughly once a day on
   * QuickNode, usually on the reconnect right after a restart) abandoned the
   * whole gap replay for that reconnect. That is a real hole rather than a
   * cosmetic one: the blocks between the socket dropping and reconnecting are
   * exactly the ones nothing else will ever look at, so a mint inside that
   * window is missed outright and silently.
   *
   * Three attempts, 250ms apart. Deliberately tight — this sits on the
   * reconnect path, and a drop opening does not wait for us.
   */
  private async currentBlock(): Promise<number> {
    let last: Error | undefined;
    for (let attempt = 0; attempt < HEAD_READ_ATTEMPTS; attempt += 1) {
      try {
        return Number(BigInt(await rpcCall<string>(this.opts.httpUrl, "eth_blockNumber", [])));
      } catch (err) {
        last = err as Error;
        if (attempt < HEAD_READ_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, HEAD_RETRY_MS));
        }
      }
    }
    throw last ?? new Error("eth_blockNumber failed");
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
