// OpenSea drop reconnaissance, from the command line.
//
//   npm run probe -- --chain base --contract 0xNFT
//   npm run probe -- --chain base --contract 0xNFT --minter 0xWallet
//
// Read-only. Nothing is signed or sent, and no wallet store is needed — this is
// the same path /probe uses inside the bot, exposed so the OpenSea integration
// can be tested before any of the Telegram machinery is running.
//
// The interesting answer is whether OpenSea hands over calldata *right now*.
// Before a stage opens it refuses, which is the constraint that forces the fetch
// into the critical path at T-0.

import { formatEther, Wallet } from "ethers";
import { config as loadEnv } from "dotenv";
import { CHAINS, resolveChain } from "../chains";
import { resolveRpcsForChain, planRpcs } from "../rpc-resolver";
import { fetchPublicDrop } from "../seadrop-public";
import { fetchSigners } from "../core/signed-mint";
import { fetchAllowListRoot, ZERO_ROOT } from "../core/allowlist";
import {
  slugForContract,
  fetchDrop,
  probeIssuance,
  stageIsLive,
  describeStage,
  fetchMintCalldata,
  OpenSeaApiError,
  CHAIN_SLUGS,
} from "../core/opensea-api";
import { inspectCalldata } from "../core/mint-opensea";

loadEnv();

