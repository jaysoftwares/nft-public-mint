// Check balances for addresses across every configured chain.
//
//   npm run balances -- 0xAAA 0xBBB 0xCCC
//   npm run balances -- --file addresses.txt
//
// No passphrase and no wallet store — addresses are public, so this is safe to
// run anywhere and safe to share the output of.
//
// It reports every chain rather than just the one you meant, because the most
// common funding mistake is sending on the wrong network. Money that landed on
// Ethereum instead of Base is invisible to a Base-only check, and the symptom
// at mint time is an unhelpful "wallet is underfunded".

import { readFileSync } from "node:fs";
import { formatEther, isAddress, getAddress } from "ethers";
import { config as loadEnv } from "dotenv";
import { CHAINS } from "../chains";
import { resolveRpcsForChain, planRpcs } from "../rpc-resolver";
import { fetchBalances } from "../core/balances";
import { gasReservation } from "../core/balances";

loadEnv();

const g = (t: string): string => `\x1b[32m${t}\x1b[0m`;
const y = (t: string): string => `\x1b[33m${t}\x1b[0m`;
const dim = (t: string): string => `\x1b[90m${t}\x1b[0m`;
const b = (t: string): string => `\x1b[1m${t}\x1b[0m`;

function collectAddresses(): string[] {
  const argv = process.argv.slice(2);
  const fileIndex = argv.indexOf("--file");
  const raw =
    fileIndex !== -1 && argv[fileIndex + 1]
      ? readFileSync(argv[fileIndex + 1], "utf8")
      : argv.join(" ");

  // Pull addresses out of whatever shape they arrive in — a bare list, or a
  // pasted `wallets list` table with index prefixes and trailing flags.
  const found = raw.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of found) {
    if (!isAddress(candidate)) continue;
    const normalised = getAddress(candidate);
    if (seen.has(normalised.toLowerCase())) continue;
    seen.add(normalised.toLowerCase());
    unique.push(normalised);
  }
  return unique;
}

async function main(): Promise<void> {
  const addresses = collectAddresses();
  if (addresses.length === 0) {
    console.error("\nUsage: npm run balances -- 0xAAA 0xBBB   (or --file list.txt)\n");
    process.exit(1);
  }

  const gasLimit = Number(process.env.GAS_LIMIT ?? 250_000);
  const maxFeeGwei = process.env.MAX_FEE_PER_GAS ?? "2";
  const required = gasReservation(gasLimit, BigInt(Math.round(Number(maxFeeGwei) * 1e9)));

  console.log(`\n${b("Balances")} — ${addresses.length} address(es)`);
  console.log(dim(`armed threshold ${formatEther(required)} ETH  (${gasLimit} gas × ${maxFeeGwei} gwei)\n`));

  const totals = new Map<string, bigint>();
  const perChain = new Map<string, Map<string, bigint>>();

  for (const profile of CHAINS) {
    let readUrl: string;
    try {
      const plan = await planRpcs(resolveRpcsForChain(profile.key).urls, profile.chainId);
      if (plan.urls.length === 0) {
        console.log(`${b(profile.name)}  ${y("no usable endpoint")}`);
        continue;
      }
      readUrl = plan.urls[0];
    } catch {
      console.log(`${b(profile.name)}  ${y("unreachable")}`);
      continue;
    }

    const balances = await fetchBalances(
      readUrl,
      addresses.map((address, i) => ({ id: String(i), address }))
    );
    perChain.set(profile.key, balances);

    let total = 0n;
    for (const address of addresses) total += balances.get(address) ?? 0n;
    totals.set(profile.key, total);
  }

  // One row per address, one column per chain that holds anything — plus the
  // armed verdict, which is what actually gates a mint.
  const funded = CHAINS.filter((c) => (totals.get(c.key) ?? 0n) > 0n);

  addresses.forEach((address, i) => {
    const parts: string[] = [];
    for (const profile of CHAINS) {
      const balance = perChain.get(profile.key)?.get(address) ?? 0n;
      if (balance > 0n) parts.push(`${profile.name} ${formatEther(balance)}`);
    }
    const baseBalance = perChain.get("base")?.get(address) ?? 0n;
    const armed = baseBalance >= required;
    console.log(
      `  ${String(i).padStart(2)}  ${address}  ` +
        (parts.length > 0 ? parts.join(" · ") : dim("empty")) +
        (armed ? `  ${g("armed")}` : "")
    );
  });

  console.log("");
  for (const profile of CHAINS) {
    const total = totals.get(profile.key);
    if (total === undefined) continue;
    const armedCount = addresses.filter(
      (a) => (perChain.get(profile.key)?.get(a) ?? 0n) >= required
    ).length;
    console.log(
      `${b(profile.name.padEnd(16))} ${formatEther(total).padStart(12)} ETH   ` +
        `${armedCount}/${addresses.length} armed`
    );
  }

  if (funded.length > 1) {
    console.log(
      `\n${y("!")} Balances found on more than one chain — check that is intentional.`
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
