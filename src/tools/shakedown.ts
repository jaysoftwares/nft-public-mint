// Live, read-only shakedown.
//
//   npm run shakedown -- --chain base
//   npm run shakedown -- --chain base --contract 0xNFT
//   npm run shakedown -- --chain base --watch 60
//
// Everything the offline self-test cannot reach: whether the RPC endpoints
// actually work, whether the provider supports the batching the nonce manager
// depends on, how big an eth_getLogs range it tolerates, whether a WebSocket
// stays up, and whether the allowlist parser copes with a real published file.
//
// Nothing here signs, spends, or needs a private key. It reads. Failures are
// reported with the specific consequence for the bot rather than as a stack
// trace, because the point is to find out what breaks before money is involved.

import { formatEther } from "ethers";
import { config as loadEnv } from "dotenv";
import { CHAINS, resolveChain } from "../chains";
import { resolveRpcsForChain, planRpcs, maskRpc } from "../rpc-resolver";
import { rpcCall, rpcBatch, rpcBatchChunked, post, hostOf } from "../core/rpc";
import { classifyEndpoints } from "../core/dispatcher";
import { buildLocalMintPlan } from "../seadrop-public";
import {
  fetchAllowListRoot,
  findAllowListUri,
  toHttpUrl,
  parseAllowList,
  checkEligibility,
  computeLeaf,
  buildTree,
  ZERO_ROOT,
} from "../core/allowlist";
import { fetchSigners } from "../core/signed-mint";
import { ERC721_TRANSFER, deriveWsUrl } from "../core/log-watcher";

loadEnv();

let warnings = 0;
let failures = 0;

