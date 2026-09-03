// Chain registry — everything chain-specific lives here so adding a new
// network is a single entry instead of hunting for hardcoded values.
//
// `key` is the identifier used in three places, and they must match:
//   1. the OpenSea GraphQL `chain` field (opensea-api.ts)
//   2. the `--chain` CLI option
//   3. the `CHAIN` env var
//
// OpenSea confirmed support for Robinhood Chain (opensea.io/discover/chain/robinhood)
// and for Ink: /chain/ink/contract/… resolves to ChainIdentifier(chainId=57073),
// so the OpenSea-based mint flow works on both unchanged. SeaDrop 1.0 is deployed
// at the usual singleton address on Ink too, so the public path works there as well.
// Base was removed 2026-09-03 at the operator's request; nothing here assumed it
// except the fallback explorer below.

export interface ChainProfile {
  key: string;          // OpenSea id + --chain value + CHAIN env value
  chainId: number;      // EVM network chain id
  name: string;         // human label
  explorer: string;     // block explorer base URL, NO trailing slash
  nativeSymbol: string;
  rpc: {
    alchemyHost?: string; // Alchemy host for this network (docs/reference)
    public: string[];     // public RPC + sequencer endpoints
  };
}

export const CHAINS: ChainProfile[] = [
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum",
    explorer: "https://etherscan.io",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "eth-mainnet.g.alchemy.com",
      public: [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.merkle.io",
        "https://cloudflare-eth.com",
      ],
    },
  },
  {
    key: "ink",
    chainId: 57073,
    name: "Ink",
    explorer: "https://explorer.inkonchain.com",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "ink-mainnet.g.alchemy.com",
      // All three verified live 2026-09-03: each answers eth_chainId with 57073
      // and serves eth_feeHistory, which the fee oracle needs. Ink publishes no
      // separate sequencer hostname, so every endpoint here is a provider and
      // dispatch shards across them rather than favouring one.
      //
      // Order matters more than it looks. The first entry becomes the read URL,
      // and wsUrlFor derives the socket from it by rewriting https to wss — so
      // leading with a host that serves no WebSocket costs push delivery for
      // the whole chain. rpc-gel is exactly that host: it answers HTTP fine and
      // refuses the upgrade, which dropped copy-mint to 750ms polling and then
      // to "Your IP has exceeded its request rate limit". The two that do
      // accept eth_subscribe lead instead.
      public: [
        "https://rpc-qnd.inkonchain.com",
        "https://ink.drpc.org",
        "https://rpc-gel.inkonchain.com",
      ],
    },
  },
  {
    key: "robinhood",
    chainId: 4663,
    name: "Robinhood Chain",
    explorer: "https://robinhoodchain.blockscout.com",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "robinhood-mainnet.g.alchemy.com",
      public: [
        "https://rpc.mainnet.chain.robinhood.com",
        "https://sequencer.mainnet.chain.robinhood.com",
      ],
    },
  },
];

// Ethereum, because it is the one chain in this list that cannot be removed
// out from under the fallback.
const DEFAULT_EXPLORER = "https://etherscan.io";

// Resolve a chain by its numeric chainId (from the live network) or by its
// string key (--chain / CHAIN). Returns undefined for unknown chains.
export function resolveChain(
  idOrKey: string | number | bigint | null | undefined
): ChainProfile | undefined {
  if (idOrKey === null || idOrKey === undefined) return undefined;
  if (typeof idOrKey === "string") {
    const key = idOrKey.trim().toLowerCase();
    return CHAINS.find((c) => c.key === key);
  }
  const id = Number(idOrKey);
  return CHAINS.find((c) => c.chainId === id);
}

// Build a block-explorer tx URL for whatever chain we're on. Accepts either the
// numeric chainId (preferred — it's authoritative) or the chain key. Falls back
// to Etherscan for unknown chains so links are never broken silently.
export function explorerTx(
  idOrKey: string | number | bigint | null | undefined,
  txHash: string
): string {
  const profile = resolveChain(idOrKey);
  const base = profile?.explorer ?? DEFAULT_EXPLORER;
  return `${base}/tx/${txHash}`;
}
