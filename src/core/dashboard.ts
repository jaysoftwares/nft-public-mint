// What the dashboard counts, with no Telegram in sight.
//
// The numbers on that one screen come from four sources that each know a
// different part of the answer: the wallet store knows identities, every chain
// knows its own balances, the ledger knows what was spent, and the watch list
// knows what fired. Joining them is arithmetic — and arithmetic that decides
// whether an operator believes their wallets are funded is worth testing
// offline, so it lives here as pure functions and the rendering lives next to
// the bot.
//
// Three rules run through all of it:
//
//   · An unreadable balance is not a zero. A chain that would not answer is
//     reported as unread rather than as five hundred empty wallets — the same
//     reason resolveForAutoFire refuses to call an unknown balance empty. That
//     confusion is exactly what produced "I funded it but it says no funds".
//   · The funder is not a minting wallet. It holds the campaign's ETH and never
//     fires, so counting it among the funded set overstates what can actually
//     mint, every time, by one.
//   · Funded means funded *somewhere*. Three chains are live at once and a
//     wallet holding gas on Robinhood is usable, whatever Base says about it.

import { LedgerEntry } from "./ledger";

/** The parts of a stored wallet the dashboard needs. */
export interface WalletFacts {
  id: string;
  address: string;
  kind: string;
  autoFire: boolean;
}

/** One chain's contribution, as read a moment ago. */
export interface ChainReading {
  key: string;
  name: string;
  symbol: string;
  /** The bar a wallet must clear to count as funded — the gas reservation. */
  minFundedWei: bigint;
  /** Address → balance. Undefined means the chain could not be read at all. */
  balances?: Map<string, bigint>;
}

export interface WalletCounts {
  /** Minting wallets — everything except the funder. */
  total: number;
  derived: number;
  imported: number;
  /** Armed for autonomous firing. */
  armed: number;
  manual: number;
}

export interface ChainFunding {
  key: string;
  name: string;
  symbol: string;
  /** False when the chain did not answer; every count below is then zero. */
  read: boolean;
  funded: number;
  empty: number;
  /** Wallets this chain returned no balance for — neither funded nor empty. */
  unknown: number;
  /** Held by the minting wallets, excluding the funder. */
  totalWei: bigint;
  funderWei: bigint;
  minFundedWei: bigint;
}

export interface FundingSummary {
  chains: ChainFunding[];
  /** Minting wallets clearing the reservation on at least one readable chain. */
  fundedAnywhere: number;
  /** Armed *and* funded — the set a copy signal can actually spend. */
  readyToFire: number;
  /** Everything the minting wallets hold, summed over readable chains. */
  totalWei: bigint;
  funderWei: bigint;
  chainsRead: number;
  /** No chain answered, so "0 funded" would be a guess rather than a count. */
  blind: boolean;
}

export interface MintSummary {
  /** Ledger entries — one per drop fired at. */
  runs: number;
  /** Accepted wallet transactions across those runs. */
  txs: number;
  /** NFTs, where the path recorded a quantity; one per transaction otherwise. */
  nfts: number;
  collections: number;
  spentWei: bigint;
  lastAt?: number;
}

export interface CopyState {
  enabled: boolean;
  targets: number;
  /** Fires ever recorded against the watch list, landed or not. */
  fires: number;
}

export interface DayWindow {
  /** Spending the bot decided on alone — what the daily cap measures. */
  autoSpentWei: bigint;
  /** Spending the operator asked for, which the cap deliberately ignores. */
  manualSpentWei: bigint;
  capWei: bigint;
  mintRuns: number;
  copyRuns: number;
  fundedWei: bigint;
}

export interface DashboardStats {
  wallets: WalletCounts;
  funding: FundingSummary;
  /** Every mint this user has run. */
  minted: MintSummary;
  /** The copy-driven subset of the above. */
  copied: MintSummary;
  copy: CopyState;
  day: DayWindow;
  generatedAt: number;
}

export interface DashboardInput {
  wallets: WalletFacts[];
  /** The funding wallet's address, excluded from the minting set. */
  funder: string;
  chains: ChainReading[];
  ledger: LedgerEntry[];
  targets: { fires: number }[];
  copyEnabled: boolean;
  capDailyWei: bigint;
  now?: number;
}

const DAY_MS = 24 * 3_600_000;