function ok(label: string, detail = ""): void {
  console.log(`  [32m✓[0m ${label}${detail ? `  ${detail}` : ""}`);
}
function warn(label: string, detail = ""): void {
  warnings++;
  console.log(`  [33m![0m ${label}${detail ? `  ${detail}` : ""}`);
}
function bad(label: string, detail = ""): void {
  failures++;
  console.log(`  [31m✗[0m ${label}${detail ? `  ${detail}` : ""}`);
}
function section(name: string): void {
  console.log(`\n[1m${name}[0m`);
}
function note(text: string): void {
  console.log(`    [90m${text}[0m`);
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const chainKey = (arg("chain") ?? process.env.CHAIN ?? "base").toLowerCase();
  const contract = arg("contract");
  const watchSeconds = Number(arg("watch") ?? 0);

  const chain = resolveChain(chainKey);
  if (!chain) {
    console.error(`\nUnknown chain "${chainKey}". Known: ${CHAINS.map((c) => c.key).join(", ")}\n`);
    process.exit(1);
  }

  console.log(`\n[1mCopymint shakedown[0m — ${chain.name} (chain ${chain.chainId})`);
  console.log(`[90mRead-only. Nothing is signed or sent.[0m`);

  // ── 1. Endpoints ────────────────────────────────────────────────────
  section("1. RPC endpoints");
  const candidates = resolveRpcsForChain(chainKey).urls;
  note(`${candidates.length} candidate(s) from .env + chains.ts`);

  const plan = await planRpcs(candidates, chain.chainId);
  if (plan.urls.length === 0) {
    bad("No usable endpoint", "the bot cannot start");
    finish();
    return;
  }
  plan.verified
    ? ok(`chain id ${chain.chainId} confirmed`)
    : warn("no endpoint confirmed the chain id", "the bot will ask before continuing");

  for (const dropped of plan.dropped) {
    warn(`${hostOf(dropped.url)} is chain ${dropped.chainId}`, "dropped");
  }

  const endpoints = classifyEndpoints(plan.urls);
  const sequencers = endpoints.filter((e) => e.kind === "sequencer");
  const providers = endpoints.filter((e) => e.kind === "provider");

  for (const ep of endpoints) {
    console.log(`    ${ep.kind === "sequencer" ? "▸" : "·"} ${ep.label}  ${maskRpc(ep.url)}`);
  }

  if (sequencers.length === 0) {
    warn(
      "no sequencer endpoint found",
      "dispatch falls back to providers — slower inclusion, and metered"
    );
  } else {
    ok(`${sequencers.length} sequencer, ${providers.length} provider(s)`);
  }

  const readUrl = plan.urls[0];

  // ── 2. Latency ──────────────────────────────────────────────────────
  section("2. Latency");
  note("This is the number that decides where to host. Compare across VPS regions.");
  for (const ep of endpoints) {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = Date.now();
      try {
        await post(ep.url, JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }), 8000);
        samples.push(Date.now() - started);
      } catch {
        /* counted as a miss below */
      }
    }
    if (samples.length === 0) {
      warn(`${ep.label}`, "no response — send-only endpoints often reject eth_chainId");
      continue;
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const detail = `median ${median}ms  (min ${samples[0]}, max ${samples[samples.length - 1]})`;
    median > 250 ? warn(ep.label, detail) : ok(ep.label, detail);
  }

  // ── 3. Batching ─────────────────────────────────────────────────────
  section("3. JSON-RPC batching");
  note("Nonce reconcile checks 500 wallets in one request. Without batching that becomes 500.");
  try {
    const results = await rpcBatch<string>(readUrl, [
      { method: "eth_chainId", params: [] },
      { method: "eth_blockNumber", params: [] },
      { method: "eth_gasPrice", params: [] },
    ]);
    const answered = results.filter((r) => r.result !== undefined).length;
    if (answered === 3) ok("batch of 3 answered");
    else bad(`batch returned ${answered}/3`, "nonce reconcile will not work at scale");

    // Find the practical ceiling, since providers differ and the manager
    // chunks at 100 by default.
    for (const size of [50, 100, 200]) {
      try {
        const big = await rpcBatch<string>(
          readUrl,
          Array.from({ length: size }, () => ({ method: "eth_chainId", params: [] })),
          20_000
        );
        const good = big.filter((r) => r.result !== undefined).length;
        good === size
          ? ok(`batch of ${size} answered`)
          : warn(`batch of ${size} answered ${good}`, "chunk size may need lowering");
      } catch (err) {
        warn(`batch of ${size} rejected`, (err as Error).message.slice(0, 80));
        break;
      }
    }
    // The limit above is what the endpoint allows in ONE batch. What matters is
    // whether a 500-wallet reconcile completes regardless — providers meter
    // individual calls, and some answer HTTP 200 with per-entry rate-limit
    // errors rather than refusing the batch, so this asks for a realistic
    // volume rather than a token one.
    try {
      const many = Array.from({ length: 1000 }, () => ({
        method: "eth_chainId",
        params: [] as unknown[],
      }));
      const started = Date.now();
      const chunked = await rpcBatchChunked<string>(readUrl, many, 200);
      const answered = chunked.filter((r) => r.result !== undefined).length;
      const elapsed = Date.now() - started;
      if (answered === many.length) {
        ok(`${many.length} calls completed`, `${elapsed}ms`);
        note("rpcBatchChunked shrinks to the endpoint's limit automatically");

        // Effective throughput, and what it means for the reconcile loop.
        // Reconcile is rolling — reconcileBatch wallets per cycle, two calls
        // each — so the question is whether one slice fits comfortably inside
        // the interval, not whether all 500 do.
        const perCall = elapsed / many.length;
        const callsPerSec = Math.round(1000 / perCall);
        note(`effective throughput ~${callsPerSec} calls/sec`);

        const sliceCalls = 100 * 2; // default reconcileBatch × 2 calls per wallet
        const sliceMs = Math.round(perCall * sliceCalls);
        if (sliceMs < 15_000) {
          ok(
            `reconcile slice (100 wallets) ~${(sliceMs / 1000).toFixed(1)}s`,
            "comfortable inside the 30s loop"
          );
          note(`all 500 wallets come round every ${Math.ceil(500 / 100) * 30}s`);
        } else {
          warn(
            `reconcile slice (100 wallets) ~${(sliceMs / 1000).toFixed(0)}s`,
            "lower reconcileBatch in config.json"
          );
        }

        const fullMs = Math.round(perCall * 1000);
        if (fullMs > 20_000) {
          note(
            `a full 500-wallet sweep would take ~${(fullMs / 1000).toFixed(0)}s — ` +
              `raise the provider's per-second limit if you want faster whole-set reads`
          );
        }
      } else {
        bad(`only ${answered}/${many.length} answered`, "nonce reconcile would silently skip wallets");
      }
    } catch (err) {
      bad("adaptive chunking failed", (err as Error).message.slice(0, 100));
    }
  } catch (err) {
    bad("batching unsupported", (err as Error).message.slice(0, 100));
    note("nonce-manager.ts and balances.ts both depend on this — use a different read endpoint");
  }

  // ── 4. Log range limits ─────────────────────────────────────────────
  section("4. eth_getLogs range");
  note("holdings.ts scans in 2000-block chunks. Providers cap this differently.");
  const head = Number(BigInt(await rpcCall<string>(readUrl, "eth_blockNumber", [])));
  ok("chain head", String(head));

  // Two separate numbers, and conflating them is misleading. Providers reject on
  // response SIZE, so an unfiltered scan of every ERC-721 transfer on the chain
  // caps out far sooner than the address-filtered scan a sweep actually issues.
  // A good endpoint will happily serve an unfiltered range so large the
  // response runs to hundreds of megabytes, so this is bounded by time as well
  // as by rejection — a probe that takes 10s has already told us the range is
  // impractical, whether or not it eventually returns.
  const probeRange = async (range: number, contracts?: string[]): Promise<boolean> => {
    const filter: Record<string, unknown> = {
      fromBlock: `0x${(head - range).toString(16)}`,
      toBlock: `0x${head.toString(16)}`,
      topics: [ERC721_TRANSFER],
    };
    if (contracts) filter.address = contracts;
    const started = Date.now();
    try {
      await rpcCall<unknown[]>(readUrl, "eth_getLogs", [filter], 10_000);
      return Date.now() - started < 8_000;
    } catch {
      return false;
    }
  };

  let unfiltered = 0;
  for (const range of [10, 100, 1000, 2000]) {
    if (!(await probeRange(range))) break;
    unfiltered = range;
  }
  note(`unfiltered (whole chain): up to ${unfiltered || "<10"} blocks`);

  // A sweep always filters by contract. Probe with a real one so the number
  // reflects what holdings.ts will actually ask for.
  const sampleContract = contract ?? "0x0000000000000000000000000000000000000001";
  let filtered = 0;
  for (const range of [100, 2000, 10_000, 50_000]) {
    if (!(await probeRange(range, [sampleContract]))) break;
    filtered = range;
  }
  note(`address-filtered (what a sweep issues): up to ${filtered || "<100"} blocks`);

  if (filtered >= 2000) {
    ok("sweep scanning is fine", `${filtered} blocks per request with a contract filter`);
  } else if (filtered > 0) {
    warn(`filtered scans capped at ${filtered} blocks`, "sweeps will be slow but will work");
  } else {
    warn("could not establish a filtered range", "sweeps may need a different endpoint");
  }
  note("holdings.ts halves the range automatically when a response comes back too large");
  const bestRange = Math.max(unfiltered, 10);

  // ── 5. Live mint traffic ────────────────────────────────────────────
  section("5. Live mint detection");
  note("Confirms the watcher's filter matches real traffic on this chain.");
  try {
    const range = Math.min(bestRange || 100, 500);
    const logs = await rpcCall<{ address: string; topics: string[] }[]>(
      readUrl,
      "eth_getLogs",
      [
        {
          fromBlock: `0x${(head - range).toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
          topics: [ERC721_TRANSFER, `0x${"0".repeat(64)}`],
        },
      ],
      30_000
    );
    const erc721 = logs.filter((l) => l.topics.length === 4);
    const contracts = new Set(erc721.map((l) => l.address.toLowerCase()));
    if (erc721.length > 0) {
      ok(
        `${erc721.length} mint(s) in the last ${range} blocks`,
        `across ${contracts.size} contract(s)`
      );
      note("the copy-mint filter works against real traffic on this chain");
    } else {
      warn(`no mints in the last ${range} blocks`, "quiet period, or the filter needs review");
    }
  } catch (err) {
    warn("mint scan failed", (err as Error).message.slice(0, 90));
  }

  // ── 6. WebSocket ────────────────────────────────────────────────────
  section("6. WebSocket");
  const wsUrl = deriveWsUrl(readUrl);
  if (!wsUrl) {
    warn("could not derive a ws:// url", "the watcher will poll instead");
  } else if (typeof WebSocket === "undefined") {
    bad("no global WebSocket", "Node 22+ required, or the watcher polls");
  } else {
    note(`trying ${maskRpc(wsUrl)}`);
    const heads = await testWebSocket(wsUrl, 12_000);
    if (heads > 0) {
      ok(`${heads} block header(s) received`, "live subscription works");
    } else {
      warn("no headers received in 12s", "the watcher will fall back to polling (still makes N+1)");
    }
  }

  // ── 7. A real drop ──────────────────────────────────────────────────
  if (contract) {
    section(`7. Drop ${contract}`);

    // Public stage
    try {
      const mintPlan = await buildLocalMintPlan(readUrl, contract, 1);
      if (mintPlan) {
        const starts = new Date(mintPlan.drop.startTime * 1000);
        const ends = new Date(mintPlan.drop.endTime * 1000);
        const live = Date.now() >= starts.getTime() && Date.now() < ends.getTime();
        ok("public stage readable", live ? "LIVE" : "not live");
        note(`price ${formatEther(mintPlan.drop.mintPrice)} ETH · cap ${mintPlan.drop.maxTotalMintableByWallet || "unlimited"}/wallet`);
        note(`window ${starts.toISOString()} → ${ends.toISOString()}`);
        note(`fee recipient ${mintPlan.feeRecipient}`);
      } else {
        note("no public stage on the SeaDrop singleton");
      }
    } catch (err) {
      warn("public stage read failed", (err as Error).message.slice(0, 90));
    }

    // Allowlist stage — the real test of the phase-3 parser
    try {
      const root = await fetchAllowListRoot(readUrl, contract);
      if (BigInt(root) === BigInt(ZERO_ROOT)) {
        note("no allowlist root set — no allowlist stage");
      } else {
        ok("allowlist root found", root.slice(0, 18) + "…");
        const uri = await findAllowListUri(readUrl, contract);
        if (!uri) {
          warn("no AllowListUpdated event carrying a list URI", "pass one to /check manually");
        } else {
          ok("list URI located", uri.slice(0, 70));
          try {
            const response = await fetch(toHttpUrl(uri));
            if (!response.ok) {
              warn(`list fetch HTTP ${response.status}`);
            } else {
              const entries = parseAllowList(await response.json());
              ok(`parsed ${entries.length} entries`);

              // The decisive check: does our reconstruction reproduce the chain?
              const rebuilt = buildTree(
                entries.map((e) => computeLeaf(e.minter, e.mintParams))
              ).root;
              if (BigInt(rebuilt) === BigInt(root)) {
                ok("REBUILT ROOT MATCHES CHAIN", "the parser understands this file");
                const sample = checkEligibility(
                  [{ id: "probe", address: entries[0].minter }],
                  entries,
                  root
                );
                sample.eligible.length === 1
                  ? ok("proof generation verified against a listed address")
                  : warn("proof generation failed for a listed address");
              } else {
                bad("rebuilt root does NOT match chain");
                note(`chain    ${root}`);
                note(`rebuilt  ${rebuilt}`);
                note("the parser read this file in a way that does not reproduce the tree;");
                note("/check would correctly withhold all proofs rather than issue bad ones");
              }
            }
          } catch (err) {
            warn("list parse failed", (err as Error).message.slice(0, 120));
            note("this is exactly what /check would report; the format needs inspecting");
          }
        }
      }
    } catch (err) {
      warn("allowlist read failed", (err as Error).message.slice(0, 90));
    }

    // Signed stage
    try {
      const signers = await fetchSigners(readUrl, contract);
      if (signers.length > 0) {
        ok(`${signers.length} registered signer(s)`, "this drop has a signed stage");
        note(signers.join(", "));
        note("signatures fetched from OpenSea are verified against these before broadcast");
      } else {
        note("no registered signers — no signed stage");
      }
    } catch (err) {
      warn("signer read failed", (err as Error).message.slice(0, 90));
    }
  } else {
    section("7. Drop");
    note("skipped — pass --contract 0x… to check a real collection");
  }

  // ── 8. Sustained watch ──────────────────────────────────────────────
  if (watchSeconds > 0) {
    section(`8. Sustained watch (${watchSeconds}s)`);
    note("Polls for mints the way the watcher does when no WebSocket is available.");
    let seen = 0;
    let last = head;
    const until = Date.now() + watchSeconds * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const now = Number(BigInt(await rpcCall<string>(readUrl, "eth_blockNumber", [])));
        if (now <= last) continue;
        const logs = await rpcCall<{ topics: string[] }[]>(readUrl, "eth_getLogs", [
          {
            fromBlock: `0x${(last + 1).toString(16)}`,
            toBlock: `0x${now.toString(16)}`,
            topics: [ERC721_TRANSFER, `0x${"0".repeat(64)}`],
          },
        ]);
        const mints = logs.filter((l) => l.topics.length === 4).length;
        seen += mints;
        process.stdout.write(`\r    block ${now} · ${seen} mint(s) seen   `);
        last = now;
      } catch {
        /* transient; keep going */
      }
    }
    process.stdout.write("\n");
    ok(`watched ${watchSeconds}s`, `${seen} mint(s) detected`);
  }

  finish();
}

function testWebSocket(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    let heads = 0;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve(0);
      return;
    }

    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(heads);
    }, timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] })
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { method?: string };
        if (message.method === "eth_subscription") heads += 1;
      } catch {
        /* ignore */
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(heads);
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve(heads);
    });
  });
}

function finish(): void {
  console.log("");
  if (failures > 0) {
    console.log(`[31m${failures} blocking issue(s)[0m, ${warnings} warning(s)\n`);
    process.exit(1);
  }
  if (warnings > 0) {
    console.log(`[33mNo blocking issues, ${warnings} warning(s)[0m\n`);
  } else {
    console.log(`[32mAll checks passed.[0m\n`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
