// Signed (FCFS) stages — the on-chain half.
//
// mintSigned() carries an EIP-712 signature produced by a server-side key that
// SeaDrop has registered via getSigners(). Unlike a merkle proof, that signature
// cannot be derived from public data, which is why this path needs OpenSea at
// all. Everything *else* about it is fully specified on chain and implemented
// here.
//
// The load-bearing piece is verifySignature(). We do not control the API that
// issues these, and a response we misparse would otherwise become 500 reverting
// transactions. Instead the digest is rebuilt locally, the signer recovered, and
// checked against getSigners(). A signature that will not satisfy the contract
// is therefore rejected before it costs anything — the same guard the allowlist
// path gets from rebuilding the merkle root.

import {
  Contract,
  JsonRpcProvider,
  TypedDataEncoder,
  verifyTypedData,
  getAddress,
  formatEther,
  Wallet,
  HDNodeWallet,
} from "ethers";
import { SEADROP_ADDRESS, resolveFeeRecipient } from "../seadrop-public";
import { MintParams } from "./allowlist";
import { NonceManager } from "./nonce-manager";
import { Endpoint, dispatchAll, prepareTx, summariseErrors } from "./dispatcher";
import { fetchBalances, requiredPerWallet, shortfalls, Shortfall } from "./balances";
import { collectReceipts, sleepUntil, ReceiptRow } from "./mint-runtime";
import { rpcCall, warmSockets } from "./rpc";
import { record } from "./ledger";

const SIGNED_ABI = [
  "function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, uint256 salt, bytes signature) payable",
  "function getSigners(address nftContract) view returns (address[])",
  "function getDigestIsUsed(address nftContract, bytes32 digest) view returns (bool)",
];

/** SeaDrop's EIP-712 domain. Name and version are fixed in the contract. */
export function signedMintDomain(chainId: number): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
} {
  return {
    name: "SeaDrop",
    version: "1.0",
    chainId,
    verifyingContract: SEADROP_ADDRESS,
  };
}

export const SIGNED_MINT_TYPES = {
  SignedMint: [
    { name: "nftContract", type: "address" },
    { name: "minter", type: "address" },
    { name: "feeRecipient", type: "address" },
    { name: "mintParams", type: "MintParams" },
    { name: "salt", type: "uint256" },
  ],
  MintParams: [
    { name: "mintPrice", type: "uint256" },
    { name: "maxTotalMintableByWallet", type: "uint256" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "dropStageIndex", type: "uint256" },
    { name: "maxTokenSupplyForStage", type: "uint256" },
    { name: "feeBps", type: "uint256" },
    { name: "restrictFeeRecipients", type: "bool" },
  ],
};

export interface SignedMintMessage {
  nftContract: string;
  minter: string;
  feeRecipient: string;
  mintParams: MintParams;
  salt: bigint;
}

export class SignedMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedMintError";
  }
}

function toTypedValue(message: SignedMintMessage): Record<string, unknown> {
  return {
    nftContract: getAddress(message.nftContract),
    minter: getAddress(message.minter),
    feeRecipient: getAddress(message.feeRecipient),
    mintParams: {
      mintPrice: message.mintParams.mintPrice,
      maxTotalMintableByWallet: message.mintParams.maxTotalMintableByWallet,
      startTime: message.mintParams.startTime,
      endTime: message.mintParams.endTime,
      dropStageIndex: message.mintParams.dropStageIndex,
      maxTokenSupplyForStage: message.mintParams.maxTokenSupplyForStage,
      feeBps: message.mintParams.feeBps,
      restrictFeeRecipients: message.mintParams.restrictFeeRecipients,
    },
    salt: message.salt,
  };
}

/** The digest SeaDrop derives and checks against its replay-protection map. */
export function deriveDigest(chainId: number, message: SignedMintMessage): string {
  return TypedDataEncoder.hash(
    signedMintDomain(chainId),
    SIGNED_MINT_TYPES,
    toTypedValue(message)
  );
}