const g = (t: string): string => `\x1b[32m${t}\x1b[0m`;
const y = (t: string): string => `\x1b[33m${t}\x1b[0m`;
const r = (t: string): string => `\x1b[31m${t}\x1b[0m`;
const dim = (t: string): string => `\x1b[90m${t}\x1b[0m`;
const b = (t: string): string => `\x1b[1m${t}\x1b[0m`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const chainKey = (arg("chain") ?? process.env.CHAIN ?? "robinhood").toLowerCase();
  const contract = arg("contract");
  const slugArg = arg("slug");
  const quantity = Number(arg("qty") ?? 1);

  if (!contract) {
    console.error("\nUsage: npm run probe -- --chain base --contract 0xNFT [--minter 0x…]\n");
    process.exit(1);
  }

  const chain = resolveChain(chainKey);
  if (!chain) {
    console.error(`\nUnknown chain "${chainKey}". Known: ${CHAINS.map((c) => c.key).join(", ")}\n`);
    process.exit(1);
  }

  const apiKey = (process.env.OPENSEA_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("\nOPENSEA_API_KEY is not set in .env\n");
    process.exit(1);
  }

  // A throwaway address is a deliberate default: it shows what an *unentitled*
  // wallet is offered, which distinguishes an open public stage from a gated
  // one. Pass --minter to ask about a wallet you actually hold.
  const minter = arg("minter") ?? Wallet.createRandom().address;
  const usingThrowaway = arg("minter") === undefined;

  console.log(`\n${b("OpenSea probe")} — ${chain.name}`);
  console.log(dim(`contract ${contract}`));
  console.log(dim(`minter   ${minter}${usingThrowaway ? " (throwaway)" : ""}`));
  console.log(dim(`api key  ${apiKey.slice(0, 4)}…${apiKey.slice(-4)}\n`));

  const plan = await planRpcs(resolveRpcsForChain(chainKey).urls, chain.chainId);
  const readUrl = plan.urls[0];

  // ── On-chain truth first ──
  console.log(b("On chain"));
  try {
    const drop = await fetchPublicDrop(readUrl, contract);
    if (drop) {
      const live = Date.now() / 1000 >= drop.startTime && Date.now() / 1000 < drop.endTime;
      console.log(
        `  ${g("✓")} public stage · ${drop.mintPrice === 0n ? "FREE" : formatEther(drop.mintPrice) + " ETH"}` +
          ` · cap ${drop.maxTotalMintableByWallet || "∞"} · ${live ? g("LIVE") : y("not live")}`
      );
    } else {
      console.log(`  ${dim("no public stage on the SeaDrop singleton")}`);
    }
  } catch {
    console.log(`  ${y("!")} could not read the public stage`);
  }

  try {
    const root = await fetchAllowListRoot(readUrl, contract);
    console.log(
      BigInt(root) === BigInt(ZERO_ROOT)
        ? `  ${dim("no allowlist root — no merkle stage")}`
        : `  ${g("✓")} allowlist root ${root.slice(0, 18)}…`
    );
  } catch {
    console.log(`  ${dim("allowlist root unreadable")}`);
  }

  try {
    const signers = await fetchSigners(readUrl, contract);
    console.log(
      signers.length > 0
        ? `  ${g("✓")} ${signers.length} registered signer(s) — a signed stage exists\n    ${dim(signers.join(", "))}`
        : `  ${dim("no registered signers")}`
    );
  } catch {
    console.log(`  ${dim("signers unreadable")}`);
  }

  // ── OpenSea's view ──
  console.log(`\n${b("OpenSea")}`);
  const chainSlug = CHAIN_SLUGS[chain.chainId];
  if (!chainSlug) {
    console.log(`  ${r("✗")} OpenSea has no slug for chain ${chain.chainId}`);
    process.exit(1);
  }

  let slug = slugArg;
  if (!slug) {
    slug = await slugForContract(apiKey, chain.chainId, contract);
    if (!slug) {
      console.log(`  ${r("✗")} OpenSea does not recognise this contract on ${chainSlug}`);
      console.log(dim(`      pass --slug if you know the collection slug`));
      process.exit(1);
    }
  }
  console.log(`  ${g("✓")} collection slug ${b(slug)}`);

  try {
    const drop = await fetchDrop(apiKey, slug);
    console.log(`  ${g("✓")} ${drop.collection_name ?? slug} · ${drop.drop_type}`);
    console.log(
      `    ${dim(`minting: ${drop.is_minting} · supply ${drop.total_supply ?? "?"}/${drop.max_supply ?? "?"}`)}`
    );
    if (drop.stages.length === 0) {
      console.log(`    ${dim("no stages listed")}`);
    }
    for (const stage of drop.stages) {
      const live = stageIsLive(stage);
      console.log(
        `    ${live ? g("▸") : dim("·")} ${describeStage(stage)}` +
          ` · ${stage.price ? stage.price : "?"} · max ${stage.max_per_wallet}`
      );
      console.log(`      ${dim(`${stage.start_time} → ${stage.end_time}`)}`);
    }
  } catch (err) {
    const e = err as OpenSeaApiError;
    console.log(`  ${y("!")} drop detail unavailable — ${e.message}`);
    if (e.body) console.log(dim(`      ${e.body.slice(0, 200)}`));
  }

  // ── The decisive question ──
  console.log(`\n${b("Will it issue calldata now?")}`);
  const result = await probeIssuance(apiKey, slug, minter, quantity);

  if (result.available) {
    console.log(`  ${g("✓ YES")} — ${result.detail}`);

    // Show what it actually handed over, and run it through the same inspection
    // the mint path uses.
    try {
      const tx = await fetchMintCalldata(apiKey, slug, minter, quantity);
      console.log(`\n${b("Returned calldata")}`);
      console.log(`  to    ${tx.to}`);
      console.log(`  value ${formatEther(tx.value)} ETH`);
      console.log(`  data  ${tx.data.slice(0, 10)}… (${(tx.data.length - 2) / 2} bytes)`);

      const check = inspectCalldata(tx, contract, minter);
      if (check.ok) {
        console.log(`  ${g("✓")} inspection passed${check.method ? ` · ${check.method}` : ""}`);
        if (check.reason) console.log(`    ${dim(check.reason)}`);
        if (check.creditedTo) console.log(`    ${dim(`credits ${check.creditedTo}`)}`);
      } else {
        console.log(`  ${r("✗")} inspection FAILED — ${check.reason}`);
        console.log(dim(`      the mint path would refuse to sign this`));
      }
    } catch (err) {
      console.log(`  ${y("!")} second fetch failed — ${(err as Error).message}`);
    }
  } else {
    const kind = result.kind ?? "unknown";
    const colour = kind === "auth" ? r : y;
    console.log(`  ${colour("✗ NO")} (${kind}) — ${result.detail}`);
    if (result.body) console.log(dim(`      raw: ${result.body.slice(0, 300)}`));
    if (kind === "not_eligible" && usingThrowaway) {
      console.log(
        dim(`      expected for a throwaway address on a gated stage.`)
      );
      console.log(dim(`      re-run with --minter <a wallet you hold> to test eligibility.`));
    }
    if (kind === "auth") {
      console.log(dim(`      check OPENSEA_API_KEY in .env`));
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
