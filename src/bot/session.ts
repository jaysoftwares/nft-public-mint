// Bot runtime state.
//
// The store is unlocked once, at boot, with a passphrase supplied by the
// environment or typed at the console — never over Telegram. A chat message
// carrying the passphrase would put it on Telegram's servers and in message
// history, which defeats encrypting the seed at rest in the first place.
//
// Every configured chain is resolved and held live at the same time. There is no
// "current chain" to switch: nonces, balances and endpoints are tracked per
// chain, and a command works out which chain it means from the contract it was
// given. Wallets are the same addresses everywhere, but their balances and
// nonces are not, so anything derived from chain state is keyed by chain.

import { HDNodeWallet, Wallet } from "ethers";
import { ResolvedConfig } from "../core/config";
import { UnlockedStore, ManagedWallet, unlock } from "../core/wallet-store";
import { NonceManager } from "../core/nonce-manager";
import { Endpoint, classifyEndpoints } from "../core/dispatcher";
import { fetchBalances, gasReservation } from "../core/balances";
import { TagContext } from "../core/tags";
import { resolveRpcsForChain, planRpcs } from "../rpc-resolver";
import { CHAINS, resolveChain, ChainProfile } from "../chains";
import { rpcCall } from "../core/rpc";
import { LogWatcher, LogEvent, deriveWsUrl } from "../core/log-watcher";
import { CopyEngine, CopyEvent } from "../core/copy-mint";
import { resolveForAutoFire } from "../core/tags";
import * as targets from "../core/targets";

export interface RpcSetup {
  readUrl: string;
  allUrls: string[];
  endpoints: Endpoint[];
  verified: boolean;
  dropped: { url: string; chainId: number }[];
}

/** Everything chain-specific, held once per chain for the process lifetime. */
export interface ChainContext {
  key: string;
  chainId: number;
  name: string;
  profile: ChainProfile;
  rpc: RpcSetup;
  nonces: NonceManager;
}

export type ReconcileNotice = (message: string) => void;

export class Session {
  readonly config: ResolvedConfig;
  readonly store: UnlockedStore;
  readonly chains = new Map<string, ChainContext>();
  /** Fallback only — used when a contract's chain cannot be determined. */
  readonly defaultChain: string;

  private reconcileTimer?: NodeJS.Timeout;
  private balanceCache = new Map<string, { at: number; balances: Map<string, bigint> }>();
  private watchers = new Map<string, LogWatcher>();
  private engines = new Map<string, CopyEngine>();
  private codeCache = new Map<string, string[]>();
  /** Where the rolling reconcile got to on each chain. */
  private reconcileCursors = new Map<string, number>();

  /**
   * Runtime kill switch, seeded from config.
   *
   * Deliberately not persisted: /copy off must take effect instantly, and
   * /copy on must NOT survive a restart. Autonomous spending resumes after a
   * reboot only because config.json says it should.
   */
  copyEnabled = false;

  private constructor(config: ResolvedConfig, store: UnlockedStore, chains: ChainContext[]) {
    this.config = config;
    this.store = store;
    for (const chain of chains) this.chains.set(chain.key, chain);
    this.defaultChain = this.chains.has(config.chain) ? config.chain : chains[0].key;
    this.copyEnabled = config.copy.enabled;
  }

  static async open(config: ResolvedConfig, passphrase: string): Promise<Session> {
    const store = unlock(passphrase);
    store.primeDerivation();

    // Resolve every chain in parallel. One unreachable chain is a warning, not
    // a failure — the others stay usable.
    const results = await Promise.all(
      CHAINS.map(async (profile) => {
        try {
          return await Session.resolveChain(config, profile);
        } catch {
          return undefined;
        }
      })
    );

    const usable = results.filter((c): c is ChainContext => c !== undefined);
    if (usable.length === 0) {
      throw new Error("No chain could be resolved — check your RPC configuration.");
    }
    return new Session(config, store, usable);
  }

  private static async resolveChain(
    config: ResolvedConfig,
    profile: ChainProfile
  ): Promise<ChainContext | undefined> {
    // Per-chain overrides in config win; otherwise the CLI's own resolution
    // (RPC_URL_<CHAIN> in .env, then the public list) applies.
    const manual = profile.key === config.chain ? [...config.rpc.read, ...config.rpc.send] : [];
    const candidates = resolveRpcsForChain(profile.key, manual).urls;
    const plan = await planRpcs(candidates, profile.chainId);
    if (plan.urls.length === 0) return undefined;

    return {
      key: profile.key,
      chainId: profile.chainId,
      name: profile.name,
      profile,
      rpc: {
        // planRpcs puts a query-capable endpoint first; sequencers answer
        // nothing but eth_sendRawTransaction and must never serve reads.
        readUrl: plan.urls[0],
        allUrls: plan.urls,
        endpoints: classifyEndpoints(plan.urls),
        verified: plan.verified,
        dropped: plan.dropped,
      },
      nonces: new NonceManager(plan.urls[0]),
    };
  }