export function recoverSigner(
  chainId: number,
  message: SignedMintMessage,
  signature: string
): string {
  return verifyTypedData(
    signedMintDomain(chainId),
    SIGNED_MINT_TYPES,
    toTypedValue(message),
    signature
  );
}

export async function fetchSigners(rpcUrl: string, nftContract: string): Promise<string[]> {
  const provider = new JsonRpcProvider(rpcUrl);
  const seadrop = new Contract(SEADROP_ADDRESS, SIGNED_ABI, provider);
  try {
    return [...((await seadrop.getSigners(nftContract)) as string[])];
  } catch (err) {
    throw new SignedMintError(
      `Could not read registered signers for ${nftContract}: ${(err as Error).message}`
    );
  }
}

export async function digestAlreadyUsed(
  rpcUrl: string,
  nftContract: string,
  digest: string
): Promise<boolean> {
  const provider = new JsonRpcProvider(rpcUrl);
  const seadrop = new Contract(SEADROP_ADDRESS, SIGNED_ABI, provider);
  try {
    return (await seadrop.getDigestIsUsed(nftContract, digest)) as boolean;
  } catch {
    // Not fatal — the contract will reject a reused digest anyway. This check
    // only lets us say so before spending gas.
    return false;
  }
}

export interface VerificationResult {
  valid: boolean;
  recovered?: string;
  reason?: string;
}

/**
 * Prove a fetched signature will actually satisfy the contract.
 *
 * Called on every signature before it is used. A wrong parse, a stale response,
 * or a signature bound to different mintParams all surface here at zero cost
 * instead of as a wall of reverts.
 */
export function verifySignature(
  chainId: number,
  message: SignedMintMessage,
  signature: string,
  registeredSigners: string[]
): VerificationResult {
  let recovered: string;
  try {
    recovered = recoverSigner(chainId, message, signature);
  } catch (err) {
    return { valid: false, reason: `signature could not be recovered: ${(err as Error).message}` };
  }

  const allowed = registeredSigners.map((s) => s.toLowerCase());
  if (!allowed.includes(recovered.toLowerCase())) {
    return {
      valid: false,
      recovered,
      reason:
        `recovered ${recovered} is not a registered signer ` +
        `(${registeredSigners.length ? registeredSigners.join(", ") : "none registered on chain"})`,
    };
  }
  return { valid: true, recovered };
}

export function encodeMintSigned(
  nftContract: string,
  feeRecipient: string,
  quantity: number,
  params: MintParams,
  salt: bigint,
  signature: string
): string {
  const iface = new Contract(SEADROP_ADDRESS, SIGNED_ABI).interface;
  return iface.encodeFunctionData("mintSigned", [
    nftContract,
    feeRecipient,
    // Zero credits msg.sender, keeping the signature bound to the sending wallet.
    "0x0000000000000000000000000000000000000000",
    BigInt(quantity),
    [
      params.mintPrice,
      params.maxTotalMintableByWallet,
      params.startTime,
      params.endTime,
      params.dropStageIndex,
      params.maxTokenSupplyForStage,
      params.feeBps,
      params.restrictFeeRecipients,
    ],
    salt,
    signature,
  ]);
}

// ── Execution ─────────────────────────────────────────────────────────

/** One wallet's fetched-and-verified authorisation to mint. */
export interface SignedGrant {
  id: string;
  address: string;
  mintParams: MintParams;
  salt: bigint;
  signature: string;
}

export interface SignedMintDeps {
  readUrl: string;
  allRpcUrls: string[];
  endpoints: Endpoint[];
  chainId: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonces: NonceManager;
  signerFor(id: string): Wallet | HDNodeWallet;
}

export interface SignedMintRequest {
  nftContract: string;
  quantity: number;
  grants: SignedGrant[];
  waitForStart: boolean;
  skipUnderfunded: boolean;
}

