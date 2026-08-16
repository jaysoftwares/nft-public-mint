// Find real SeaDrop collections to test against, straight from chain state.
//
//   npm run find-drops -- --chain base
//   npm run find-drops -- --chain base --blocks 400000
//
// Every SeaDrop event — PublicDropUpdated, AllowListUpdated, SeaDropMint,
// SignedMintValidationParamsUpdated and the rest — carries nftContract as its
// first indexed parameter. So scanning the singleton's own logs and reading
// topic1 enumerates every collection that has ever configured a drop, without
// needing to know or match individual event signatures.
//
// Each candidate is then read back through the same code paths the bot uses, so
// what this prints is exactly what /mint, /check and /probe would see.

import { formatEther } from "ethers";
import { config as loadEnv } from "dotenv";
import { CHAINS, resolveChain } from "../chains";
import { resolveRpcsForChain, planRpcs } from "../rpc-resolver";
import { rpcCall, hostOf } from "../core/rpc";
import { SEADROP_ADDRESS, fetchPublicDrop } from "../seadrop-public";
import { fetchAllowListRoot, ZERO_ROOT } from "../core/allowlist";
import { fetchSigners } from "../core/signed-mint";

loadEnv();

interface Candidate {
  contract: string;
  lastBlock: number;
  publicDrop?: {
    price: bigint;
    startTime: number;
    endTime: number;
    cap: number;
    live: boolean;
    upcoming: boolean;
  };
  hasAllowList?: boolean;
  signerCount?: number;
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function fmtTime(seconds: number): string {
  if (seconds === 0) return "—";
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function relative(seconds: number): string {
  const delta = seconds * 1000 - Date.now();
  const abs = Math.abs(delta);
  const unit =
    abs < 60_000
      ? `${Math.round(abs / 1000)}s`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)}m`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)}h`
          : `${Math.round(abs / 86_400_000)}d`;
  return delta > 0 ? `in ${unit}` : `${unit} ago`;
}

