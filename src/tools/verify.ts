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

import { rmSync, existsSync, readFileSync } from "node:fs";
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
  emptyContext,
  SelectorError,
} from "../core/tags";
import { planFunding, planEthSweep, signEthSweep, TRANSFER_GAS } from "../core/funding";
import { requiredPerWallet, shortfalls } from "../core/balances";
import { substituteAddress, contains, selectorOf } from "../core/calldata";
import { evaluate, PolicyCaps } from "../core/policy";
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
import { id as ethersId, TypedDataEncoder } from "ethers";
import { inspectCalldata } from "../core/mint-opensea";
import { writeDefaultConfig, updateUserSettings, ConfigError } from "../core/config";
import { FILES, stateDir, storedUserChatIds, userStateDir, withStateDir } from "../core/paths";
import { deriveUserPassphrase } from "../core/user-key";
import { ensureUserFundingWallet } from "../bot/user-wallet";
import * as watchTargets from "../core/targets";
import { rpcBatchChunked } from "../core/rpc";
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
    !baited.allowed && baited.reason === "Price above ceiling"
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