export type SignedMintEvent =
  | { type: "stage"; params: MintParams; startsAt: Date; endsAt: Date; live: boolean; feeRecipient: string }
  | { type: "verified"; valid: number; rejected: { address: string; reason: string }[] }
  | { type: "funding"; eligible: number; underfunded: Shortfall[]; requiredPerWallet: bigint }
  | { type: "signing"; done: number; total: number }
  | { type: "armed"; total: number; signMs: number }
  | { type: "waiting"; msRemaining: number }
  | { type: "dispatched"; count: number; ms: number }
  | { type: "receipts"; confirmed: number; reverted: number; pending: number; total: number }
  | { type: "done"; report: SignedMintReport };

export interface SignedMintReport {
  contract: string;
  quantity: number;
  attempted: number;
  accepted: number;
  rejected: number;
  confirmed: number;
  reverted: number;
  pending: number;
  valuePerWallet: bigint;
  totalValue: bigint;
  dispatchMs: number;
  rows: ReceiptRow[];
  errorSummary: { reason: string; count: number }[];
}

export async function executeSignedMint(
  req: SignedMintRequest,
  deps: SignedMintDeps,
  emit: (event: SignedMintEvent) => void
): Promise<SignedMintReport> {
  if (req.grants.length === 0) {
    throw new SignedMintError("No signatures to mint with.");
  }

  const params = req.grants[0].mintParams;
  if (req.quantity > Number(params.maxTotalMintableByWallet)) {
    throw new SignedMintError(
      `Quantity ${req.quantity} exceeds this stage's per-wallet cap of ${params.maxTotalMintableByWallet}. ` +
        "The signature commits to that cap, so a larger quantity cannot be made valid."
    );
  }

  const fee = await resolveFeeRecipient(deps.readUrl, req.nftContract, params.restrictFeeRecipients);
  if (!fee) {
    throw new SignedMintError(
      "This drop restricts fee recipients and lists none on chain — the mint cannot be constructed."
    );
  }

  const startsAt = new Date(Number(params.startTime) * 1000);
  const endsAt = new Date(Number(params.endTime) * 1000);
  const now = Date.now();
  const live = now >= startsAt.getTime() && now < endsAt.getTime();
  emit({ type: "stage", params, startsAt, endsAt, live, feeRecipient: fee.address });

  if (now >= endsAt.getTime()) {
    throw new SignedMintError(`That stage closed at ${endsAt.toISOString()}.`);
  }
  if (!live && !req.waitForStart) {
    throw new SignedMintError(
      `The stage opens at ${startsAt.toISOString()}. Firing now reverts and burns gas — re-run with waiting enabled.`
    );
  }

  // ── Verify every signature locally before spending anything ──
  const registered = await fetchSigners(deps.readUrl, req.nftContract);
  const rejected: { address: string; reason: string }[] = [];
  const valid: SignedGrant[] = [];

  for (const grant of req.grants) {
    const result = verifySignature(
      deps.chainId,
      {
        nftContract: req.nftContract,
        minter: grant.address,
        feeRecipient: fee.address,
        mintParams: grant.mintParams,
        salt: grant.salt,
      },
      grant.signature,
      registered
    );
    if (result.valid) valid.push(grant);
    else rejected.push({ address: grant.address, reason: result.reason ?? "unknown" });
  }

  emit({ type: "verified", valid: valid.length, rejected });

  if (valid.length === 0) {
    throw new SignedMintError(
      `None of the ${req.grants.length} signature(s) verify against the drop's registered signers.\n` +
        (rejected[0]?.reason ?? "") +
        "\nNothing was sent. This usually means the API response was parsed into the wrong mintParams."
    );
  }

  // ── Funding ──
  const value = params.mintPrice * BigInt(req.quantity);
  const targets = valid.map((g) => ({ id: g.id, address: g.address }));
  const required = requiredPerWallet(deps.gasLimit, deps.maxFeePerGas, value);
  const balances = await fetchBalances(deps.readUrl, targets);
  const underfunded = shortfalls(targets, balances, required);

  const funded = valid.filter((g) => !underfunded.some((u) => u.id === g.id));
  emit({ type: "funding", eligible: funded.length, underfunded, requiredPerWallet: required });

  if (underfunded.length > 0 && !req.skipUnderfunded) {
    throw new SignedMintError(
      `${underfunded.length} of ${valid.length} wallets hold less than the ` +
        `${formatEther(required)} ETH a node reserves. Fund them, or re-run allowing them to be skipped.`
    );
  }
  if (funded.length === 0) {
    throw new SignedMintError("Every wallet with a valid signature is underfunded.");
  }

  // ── Pre-sign ──
  await warmSockets(deps.allRpcUrls);
  await deps.nonces.prime(funded.map((g) => ({ id: g.id, address: g.address })));

  const signStart = process.hrtime.bigint();
  const prepared = [];
  for (let i = 0; i < funded.length; i++) {
    const grant = funded[i];
    const data = encodeMintSigned(
      req.nftContract,
      fee.address,
      req.quantity,
      grant.mintParams,
      grant.salt,
      grant.signature
    );
    const raw = await deps.signerFor(grant.id).signTransaction({
      to: SEADROP_ADDRESS,
      data,
      value,
      nonce: deps.nonces.next(grant.address),
      gasLimit: deps.gasLimit,
      maxFeePerGas: deps.maxFeePerGas,
      maxPriorityFeePerGas: deps.maxPriorityFeePerGas,
      type: 2,
      chainId: deps.chainId,
    });
    prepared.push(prepareTx(grant.id, grant.address, raw));
    if ((i + 1) % 25 === 0 || i + 1 === funded.length) {
      emit({ type: "signing", done: i + 1, total: funded.length });
    }
  }
  const signMs = Number(process.hrtime.bigint() - signStart) / 1e6;
  emit({ type: "armed", total: prepared.length, signMs });

  // ── Hold, then fire ──
  if (!live && req.waitForStart) {
    emit({ type: "waiting", msRemaining: startsAt.getTime() - Date.now() });
    await sleepUntil(startsAt.getTime());
  }

  const report = await dispatchAll(prepared, deps.endpoints, {
    onDispatched: (count, ms) => emit({ type: "dispatched", count, ms }),
  });

  for (const outcome of report.outcomes) {
    if (!outcome.accepted) deps.nonces.rollback(outcome.address);
  }

  const totalValue = value * BigInt(report.accepted);
  if (report.accepted > 0) {
    record({
      kind: "mint",
      chainId: deps.chainId,
      contract: req.nftContract,
      walletIds: report.outcomes.filter((o) => o.accepted).map((o) => o.id),
      valueWei: totalValue.toString(),
      fromBlock: await currentBlock(deps.readUrl),
      note: "signed",
    });
  }

  const rows = await collectReceipts(
    deps.readUrl,
    report.outcomes.filter((o) => o.accepted),
    (confirmed, reverted, pending, total) =>
      emit({ type: "receipts", confirmed, reverted, pending, total })
  );
  for (const outcome of report.outcomes) {
    if (outcome.accepted) continue;
    rows.push({ id: outcome.id, address: outcome.address, hash: outcome.hash, status: "reverted" });
  }

  const final: SignedMintReport = {
    contract: req.nftContract,
    quantity: req.quantity,
    attempted: prepared.length,
    accepted: report.accepted,
    rejected: report.rejected,
    confirmed: rows.filter((r) => r.status === "confirmed").length,
    reverted: rows.filter((r) => r.status === "reverted").length,
    pending: rows.filter((r) => r.status === "pending").length,
    valuePerWallet: value,
    totalValue,
    dispatchMs: report.dispatchMs,
    rows,
    errorSummary: summariseErrors(report.outcomes),
  };
  emit({ type: "done", report: final });
  return final;
}

async function currentBlock(readUrl: string): Promise<number | undefined> {
  try {
    return Number(BigInt(await rpcCall<string>(readUrl, "eth_blockNumber", [])));
  } catch {
    return undefined;
  }
}
