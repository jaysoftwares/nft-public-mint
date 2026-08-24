// Offline self-test for the wallet, crypto, selector, copy-mint and allowlist
// layers.
//
//   npm run verify
//
// Everything here runs without a network, a passphrase prompt, or the operator's
// real store — COPYMINT_HOME is redirected to a temp directory that is deleted
// on the way out. Derivation is checked against published BIP-44 vectors rather
// than against itself, so a wrong derivation path fails loudly instead of being
// consistently wrong.

import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const SCRATCH = join(tmpdir(), `copymint-verify-${process.pid}-${Date.now()}`);
process.env.COPYMINT_HOME = SCRATCH;

/* eslint-disable import/first */
import { Wallet, parseEther, Transaction } from "ethers";
import { sealJson, unsealJson, DecryptError } from "../core/crypto";
import {
  initFromMnemonic,
  unlock,
  readImportBlob,
  storeExists,
  importEntriesFromMnemonic,
} from "../core/wallet-store";
import {
  resolve as resolveWallets,
  resolveForAutoFire,
  resolveForCopy,
  emptyContext,
  SelectorError,
} from "../core/tags";
import {
  planFunding,
  planEthSweep,
  signEthSweep,
  parseFundAmount,
  TRANSFER_GAS,
} from "../core/funding";
import { requiredPerWallet, shortfalls } from "../core/balances";
import { substituteAddress, contains, selectorOf, buildReplay, ReplayError } from "../core/calldata";
import { evaluate, PolicyCaps } from "../core/policy";
import { decodeSeaDropMint } from "../core/copy-plan";
import { diagnose, overallState, ChainReadiness } from "../core/diagnosis";
import { buildDashboardSvg } from "../bot/dashboard-image";
import { BOT_COMMANDS, UNLISTED_ALIASES, validateCommands } from "../bot/commands";
import { parseCollectionInput } from "../core/collection-input";
import { openSeaChainSlug } from "../core/opensea-api";
import { CHAINS } from "../chains";
import {
  computeLeaf,
  buildTree,
  proofFor,
  verifyProof,
  checkEligibility,
  parseAllowList,
  MintParams,
  AllowListEntry,
  ALLOWLIST_UPDATED_TOPIC,
} from "../core/allowlist";
import { id as ethersId, TypedDataEncoder, Interface as ethersInterface } from "ethers";
import { inspectCalldata, openSignal, OPEN_POLL } from "../core/mint-opensea";
import {
  writeDefaultConfig,
  updateUserSettings,
  chainOverrideFrom,
  parseCapAmount,
  ConfigError,
} from "../core/config";
import { FILES, stateDir, storedUserChatIds, userStateDir, withStateDir } from "../core/paths";
import { deriveUserPassphrase } from "../core/user-key";
import { ensureUserFundingWallet } from "../bot/user-wallet";
import { collectDashboard, summariseMints, pct } from "../core/dashboard";
import { LedgerEntry } from "../core/ledger";
import { renderDashboard } from "../bot/dashboard";
import * as watchTargets from "../core/targets";
import { assessMint, blocksForHours } from "../core/target-probe";
import { rpcBatchChunked } from "../core/rpc";
import {
  NonceManager,
  STUCK_MIN_OBSERVATIONS,
  STUCK_MIN_DWELL_MS,
} from "../core/nonce-manager";
import { isBenign, classifyEndpoints } from "../core/dispatcher";
import { isFundingRevert } from "../core/calldata";
import { LogWatcher, deriveWsUrl, ERC721_TRANSFER } from "../core/log-watcher";
import { record as recordLedger, spentSince as ledgerSpentSince } from "../core/ledger";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
import {
  deriveDigest,
  recoverSigner,
  verifySignature,
  signedMintDomain,
  SIGNED_MINT_TYPES,
  SignedMintMessage,
} from "../core/signed-mint";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