/** Percentage, rounded, and never NaN when the denominator is zero. */
export function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/**
 * Roll up a set of ledger entries.
 *
 * `quantity` is optional on purpose: copy-mint replays someone else's calldata
 * and cannot always decode how many it bought, and entries written before the
 * field existed have none either. Both cases count one NFT per transaction —
 * an undercount is honest in a way that inventing mints would not be.
 */
export function summariseMints(entries: LedgerEntry[]): MintSummary {
  const collections = new Set<string>();
  let txs = 0;
  let nfts = 0;
  let spentWei = 0n;
  let lastAt: number | undefined;

  for (const entry of entries) {
    txs += entry.walletIds.length;
    nfts += Math.max(1, entry.quantity ?? 1) * entry.walletIds.length;
    spentWei += BigInt(entry.valueWei);
    if (entry.contract) collections.add(entry.contract.toLowerCase());
    if (lastAt === undefined || entry.ts > lastAt) lastAt = entry.ts;
  }

  return { runs: entries.length, txs, nfts, collections: collections.size, spentWei, lastAt };
}

function fundingFor(
  minters: WalletFacts[],
  funder: string,
  chains: ChainReading[]
): FundingSummary {
  const fundedSomewhere = new Set<string>();
  const rows: ChainFunding[] = [];
  let totalWei = 0n;
  let funderWei = 0n;

  for (const chain of chains) {
    const row: ChainFunding = {
      key: chain.key,
      name: chain.name,
      symbol: chain.symbol,
      read: chain.balances !== undefined,
      funded: 0,
      empty: 0,
      unknown: 0,
      totalWei: 0n,
      funderWei: 0n,
      minFundedWei: chain.minFundedWei,
    };

    if (chain.balances) {
      // Balances come back keyed by the store's checksummed address; matching
      // case-insensitively means a differently-cased funder in config.json
      // cannot silently land in the minting set.
      const byAddress = new Map<string, bigint>();
      for (const [address, wei] of chain.balances) byAddress.set(address.toLowerCase(), wei);

      for (const wallet of minters) {
        const balance = byAddress.get(wallet.address.toLowerCase());
        if (balance === undefined) {
          row.unknown += 1;
          continue;
        }
        row.totalWei += balance;
        if (balance >= chain.minFundedWei && balance > 0n) {
          row.funded += 1;
          fundedSomewhere.add(wallet.id);
        } else {
          row.empty += 1;
        }
      }

      row.funderWei = byAddress.get(funder.toLowerCase()) ?? 0n;
      totalWei += row.totalWei;
      funderWei += row.funderWei;
    }

    rows.push(row);
  }

  const chainsRead = rows.filter((r) => r.read).length;
  return {
    chains: rows,
    fundedAnywhere: fundedSomewhere.size,
    readyToFire: minters.filter((w) => w.autoFire && fundedSomewhere.has(w.id)).length,
    totalWei,
    funderWei,
    chainsRead,
    blind: chainsRead === 0,
  };
}

export function collectDashboard(input: DashboardInput): DashboardStats {
  const now = input.now ?? Date.now();
  const funder = input.funder.toLowerCase();
  const minters = input.wallets.filter((w) => w.address.toLowerCase() !== funder);

  const mints = input.ledger.filter((e) => e.kind === "mint");
  const auto = mints.filter((e) => e.auto === true);
  const recent = input.ledger.filter((e) => now - e.ts < DAY_MS);
  const recentMints = recent.filter((e) => e.kind === "mint");

  const sum = (entries: LedgerEntry[]): bigint =>
    entries.reduce((total, e) => total + BigInt(e.valueWei), 0n);

  return {
    wallets: {
      total: minters.length,
      derived: minters.filter((w) => w.kind === "derived").length,
      imported: minters.filter((w) => w.kind !== "derived").length,
      armed: minters.filter((w) => w.autoFire).length,
      manual: minters.filter((w) => !w.autoFire).length,
    },
    funding: fundingFor(minters, input.funder, input.chains),
    minted: summariseMints(mints),
    copied: summariseMints(auto),
    copy: {
      enabled: input.copyEnabled,
      targets: input.targets.length,
      fires: input.targets.reduce((total, t) => total + (t.fires ?? 0), 0),
    },
    day: {
      autoSpentWei: sum(recentMints.filter((e) => e.auto === true)),
      manualSpentWei: sum(recentMints.filter((e) => e.auto !== true)),
      capWei: input.capDailyWei,
      mintRuns: recentMints.length,
      copyRuns: recentMints.filter((e) => e.auto === true).length,
      fundedWei: sum(recent.filter((e) => e.kind === "fund")),
    },
    generatedAt: now,
  };
}