  // ── Chain selection ───────────────────────────────────────────────────

  chain(key?: string): ChainContext {
    const wanted = (key ?? this.defaultChain).toLowerCase();
    const found = this.chains.get(wanted);
    if (!found) {
      const known = [...this.chains.keys()].join(", ");
      throw new Error(`Chain "${wanted}" is not available. Resolved chains: ${known}`);
    }
    return found;
  }

  get availableChains(): ChainContext[] {
    return [...this.chains.values()];
  }

  /**
   * Work out which chain a contract lives on by looking for deployed code.
   *
   * This is what removes the need to switch chains by hand. A contract deployed
   * at the same address on several chains is genuinely ambiguous — CREATE2 makes
   * that common — so the default chain wins the tie rather than the bot picking
   * arbitrarily.
   */
  async detectChain(contract: string): Promise<{ chain: ChainContext; ambiguous: boolean }> {
    const cached = this.codeCache.get(contract.toLowerCase());
    const hits =
      cached ??
      (
        await Promise.all(
          this.availableChains.map(async (chain) => {
            try {
              const code = await rpcCall<string>(
                chain.rpc.readUrl,
                "eth_getCode",
                [contract, "latest"],
                6_000
              );
              return code && code !== "0x" ? chain.key : undefined;
            } catch {
              return undefined;
            }
          })
        )
      ).filter((k): k is string => k !== undefined);

    this.codeCache.set(contract.toLowerCase(), hits);

    if (hits.length === 0) {
      throw new Error(
        `No contract code at ${contract} on any resolved chain (${this.availableChains
          .map((c) => c.name)
          .join(", ")}).`
      );
    }
    if (hits.includes(this.defaultChain)) {
      return { chain: this.chain(this.defaultChain), ambiguous: hits.length > 1 };
    }
    return { chain: this.chain(hits[0]), ambiguous: hits.length > 1 };
  }

  // ── Wallets ───────────────────────────────────────────────────────────

  wallets(): ManagedWallet[] {
    return this.store.all();
  }

  signerFor = (id: string): Wallet | HDNodeWallet => this.store.signer(id);

  /** Balances are per chain — the same address holds different amounts. */
  async balances(chainKey?: string, force = false): Promise<Map<string, bigint>> {
    const chain = this.chain(chainKey);
    const cached = this.balanceCache.get(chain.key);
    if (!force && cached && Date.now() - cached.at < 15_000) return cached.balances;

    const targetsList = this.wallets().map((w) => ({ id: w.id, address: w.address }));
    const balances = await fetchBalances(chain.rpc.readUrl, targetsList);
    this.balanceCache.set(chain.key, { at: Date.now(), balances });
    return balances;
  }

  /**
   * The context selectors resolve against, for one chain. `funded` means "can
   * cover the gas reservation here" — a wallet flush on Base is not funded on
   * Ethereum, and a selector must reflect that.
   */
  async tagContext(chainKey?: string, force = false): Promise<TagContext> {
    const chain = this.chain(chainKey);
    const balances = await this.balances(chain.key, force);
    const stuck = chain.nonces.stuckAddresses();

    const ctx: TagContext = {
      minFundedWei: gasReservation(this.config.gasLimit, this.config.maxFeePerGas),
      state: new Map(),
    };
    for (const wallet of this.wallets()) {
      ctx.state.set(wallet.id, {
        balanceWei: balances.get(wallet.address) ?? 0n,
        nonceGap: stuck.has(wallet.address),
      });
    }
    return ctx;
  }

  async primeNonces(wallets: ManagedWallet[], chainKey?: string): Promise<void> {
    const chain = this.chain(chainKey);
    const missing = wallets
      .filter((w) => !chain.nonces.has(w.address))
      .map((w) => ({ id: w.id, address: w.address }));
    if (missing.length > 0) await chain.nonces.prime(missing);
  }

  nonceFor(address: string, chainKey?: string): number {
    const value = this.chain(chainKey).nonces.peek(address);
    if (value === undefined) throw new Error(`No primed nonce for ${address}.`);
    return value;
  }

  // ── Nonce hygiene ─────────────────────────────────────────────────────

  /**
   * Background reconcile across every chain. Runs off the critical path;
   * anything it heals or fails to heal is reported, so a dying wallet is never
   * silent.
   */
  startReconcile(intervalMs: number, notify: ReconcileNotice): void {
    this.stopReconcile();
    this.reconcileTimer = setInterval(() => {
      for (const chain of this.availableChains) {
        void this.reconcileChain(chain, notify);
      }
    }, intervalMs);
    this.reconcileTimer.unref?.();
  }