async function main(): Promise<void> {
  const chainKey = (arg("chain") ?? process.env.CHAIN ?? "base").toLowerCase();
  const lookback = Number(arg("blocks") ?? 200_000);
  const limit = Number(arg("limit") ?? 40);

  const chain = resolveChain(chainKey);
  if (!chain) {
    console.error(`\nUnknown chain "${chainKey}". Known: ${CHAINS.map((c) => c.key).join(", ")}\n`);
    process.exit(1);
  }

  const plan = await planRpcs(resolveRpcsForChain(chainKey).urls, chain.chainId);
  if (plan.urls.length === 0) {
    console.error(`\nNo usable RPC for ${chain.name}.\n`);
    process.exit(1);
  }
  const readUrl = plan.urls[0];

  console.log(`\n\x1b[1mSeaDrop collections on ${chain.name}\x1b[0m`);
  console.log(`\x1b[90mreading ${hostOf(readUrl)} · SeaDrop ${SEADROP_ADDRESS}\x1b[0m\n`);

  // Is SeaDrop even deployed here? A drop tool aimed at a singleton that does
  // not exist on this chain is worth finding out about immediately.
  const code = await rpcCall<string>(readUrl, "eth_getCode", [SEADROP_ADDRESS, "latest"]);
  if (!code || code === "0x") {
    console.log(`\x1b[31mSeaDrop is NOT deployed at that address on ${chain.name}.\x1b[0m`);
    console.log(`Collections here must use a different mint contract — the SeaDrop paths`);
    console.log(`(public, allowlist and signed) cannot apply.\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m✓\x1b[0m SeaDrop deployed (${(code.length - 2) / 2} bytes of code)\n`);

  const head = Number(BigInt(await rpcCall<string>(readUrl, "eth_blockNumber", [])));
  const from = Math.max(0, head - lookback);
  console.log(`Scanning blocks ${from} → ${head} (${lookback} blocks, ~${Math.round(lookback / 43_200)}d)`);

  // Address-filtered scans tolerate wide ranges; the shakedown measured 10k on
  // Base's public endpoint, and paid providers allow more.
  const seen = new Map<string, number>();
  const chunk = 10_000;
  let scanned = 0;

  for (let start = from; start <= head; start += chunk) {
    const end = Math.min(start + chunk - 1, head);
    try {
      const logs = await rpcCall<{ topics: string[]; blockNumber: string }[]>(
        readUrl,
        "eth_getLogs",
        [
          {
            address: SEADROP_ADDRESS,
            fromBlock: `0x${start.toString(16)}`,
            toBlock: `0x${end.toString(16)}`,
          },
        ],
        30_000
      );
      for (const log of logs) {
        // topic1 is nftContract on every SeaDrop event.
        if (!log.topics[1]) continue;
        const contract = `0x${log.topics[1].slice(-40)}`;
        const block = parseInt(log.blockNumber, 16);
        const previous = seen.get(contract) ?? 0;
        if (block > previous) seen.set(contract, block);
      }
    } catch (err) {
      process.stdout.write(`\r  \x1b[33m!\x1b[0m ${start}-${end}: ${(err as Error).message.slice(0, 50)}\n`);
    }
    scanned += end - start + 1;
    process.stdout.write(
      `\r  ${Math.round((scanned / lookback) * 100)}% · ${seen.size} collection(s) found   `
    );
  }
  process.stdout.write("\n\n");

  if (seen.size === 0) {
    console.log(`\x1b[33mNo SeaDrop activity in the last ${lookback} blocks.\x1b[0m`);
    console.log(`Try a wider window: --blocks 1000000\n`);
    process.exit(0);
  }

  // Newest activity first — a recently configured drop is the useful one.
  const ordered = [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([contract, lastBlock]) => ({ contract, lastBlock }));

  console.log(`Inspecting the ${ordered.length} most recently active…\n`);

  const now = Math.floor(Date.now() / 1000);
  const candidates: Candidate[] = [];

  for (const { contract, lastBlock } of ordered) {
    const candidate: Candidate = { contract, lastBlock };
    try {
      const drop = await fetchPublicDrop(readUrl, contract);
      if (drop) {
        candidate.publicDrop = {
          price: drop.mintPrice,
          startTime: drop.startTime,
          endTime: drop.endTime,
          cap: drop.maxTotalMintableByWallet,
          live: now >= drop.startTime && now < drop.endTime,
          upcoming: now < drop.startTime,
        };
      }
    } catch {
      /* not readable — reported by omission */
    }
    try {
      const root = await fetchAllowListRoot(readUrl, contract);
      candidate.hasAllowList = BigInt(root) !== BigInt(ZERO_ROOT);
    } catch {
      /* ignore */
    }
    try {
      candidate.signerCount = (await fetchSigners(readUrl, contract)).length;
    } catch {
      /* ignore */
    }
    candidates.push(candidate);
    process.stdout.write(`\r  ${candidates.length}/${ordered.length}   `);
  }
  process.stdout.write("\r                    \r");

  const live = candidates.filter((c) => c.publicDrop?.live);
  const upcoming = candidates.filter((c) => c.publicDrop?.upcoming);
  const allowlist = candidates.filter((c) => c.hasAllowList);
  const signed = candidates.filter((c) => (c.signerCount ?? 0) > 0);

  const show = (label: string, list: Candidate[], why: string): void => {
    console.log(`\x1b[1m${label}\x1b[0m  \x1b[90m${why}\x1b[0m`);
    if (list.length === 0) {
      console.log(`  none\n`);
      return;
    }
    for (const c of list.slice(0, 10)) {
      const d = c.publicDrop;
      console.log(`  ${c.contract}`);
      if (d) {
        const price = d.price === 0n ? "FREE" : `${formatEther(d.price)} ETH`;
        console.log(
          `    \x1b[90mpublic: ${price} · cap ${d.cap || "∞"}/wallet · ` +
            `${fmtTime(d.startTime)} (${relative(d.startTime)}) → ${fmtTime(d.endTime)}\x1b[0m`
        );
      }
      const extras: string[] = [];
      if (c.hasAllowList) extras.push("allowlist stage");
      if ((c.signerCount ?? 0) > 0) extras.push(`${c.signerCount} signer(s)`);
      if (extras.length > 0) console.log(`    \x1b[90m${extras.join(" · ")}\x1b[0m`);
    }
    console.log("");
  };

  show("LIVE PUBLIC", live, "→ testable with /mint right now");
  show("UPCOMING PUBLIC", upcoming, "→ testable with /mint … wait");
  show("ALLOWLIST STAGE", allowlist, "→ testable with /check (read-only, free)");
  show("SIGNED STAGE", signed, "→ testable with /probe");

  console.log(`\x1b[1mSummary\x1b[0m`);
  console.log(`  ${candidates.length} inspected · ${live.length} live public · ${upcoming.length} upcoming`);
  console.log(`  ${allowlist.length} with an allowlist · ${signed.length} with signers\n`);

  const cheapest = live
    .filter((c) => c.publicDrop)
    .sort((a, b) => (a.publicDrop!.price < b.publicDrop!.price ? -1 : 1))[0];
  if (cheapest) {
    console.log(`\x1b[1mSuggested money test\x1b[0m`);
    console.log(`  npm run shakedown -- --chain ${chainKey} --contract ${cheapest.contract}`);
    console.log(
      `  \x1b[90mthen /mint ${cheapest.contract} 1 0-2 — ` +
        `${cheapest.publicDrop!.price === 0n ? "free" : formatEther(cheapest.publicDrop!.price) + " ETH"} per wallet\x1b[0m\n`
    );
  }
  if (allowlist.length > 0) {
    console.log(`\x1b[1mSuggested free test (allowlist parser)\x1b[0m`);
    console.log(`  npm run shakedown -- --chain ${chainKey} --contract ${allowlist[0].contract}\n`);
  }
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