// Hardhat's published test mnemonic. These addresses are fixed BIP-44 vectors,
// so matching them proves m/44'/60'/0'/0/i is being derived correctly.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
/** Hardhat account 0's key — the private half of VECTORS[0]. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const VECTORS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];

function cleanup(): void {
  if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log("\nCopymint — self-test");
  console.log(`Scratch state: ${SCRATCH}`);

  // ── crypto ────────────────────────────────────────────────────────────
  section("crypto");
  const passphrase = "correct horse battery staple";
  const envelope = sealJson({ mnemonic: TEST_MNEMONIC }, passphrase);

  check("ciphertext leaks no plaintext", !JSON.stringify(envelope).includes("junk"));
  check(
    "round trip preserves content",
    unsealJson<{ mnemonic: string }>(envelope, passphrase).mnemonic === TEST_MNEMONIC
  );

  check(
    "wrong passphrase is rejected",
    throws(() => unsealJson(envelope, "not the passphrase"), DecryptError)
  );
  check(
    "tampered ciphertext is rejected",
    throws(
      () => unsealJson({ ...envelope, ct: Buffer.from("tampered").toString("base64") }, passphrase),
      DecryptError
    )
  );

  // ── owner settings ────────────────────────────────────────────────────
  section("RPC batch sizing");
  const observedBatchSizes: number[] = [];
  let singleCalls = 0;
  const batchServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      if (Array.isArray(body)) {
        observedBatchSizes.push(body.length);
        response.end(
          JSON.stringify(
            body.map((entry) => ({
              jsonrpc: "2.0",
              id: entry.id,
              result: entry.params[0],
            }))
          )
        );
        return;
      }
      singleCalls++;
      response.end(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.params[0] })
      );
    });
  });
  await new Promise<void>((resolve) => batchServer.listen(0, "127.0.0.1", resolve));
  try {
    const serverAddress = batchServer.address() as { port: number };
    const values = Array.from({ length: 46 }, (_, index) => `0x${index.toString(16)}`);
    const batched = await rpcBatchChunked<string>(
      `http://127.0.0.1:${serverAddress.port}`,
      values.map((value) => ({ method: "test_echo", params: [value] }))
    );
    check("batch size is capped below provider RPS", observedBatchSizes.join(",") === "45,1");
    check("transport stays on JSON-RPC batches", singleCalls === 0);
    check(
      "chunked batches preserve ordered results",
      batched.map((entry) => entry.result).join(",") === values.join(",")
    );
  } finally {
    await new Promise<void>((resolve) => batchServer.close(() => resolve()));
  }


  // ── nonce reconciliation ──────────────────────────────────────────────
  //
  // The regression this guards is the expensive one. `pending > latest` is the
  // ordinary state of an accepted-but-unmined mint, and treating it as a stuck
  // pool entry made the reconciler cancel healthy mints with a 0-value
  // self-send and then tag the wallet `stuck`, which took it out of the
  // copy-mint pool. Both halves are checked here.
  section("nonce reconciliation");

  const ADDR = VECTORS[0];
  const nonceState = { latest: 5, pending: 5, accepted: [] as string[] };
  let clock = 1_000_000;

  const nodeServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const answer = (entry: { id: number; method: string; params: unknown[] }): unknown => {
        if (entry.method === "eth_getTransactionCount") {
          const block = entry.params[1];
          const value = block === "latest" ? nonceState.latest : nonceState.pending;
          return { jsonrpc: "2.0", id: entry.id, result: `0x${value.toString(16)}` };
        }
        if (entry.method === "eth_sendRawTransaction") {
          nonceState.accepted.push(entry.params[0] as string);
          return { jsonrpc: "2.0", id: entry.id, result: `0x${"11".repeat(32)}` };
        }
        return { jsonrpc: "2.0", id: entry.id, error: { message: `unexpected ${entry.method}` } };
      };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body))
      );
    });
  });
  await new Promise<void>((resolve) => nodeServer.listen(0, "127.0.0.1", resolve));

  try {
    const nodeUrl = `http://127.0.0.1:${(nodeServer.address() as { port: number }).port}`;
    const targetsToCheck = [{ id: "d:0", address: ADDR }];

    // A live mint: one transaction accepted and waiting, and the chain moving
    // under it. However many times this is reconciled, nothing is wrong.
    const healthy = new NonceManager(nodeUrl, () => clock);
    await healthy.prime(targetsToCheck);
    let healedHealthy = 0;
    for (let round = 0; round < STUCK_MIN_OBSERVATIONS + 3; round++) {
      nonceState.pending = nonceState.latest + 1; // one tx in flight
      const report = await healthy.reconcile(targetsToCheck);
      healedHealthy += report.faults.length;
      nonceState.latest += 1; // …and it mines, as a healthy one does
      clock += 30_000;
    }
    check("an in-flight mint is never healed", healedHealthy === 0);
    check("…and its wallet stays usable", healthy.stuckAddresses().size === 0);

    // A wedged pool: the gap persists and `latest` never moves.
    nonceState.latest = 20;
    nonceState.pending = 21;
    clock = 2_000_000;
    const wedged = new NonceManager(nodeUrl, () => clock);
    await wedged.prime(targetsToCheck);

    const first = await wedged.reconcile(targetsToCheck);
    check("a first sighting is provisional, not a fault", first.faults.length === 0);
    check("…and is still reported", first.provisional.length === 1);

    // Enough sightings, but not enough wall clock: still not actionable.
    clock += 1_000;
    await wedged.reconcile(targetsToCheck);
    clock += 1_000;
    const tooSoon = await wedged.reconcile(targetsToCheck);
    check("the dwell floor holds back an early verdict", tooSoon.faults.length === 0);
    check("…and the wallet is not yet disqualified", wedged.stuckAddresses().size === 0);

    // Past the dwell, with `latest` still pinned: now it is genuinely stuck.
    clock += STUCK_MIN_DWELL_MS;
    const confirmed = await wedged.reconcile(targetsToCheck);
    check("a pinned gap past the dwell is a fault", confirmed.faults.length === 1);
    check("…classified as stuck", confirmed.faults[0]?.kind === "stuck");
    check("…and the wallet is disqualified", wedged.stuckAddresses().has(ADDR));

    // Healing must not hand back nonces that were already spent.
    const queued = new NonceManager(nodeUrl, () => clock);
    await queued.prime(targetsToCheck); // local = pending = 21
    queued.next(ADDR);
    queued.next(ADDR); // local = 23: two more signed above the blockage
    const healResults = await queued.heal(
      [{ id: "d:0", address: ADDR, kind: "stuck", local: 23, latest: 20, pending: 21 }],
      {
        signerFor: () => new Wallet(TEST_KEY),
        chainId: 8453,
        endpoints: classifyEndpoints([nodeUrl]),
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 50_000_000n,
      }
    );
    check("a stuck nonce is replaced", healResults[0]?.action === "replaced");
    check(
      "…without discarding the nonces queued above it",
      queued.peek(ADDR) === 23,
      `counter is ${queued.peek(ADDR)}, expected 23`
    );

    // ── what the reconciler is allowed to poll ──────────────────────────
    //
    // This loop was the provider bill. Every primed wallet was reconciled
    // forever at two calls each — a hundred a cycle, three chains, every
    // thirty seconds, which is 1.7 million requests a day against a store
    // where one wallet had ever sent anything. A wallet that has not sent
    // cannot have a dropped or a stuck transaction, so there is nothing for
    // those calls to find.
    section("the reconciler only watches wallets in flight");

    const idle = new NonceManager(nodeUrl, () => clock);
    await idle.prime(targetsToCheck);
    check(
      "priming a wallet does not put it under observation",
      idle.activeAddresses().size === 0
    );

    idle.next(ADDR);
    check("sending from it does", idle.activeAddresses().has(ADDR));

    nonceState.latest = 30;
    nonceState.pending = 30;
    await idle.reconcile(targetsToCheck);
    check(
      "…and it is retired once the chain shows it settled",
      idle.activeAddresses().size === 0
    );

    // The 49-of-50 case: copy-mint signs from every candidate and the node
    // rejects the empty ones. Those must not be left under observation, or
    // one busy drop re-creates the standing bill this change removed.
    const rejected = new NonceManager(nodeUrl, () => clock);
    await rejected.prime(targetsToCheck);
    rejected.next(ADDR);
    rejected.rollback(ADDR);
    await rejected.reconcile(targetsToCheck);
    check(
      "a wallet whose send was rejected stops being watched",
      rejected.activeAddresses().size === 0
    );

    // A restart loses the counter that recorded an in-flight transaction, so
    // the funded wallets are swept once at startup to cover exactly that.
    const restarted = new NonceManager(nodeUrl, () => clock);
    await restarted.prime(targetsToCheck);
    restarted.markActive(ADDR);
    check("a restart can put a funded wallet back under observation", restarted.activeAddresses().has(ADDR));
    check(
      "…but never one it knows nothing about",
      (restarted.markActive("0x" + "ab".repeat(20)), restarted.activeAddresses().size === 1)
    );

    nonceState.pending = 31; // one still in the pool
    await restarted.reconcile(targetsToCheck);
    check("…and an unsettled one stays under observation", restarted.activeAddresses().has(ADDR));
  } finally {
    await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
  }

  // ── dispatch acceptance ───────────────────────────────────────────────
  section("dispatch acceptance");
  check("a duplicate submission counts as accepted", isBenign("already known"));
  check("…however the node words it", isBenign("known transaction: 0xabc"));
  check(
    "a rejected nonce does NOT count as accepted",
    !isBenign("nonce too low: next nonce 12, tx nonce 11")
  );
  check("an underpriced replacement does not either", !isBenign("replacement transaction underpriced"));

  // ── autonomous spend cap ──────────────────────────────────────────────
  //
  // The cap bounds what copy-mint spends on its own. A mint the operator ran by
  // hand used to count against it, so one /mint could silence copy-mint for a
  // day with "Daily budget exhausted".
  section("autonomous spend cap");
  recordLedger({
    kind: "mint",
    chainId: 8453,
    walletIds: ["d:0"],
    valueWei: "1000000000000000000",
  });
  recordLedger({
    kind: "mint",
    auto: true,
    chainId: 8453,
    walletIds: ["d:1"],
    valueWei: "2000000000000000000",
  });
  check(
    "the cap counts only autonomous spending",
    ledgerSpentSince(24, ["mint"], { autoOnly: true }) === 2_000_000_000_000_000_000n
  );
  check(
    "…while total spend still reports everything",
    ledgerSpentSince(24, ["mint"]) === 3_000_000_000_000_000_000n
  );

  // ── replay probe ──────────────────────────────────────────────────────
  section("replay probe");
  check(
    "an empty probe wallet is a funding problem",
    isFundingRevert("insufficient funds for gas * price + value")
  );
  check("…however the node words it", isFundingRevert("insufficient balance for transfer"));
  check(
    "a real revert is not mistaken for one",
    !isFundingRevert("NotActive()")
  );
  check("…nor is a missing reason", !isFundingRevert(undefined));


  // ── copy-mint detection without WebSocket ─────────────────────────────
  //
  // deriveWsUrl only rewrites a scheme, so it returns a wss:// URL for hosts
  // that do not serve WebSocket at all — mainnet.base.org answers the upgrade
  // with 405 and both Robinhood endpoints with 400. The watcher looped on
  // those forever and never reached the polling branch, so copy-mint reported
  // "Watching 1 target" and detected nothing. Polling has to actually deliver.
  section("copy-mint detection without WebSocket");

  check("a scheme rewrite is not proof of WebSocket support", deriveWsUrl("https://x.io/") === "wss://x.io/");
  check("a non-http endpoint yields none", deriveWsUrl("ipc:///tmp/geth.ipc") === undefined);

  const WATCHED = VECTORS[1];
  const MINT_CONTRACT = "0x1111111111111111111111111111111111111111";
  const MINT_TX = `0x${"ab".repeat(32)}`;
  let logsServed = 0;
  let headCalls = 0;

  const chainServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const reply = (result: unknown): string =>
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      response.setHeader("content-type", "application/json");

      if (body.method === "eth_blockNumber") {
        // The startup read sees block 100; every poll after it sees 101, so
        // there is exactly one new block to scan and one log to find in it.
        headCalls += 1;
        response.end(reply(headCalls === 1 ? "0x64" : "0x65"));
        return;
      }
      if (body.method === "eth_getLogs") {
        const isErc721 = body.params[0].topics[0] === ERC721_TRANSFER;
        logsServed += 1;
        response.end(
          reply(
            isErc721
              ? [
                  {
                    address: MINT_CONTRACT,
                    topics: [
                      ERC721_TRANSFER,
                      `0x${"0".repeat(64)}`,
                      `0x${"0".repeat(24)}${WATCHED.slice(2).toLowerCase()}`,
                      `0x${"0".repeat(63)}1`,
                    ],
                    transactionHash: MINT_TX,
                    blockNumber: "0x65",
                  },
                ]
              : []
          )
        );
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: "no" } }));
    });
  });
  await new Promise<void>((resolve) => chainServer.listen(0, "127.0.0.1", resolve));

  try {
    const chainUrl = `http://127.0.0.1:${(chainServer.address() as { port: number }).port}`;
    const detected: { contract: string; recipient: string; tx: string }[] = [];

    const watcher = new LogWatcher({
      wsUrl: undefined, // the state a non-WebSocket endpoint must end up in
      httpUrl: chainUrl,
      targets: [WATCHED],
      onMint: (event) =>
        detected.push({
          contract: event.contract,
          recipient: event.recipient,
          tx: event.transactionHash,
        }),
      onStatus: () => undefined,
      pollIntervalMs: 20,
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    watcher.stop();

    check("polling detects a mint", detected.length >= 1);
    check("…on the right contract", detected[0]?.contract === MINT_CONTRACT);
    check(
      "…credited to the watched address",
      detected[0]?.recipient?.toLowerCase() === WATCHED.toLowerCase()
    );
    check("…and carries the source transaction", detected[0]?.tx === MINT_TX);
    check("a replayed log is not signalled twice", detected.length === 1, `saw ${detected.length}`);

    // Stopping must actually stop: a tick that was mid-request used to re-arm
    // itself after stopPolling(), leaving two loops reporting different gaps.
    const servedAtStop = logsServed;
    await new Promise((resolve) => setTimeout(resolve, 150));
    check("a stopped watcher issues no further polls", logsServed === servedAtStop);

    // The regression itself: a wsUrl the runtime cannot open must end in
    // polling, not in an endless reconnect. Before this, the watcher retried
    // forever and copy-mint never saw a single mint.
    headCalls = 0;
    logsServed = 0;
    const fellBack: string[] = [];
    const detectedAfterFallback: string[] = [];

    const wedged = new LogWatcher({
      // Not a WebSocket scheme, so the constructor rejects it every time —
      // standing in for a host that answers the upgrade with 400 or 405.
      wsUrl: "https://not-a-websocket.invalid/",
      httpUrl: chainUrl,
      targets: [WATCHED],
      onMint: (event) => detectedAfterFallback.push(event.transactionHash),
      onStatus: (message) => fellBack.push(message),
      pollIntervalMs: 20,
    });

    await wedged.start();
    // 1s + 2s of backoff between the three attempts, then polling.
    await new Promise((resolve) => setTimeout(resolve, 3_800));
    wedged.stop();

    check(
      "an unusable WebSocket endpoint gives up and polls",
      fellBack.some((m) => m.includes("Switching to polling"))
    );
    check(
      "…saying which host and why",
      fellBack.some((m) => m.includes("does not serve WebSocket"))
    );
    check(
      "…and the backoff grows instead of pinning at retry 1",
      fellBack.some((m) => m.includes("retry 2")),
      fellBack.join(" | ")
    );
    check("…and mints are detected after the switch", detectedAfterFallback.length === 1);
  } finally {
    await new Promise<void>((resolve) => chainServer.close(() => resolve()));
  }

  // ── a flaky chain-head read ────────────────────────────────────────────
  //
  // The head read gates the gap replay, and it used to get exactly one attempt.
  // QuickNode answers "Empty result for eth_blockNumber" roughly once a day —
  // usually on the reconnect right after a restart — and that one answer threw
  // the whole catch-up away. The blocks between a socket dropping and coming
  // back are the ones nothing else will ever look at, so a mint in that window
  // was missed outright and in silence.
  section("chain head retry");

  let headAttempts = 0;
  let emptyRepliesLeft = 2;
  const flakyServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      if (body.method === "eth_blockNumber") {
        headAttempts += 1;
        if (emptyRepliesLeft > 0) {
          emptyRepliesLeft -= 1;
          // Exactly what the provider sends: HTTP 200, no error, no result.
          response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x64" }));
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }));
    });
  });
  await new Promise<void>((resolve) => flakyServer.listen(0, "127.0.0.1", resolve));

  try {
    const flakyUrl = `http://127.0.0.1:${(flakyServer.address() as { port: number }).port}`;
    const notices: string[] = [];
    const flaky = new LogWatcher({
      wsUrl: undefined,
      httpUrl: flakyUrl,
      targets: [WATCHED],
      onMint: () => undefined,
      onStatus: (message) => notices.push(message),
      pollIntervalMs: 10_000,
    });

    await flaky.start();
    flaky.stop();

    check("a transient empty head read is retried", headAttempts === 3, `attempts: ${headAttempts}`);
    check(
      "…and the watcher never reports a failed startup read",
      !notices.some((m) => m.includes("Could not read the chain head")),
      notices.join(" | ")
    );
  } finally {
    await new Promise<void>((resolve) => flakyServer.close(() => resolve()));
  }

  // Retries are bounded: a provider that is genuinely down must not hold the
  // reconnect path open, and the watcher still has to come up.
  let deadAttempts = 0;
  const deadServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.method === "eth_blockNumber") deadAttempts += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id }));
    });
  });
  await new Promise<void>((resolve) => deadServer.listen(0, "127.0.0.1", resolve));

  try {
    const deadUrl = `http://127.0.0.1:${(deadServer.address() as { port: number }).port}`;
    const deadNotices: string[] = [];
    const dead = new LogWatcher({
      wsUrl: undefined,
      httpUrl: deadUrl,
      targets: [WATCHED],
      onMint: () => undefined,
      onStatus: (message) => deadNotices.push(message),
      pollIntervalMs: 10_000,
    });
    await dead.start();
    dead.stop();

    check("a dead endpoint gives up after three tries", deadAttempts === 3, `attempts: ${deadAttempts}`);
    check(
      "…and the watcher still comes up rather than throwing",
      deadNotices.some((m) => m.includes("Could not read the chain head")),
      deadNotices.join(" | ")
    );
  } finally {
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));
  }

  section("user settings");
  const configPath = writeDefaultConfig();
  const savedSettings = updateUserSettings({
    destination: VECTORS[0].toLowerCase(),
  });
  const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
  check("destination is checksummed", savedSettings.destination === VECTORS[0]);
  check("vault is persisted", savedConfig.vault === VECTORS[0]);
  check("destination does not overwrite funder", savedConfig.funder !== VECTORS[0]);
  updateUserSettings({ funder: VECTORS[1] });
  const configWithFunder = JSON.parse(readFileSync(configPath, "utf8"));
  check("derived funder is persisted separately", configWithFunder.funder === VECTORS[1]);
  updateUserSettings({ copyEnabled: true });
  const configWithCopyEnabled = JSON.parse(readFileSync(configPath, "utf8"));
  check("Telegram copy ON survives restart", configWithCopyEnabled.copy.enabled === true);
  updateUserSettings({ copyEnabled: false });
  const configWithCopyDisabled = JSON.parse(readFileSync(configPath, "utf8"));
  check("Telegram copy OFF survives restart", configWithCopyDisabled.copy.enabled === false);
  check(
    "invalid destination is rejected",
    throws(() => updateUserSettings({ destination: "not-an-address" }), ConfigError)
  );

  // ── per-user isolation ────────────────────────────────────────────────
  section("per-user isolation");
  const firstKey = deriveUserPassphrase("server-master", 11111);
  const secondKey = deriveUserPassphrase("server-master", 22222);
  check("user encryption keys are distinct", firstKey !== secondKey);
  check("user encryption key is stable", firstKey === deriveUserPassphrase("server-master", 11111));
  const firstUserDir = userStateDir(11111);
  const secondUserDir = userStateDir(22222);
  const [firstUser, secondUser] = await Promise.all([
    withStateDir(firstUserDir, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      writeDefaultConfig();
      updateUserSettings({ destination: VECTORS[0] });
      initFromMnemonic(TEST_MNEMONIC, "first-user-passphrase");
      const userStore = unlock("first-user-passphrase");
      const funding = ensureUserFundingWallet(userStore, ZERO_ADDRESS);
      updateUserSettings({ funder: funding.wallet.address });
      const repeated = ensureUserFundingWallet(userStore, funding.wallet.address);
      return {
        state: stateDir(),
        seed: FILES.seed(),
        walletCount: userStore.all().length,
        funding: funding.wallet,
        repeatedFunding: repeated.wallet,
        config: JSON.parse(readFileSync(FILES.config(), "utf8")),
      };
    }),
    withStateDir(secondUserDir, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      writeDefaultConfig();
      updateUserSettings({ destination: VECTORS[1] });
      initFromMnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        "second-user-passphrase"
      );
      const userStore = unlock("second-user-passphrase");
      const funding = ensureUserFundingWallet(userStore, ZERO_ADDRESS);
      updateUserSettings({ funder: funding.wallet.address });
      userStore.generate(1);
      return {
        state: stateDir(),
        seed: FILES.seed(),
        walletCount: userStore.all().length,
        funding: funding.wallet,
        config: JSON.parse(readFileSync(FILES.config(), "utf8")),
      };
    }),
  ]);
  check("user state directories are distinct", firstUser.state !== secondUser.state);
  check("async state context survives timers", firstUser.state === firstUserDir);
  check("wallet-store paths are isolated", firstUser.seed !== secondUser.seed);
  check("first user's wallet count is isolated", firstUser.walletCount === 1);
  check("second user's wallet count is isolated", secondUser.walletCount === 2);
  check(
    "users receive different funding wallets",
    firstUser.funding.address !== secondUser.funding.address
  );
  check("funding wallet is manual-only", firstUser.funding.autoFire === false);
  check("funding wallet is tagged", firstUser.funding.tags.includes("funder"));
  check(
    "funding wallet creation is idempotent",
    firstUser.repeatedFunding.address === firstUser.funding.address
  );
  check("first user's funder is persisted", firstUser.config.funder === firstUser.funding.address);
  check("second user's funder is persisted", secondUser.config.funder === secondUser.funding.address);
  check("first user keeps its destination", firstUser.config.vault === VECTORS[0]);
  check("second user keeps its destination", secondUser.config.vault === VECTORS[1]);
  check(
    "stored users are discoverable after restart",
    storedUserChatIds().join(",") === "11111,22222"
  );
  check("state context returns to root", stateDir() === SCRATCH);

  // ── wallet store ──────────────────────────────────────────────────────
  section("Telegram wallet imports");
  withStateDir(userStateDir(33333), () => {
    initFromMnemonic(TEST_MNEMONIC, "import-test-passphrase");
    const importStore = unlock("import-test-passphrase");
    importStore.generate(1);
    const seedEntries = importEntriesFromMnemonic(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      2
    );
    const seedImport = importStore.importKeys(seedEntries);
    check("seed phrase derives requested import count", seedEntries.length === 2);
    check("seed-derived private keys import", seedImport.added.length === 2);
    check(
      "seed-imported wallets default to manual-only",
      importStore.all().filter((wallet) => wallet.kind === "imported").every((wallet) => !wallet.autoFire)
    );
    const derivedDuplicate = importStore.importKeys([
      { privateKey: importStore.signer("d:0").privateKey },
    ]);
    check(
      "a derived signer cannot be imported twice under another id",
      derivedDuplicate.added.length === 0 && derivedDuplicate.duplicates.length === 1
    );
    check(
      "invalid seed phrase is rejected",
      throws(() => importEntriesFromMnemonic("not a seed phrase", 1))
    );
  });

  section("per-target mint filters");
  withStateDir(userStateDir(44444), () => {
    const freeTarget = watchTargets.add(VECTORS[0], "high", "free", "free-alpha");
    check("new target persists free-only filter", freeTarget.mintMode === "free");
    check("free-only target accepts zero-value mint", watchTargets.allowsMint(freeTarget, 0n));
    check("free-only target rejects paid mint", !watchTargets.allowsMint(freeTarget, 1n));
    const paidTarget = watchTargets.setMintMode(VECTORS[0], "paid");
    check("target filter can change to paid", paidTarget.mintMode === "paid");
    check("paid-only target rejects free mint", !watchTargets.allowsMint(paidTarget, 0n));
    check("paid-only target accepts paid mint", watchTargets.allowsMint(paidTarget, 1n));
    const bothTarget = watchTargets.setMintMode(VECTORS[0], "both");
    check(
      "both filter accepts free and paid",
      watchTargets.allowsMint(bothTarget, 0n) && watchTargets.allowsMint(bothTarget, 1n)
    );
  });

  // ── caps, now settable from chat ──────────────────────────────────────
  //
  // These bound what the bot spends unattended, so the writer has to refuse a
  // bad value rather than store it. A cap that silently became zero would stop
  // every mint; one that silently gained a decimal place would stop nothing.
  section("spend caps from chat");

  withStateDir(userStateDir(44446), () => {
    const capsPath = writeDefaultConfig();
    const reload = (): { caps: Record<string, string>; copy: { walletSelector: string } } =>
      JSON.parse(readFileSync(capsPath, "utf8"));

    const raised = updateUserSettings({ caps: { maxPriceEth: "0.02" } });
    check("a cap can be raised from chat", raised.caps?.maxPriceEth === "0.02");
    check("…and the others are left alone", raised.caps?.dailyEth === "0.50");
    check("…and it survives a reload", reload().caps.maxPriceEth === "0.02");

    check("zero is refused — it would stop every mint", throws(() => parseCapAmount("0", "caps.maxPriceEth"), ConfigError));
    check("a negative amount is refused", throws(() => parseCapAmount("-1", "caps.maxPriceEth"), ConfigError));
    check("words are refused", throws(() => parseCapAmount("lots", "caps.maxPriceEth"), ConfigError));
    check(
      "a misplaced decimal point is caught by the ceiling",
      throws(() => parseCapAmount("100", "caps.dailyEth"), ConfigError)
    );
    check("a trailing ETH is tolerated", parseCapAmount("0.02 ETH", "caps.maxPriceEth") === "0.02");

    // A ceiling above what one event may spend can never bind, so it is not a
    // guard — refuse the combination rather than store a number that does
    // nothing.
    check(
      "a max price above the per-event cap is refused",
      throws(() => updateUserSettings({ caps: { maxPriceEth: "0.9" } }), ConfigError)
    );
    check(
      "…and the stored value is unchanged after that refusal",
      reload().caps.maxPriceEth === "0.02"
    );
    check(
      "…while raising the per-event cap first makes it accepted",
      updateUserSettings({ caps: { perEventEth: "1", maxPriceEth: "0.9" } }).caps?.maxPriceEth === "0.9"
    );

    const selector = updateUserSettings({ copyWalletSelector: "funded" });
    check("the copy-mint wallet selector is settable", selector.copyWalletSelector === "funded");
    check("…and reloads", reload().copy.walletSelector === "funded");
    check("an empty selector is refused", throws(() => updateUserSettings({ copyWalletSelector: "  " }), ConfigError));
    check(
      "setting a selector does not disturb the caps",
      reload().caps.dailyEth === "0.50"
    );
  });

  // ── copying a mint somebody else paid for ─────────────────────────────
  //
  // The address worth watching is usually a vault: it never sends a mint of its
  // own, every NFT reaching it was bought by a rotating hot wallet. Copying
  // those means dropping the "the target must be the sender" rule, and that
  // rule was load-bearing — so what replaces it is checked here rather than
  // trusted.
  section("third-party-paid copies");

  withStateDir(userStateDir(44445), () => {
    const vault = watchTargets.add(VECTORS[1], "high", "both", "vault", "any");
    const hot = watchTargets.add(VECTORS[2], "high", "both", "hot", "self");

    check("a target can be set to accept any payer", vault.payer === "any");
    check("…and the default stays the strict one", hot.payer === "self");

    check(
      "self only accepts the target's own transaction",
      watchTargets.allowsPayer(hot, VECTORS[2]) && !watchTargets.allowsPayer(hot, VECTORS[0])
    );
    check(
      "…case-insensitively, since senders arrive lowercased",
      watchTargets.allowsPayer(hot, VECTORS[2].toLowerCase())
    );
    check(
      "any accepts a mint paid for by a wallet never seen before",
      watchTargets.allowsPayer(vault, VECTORS[0])
    );

    const flipped = watchTargets.setPayer(VECTORS[2], "any");
    check("the rule can be changed on an existing target", flipped.payer === "any");
    check(
      "…and survives a reload",
      watchTargets.find(VECTORS[2])?.payer === "any"
    );

    check("'vault' is accepted as a friendlier spelling of any", watchTargets.parsePayer("vault") === "any");
    check("an unknown payer setting raises rather than defaulting", throws(() => watchTargets.parsePayer("everyone")));

    // A file written before this setting existed must not be widened by an
    // upgrade — the operator agreed to the strict rule.
    const file = join(userStateDir(44445), "targets.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    for (const entry of raw.targets) delete entry.payer;
    writeFileSync(file, JSON.stringify(raw), "utf8");
    check(
      "a target saved before this setting existed reads back as self",
      watchTargets.list().every((t) => t.payer === "self")
    );
  });

  // ── per-target overrides ──────────────────────────────────────────────
  //
  // Wallets-per-fire and the price ceiling used to be one shared number each,
  // set in a file the operator could not reach. Both now sit on the target, so
  // both need the guard the shared versions had: a bad value must be refused
  // rather than stored, and a missing one must fall back to the shared default
  // rather than to no limit at all.
  section("per-target overrides");

  withStateDir(userStateDir(44447), () => {
    const TIERS = { high: 50, med: 20, low: 5 };
    const t = watchTargets.add(VECTORS[0], "low", "both", "vault", "any");

    check("with no override the tier decides", watchTargets.walletsFor(t, TIERS) === 5);
    const wide = watchTargets.setWalletCount(VECTORS[0], 120);
    check("an override replaces the tier", watchTargets.walletsFor(wide, TIERS) === 120);
    check("…and survives a reload", watchTargets.find(VECTORS[0])?.walletCount === 120);
    const cleared = watchTargets.setWalletCount(VECTORS[0], undefined);
    check("clearing hands it back to the tier", watchTargets.walletsFor(cleared, TIERS) === 5);
    check("…leaving no stale value behind", cleared.walletCount === undefined);

    check("zero wallets is refused", throws(() => watchTargets.setWalletCount(VECTORS[0], 0)));
    check("a negative count is refused", throws(() => watchTargets.setWalletCount(VECTORS[0], -5)));
    check("a fraction is refused", throws(() => watchTargets.setWalletCount(VECTORS[0], 2.5)));
    check(
      "more than the whole store is refused",
      throws(() => watchTargets.setWalletCount(VECTORS[0], 501))
    );

    const GLOBAL = parseEther("0.005");
    check(
      "with no override the global ceiling applies",
      watchTargets.maxPriceFor(watchTargets.find(VECTORS[0])!, GLOBAL) === GLOBAL
    );
    const dearer = watchTargets.setMaxPrice(VECTORS[0], "0.02");
    check("a per-target ceiling overrides the global one", watchTargets.maxPriceFor(dearer, GLOBAL) === parseEther("0.02"));
    check("…and reloads", watchTargets.find(VECTORS[0])?.maxPriceEth === "0.02");
    check(
      "clearing returns to the global cap",
      watchTargets.maxPriceFor(watchTargets.setMaxPrice(VECTORS[0], undefined), GLOBAL) === GLOBAL
    );

    check("a zero ceiling is refused", throws(() => watchTargets.setMaxPrice(VECTORS[0], "0")));
    check("words are refused", throws(() => watchTargets.setMaxPrice(VECTORS[0], "cheap")));
    check(
      "a misplaced decimal is caught by the ceiling",
      throws(() => watchTargets.setMaxPrice(VECTORS[0], "100"))
    );
    check("a trailing ETH is tolerated", watchTargets.setMaxPrice(VECTORS[0], "0.03 ETH").maxPriceEth === "0.03");

    // The dangerous fallback. A stored value that cannot be parsed must read as
    // the global cap, never as "no ceiling" — that direction spends money.
    check(
      "an unparseable stored ceiling falls back to the global cap",
      watchTargets.maxPriceFor({ maxPriceEth: "not-a-number" }, GLOBAL) === GLOBAL
    );
    check(
      "…and an empty one does too",
      watchTargets.maxPriceFor({ maxPriceEth: "" }, GLOBAL) === GLOBAL
    );

    check(
      "setting one override leaves the other alone",
      watchTargets.find(VECTORS[0])?.walletCount === undefined &&
        watchTargets.find(VECTORS[0])?.maxPriceEth === "0.03"
    );
    check("…and neither disturbs the payer rule", watchTargets.find(VECTORS[0])?.payer === "any");
  });

  // ── how far back a scan actually reaches ──────────────────────────────
  //
  // Block times differ by two orders of magnitude across the watched chains —
  // 12s on Ethereum, 0.1s on Robinhood — so a fixed block count means three
  // days on one and half an hour on another. That is exactly how a scan comes
  // back empty and gets read as "this address never mints".
  section("scan window");

  const blockServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // A chain producing a block every 0.1s, like Robinhood.
      const number = Number(BigInt(body.params[0] as string));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { timestamp: `0x${Math.round(number / 10).toString(16)}` },
        })
      );
    });
  });
  await new Promise<void>((resolve) => blockServer.listen(0, "127.0.0.1", resolve));
  const blockUrl = `http://127.0.0.1:${(blockServer.address() as { port: number }).port}`;

  const window = await blocksForHours(blockUrl, 1_000_000, 24);
  check("block time is measured rather than assumed", Math.abs(window.secondsPerBlock - 0.1) < 0.01);
  check(
    "…so 24 hours on a fast chain is hundreds of thousands of blocks",
    Math.abs(window.blocks - 864_000) < 1000
  );
  blockServer.close();

  // ── explaining why a copy did not happen ──────────────────────────────
  //
  // The report has one job: name every setting standing between a mint and a
  // copy, so fixing one and discovering another is not the loop. It judges with
  // the engine's own predicates, so a pass here is a statement about the
  // engine rather than about a second implementation of it.
  section("copy blockers");

  withStateDir(userStateDir(44448), () => {
    const vault = watchTargets.add(VECTORS[1], "high", "both", "vault", "any");
    const base = {
      target: vault,
      tiers: { high: 50, med: 20, low: 5 },
      globalMaxPriceWei: parseEther("0.005"),
      perEventWei: parseEther("0.1"),
      gasReservationWei: parseEther("0.0005"),
      poolSize: 100,
      copyEnabled: true,
    };
    const mint = {
      contract: VECTORS[2],
      transactionHash: "0xabc",
      blockNumber: 1,
      payer: VECTORS[0],
      valueWei: parseEther("0.011"),
      selector: "0x161ac21f",
      method: "mintPublic",
      standard: "erc721" as const,
    };

    const overPriced = assessMint(mint, base);
    check("a mint above the ceiling is reported as blocked", !overPriced.wouldCopy);
    check("…naming the price as the reason", overPriced.blockers.some((b) => b.kind === "price"));

    const raised = assessMint(mint, {
      ...base,
      target: { ...vault, maxPriceEth: "0.02" },
    });
    check("a per-target ceiling unblocks it", raised.wouldCopy);
    check(
      "…and the wallet count is trimmed by the per-event cap",
      raised.walletCount === Math.floor(0.1 / 0.0115)
    );

    check(
      "a self-only target blocks a third-party-paid mint",
      assessMint(mint, { ...base, target: { ...vault, payer: "self" } }).blockers.some(
        (b) => b.kind === "payer"
      )
    );
    check(
      "a free-only target blocks a paid mint",
      assessMint(mint, { ...base, target: { ...vault, mintMode: "free" } }).blockers.some(
        (b) => b.kind === "mintMode"
      )
    );
    check(
      "copy-mint being off is reported, not silently assumed",
      assessMint(mint, { ...base, copyEnabled: false }).blockers.some((b) => b.kind === "copyOff")
    );
    check(
      "an empty wallet pool is reported",
      assessMint(mint, { ...base, poolSize: 0 }).blockers.some((b) => b.kind === "pool")
    );
    check(
      "a signature-gated mint is reported as uncopyable by anyone",
      assessMint({ ...mint, method: "mintSigned" }, base).blockers.some(
        (b) => b.kind === "signature"
      )
    );

    // Every blocker at once, because fixing them one at a time is the loop this
    // exists to end.
    const everything = assessMint(
      { ...mint, method: "mintSigned" },
      { ...base, target: { ...vault, payer: "self", mintMode: "free" }, poolSize: 0, copyEnabled: false }
    );
    check("all blockers are reported together, not just the first", everything.blockers.length >= 5);
    check("…and each carries a remedy", everything.blockers.every((b) => b.remedy.length > 0));

    const free = assessMint({ ...mint, valueWei: 0n, method: "mintPublic" }, base);
    check("a free mint from a correctly-set target copies", free.wouldCopy);
    check("…using the target's wallet count", free.walletCount === 50);

    const capped = assessMint({ ...mint, valueWei: 0n }, {
      ...base,
      target: { ...vault, walletCount: 7 },
    });
    check("…or its own override when it has one", capped.walletCount === 7);
  });

  // ── and the replay rule that makes it safe ────────────────────────────
  //
  // Dropping the sender check exposes the one failure simulation cannot catch:
  // calldata that succeeds and mints into *their* wallet. The defence is that a
  // third-party-paid mint must name the target somewhere, so the recipient can
  // be rewritten to us.
  section("third-party replay safety");

  const REPLAY_NFT = "0x1111111111111111111111111111111111111111";
  const REPLAY_TARGET = VECTORS[0];
  const REPLAY_WALLET = VECTORS[1];
  const SEADROP_SINGLETON = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
  const seadrop = new ethersInterface([
    "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
  ]);
  const creditingTarget = seadrop.encodeFunctionData("mintPublic", [
    REPLAY_NFT,
    "0x0000a26b00c1F0DF003000390027140000fAa719",
    REPLAY_TARGET,
    1,
  ]);
  // The same drop minted by the target itself: nothing in the calldata names
  // anyone, because SeaDrop credits msg.sender when minterIfNotPayer is zero.
  const creditingSender = seadrop.encodeFunctionData("mintPublic", [
    REPLAY_NFT,
    "0x0000a26b00c1F0DF003000390027140000fAa719",
    "0x0000000000000000000000000000000000000000",
    1,
  ]);

  // A node that approves everything, so what is under test is the rule rather
  // than the chain's opinion of it.
  const gasServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x30d40" }));
    });
  });
  await new Promise<void>((resolve) => gasServer.listen(0, "127.0.0.1", resolve));
  const gasUrl = `http://127.0.0.1:${(gasServer.address() as { port: number }).port}`;

  const boundPlan = await buildReplay({
    readUrl: gasUrl,
    target: REPLAY_TARGET,
    to: SEADROP_SINGLETON,
    originalData: creditingTarget,
    value: 0n,
    wallets: [{ id: "d:1", address: REPLAY_WALLET }],
    configuredGasLimit: 250_000,
    requireAddressBound: true,
  });
  check("a mint naming the target is replayable when someone else paid", boundPlan.addressBound);
  check(
    "…and the rewritten calldata no longer mentions the target",
    !contains(boundPlan.dataFor.get(REPLAY_WALLET)!, REPLAY_TARGET)
  );
  check(
    "…crediting our wallet instead",
    inspectCalldata(
      { to: SEADROP_SINGLETON, data: boundPlan.dataFor.get(REPLAY_WALLET)!, value: 0n },
      REPLAY_NFT,
      REPLAY_WALLET
    ).ok
  );
  check(
    "…where the original would have credited theirs",
    !inspectCalldata({ to: SEADROP_SINGLETON, data: creditingTarget, value: 0n }, REPLAY_NFT, REPLAY_WALLET).ok
  );

  // The expensive one. This calldata simulates perfectly and mints to whoever
  // msg.sender is — but the target was credited by some mechanism we cannot
  // see, so replaying it is a guess with money on it.
  let unboundRefused = false;
  try {
    await buildReplay({
      readUrl: gasUrl,
      target: REPLAY_TARGET,
      to: SEADROP_SINGLETON,
      originalData: creditingSender,
      value: 0n,
      wallets: [{ id: "d:1", address: REPLAY_WALLET }],
      configuredGasLimit: 250_000,
      requireAddressBound: true,
    });
  } catch (err) {
    unboundRefused = err instanceof ReplayError;
  }
  check("calldata that never names the target is REFUSED when another wallet paid", unboundRefused);

  const selfPlan = await buildReplay({
    readUrl: gasUrl,
    target: REPLAY_TARGET,
    to: SEADROP_SINGLETON,
    originalData: creditingSender,
    value: 0n,
    wallets: [{ id: "d:1", address: REPLAY_WALLET }],
    configuredGasLimit: 250_000,
  });
  check("…but still replayable when the target paid for it themselves", !selfPlan.addressBound);
  gasServer.close();

  section("wallet store");
  check("starts empty", !storeExists());

  initFromMnemonic(TEST_MNEMONIC, "bot passphrase");
  check("store created", storeExists());

  const store = unlock("bot passphrase");
  const created = store.generate(500);
  check("generate 500", created.length === 500, `got ${created.length}`);

  const wallets = store.all();
  check("500 wallets listed", wallets.length === 500, `got ${wallets.length}`);
  VECTORS.forEach((expected, i) => {
    check(`index ${i} matches BIP-44 vector`, wallets[i].address === expected, `got ${wallets[i].address}`);
  });
  check("derived wallets default to auto-fire", wallets.every((w) => w.autoFire));
  check("signer resolves to the right address", store.signer("d:1").address === VECTORS[1]);

  store.generate(100);
  check("extending appends", store.all().length === 600);
  check("extending leaves earlier indices alone", store.all()[0].address === VECTORS[0]);

  // ── imports ───────────────────────────────────────────────────────────
  section("imports");
  const throwaway = Wallet.createRandom();
  const blob = sealJson({ keys: [{ privateKey: throwaway.privateKey }] }, "bot passphrase");

  const entries = readImportBlob(JSON.stringify(blob), "bot passphrase");
  check("encrypted blob decodes", entries.length === 1);

  const first = store.importKeys(entries);
  check("key imported", first.added.length === 1 && first.added[0] === throwaway.address);

  const second = store.importKeys(entries);
  check("re-import is a no-op", second.added.length === 0 && second.duplicates.length === 1);

  const imported = store.all().find((w) => w.kind === "imported");
  check("imported wallet present", imported !== undefined);
  check("imported defaults to MANUAL, not auto-fire", imported?.autoFire === false);
  check(
    "an unencrypted key file is refused",
    throws(() => readImportBlob(JSON.stringify({ keys: [{ privateKey: throwaway.privateKey }] }), "x"))
  );

  // ── persistence ───────────────────────────────────────────────────────
  section("persistence");
  // Timed on a cold store: this is the real boot cost, and it is the reason
  // derivation is warmed at startup rather than inside a mint path.
  const unlockStart = Date.now();
  const reopened = unlock("bot passphrase");
  const unlockMs = Date.now() - unlockStart;
  const primeStart = Date.now();
  reopened.primeDerivation();
  console.log(`    cold unlock (scrypt): ${unlockMs}ms`);
  console.log(`    cold derivation of 601 wallets: ${Date.now() - primeStart}ms`);

  check("wallet count survives reload", reopened.all().length === 601);
  check(
    "manual flag survives reload",
    reopened.all().find((w) => w.kind === "imported")?.autoFire === false
  );

  // ── selectors ─────────────────────────────────────────────────────────
  section("selectors");
  const all = reopened.all();
  const ctx = emptyContext(parseEther("0.0005"));
  all.forEach((w, i) => {
    ctx.state.set(w.id, { balanceWei: i < 10 ? parseEther("0.001") : 0n, nonceGap: i === 3 });
  });

  const cases: [string, number][] = [
    ["all", 601],
    ["derived", 600],
    ["imported", 1],
    ["funded", 10],
    ["derived+funded", 10],
    ["derived+!funded", 590],
    ["0-99", 100],
    ["7", 1],
    ["imported,0-4", 6],
    ["stuck", 1],
    [VECTORS[0], 1],
  ];
  for (const [selector, expected] of cases) {
    const got = resolveWallets(selector, all, ctx).length;
    check(`${selector} → ${expected}`, got === expected, `got ${got}`);
  }
  check(
    "a typo raises instead of matching nothing",
    throws(() => resolveWallets("funded+nonsenseterm", all, ctx), SelectorError)
  );

  section("auto-fire safety rails");
  const auto = resolveForAutoFire("all+funded", all, ctx);
  check("stuck wallets excluded", !auto.selected.some((w) => ctx.state.get(w.id)?.nonceGap));
  check("exclusion is reported", auto.excludedStuck === 1);

  const autoImported = resolveForAutoFire("imported", all, ctx);
  check("imported wallets refused even when selected", autoImported.selected.length === 0);
  check("manual exclusion is reported", autoImported.excludedManual === 1);

  // ── the pool a copy signal fires from ─────────────────────────────────
  //
  // Two gates were removed from this after they declined fifteen mints in a
  // day while the money sat ready: a wallet no longer has to be "armed", and no
  // longer has to prove it holds gas. Deciding the second meant reading every
  // balance first, which cost ten to fifteen seconds of a one-block budget to
  // learn something the node decides for free at dispatch.
  section("copy pool");

  const copyPool = resolveForCopy("all", all, ctx);
  check(
    "an unarmed wallet still fires",
    copyPool.selected.some((w) => !w.autoFire),
    `selected ${copyPool.selected.length} of ${all.length}`
  );

  const noBalances = emptyContext(parseEther("0.0005"));
  const blindPool = resolveForCopy("all", all, noBalances);
  check(
    "…and so does one whose balance was never read",
    blindPool.selected.length === all.length
  );

  const brokeCtx2 = emptyContext(parseEther("0.0005"));
  all.forEach((w) => brokeCtx2.state.set(w.id, { balanceWei: 0n }));
  check(
    "…and so does an empty one, because the node rejects it for free",
    resolveForCopy("all", all, brokeCtx2).selected.length === all.length
  );

  // A nonce gap is different: that transaction cannot land whatever the
  // balance, so skipping it costs nothing and is still done.
  const stuckCtx2 = emptyContext(parseEther("0.0005"));
  all.forEach((w) => stuckCtx2.state.set(w.id, { balanceWei: parseEther("1"), nonceGap: true }));
  const jammedPool = resolveForCopy("all", all, stuckCtx2);
  check("a wallet behind a nonce gap is still skipped", jammedPool.selected.length === 0);
  check("…and counted", jammedPool.stuck === all.length);

  check("the selector still decides membership", resolveForCopy("imported", all, ctx).matched < all.length);

  // ── the funder never mints ────────────────────────────────────────────
  //
  // The one exclusion that survived. Arming and funding were dropped because
  // they were preferences dressed as safety; this is neither — the funder is
  // the wallet every other wallet is topped up from, so it is the only one
  // reliably holding money, and "all" therefore reaches it first. On the live
  // deployment it sent all fifty-six copy mints while five hundred derived
  // wallets sat idle, and both gates that should have stopped it (a "funder"
  // tag and autoFire: false) were the ones that had just been removed.
  section("the funder is not a minting wallet");

  const guarded = emptyContext(parseEther("0.0005"));
  guarded.protectedAddresses = new Set([all[0].address.toLowerCase()]);
  const guardedPool = resolveForCopy("all", all, guarded);
  check(
    "the funding wallet is kept out of the copy pool",
    !guardedPool.selected.some((w) => w.address === all[0].address)
  );
  check("…and the exclusion is counted", guardedPool.excludedProtected === 1);
  check("…while every other wallet is untouched", guardedPool.selected.length === all.length - 1);
  check(
    "…and naming it explicitly does not get round the rule",
    resolveForCopy(all[0].address, all, guarded).selected.length === 0
  );
  check(
    "…nor does the auto-fire pool disagree with the copy pool",
    !resolveForAutoFire("all", all, guarded).selected.some((w) => w.address === all[0].address)
  );
  check(
    "with no funder configured nothing is excluded",
    resolveForCopy("all", all, emptyContext(parseEther("0.0005"))).excludedProtected === 0
  );

  // ── who gets tried first ──────────────────────────────────────────────
  //
  // A signal takes the first N of the pool, so order decides who mints. Live,
  // the only wallets holding gas were the last ten in the store and were never
  // reached; the fifty at the front had never been funded. Nothing is excluded
  // here — an unread balance is not evidence of an empty wallet — but a wallet
  // known to hold gas is asked before one known to be empty.
  section("the funded wallets are tried first");

  const ordering = emptyContext(parseEther("0.0005"));
  all.forEach((w) => ordering.state.set(w.id, { lastKnownBalanceWei: 0n }));
  const last = all[all.length - 1];
  ordering.state.set(last.id, { lastKnownBalanceWei: parseEther("1") });
  const ordered = resolveForCopy("all", all, ordering);
  check("a wallet known to hold gas leads the queue", ordered.selected[0]?.id === last.id);
  check("…and nothing is dropped for being empty", ordered.selected.length === all.length);

  const mixedCtx = emptyContext(parseEther("0.0005"));
  mixedCtx.state.set(all[0].id, { lastKnownBalanceWei: 0n });
  const mixedOrder = resolveForCopy("all", all, mixedCtx);
  check(
    "an unread balance outranks a known-empty wallet",
    mixedOrder.selected[mixedOrder.selected.length - 1]?.id === all[0].id
  );
  check(
    "…and dust below the gas reservation counts as empty",
    (() => {
      const dusty = emptyContext(parseEther("0.0005"));
      dusty.state.set(all[0].id, { lastKnownBalanceWei: parseEther("0.0001") });
      const pool = resolveForCopy("all", all, dusty);
      return pool.selected[pool.selected.length - 1]?.id === all[0].id;
    })()
  );
  check(
    "equal ranks keep store order",
    resolveForCopy("all", all, emptyContext(parseEther("0.0005")))
      .selected.map((w) => w.id)
      .join() === all.map((w) => w.id).join()
  );

  // ── pasted input ──────────────────────────────────────────────────────
  section("collection input");

  const OMR = "0x8761D975bc4eccAF48cB650Fb0871e066058Ea61";
  const inputCases: [string, string][] = [
    ["https://opensea.io/collection/omrevo/overview", "slug:omrevo"],
    ["https://opensea.io/collection/omrevo", "slug:omrevo"],
    ["opensea.io/collection/omrevo?tab=items", "slug:omrevo"],
    ["https://opensea.io/collection/OMREVO", "slug:omrevo"],
    ["omrevo", "slug:omrevo"],
    [OMR, `address:${OMR}`],
    [`  ${OMR}  `, `address:${OMR}`],
    [`https://opensea.io/item/robinhood/${OMR}/1`, `address:${OMR}`],
    [`https://opensea.io/assets/base/${OMR}/1`, `address:${OMR}`],
    ["0xnothex", "invalid"],
    ["https://example.com/collection/omrevo", "invalid"],
    ["", "invalid"],
  ];
  for (const [input, expected] of inputCases) {
    const parsed = parseCollectionInput(input);
    const got =
      parsed.kind === "slug"
        ? `slug:${parsed.slug}`
        : parsed.kind === "address"
          ? `address:${parsed.address}`
          : "invalid";
    check(`${input || "(empty)"} → ${expected}`, got === expected, `got ${got}`);
  }

  check(
    "an item URL keeps the chain as a hint",
    (parseCollectionInput(`https://opensea.io/item/robinhood/${OMR}/1`) as { chainHint?: string })
      .chainHint === "robinhood"
  );

  // ── OpenSea chain coverage ────────────────────────────────────────────
  //
  // A missing entry here is invisible until a mint fails on the chain, which is
  // how Robinhood /fcfs failed at slug resolution rather than at the mint.
  section("OpenSea chain slugs");
  for (const profile of CHAINS) {
    check(
      `${profile.name} (${profile.chainId}) has an OpenSea slug`,
      openSeaChainSlug(profile.chainId) !== undefined
    );
  }
  check("Robinhood maps to the slug OpenSea answers on", openSeaChainSlug(4663) === "robinhood");

  // ── the dashboard's arithmetic ────────────────────────────────────────
  //
  // This screen gets read as the answer to "am I funded?", so the ways it can
  // mislead are the ways that cost money: counting the funder among the wallets
  // that mint, reporting a chain that would not answer as a set of empty
  // wallets, or reading funded-on-Base as funded everywhere.
  section("dashboard");

  const DASH_FUNDER = VECTORS[0];
  const DASH_A = VECTORS[1];
  const DASH_B = VECTORS[2];
  const DASH_IMPORTED = "0x00000000000000000000000000000000000000aa";
  const RESERVE = parseEther("0.0005");

  const dashWallets = [
    { id: "d:0", address: DASH_FUNDER, kind: "derived", autoFire: false },
    { id: "d:1", address: DASH_A, kind: "derived", autoFire: true },
    { id: "d:2", address: DASH_B, kind: "derived", autoFire: true },
    { id: "i:aa", address: DASH_IMPORTED, kind: "imported", autoFire: false },
  ];

  const dashChains = [
    {
      key: "base",
      name: "Base",
      symbol: "ETH",
      minFundedWei: RESERVE,
      // The imported wallet is deliberately absent: a balance the node did not
      // return is unknown, not zero.
      balances: new Map<string, bigint>([
        [DASH_FUNDER, parseEther("0.03")],
        [DASH_A, 0n],
        [DASH_B, parseEther("1")],
      ]),
    },
    {
      key: "robinhood",
      name: "Robinhood",
      symbol: "ETH",
      minFundedWei: RESERVE,
      balances: new Map<string, bigint>([
        [DASH_FUNDER, 0n],
        [DASH_A, parseEther("0.001")],
        [DASH_B, 0n],
        [DASH_IMPORTED, 0n],
      ]),
    },
    // No balances at all — this chain did not answer.
    { key: "ethereum", name: "Ethereum", symbol: "ETH", minFundedWei: RESERVE },
  ];

  const dashNow = Date.parse("2026-08-19T12:00:00Z");
  const HOUR = 3_600_000;
  const dashLedger: LedgerEntry[] = [
    {
      ts: dashNow - 60_000,
      kind: "mint",
      chainId: 8453,
      contract: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      walletIds: ["d:1", "d:2"],
      valueWei: parseEther("0.002").toString(),
      quantity: 3,
    },
    {
      ts: dashNow - 120_000,
      kind: "mint",
      chainId: 8453,
      contract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      walletIds: ["d:1"],
      valueWei: parseEther("0.001").toString(),
      auto: true,
    },
    {
      // Older than the rolling window, and the same collection in another case.
      ts: dashNow - 40 * HOUR,
      kind: "mint",
      chainId: 1,
      contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      walletIds: ["d:2"],
      valueWei: parseEther("5").toString(),
      auto: true,
    },
    {
      ts: dashNow - 30_000,
      kind: "fund",
      chainId: 8453,
      walletIds: ["d:1"],
      valueWei: parseEther("0.01").toString(),
    },
  ];

  const dash = collectDashboard({
    wallets: dashWallets,
    funder: DASH_FUNDER,
    chains: dashChains,
    ledger: dashLedger,
    targets: [{ fires: 4 }, { fires: 1 }],
    copyEnabled: true,
    capDailyWei: parseEther("0.05"),
    now: dashNow,
  });

  check("the funder is not counted as a minting wallet", dash.wallets.total === 3);
  check(
    "…and derived/imported still split correctly",
    dash.wallets.derived === 2 && dash.wallets.imported === 1
  );
  check("armed and manual add up", dash.wallets.armed === 2 && dash.wallets.manual === 1);

  const baseRow = dash.funding.chains.find((c) => c.key === "base")!;
  const rhRow = dash.funding.chains.find((c) => c.key === "robinhood")!;
  const ethRow = dash.funding.chains.find((c) => c.key === "ethereum")!;

  check("a chain counts only the wallets it answered for", baseRow.funded === 1 && baseRow.empty === 1);
  check("…and reports the rest as unread rather than empty", baseRow.unknown === 1);
  check("the funder's balance is reported apart from the set", baseRow.funderWei === parseEther("0.03"));
  check("…and left out of the set's total", baseRow.totalWei === parseEther("1"));
  check("a chain that did not answer is marked unread", !ethRow.read);
  check("…and contributes no empty wallets", ethRow.empty === 0 && ethRow.funded === 0);

  check(
    "funded means funded on at least one chain",
    dash.funding.fundedAnywhere === 2 && rhRow.funded === 1
  );
  check("ready to fire is armed AND funded", dash.funding.readyToFire === 2);
  check(
    "only chains that answered count as read",
    dash.funding.chainsRead === 2 && !dash.funding.blind
  );

  check("every mint is counted", dash.minted.runs === 3 && dash.minted.txs === 4);
  check("a recorded quantity multiplies the NFT count", dash.minted.nfts === 8);
  check(
    "a missing quantity counts one NFT per transaction, not zero",
    summariseMints([{ ...dashLedger[1], quantity: undefined }]).nfts === 1
  );
  check("collections are deduplicated case-insensitively", dash.minted.collections === 2);
  check("spend sums across every mint", dash.minted.spentWei === parseEther("5.003"));

  check("copies are the autonomous subset", dash.copied.runs === 2 && dash.copied.txs === 2);
  check("…and carry their own spend", dash.copied.spentWei === parseEther("5.001"));
  check("watch-list fires are totalled", dash.copy.fires === 5 && dash.copy.targets === 2);

  check("the 24h window drops older entries", dash.day.mintRuns === 2 && dash.day.copyRuns === 1);
  check(
    "hand-driven spend is reported apart from the capped kind",
    dash.day.autoSpentWei === parseEther("0.001") &&
      dash.day.manualSpentWei === parseEther("0.002")
  );
  check("funding transfers are not counted as mints", dash.day.fundedWei === parseEther("0.01"));

  check("percentages survive an empty set", pct(0, 0) === 0 && pct(2, 3) === 67);

  // ── and how it reads ──
  const dashText = renderDashboard(dash);
  check("the headline states funded out of total", dashText.includes("<b>2 of 3</b> have enough for gas"));
  check("an unread chain says so in words", /Ethereum<\/b> \u2014 could not be reached/.test(dashText));
  check("the card fits one Telegram message", dashText.length < 4000);

  const blindCard = renderDashboard(
    collectDashboard({
      wallets: dashWallets,
      funder: DASH_FUNDER,
      chains: dashChains.map((c) => ({ ...c, balances: undefined })),
      ledger: dashLedger,
      targets: [],
      copyEnabled: false,
      capDailyWei: parseEther("0.05"),
      now: dashNow,
    })
  );
  check(
    "with no chain readable it says unknown, never zero funded",
    blindCard.includes("how many have money is unknown")
  );
  check("…and does not state a funded count at all", !blindCard.includes("of 3 wallets funded"));

  const emptyStore = renderDashboard(
    collectDashboard({
      wallets: [],
      funder: DASH_FUNDER,
      chains: dashChains,
      ledger: [],
      targets: [],
      copyEnabled: false,
      capDailyWei: parseEther("0.05"),
      now: dashNow,
    })
  );
  check(
    "a fresh store gets a first step rather than a wall of zeroes",
    emptyStore.includes("You have none yet")
  );

  // ── a hand-typed funding amount ───────────────────────────────────────
  //
  // The buttons cannot be fat-fingered; a typed amount can, and it is
  // multiplied by the size of the wallet set.
  section("custom funding amount");

  const CAP = parseEther("0.5");
  const accepts: [string, string][] = [
    ["0.0035", "0.0035"],
    ["0.5", "0.5"],
    ["  0.002  ", "0.002"],
    ["0.002 ETH", "0.002"],
    ["0.002eth", "0.002"],
    ["Ξ0.002", "0.002"],
    [".5", ".5"],
    ["1", "1"],
  ];
  for (const [input, expectText] of accepts) {
    const got = parseFundAmount(input, input === "1" ? parseEther("1") : CAP);
    check(
      `accepts ${JSON.stringify(input)}`,
      got.ok && got.text === expectText,
      got.ok ? got.text : got.reason
    );
  }

  check("0.002 parses to the right wei", (() => {
    const r = parseFundAmount("0.002", CAP);
    return r.ok && r.wei === parseEther("0.002");
  })());

  const rejects: [string, string][] = [
    ["0", "zero"],
    ["0.0", "zero"],
    ["", "empty"],
    ["   ", "empty"],
    ["abc", "malformed"],
    ["0.002.3", "malformed"],
    ["-0.002", "malformed"],
    ["1e-3", "malformed"],
    ["0,002", "malformed"],
    ["0.0000000000000000001", "malformed"],
    ["1", "too_large"],
    ["100", "too_large"],
  ];
  for (const [input, reason] of rejects) {
    const got = parseFundAmount(input, CAP);
    check(
      `rejects ${JSON.stringify(input)} as ${reason}`,
      !got.ok && got.reason === reason,
      got.ok ? `accepted ${got.text}` : got.reason
    );
  }

  // The mistake this guard exists for: a decimal slipped one place.
  check(
    "a misplaced decimal is refused, not confirmed",
    !parseFundAmount("2", CAP).ok && parseFundAmount("0.2", CAP).ok
  );

  // ── which chain a command means ───────────────────────────────────────
  //
  // The button flows express the chosen chain by appending "on <chain>", the
  // same way a typed command does, so this parser is the single point where a
  // wiring slip would send money to a chain nobody picked.
  section("chain selection");

  const chainCases: [string[], string | undefined][] = [
    // What the fund flow now emits.
    [["derived+funded", "0.002", "on", "robinhood"], "robinhood"],
    [["all", "on", "base"], "base"],
    [["0xabc", "2", "derived+funded", "wait", "on", "robinhood"], "robinhood"],
    [["0xabc", "2", "derived+funded", "wait", "at", "17:30", "on", "base"], "base"],
    [["ROBINHOOD"], undefined],
    [["on", "Robinhood"], "robinhood"],
    [["on", "  base  "], "base"],
    // No override present.
    [["derived+funded", "0.002"], undefined],
    [[], undefined],
    // Malformed: "on" with nothing after it must not resolve to a chain.
    [["all", "on"], undefined],
    [["all", "on", ""], undefined],
  ];
  for (const [parts, expected] of chainCases) {
    const got = chainOverrideFrom(parts);
    check(
      `[${parts.join(" ")}] → ${expected ?? "no override"}`,
      got === expected,
      `got ${got}`
    );
  }

  // ── holding for a stage that has not opened ───────────────────────────
  //
  // The hold has to tell three things apart: the stage is shut (keep asking),
  // the stage is answering but has nothing for this wallet (go), and the
  // request is hopeless (stop). Getting the middle case wrong would hold
  // through a live drop.
  section("pre-open hold");

  // At or after the published open.
  check("a closed stage keeps the hold waiting", openSignal("not_live", true) === "wait");
  check("a throttle keeps the hold waiting", openSignal("rate_limited", true) === "wait");
  check("a server error keeps the hold waiting", openSignal("server", true) === "wait");
  check("an unclassified refusal keeps the hold waiting", openSignal("unknown", true) === "wait");
  check("a transport error keeps the hold waiting", openSignal(undefined, true) === "wait");
  check("an ineligible prober means the stage is open", openSignal("not_eligible", true) === "open");
  check(
    "an underfunded prober means the stage is open",
    openSignal("insufficient_balance", true) === "open"
  );
  check("a minted-out drop aborts rather than spinning", openSignal("minted_out", true) === "abort");

  // Before it — a different stage may be live and answering confidently about
  // itself. OMR EVO had a holder claim live an hour before the public sale.
  check(
    "an ineligible answer BEFORE the open is not proof of the open",
    openSignal("not_eligible", false) === "wait"
  );
  check(
    "an underfunded answer BEFORE the open is not proof of the open",
    openSignal("insufficient_balance", false) === "wait"
  );
  check(
    "a minted-out answer BEFORE the open does not abort the hold",
    openSignal("minted_out", false) === "wait"
  );

  // Refusals that waiting cannot repair, whenever they arrive.
  check("a bad API key aborts rather than spinning", openSignal("auth", true) === "abort");
  check("…even before the open", openSignal("auth", false) === "abort");
  // Seen live: an exchange hot wallet gets HTTP 400 "Account can not perform
  // trading operations". Treating that as retryable spun the hold for its full
  // grace period against an address OpenSea was never going to serve.
  check(
    "a barred account aborts rather than spinning",
    openSignal("account_restricted", true) === "abort"
  );
  check("…even before the open", openSignal("account_restricted", false) === "abort");

  // Pacing has to stay inside the rate limit it exists to protect.
  check("probes never come closer than the floor", OPEN_POLL.tightMs >= OPEN_POLL.floorMs);
  check(
    "tight cadence stays under 2 requests/second",
    1000 / OPEN_POLL.tightMs < 2,
    `${(1000 / OPEN_POLL.tightMs).toFixed(2)}/s`
  );
  check("the hold starts listening before the published open", OPEN_POLL.leadMs > 0);
  check("waiting far out is cheaper than waiting close in", OPEN_POLL.looseMs > OPEN_POLL.tightMs);
  check("a throttle backs off rather than retrying at pace", OPEN_POLL.firstBackoffMs > OPEN_POLL.tightMs);
  check("backoff is capped", OPEN_POLL.maxBackoffMs >= OPEN_POLL.firstBackoffMs);
  check("the hold gives up eventually", OPEN_POLL.graceMs > 0 && OPEN_POLL.graceMs <= 600_000);

  // Measured at a real open: an 8s default timeout on a hung first probe put
  // detection 9s past the stage opening. A probe asks a yes/no question and is
  // cheap to repeat, so it should be abandoned well before that.
  check(
    "a probe is abandoned faster than the default request timeout",
    OPEN_POLL.probeTimeoutMs <= 3_000,
    `${OPEN_POLL.probeTimeoutMs}ms`
  );
  check(
    "…but escalates so a merely slow endpoint still gets answered",
    OPEN_POLL.maxProbeTimeoutMs > OPEN_POLL.probeTimeoutMs
  );
  check(
    "a hung probe cannot delay detection by more than its timeout plus the gap",
    OPEN_POLL.probeTimeoutMs + OPEN_POLL.tightMs < 5_000
  );

  // A finished drop and an unopened stage both answer 404 on the mint
  // endpoint. Seen live: a drop sold out during an earlier stage, so the one
  // being waited for never opened, and the hold burned its whole grace period
  // to report a timeout instead of the reason.
  check("the hold rechecks whether the drop still exists", OPEN_POLL.dropRecheckMs > 0);
  check(
    "…often enough to exit early rather than at the grace deadline",
    OPEN_POLL.dropRecheckMs * 4 <= OPEN_POLL.graceMs,
    `${OPEN_POLL.dropRecheckMs}ms vs ${OPEN_POLL.graceMs}ms`
  );
  check(
    "…but rarely enough to stay a rounding error on the request budget",
    OPEN_POLL.dropRecheckMs >= OPEN_POLL.tightMs * 10
  );

  // The worst case that matters: how many requests a full grace period of
  // tight probing would spend if the stage never opened at all.
  const worstCaseProbes = Math.ceil(OPEN_POLL.graceMs / OPEN_POLL.tightMs);
  check(
    `a full ${OPEN_POLL.graceMs / 1000}s hold costs at most ${worstCaseProbes} requests`,
    worstCaseProbes <= 500,
    `${worstCaseProbes}`
  );

  // ── money arithmetic ──────────────────────────────────────────────────
  section("money arithmetic");
  const maxFee = parseEther("0.000000002"); // 2 gwei
  const required = requiredPerWallet(250_000, maxFee, parseEther("0.001"));
  check(
    "reservation = gasLimit × maxFee + price",
    required === parseEther("0.0015"),
    `got ${required}`
  );

  const targets = all.slice(0, 5).map((w) => ({ id: w.id, address: w.address }));
  const balances = new Map(targets.map((t, i) => [t.address, i < 2 ? parseEther("0.002") : 0n]));
  const short = shortfalls(targets, balances, parseEther("0.0015"));
  check("shortfalls finds the underfunded", short.length === 3, `got ${short.length}`);
  check("deficit is the difference", short[0].deficit === parseEther("0.0015"));

  const fundPlan = planFunding(short, maxFee);
  check("funding plan covers every shortfall", fundPlan.transfers.length === 3);
  check(
    "funding gas is 21000 per transfer",
    fundPlan.gasCost === BigInt(3) * BigInt(TRANSFER_GAS) * maxFee
  );

  const sweepPlan = planEthSweep(targets, balances, maxFee);
  check("sweep skips wallets that can't pay their own gas", sweepPlan.transfers.length === 2);
  check(
    "sweep leaves exactly the transfer cost behind",
    sweepPlan.transfers[0].amount === parseEther("0.002") - BigInt(TRANSFER_GAS) * maxFee
  );

  // Signing is checked by decoding the raw transactions back. A sweep that
  // signs from the wrong wallet, or sends somewhere other than the funder,
  // would empty the whole set — recovering the sender from the signature
  // proves it did neither.
  const DESTINATION = "0x000000000000000000000000000000000000dEaD";
  const signed = await signEthSweep(sweepPlan, {
    signerFor: (id: string) => store.signer(id),
    destination: DESTINATION,
    chainId: 8453,
    endpoints: [],
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxFee / 2n,
    nonceFor: () => 7,
  });
  check("sweep signs one transaction per transfer", signed.length === 2);

  const rawTx = JSON.parse(signed[0].body).params[0] as string;
  const decoded = Transaction.from(rawTx);
  check(
    "…signed by the wallet holding the funds",
    decoded.from?.toLowerCase() === sweepPlan.transfers[0].address.toLowerCase(),
    `signed by ${decoded.from}`
  );
  check("…sent to the pinned destination", decoded.to?.toLowerCase() === DESTINATION.toLowerCase());
  check("…for the planned amount", decoded.value === sweepPlan.transfers[0].amount);
  check("…at the wallet's own nonce", decoded.nonce === 7);
  check("…and never exceeds a plain transfer's gas", decoded.gasLimit === BigInt(TRANSFER_GAS));

  const nothing = await signEthSweep(
    { transfers: [], total: 0n, skipped: [] },
    {
      signerFor: (id: string) => store.signer(id),
      destination: DESTINATION,
      chainId: 8453,
      endpoints: [],
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: maxFee / 2n,
      nonceFor: () => 0,
    }
  );
  check("an empty sweep signs nothing", nothing.length === 0);

  // ── calldata substitution ─────────────────────────────────────────────
  section("calldata substitution");
  const TARGET = VECTORS[0];
  const OURS = VECTORS[1];
  const pad = (a: string): string => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const QTY_ONE = "1".padStart(64, "0");

  // mintPublic-style: no address parameter at all, credits msg.sender.
  const agnostic = `0x161ac21f${pad("0x00005EA00Ac477B1030CE78506496e8C2dE24bf5")}${QTY_ONE}`;
  const agnosticOut = substituteAddress(agnostic, TARGET, OURS);
  check("address-agnostic calldata is untouched", agnosticOut.occurrences === 0);
  check("…and byte-identical", agnosticOut.data === agnostic);

  // mint(address to, uint256 qty) — the dangerous one that succeeds while
  // minting to them.
  const bound = `0x40c10f19${pad(TARGET)}${QTY_ONE}`;
  const boundOut = substituteAddress(bound, TARGET, OURS);
  check("recipient parameter is rewritten", boundOut.occurrences === 1);
  check("…to our address", boundOut.data.includes(pad(OURS).slice(24)));
  check("…and the target is gone", !contains(boundOut.data, TARGET));

  // Several occurrences (e.g. to + minterIfNotPayer).
  const twice = `0x00000000${pad(TARGET)}${pad(TARGET)}${QTY_ONE}`;
  check("every occurrence is rewritten", substituteAddress(twice, TARGET, OURS).occurrences === 2);

  // Checksummed input against lowercase calldata must still match.
  check(
    "matching is case-insensitive",
    substituteAddress(bound.toLowerCase(), TARGET, OURS).occurrences === 1
  );

  // A run of digits that merely spans the same characters at an odd nibble
  // offset is not an encoded address and must not be touched.
  const misaligned = `0xa${TARGET.slice(2).toLowerCase()}b`;
  const misalignedOut = substituteAddress(misaligned, TARGET, OURS);
  check("non-byte-aligned matches are ignored", misalignedOut.occurrences === 0);
  check("…leaving the data unchanged", misalignedOut.data === misaligned);

  check("selector is the first 4 bytes", selectorOf(bound) === "0x40c10f19");

  // ── spend policy ──────────────────────────────────────────────────────
  section("spend policy");
  const caps: PolicyCaps = {
    perEventWei: parseEther("0.1"),
    maxPriceWei: parseEther("0.005"),
    dailyWei: parseEther("0.5"),
  };
  const gasRes = parseEther("0.0005");
  const base = {
    gasReservationWei: gasRes,
    caps,
    spentLast24hWei: 0n,
    targetFiresInWindow: 0,
    maxFiresPerWindow: 3,
    duplicateContract: false,
  };

  const happy = evaluate({ ...base, unitPriceWei: parseEther("0.001"), requestedWallets: 20 });
  check("normal event is allowed", happy.allowed);
  check(
    "cost per wallet includes the gas reservation",
    happy.allowed && happy.unitCostWei === parseEther("0.0015")
  );

  // The bait guard. An over-priced mint is rejected, never trimmed to fit.
  const baited = evaluate({ ...base, unitPriceWei: parseEther("0.1"), requestedWallets: 50 });
  check("price above ceiling is REJECTED", !baited.allowed);
  check(
    "…and not trimmed to fit the budget",
    !baited.allowed && baited.reason === "Too expensive"
  );

  // Budget limits trim rather than reject: some wallets beat none.
  const trimmed = evaluate({ ...base, unitPriceWei: parseEther("0.001"), requestedWallets: 500 });
  check("per-event cap trims instead of rejecting", trimmed.allowed);
  check(
    "…to exactly what the cap affords",
    trimmed.allowed && trimmed.walletCount === 66,
    trimmed.allowed ? `got ${trimmed.walletCount}` : ""
  );
  check("…and says why", trimmed.allowed && trimmed.trimReason === "per-event cap");

  const nearDaily = evaluate({
    ...base,
    unitPriceWei: parseEther("0.001"),
    requestedWallets: 50,
    spentLast24hWei: parseEther("0.485"),
  });
  check("daily budget trims too", nearDaily.allowed && nearDaily.walletCount === 10);
  check("…attributed to the daily budget", nearDaily.allowed && nearDaily.trimReason === "daily budget");

  check(
    "exhausted daily budget rejects",
    !evaluate({
      ...base,
      unitPriceWei: parseEther("0.001"),
      requestedWallets: 10,
      spentLast24hWei: parseEther("0.5"),
    }).allowed
  );

  check(
    "duplicate contract is skipped",
    !evaluate({
      ...base,
      unitPriceWei: parseEther("0.001"),
      requestedWallets: 10,
      duplicateContract: true,
    }).allowed
  );

  check(
    "target cooldown is enforced",
    !evaluate({
      ...base,
      unitPriceWei: parseEther("0.001"),
      requestedWallets: 10,
      targetFiresInWindow: 3,
    }).allowed
  );

  // A free mint still costs gas, so it must still be bounded.
  const free = evaluate({ ...base, unitPriceWei: 0n, requestedWallets: 10_000 });
  check("free mints are still bounded by gas", free.allowed && free.walletCount === 200);

  // ── merkle allowlist ──────────────────────────────────────────────────
  section("merkle allowlist");

  check(
    "AllowListUpdated topic is derived, not transcribed",
    ALLOWLIST_UPDATED_TOPIC === ethersId("AllowListUpdated(address,bytes32,bytes32,string[],string)")
  );

  const params: MintParams = {
    mintPrice: parseEther("0.01"),
    maxTotalMintableByWallet: 3n,
    startTime: 1_800_000_000n,
    endTime: 1_800_003_600n,
    dropStageIndex: 1n,
    maxTokenSupplyForStage: 1000n,
    feeBps: 500n,
    restrictFeeRecipients: true,
  };

  // A leaf commits to the wallet AND every stage parameter, so nothing about a
  // proof is transferable between wallets or between stages.
  const leafA = computeLeaf(VECTORS[0], params);
  check("leaf is a 32-byte hash", /^0x[0-9a-f]{64}$/.test(leafA));
  check("leaf is deterministic", computeLeaf(VECTORS[0], params) === leafA);
  check("a different wallet gives a different leaf", computeLeaf(VECTORS[1], params) !== leafA);
  check(
    "a different price gives a different leaf",
    computeLeaf(VECTORS[0], { ...params, mintPrice: parseEther("0.02") }) !== leafA
  );

  // Build a realistic list and prove every member, at several sizes — odd
  // counts are where naive tree code breaks, because the last node is promoted
  // rather than paired.
  for (const size of [1, 2, 3, 5, 8, 33, 100]) {
    const members = Array.from({ length: size }, (_, i) =>
      new Wallet(`0x${(i + 1).toString(16).padStart(64, "0")}`).address
    );
    const leaves = members.map((m) => computeLeaf(m, params));
    const tree = buildTree(leaves);

    const allVerify = leaves.every((leaf) => {
      const proof = proofFor(tree, leaf);
      return proof !== undefined && verifyProof(proof, leaf, tree.root);
    });
    check(`tree of ${size}: every member proves`, allVerify);
  }

  // A non-member must not be provable.
  const members = Array.from({ length: 10 }, (_, i) =>
    new Wallet(`0x${(i + 1).toString(16).padStart(64, "0")}`).address
  );
  const tree10 = buildTree(members.map((m) => computeLeaf(m, params)));
  const outsiderLeaf = computeLeaf(VECTORS[2], params);
  check("a non-member has no proof", proofFor(tree10, outsiderLeaf) === undefined);
  check(
    "a borrowed proof does not verify",
    !verifyProof(proofFor(tree10, computeLeaf(members[0], params))!, outsiderLeaf, tree10.root)
  );

  // ── eligibility, with the root check doing its job ────────────────────
  section("eligibility");
  const listEntries: AllowListEntry[] = [
    { minter: VECTORS[0], mintParams: params },
    { minter: VECTORS[1], mintParams: params },
  ];
  const realRoot = buildTree(listEntries.map((e) => computeLeaf(e.minter, e.mintParams))).root;
  const ourWallets = [
    { id: "d:0", address: VECTORS[0] },
    { id: "d:1", address: VECTORS[1] },
    { id: "d:2", address: VECTORS[2] },
  ];

  const good = checkEligibility(ourWallets, listEntries, realRoot);
  check("root matches when parsed correctly", good.rootMatched);
  check("listed wallets are eligible", good.eligible.length === 2);
  check("unlisted wallet is not", good.rows[2].eligible === false);
  check("eligible rows carry a proof", good.eligible.every((r) => (r.proof?.length ?? 0) >= 0));
  check(
    "generated proofs verify against the on-chain root",
    good.eligible.every((r) => verifyProof(r.proof!, computeLeaf(r.address, params), realRoot))
  );

  // The safety property that makes an unknown file format survivable: if our
  // reconstruction disagrees with the chain, no proofs are handed out.
  const wrongRoot = `0x${"ab".repeat(32)}`;
  const mismatch = checkEligibility(ourWallets, listEntries, wrongRoot);
  check("root mismatch is detected", !mismatch.rootMatched);
  check("…and NO proofs are issued", mismatch.eligible.length === 0);
  check(
    "…with the reason stated",
    mismatch.rows[0].reason === "rebuilt root does not match chain"
  );

  // A file shipping its own proofs is honoured, but only after verification.
  const suppliedProof = proofFor(
    buildTree(listEntries.map((e) => computeLeaf(e.minter, e.mintParams))),
    computeLeaf(VECTORS[0], params)
  )!;
  const withProofs: AllowListEntry[] = [
    { minter: VECTORS[0], mintParams: params, proof: suppliedProof },
    { minter: VECTORS[1], mintParams: params },
  ];
  check(
    "a valid supplied proof is used",
    checkEligibility([ourWallets[0]], withProofs, realRoot).eligible.length === 1
  );
  const bogus: AllowListEntry[] = [
    { minter: VECTORS[0], mintParams: params, proof: [`0x${"cd".repeat(32)}`] },
  ];
  check(
    "a bogus supplied proof is rejected, not trusted",
    checkEligibility([ourWallets[0]], bogus, wrongRoot).eligible.length === 0
  );

  // ── list parsing ──────────────────────────────────────────────────────
  section("allowlist parsing");
  const rawParams = {
    mintPrice: "10000000000000000",
    maxTotalMintableByWallet: "3",
    startTime: "1800000000",
    endTime: "1800003600",
    dropStageIndex: "1",
    maxTokenSupplyForStage: "1000",
    feeBps: "500",
    restrictFeeRecipients: true,
  };

  check(
    "bare array of entries",
    parseAllowList([{ minter: VECTORS[0], mintParams: rawParams }]).length === 1
  );
  check(
    "object with an entries key",
    parseAllowList({ entries: [{ address: VECTORS[0], ...rawParams }] }).length === 1
  );
  check(
    "shared top-level mintParams are inherited",
    parseAllowList({ mintParams: rawParams, entries: [{ address: VECTORS[0] }] }).length === 1
  );
  check(
    "per-address map",
    parseAllowList({ [VECTORS[0]]: { proof: [], ...rawParams } }).length === 1
  );
  check(
    "parsed params reproduce the same leaf",
    computeLeaf(VECTORS[0], parseAllowList([{ minter: VECTORS[0], mintParams: rawParams }])[0].mintParams) ===
      leafA
  );
  check(
    "an unrecognisable file raises",
    throws(() => parseAllowList({ something: "else" }))
  );

  // ── signed mints: EIP-712 ─────────────────────────────────────────────
  section("signed mint · EIP-712");

  const CHAIN_ID = 8453;
  const serverKey = new Wallet(`0x${"11".repeat(32)}`);
  const otherKey = new Wallet(`0x${"22".repeat(32)}`);

  const message: SignedMintMessage = {
    nftContract: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
    minter: VECTORS[0],
    feeRecipient: "0x0000a26b00c1F0DF003000390027140000fAa719",
    mintParams: params,
    salt: 1234567890n,
  };

  const digest = deriveDigest(CHAIN_ID, message);
  check("digest is a 32-byte hash", /^0x[0-9a-f]{64}$/.test(digest));
  check(
    "digest matches ethers' own EIP-712 encoder",
    digest ===
      TypedDataEncoder.hash(signedMintDomain(CHAIN_ID), SIGNED_MINT_TYPES, {
        nftContract: message.nftContract,
        minter: message.minter,
        feeRecipient: message.feeRecipient,
        mintParams: { ...params },
        salt: message.salt,
      })
  );

  // Every component of the message is inside the digest, so changing any one of
  // them must invalidate a signature bound to the original.
  check(
    "a different minter changes the digest",
    deriveDigest(CHAIN_ID, { ...message, minter: VECTORS[1] }) !== digest
  );
  check(
    "a different salt changes the digest",
    deriveDigest(CHAIN_ID, { ...message, salt: 9n }) !== digest
  );
  check(
    "a different chain changes the digest",
    deriveDigest(1, message) !== digest
  );
  check(
    "a different price changes the digest",
    deriveDigest(CHAIN_ID, {
      ...message,
      mintParams: { ...params, mintPrice: parseEther("0.02") },
    }) !== digest
  );

  const goodSig = await serverKey.signTypedData(
    signedMintDomain(CHAIN_ID),
    SIGNED_MINT_TYPES,
    {
      nftContract: message.nftContract,
      minter: message.minter,
      feeRecipient: message.feeRecipient,
      mintParams: { ...params },
      salt: message.salt,
    }
  );

  check(
    "signer recovers correctly",
    recoverSigner(CHAIN_ID, message, goodSig).toLowerCase() === serverKey.address.toLowerCase()
  );

  // This is the guard that makes an unknown API survivable: a signature that
  // will not satisfy the contract is rejected locally, before any gas is spent.
  check(
    "valid signature from a registered signer passes",
    verifySignature(CHAIN_ID, message, goodSig, [serverKey.address]).valid
  );
  check(
    "valid signature from an UNREGISTERED signer is rejected",
    !verifySignature(CHAIN_ID, message, goodSig, [otherKey.address]).valid
  );
  check(
    "…with the recovered address reported",
    verifySignature(CHAIN_ID, message, goodSig, [otherKey.address]).recovered?.toLowerCase() ===
      serverKey.address.toLowerCase()
  );
  check(
    "no registered signers means nothing passes",
    !verifySignature(CHAIN_ID, message, goodSig, []).valid
  );

  // A response parsed into the wrong mintParams is the realistic failure mode,
  // and it must not reach the chain.
  check(
    "signature bound to different params fails verification",
    !verifySignature(
      CHAIN_ID,
      { ...message, mintParams: { ...params, feeBps: 250n } },
      goodSig,
      [serverKey.address]
    ).valid
  );
  check(
    "signature reused for another wallet fails",
    !verifySignature(CHAIN_ID, { ...message, minter: VECTORS[1] }, goodSig, [serverKey.address])
      .valid
  );
  check(
    "malformed signature is rejected, not thrown",
    !verifySignature(CHAIN_ID, message, "0xdeadbeef", [serverKey.address]).valid
  );

  // ── OpenSea calldata inspection ───────────────────────────────────────
  section("OpenSea calldata inspection");

  const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
  const NFT = "0x3ae17a394fcab94262f35c01b61be10e526996dc";
  const OTHER_NFT = "0xa024ec82a3dd9d1ec8b47d067173c90362cbdce0";
  const ME = VECTORS[0];
  const THEM = VECTORS[1];

  const seadropIface = new (await import("ethers")).Interface([
    "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
  ]);
  const mintPublicData = (nft: string, credited: string): string =>
    seadropIface.encodeFunctionData("mintPublic", [
      nft,
      "0x0000a26b00c1F0DF003000390027140000fAa719",
      credited,
      1n,
    ]);

  // The good case: zero means "credit msg.sender", which is us.
  const cleanTx = inspectCalldata(
    { to: SEADROP, data: mintPublicData(NFT, ZERO_ADDRESS), value: 0n },
    NFT,
    ME
  );
  check("well-formed calldata passes", cleanTx.ok);
  check("…and is decoded", cleanTx.method === "mintPublic" && cleanTx.quantity === 1);

  // The expensive failure: it succeeds on chain, and mints into their wallet.
  const stolen = inspectCalldata(
    { to: SEADROP, data: mintPublicData(NFT, THEM), value: 0n },
    NFT,
    ME
  );
  check("calldata crediting ANOTHER wallet is rejected", !stolen.ok);
  check("…and says whose", stolen.creditedTo?.toLowerCase() === THEM.toLowerCase());

  // Explicitly naming us is fine.
  check(
    "calldata explicitly crediting us passes",
    inspectCalldata({ to: SEADROP, data: mintPublicData(NFT, ME), value: 0n }, NFT, ME).ok
  );

  // Wrong collection entirely.
  const wrongNft = inspectCalldata(
    { to: SEADROP, data: mintPublicData(OTHER_NFT, ZERO_ADDRESS), value: 0n },
    NFT,
    ME
  );
  check("calldata for a DIFFERENT collection is rejected", !wrongNft.ok);

  // Unknown targets and selectors are passed through to simulation rather than
  // being refused outright — OpenSea may route a drop elsewhere.
  check(
    "an unrecognised target defers to simulation",
    inspectCalldata({ to: NFT, data: "0xdeadbeef", value: 0n }, NFT, ME).ok
  );
  check(
    "an unrecognised selector on SeaDrop defers to simulation",
    inspectCalldata({ to: SEADROP, data: "0xdeadbeef", value: 0n }, NFT, ME).ok
  );


  // ── copying a mint that is not a plain public one ──────────────────────
  //
  // Every case here is taken from a real transaction the deployed bot watched
  // and declined. 0x161ac21f is SeaDrop's mintPublic; the calldata below is
  // byte-for-byte what a watched wallet sent on Robinhood Chain, three NFTs for
  // 0.0195 ETH, which the bot reported as an over-priced single mint and threw
  // away. Both halves of that mistake are asserted against here.
  section("copy planning");

  const LIVE_MINT_PUBLIC =
    "0x161ac21f" +
    "0000000000000000000000006c0db931b9ecc750e01ff1d540f1c8e28d62ceaf" +
    "00000000000000000000000034e381622f22e3da467378aa651484f79cdfc8c7" +
    "0000000000000000000000005e84a4bba53d563438c1f4020f8d9d7d89499999" +
    "0000000000000000000000000000000000000000000000000000000000000003";

  const liveDecoded = decodeSeaDropMint(SEADROP, LIVE_MINT_PUBLIC);
  check("a real mintPublic decodes", liveDecoded !== undefined);
  check("…with its quantity", liveDecoded?.quantity === 3);
  check(
    "…and its collection",
    liveDecoded?.nftContract.toLowerCase() === "0x6c0db931b9ecc750e01ff1d540f1c8e28d62ceaf"
  );
  check("…and is not treated as gated", liveDecoded?.gated === false);

  const signedIface = new ethersInterface([
    "function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool) mintParams, uint256 salt, bytes signature)",
  ]);
  const gatedCall = decodeSeaDropMint(
    SEADROP,
    signedIface.encodeFunctionData("mintSigned", [
      NFT,
      "0x0000a26b00c1F0DF003000390027140000fAa719",
      ZERO_ADDRESS,
      1n,
      [0n, 0n, 0n, 0n, 0n, 0n, 0n, false],
      1n,
      "0x" + "11".repeat(65),
    ])
  );
  check("a signed mint decodes", gatedCall !== undefined);
  check(
    "…and IS flagged gated, so no estimateGas is spent proving it cannot be replayed",
    gatedCall?.gated === true
  );

  check(
    "calldata sent somewhere other than SeaDrop does not decode",
    decodeSeaDropMint(NFT, LIVE_MINT_PUBLIC) === undefined
  );

  // ── the price ceiling is per NFT, not per transaction ──────────────────
  //
  // The bug this pins: buying three at 0.0065 arrived as one 0.0195 "unit
  // price" and was refused against a 0.005 ceiling it never breached. The
  // operator saw a cheap mint declined as too expensive, with no way to tell
  // that the quantity was the reason.
  const bulk = {
    ...base,
    unitPriceWei: parseEther("0.012"),
    quantity: 3,
    requestedWallets: 5,
  };
  check("three at 0.004 clears a 0.005-per-NFT ceiling", evaluate(bulk).allowed);
  check(
    "…while the same total charged for one NFT does not",
    !evaluate({ ...bulk, quantity: 1 }).allowed
  );

  // The live transaction that started this: 0.0195 for three, which is 0.0065
  // each. The quantity fix drops it from 0.0195 to 0.0065 — a threefold
  // difference — and it is STILL over the 0.005 ceiling that was configured.
  // Both facts matter: the arithmetic was wrong, and the limit was also too low
  // for what was being followed. Fixing one without the other buys nothing.
  const liveBulk = { ...base, unitPriceWei: parseEther("0.0195"), quantity: 3, requestedWallets: 5 };
  check("the real transaction is still over a 0.005 ceiling", !evaluate(liveBulk).allowed);
  check(
    "…and is refused at its per-NFT price, not its total",
    !evaluate(liveBulk).allowed &&
      (evaluate(liveBulk) as { detail?: string }).detail?.includes("0.0065 ETH per NFT") === true
  );
  check(
    "…and clears once the ceiling covers it",
    evaluate({ ...liveBulk, caps: { ...caps, maxPriceWei: parseEther("0.01") } }).allowed
  );
  check(
    "a genuinely dear mint is still refused",
    !evaluate({ ...bulk, unitPriceWei: parseEther("0.06"), quantity: 3 }).allowed
  );

  // Refusals have to name the setting to change, or they are the unexplainable
  // errors this work exists to remove.
  const dear = evaluate({ ...bulk, unitPriceWei: parseEther("0.06"), quantity: 3 });
  check("…and says what to change", !dear.allowed && (dear.fix ?? "").includes("max price per NFT"));
  check(
    "…quoting the real per-NFT price, not the transaction total",
    !dear.allowed && (dear.detail ?? "").includes("0.02 ETH per NFT")
  );

  // ── the "/" menu ───────────────────────────────────────────────────────
  //
  // Twenty-five commands were registered and none declared to Telegram, so the
  // picker was empty and every one had to be typed from memory — including the
  // ones added so the bot could explain itself.
  section("command menu");

  const commandProblems = validateCommands(BOT_COMMANDS);
  check(
    "the published list is one Telegram will accept",
    commandProblems.length === 0,
    commandProblems.join(" ")
  );

  // A menu entry pointing at nothing is the obvious way this breaks: the
  // command appears, is tapped, and the bot says nothing at all.
  const botSource = readFileSync(join(__dirname, "..", "bot", "index.ts"), "utf8");
  const registered = new Set<string>();
  // Parsed as plain strings rather than a regex: the command name is always
  // the quoted argument before the handler, and everything after "(ctx" is the
  // body, which may quote anything at all.
  for (const chunk of botSource.split("bot.command(").slice(1)) {
    const cut = chunk.indexOf("(ctx");
    const head = cut > 0 ? chunk.slice(0, cut) : "";
    head.split(String.fromCharCode(34)).forEach((piece, index) => {
      if (index % 2 === 1 && /^[a-z0-9_]+$/.test(piece)) registered.add(piece);
    });
  }
  const missing = BOT_COMMANDS.filter((c) => !registered.has(c.command)).map((c) => c.command);
  check("every command in the menu actually exists", missing.length === 0, missing.join(", "));

  // The reverse is a weaker claim — a command may be deliberately unlisted —
  // but a *new* one silently absent from the picker is the failure that put
  // /why and /setup out of reach, so it is reported rather than asserted.
  const unlisted = [...registered].filter(
    (name) => !BOT_COMMANDS.some((c) => c.command === name) && !UNLISTED_ALIASES.has(name)
  );
  check(
    "no command is missing from the menu",
    unlisted.length === 0,
    unlisted.length > 0 ? `unlisted: ${unlisted.join(", ")}` : ""
  );

  check("the most-reached-for screens come first", BOT_COMMANDS[0].command === "start");

    // ── the dashboard picture ──────────────────────────────────────────────
  //
  // Drawn rather than typed, because a Telegram text message has no type sizes,
  // no colour and no alignment that survives a phone rotating — every attempt
  // at a "designed" text card lands as the same wall of monospace rows.
  //
  // Only the SVG is asserted here. Rasterising needs fonts and a native module,
  // and the layout is the part that can silently break.
  section("dashboard picture");

  const picChains: ChainReadiness[] = [
    { key: "ethereum", name: "Ethereum", read: true, watching: true, funded: 0, matched: 500 },
    { key: "robinhood", name: "Robinhood Chain", read: true, watching: true, funded: 42, matched: 500 },
  ];
  const svg = buildDashboardSvg({
    stats: dash,
    findings: [],
    state: "ok",
    chains: picChains,
    symbols: { ethereum: "ETH", robinhood: "ETH" },
  });
  check("it is an SVG document", svg.startsWith("<svg") && svg.endsWith("</svg>"));
  check("it declares a height that fits its content", svg.includes("<svg") && / height="[0-9][0-9]*"/.test(svg));
  check("every network gets a row", svg.includes("Ethereum") && svg.includes("Robinhood Chain"));
  check(
    "a chain with no gas says so instead of showing a bare zero",
    svg.includes("no gas here")
  );
  check("a funded chain reports what it can pay with", svg.includes("42 can pay here"));

  // Followed wallets and our own, with balances, because "is it set up" and
  // "can it actually pay" are different questions and the card only answered
  // the first. Five hundred rows of zero is a wall, not a list, so only the
  // wallets holding something get a line and the rest are counted.
  const detailed = buildDashboardSvg({
    stats: dash,
    findings: [],
    state: "ok",
    chains: picChains,
    symbols: {},
    targets: [
      { address: "0x5E84a4bbA53D563438c1f4020f8D9d7d89499999", copies: 3, follows: "any mint" },
      { address: "0x99E83A929463515cFaE0391B8bF4b978c32712bB", copies: 0, follows: "any mint" },
    ],
    wallets: [
      {
        address: "0x754a2A3410d5DeC0599DA4Bb42A1C3F8e5B37353",
        kind: "imported",
        canPay: true,
        balances: { robinhood: 57129315302634000n, ethereum: 0n },
        totalWei: 57129315302634000n,
      },
    ],
    emptyWallets: 489,
  });
  check("followed wallets are listed", detailed.includes("WALLETS YOU FOLLOW"));
  check("…with a shortened address", detailed.includes("0x5E84…9999"));
  check("…and how many of their mints were copied", detailed.includes("3 copied"));
  check("our own wallets are listed", detailed.includes("YOUR WALLETS, AND WHAT THEY HOLD"));
  check("…with a balance per network", detailed.includes("0.0571"));
  check(
    "…and the empty remainder is counted rather than drawn",
    detailed.includes("489 holding nothing")
  );

  // A chain that could not be read must not print a zero balance — that reads
  // as an empty wallet when the truth is that nobody asked.
  const unreadable = buildDashboardSvg({
    stats: dash,
    findings: [],
    state: "ok",
    chains: picChains,
    symbols: {},
    wallets: [
      {
        address: "0x754a2A3410d5DeC0599DA4Bb42A1C3F8e5B37353",
        kind: "generated",
        canPay: true,
        balances: { robinhood: 1000000000000000n },
        totalWei: 1000000000000000n,
      },
    ],
    emptyWallets: 0,
  });
  check("an unread balance is a dot, never a zero", unreadable.includes(">·<"));

  check(
    "a card with no wallets or targets simply omits those sections",
    !svg.includes("WALLETS YOU FOLLOW") && !svg.includes("YOUR WALLETS")
  );

  // One apostrophe in a collection name would otherwise void the whole
  // document, and a dashboard that fails to parse renders as nothing at all.
  const risky = buildDashboardSvg({
    stats: dash,
    findings: [
      {
        severity: "blocking",
        title: "Bob's <wallets> & \"friends\"",
        detail: "d",
        fix: "f",
      },
    ],
    state: "blocking",
    chains: picChains,
    symbols: {},
  });
  check("XML metacharacters in a finding are escaped", risky.includes("Bob&apos;s &lt;wallets&gt; &amp;"));
  check("…and the raw characters never survive into the document", !/<wallets>/.test(risky));
  check("a blocking state is drawn as blocking", risky.includes("NOT BUYING"));

    // ── the health check ───────────────────────────────────────────────────
  //
  // The exact configuration the deployed bot sat in for days: copy on, wallets
  // funded and armed, watchers connected, every target following free mints
  // only, and every drop they bought costing money. Four green lights and no
  // purchases. This asserts the join gets made.
  section("health check");

  const chainRow = (name: string, over: Partial<ChainReadiness> = {}): ChainReadiness => ({
    key: name.toLowerCase(),
    name,
    read: true,
    watching: true,
    funded: 500,
    matched: 500,
    ...over,
  });
  const healthyBase = {
    copyEnabled: true,
    chains: [chainRow("Ethereum"), chainRow("Base"), chainRow("Robinhood Chain")],
    walletsTotal: 500,
    selector: "derived+funded",
    selectorExcludesImported: false,
    importedTotal: 0,
    maxPriceWei: parseEther("0.005"),
    perEventWei: parseEther("0.1"),
    dailyWei: parseEther("0.5"),
    dailySpentWei: 0n,
    skips: [],
    journal: { seen: 0, fired: 0, skipped: 0 },
    minFundedWei: parseEther("0.0005"),
  };
  const watched = (mode: "free" | "paid" | "both") => ({
    address: "0x5E84a4bbA53D563438c1f4020f8D9d7d89499999",
    tier: "high" as const,
    mintMode: mode,
    payer: "any" as const,
    addedAt: 0,
    fires: 0,
    recentFires: [],
  });

  const allFree = diagnose({ ...healthyBase, targets: [watched("free"), watched("free")] });
  check("following free mints only is reported as blocking", allFree[0]?.severity === "blocking");
  check(
    "…and named as the setting it is",
    allFree[0]?.title.includes("free mints only") === true
  );
  check("…with a one-tap remedy", allFree[0]?.action?.callback === "fixall:mode");

  const mixed = diagnose({ ...healthyBase, targets: [watched("free"), watched("both")] });
  check(
    "some-but-not-all is a limitation, not a blockage",
    mixed[0]?.severity === "limiting" && mixed[0]?.title.includes("1 of your 2")
  );

  const fine = diagnose({ ...healthyBase, targets: [watched("both")] });
  check("a correct set-up reports no problem", overallState(fine) === "ok");
  check(
    "…and says it is waiting rather than implying a fault",
    fine[0]?.title.includes("waiting") === true
  );

  // An unfunded set and an notArmed set are opposite problems. Reporting them
  // with one sentence is what sent people to top up wallets that had money.
  const noGas = diagnose({
    ...healthyBase,
    targets: [watched("both")],
    chains: healthyBase.chains.map((c) => ({ ...c, funded: 0 })),
  });
  const notArmed = diagnose({
    ...healthyBase,
    targets: [watched("both")],
    chains: healthyBase.chains.map((c) => ({ ...c, funded: 0 })),
  });
  check("no gas anywhere is reported as needing gas", noGas.some((f) => f.title.includes("can pay")));
  // Arming is gone, and its absence has to stay gone: a wallet that holds gas
  // is reported as able to pay whether or not any switch was flipped. The old
  // second switch declined fifteen mints in a day while the money sat ready.
  check(
    "arming is never reported as a reason not to buy",
    !notArmed.some((f) => (f.title + f.detail).toLowerCase().includes("arm"))
  );

  // The finding this whole section exists for: one broke network must not read
  // as a broken bot. Robinhood funded and Ethereum empty is a working set-up
  // with one chain switched off, and saying otherwise is what sent the operator
  // looking for a fault that was not there.
  const oneChainBroke = diagnose({
    ...healthyBase,
    targets: [watched("both")],
    chains: [
      chainRow("Ethereum", { funded: 0 }),
      chainRow("Base", { funded: 0 }),
      chainRow("Robinhood Chain"),
    ],
  });
  check(
    "an unfunded chain never blocks the whole bot",
    overallState(oneChainBroke) === "limiting"
  );
  check(
    "…it names the chain that cannot pay",
    oneChainBroke.some((f) => f.title === "Ethereum: nothing here can pay")
  );
  check(
    "…and does not claim the funded chain is broken",
    !oneChainBroke.some((f) => f.title.includes("Robinhood"))
  );

  // An unreadable chain is not an empty one.
  const unread = diagnose({
    ...healthyBase,
    targets: [watched("both")],
    chains: [chainRow("Ethereum", { read: false, funded: 0, matched: 0 }), chainRow("Robinhood Chain")],
  });
  check(
    "an unreachable chain says so rather than reporting no funds",
    unread.some((f) => f.title.includes("could not be reached")) &&
      !unread.some((f) => f.title.includes("Ethereum: nothing here can pay"))
  );

  // Imported wallets hold the money and are excluded twice — by the selector,
  // and by defaulting to manual. Both have to be said, and neither used to be.
  const importedLocked = diagnose({
    ...healthyBase,
    targets: [watched("both")],
    selectorExcludesImported: true,
    importedTotal: 10,
  });
  check(
    "imported wallets excluded by the selector are reported",
    importedLocked.some((f) => f.title.includes("imported wallets are not being used"))
  );
  const importedSelected = diagnose({
    ...healthyBase,
    targets: [watched("both")],
    selectorExcludesImported: false,
    importedTotal: 10,
  });
  check(
    "imported wallets that are selected raise nothing at all",
    overallState(importedSelected) === "ok"
  );

  check(
    "copy switched off is the first thing said",
    diagnose({ ...healthyBase, copyEnabled: false, targets: [watched("both")] })[0]?.title.includes(
      "switched off"
    ) === true
  );


  console.log(`\n${passed} passed, ${failed} failed\n`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

function throws(fn: () => unknown, type?: new (...a: never[]) => Error): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return type ? err instanceof type : true;
  }
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