  private async reconcileChain(chain: ChainContext, notify: ReconcileNotice): Promise<void> {
    try {
      const tracked = this.wallets()
        .filter((w) => chain.nonces.has(w.address))
        .map((w) => ({ id: w.id, address: w.address }));
      if (tracked.length === 0) return;

      // Reconcile a slice per cycle rather than the whole set.
      //
      // Each wallet costs two calls, so 500 wallets is 1,000 — more than a
      // 50/second provider plan will pass inside a 30s loop, and the attempt
      // would starve every other read the bot makes. A nonce gap does not need
      // catching within 30 seconds; catching it within a few minutes is fine,
      // and healing is off the critical path either way.
      const slice = Math.max(1, this.config.reconcileBatch);
      const cursor = this.reconcileCursors.get(chain.key) ?? 0;
      const window = [];
      for (let i = 0; i < Math.min(slice, tracked.length); i++) {
        window.push(tracked[(cursor + i) % tracked.length]);
      }
      this.reconcileCursors.set(chain.key, (cursor + window.length) % tracked.length);

      const report = await chain.nonces.reconcile(window);
      if (report.faults.length === 0) return;

      const results = await chain.nonces.heal(report.faults, {
        signerFor: this.signerFor,
        chainId: chain.chainId,
        endpoints: chain.rpc.endpoints,
        maxFeePerGas: this.config.maxFeePerGas,
        maxPriorityFeePerGas: this.config.maxPriorityFeePerGas,
      });

      const rewound = results.filter((r) => r.action === "rewound").length;
      const replaced = results.filter((r) => r.action === "replaced").length;
      const failed = results.filter((r) => r.action === "failed");

      const parts: string[] = [];
      if (rewound > 0) parts.push(`${rewound} counter(s) rewound`);
      if (replaced > 0) parts.push(`${replaced} stuck tx replaced at 2× tip`);
      if (failed.length > 0) parts.push(`${failed.length} could not be healed`);
      if (parts.length > 0) notify(`${chain.name} nonce reconcile: ${parts.join(", ")}.`);
      for (const failure of failed) notify(`  ${failure.address} — ${failure.detail}`);
    } catch (err) {
      notify(`${chain.name} nonce reconcile failed: ${(err as Error).message}`);
    }
  }

  stopReconcile(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }

  // ── Copy-mint ─────────────────────────────────────────────────────────

  /**
   * Start watching every resolved chain.
   *
   * A watched wallet is an address, not a chain, so a target minting on
   * Ethereum should be copied there even if most activity is on Base. One
   * watcher and one engine per chain, each with its own nonces and endpoints.
   */
  async startCopy(
    onCopyEvent: (event: CopyEvent, chain: ChainContext) => void,
    onStatus: (message: string, level: "info" | "warn") => void
  ): Promise<void> {
    const sessionRef = this;

    for (const chain of this.availableChains) {
      const engine = new CopyEngine(
        {
          readUrl: chain.rpc.readUrl,
          endpoints: chain.rpc.endpoints,
          chainId: chain.chainId,
          gasLimit: this.config.gasLimit,
          maxFeePerGas: this.config.maxFeePerGas,
          maxPriorityFeePerGas: this.config.maxPriorityFeePerGas,
          caps: {
            perEventWei: this.config.capPerEventWei,
            maxPriceWei: this.config.capMaxPriceWei,
            dailyWei: this.config.capDailyWei,
          },
          // Read through a getter so /copy on|off applies to the next signal
          // without rebuilding the engine.
          get copy() {
            return { ...sessionRef.config.copy, enabled: sessionRef.copyEnabled };
          },
          nonces: chain.nonces,
          signerFor: this.signerFor,
          wallets: () => this.wallets(),
          tagContext: (force?: boolean) => this.tagContext(chain.key, force),
        },
        (event) => onCopyEvent(event, chain)
      );
      this.engines.set(chain.key, engine);

      await this.primeCopyPool(chain.key);

      const watcher = new LogWatcher({
        wsUrl:
          process.env[`WS_URL_${chain.key.toUpperCase()}`] ||
          this.config.copy.wsUrl ||
          deriveWsUrl(chain.rpc.readUrl),
        httpUrl: chain.rpc.readUrl,
        targets: targets.addresses(),
        onMint: (event: LogEvent) => {
          void engine.handleSignal(event).catch((err) => {
            onStatus(`${chain.name} copy handler failed: ${(err as Error).message}`, "warn");
          });
        },
        onStatus: (message, level) => onStatus(`[${chain.name}] ${message}`, level),
      });

      this.watchers.set(chain.key, watcher);
      await watcher.start();
    }
  }

  /** Prime nonces for every wallet copy-mint could draw on, on one chain. */
  async primeCopyPool(chainKey?: string): Promise<void> {
    const chain = this.chain(chainKey);
    const ctx = await this.tagContext(chain.key, true);
    const pool = resolveForAutoFire(this.config.copy.walletSelector, this.wallets(), ctx);
    await this.primeNonces(pool.selected, chain.key);
  }

  async retargetWatchers(): Promise<void> {
    const list = targets.addresses();
    for (const watcher of this.watchers.values()) {
      await watcher.retarget(list);
    }
  }

  stopCopy(): void {
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    this.engines.clear();
  }

  get watching(): boolean {
    return this.watchers.size > 0;
  }
}
