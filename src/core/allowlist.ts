// SeaDrop allowlist stages, built entirely from public data.
//
// mintAllowList() is gated by a merkle proof, and a merkle proof is not a
// secret — the tree is published at allowListURI and the root is on chain. So
// unlike mintSigned(), this stage needs no OpenSea account, no session, and no
// API call. It is also fully pre-signable, which mintSigned() can never be.
//
// The leaf SeaDrop verifies is:
//
//   keccak256(abi.encode(minter, mintParams))
//
// with minter = minterIfNotPayer or msg.sender. Every field of mintParams is
// therefore part of the commitment: a proof is bound to one wallet at one price
// for one quantity cap in one window. Nothing about it is transferable.
//
// The published file's schema is not something we control, so the design never
// trusts it. Whatever shape it arrives in, the tree is rebuilt locally and its
// root compared against getAllowListMerkleRoot(). A mismatch means we
// misunderstood the file, and we refuse rather than generate proofs that would
// revert 500 times.

import { AbiCoder, Contract, JsonRpcProvider, keccak256, concat, getAddress, id } from "ethers";
import { SEADROP_ADDRESS } from "../seadrop-public";
import { rpcCall } from "./rpc";

const ALLOWLIST_ABI = [
  "function getAllowListMerkleRoot(address nftContract) view returns (bytes32)",
  "function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, bytes32[] proof) payable",
];

// Derived rather than pasted: a topic hash transcribed by hand is impossible to
// eyeball for correctness, and a wrong one silently finds no logs at all.
export const ALLOWLIST_UPDATED_TOPIC = id(
  "AllowListUpdated(address,bytes32,bytes32,string[],string)"
);

export const ZERO_ROOT = `0x${"0".repeat(64)}`;

export interface MintParams {
  mintPrice: bigint;
  maxTotalMintableByWallet: bigint;
  startTime: bigint;
  endTime: bigint;
  dropStageIndex: bigint;
  maxTokenSupplyForStage: bigint;
  feeBps: bigint;
  restrictFeeRecipients: boolean;
}

export interface AllowListEntry {
  minter: string;
  mintParams: MintParams;
  /** Present when the published file ships proofs directly. */
  proof?: string[];
}

export class AllowListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowListError";
  }
}

// ── Leaves and trees ──────────────────────────────────────────────────

const coder = AbiCoder.defaultAbiCoder();

export function computeLeaf(minter: string, params: MintParams): string {
  const encoded = coder.encode(
    [
      "address",
      "tuple(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
    ],
    [
      getAddress(minter),
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
    ]
  );
  return keccak256(encoded);
}

/**
 * Commutative pair hashing, as used by OpenZeppelin's MerkleProof and solady's
 * MerkleProofLib — the pair is sorted before hashing, so proofs carry no
 * left/right information.
 */
function hashPair(a: string, b: string): string {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export function buildTree(leaves: string[]): { root: string; layers: string[][] } {
  if (leaves.length === 0) throw new AllowListError("Cannot build a tree with no leaves.");

  // Sorted leaves give a deterministic tree regardless of file ordering, which
  // is the convention these lists are generated with.
  const sorted = [...new Set(leaves.map((l) => l.toLowerCase()))].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
  );

  const layers: string[][] = [sorted];
  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      // An odd node is promoted unchanged rather than paired with itself.
      next.push(i + 1 < current.length ? hashPair(current[i], current[i + 1]) : current[i]);
    }
    layers.push(next);
  }

  return { root: layers[layers.length - 1][0], layers };
}

export function proofFor(tree: { layers: string[][] }, leaf: string): string[] | undefined {
  let index = tree.layers[0].indexOf(leaf.toLowerCase());
  if (index === -1) return undefined;

  const proof: string[] = [];
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const pairIndex = index % 2 === 0 ? index + 1 : index - 1;
    if (pairIndex < layer.length) proof.push(layer[pairIndex]);
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verifyProof(proof: string[], leaf: string, root: string): boolean {
  let computed = leaf.toLowerCase();
  for (const node of proof) computed = hashPair(computed, node.toLowerCase());
  return BigInt(computed) === BigInt(root);
}

// ── Reading the drop ──────────────────────────────────────────────────

export async function fetchAllowListRoot(rpcUrl: string, nftContract: string): Promise<string> {
  const provider = new JsonRpcProvider(rpcUrl);
  const seadrop = new Contract(SEADROP_ADDRESS, ALLOWLIST_ABI, provider);
  try {
    return (await seadrop.getAllowListMerkleRoot(nftContract)) as string;
  } catch (err) {
    throw new AllowListError(
      `Could not read the allowlist root for ${nftContract}: ${(err as Error).message}`
    );
  }
}

interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
}

/**
 * Find the published list URI from the most recent AllowListUpdated event.
 *
 * The URI is in the non-indexed data, so it has to be decoded rather than read
 * from a topic. Scanning is bounded: a drop's allowlist is set shortly before
 * its stage, so recent history is where it lives.
 */
export async function findAllowListUri(
  rpcUrl: string,
  nftContract: string,
  lookbackBlocks = 500_000
): Promise<string | undefined> {
  const head = Number(BigInt(await rpcCall<string>(rpcUrl, "eth_blockNumber", [])));
  const from = Math.max(0, head - lookbackBlocks);

  const padded = `0x${nftContract.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

  // Chunked, because providers cap the range on an unfiltered-address scan.
  const chunk = 50_000;
  for (let start = head; start > from; start -= chunk) {
    const end = start;
    const begin = Math.max(from, start - chunk + 1);
    let logs: RawLog[];
    try {
      logs = await rpcCall<RawLog[]>(rpcUrl, "eth_getLogs", [
        {
          address: SEADROP_ADDRESS,
          fromBlock: `0x${begin.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          topics: [ALLOWLIST_UPDATED_TOPIC, padded],
        },
      ]);
    } catch {
      continue;
    }
    if (logs.length === 0) continue;

    const latest = logs[logs.length - 1];
    try {
      const [, allowListURI] = coder.decode(["string[]", "string"], latest.data);
      if (typeof allowListURI === "string" && allowListURI.length > 0) return allowListURI;
    } catch {
      /* fall through to the next chunk */
    }
  }
  return undefined;
}

export function toHttpUrl(uri: string): string {
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, "")}`;
  }
  return uri;
}

// ── Parsing the published file ────────────────────────────────────────

function toMintParams(raw: Record<string, unknown>): MintParams | undefined {
  const pick = (...names: string[]): unknown => {
    for (const name of names) {
      if (raw[name] !== undefined && raw[name] !== null) return raw[name];
    }
    return undefined;
  };

  const num = (value: unknown): bigint | undefined => {
    if (value === undefined) return undefined;
    try {
      return BigInt(typeof value === "number" ? Math.trunc(value) : String(value));
    } catch {
      return undefined;
    }
  };

  const mintPrice = num(pick("mintPrice", "price"));
  const maxTotal = num(pick("maxTotalMintableByWallet", "maxMintablePerWallet", "limit"));
  const startTime = num(pick("startTime", "start"));
  const endTime = num(pick("endTime", "end"));
  const dropStageIndex = num(pick("dropStageIndex", "stageIndex"));
  const maxSupply = num(pick("maxTokenSupplyForStage", "maxSupplyForStage"));
  const feeBps = num(pick("feeBps", "fee"));
  const restrict = pick("restrictFeeRecipients", "restrict");

  if (
    mintPrice === undefined ||
    maxTotal === undefined ||
    startTime === undefined ||
    endTime === undefined ||
    dropStageIndex === undefined ||
    maxSupply === undefined ||
    feeBps === undefined
  ) {
    return undefined;
  }

  return {
    mintPrice,
    maxTotalMintableByWallet: maxTotal,
    startTime,
    endTime,
    dropStageIndex,
    maxTokenSupplyForStage: maxSupply,
    feeBps,
    restrictFeeRecipients: restrict === true || restrict === "true" || restrict === 1,
  };
}

/**
 * Read whatever shape the published list arrives in.
 *
 * Three layouts are recognised: a bare array of entries, an object with an
 * entries/leaves/allowList key, and a per-address map. Shared mintParams at the
 * top level are inherited by entries that omit them, which is the common layout
 * for a single-stage list.
 */
export function parseAllowList(json: unknown): AllowListEntry[] {
  const shared =
    typeof json === "object" && json !== null
      ? toMintParams((json as Record<string, unknown>).mintParams as Record<string, unknown> ?? (json as Record<string, unknown>))
      : undefined;

  const rows = extractRows(json);
  if (rows.length === 0) {
    throw new AllowListError(
      "Could not find any allowlist entries in that file. Supply the entries manually if the format is unusual."
    );
  }

  const entries: AllowListEntry[] = [];
  for (const row of rows) {
    const minterRaw =
      row.minter ?? row.address ?? row.wallet ?? row.account ?? row.recipient;
    if (typeof minterRaw !== "string") continue;

    let minter: string;
    try {
      minter = getAddress(minterRaw.trim());
    } catch {
      continue;
    }

    const params =
      toMintParams((row.mintParams as Record<string, unknown>) ?? row) ?? shared;
    if (!params) continue;

    const proof = Array.isArray(row.proof)
      ? (row.proof as unknown[]).filter((p): p is string => typeof p === "string")
      : undefined;

    entries.push({ minter, mintParams: params, proof });
  }

  if (entries.length === 0) {
    throw new AllowListError(
      "The file was read but no entry carried both an address and usable mint parameters."
    );
  }
  return entries;
}

function extractRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (typeof json !== "object" || json === null) return [];

  const obj = json as Record<string, unknown>;
  for (const key of ["entries", "allowList", "allowlist", "leaves", "wallets", "minters"]) {
    const value = obj[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
    // Per-address map: { "0xabc…": { proof: [...] }, … }
    if (typeof value === "object" && value !== null) {
      return Object.entries(value as Record<string, unknown>).map(([address, body]) => ({
        address,
        ...(typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}),
      }));
    }
  }

  // The whole object may itself be the address map.
  const keys = Object.keys(obj);
  if (keys.length > 0 && keys.every((k) => /^0x[0-9a-fA-F]{40}$/.test(k))) {
    return keys.map((address) => ({
      address,
      ...(typeof obj[address] === "object" && obj[address] !== null
        ? (obj[address] as Record<string, unknown>)
        : {}),
    }));
  }
  return [];
}

// ── Eligibility ───────────────────────────────────────────────────────

export interface EligibilityRow {
  id: string;
  address: string;
  eligible: boolean;
  proof?: string[];
  mintParams?: MintParams;
  reason?: string;
}

export interface EligibilityReport {
  root: string;
  rootMatched: boolean;
  entryCount: number;
  rows: EligibilityRow[];
  eligible: EligibilityRow[];
}

/**
 * Work out which of our wallets can actually mint.
 *
 * The root check is the load-bearing part. Rebuilding the tree and comparing
 * against the chain proves we parsed the file correctly; without it, a schema
 * we half-understood would yield proofs that look fine and revert on every
 * wallet.
 */
export function checkEligibility(
  wallets: { id: string; address: string }[],
  entries: AllowListEntry[],
  onChainRoot: string
): EligibilityReport {
  const leafFor = new Map<string, { leaf: string; entry: AllowListEntry }>();
  for (const entry of entries) {
    leafFor.set(entry.minter.toLowerCase(), {
      leaf: computeLeaf(entry.minter, entry.mintParams),
      entry,
    });
  }

  const tree = buildTree([...leafFor.values()].map((v) => v.leaf));
  const rootMatched = BigInt(tree.root) === BigInt(onChainRoot);

  const rows: EligibilityRow[] = wallets.map((wallet) => {
    const found = leafFor.get(wallet.address.toLowerCase());
    if (!found) {
      return { id: wallet.id, address: wallet.address, eligible: false, reason: "not on the list" };
    }

    // A file that ships its own proofs is used as-is, but only after the proof
    // is verified against the on-chain root — trusting it unchecked would be
    // the same mistake as trusting the schema.
    const supplied = found.entry.proof;
    if (supplied && verifyProof(supplied, found.leaf, onChainRoot)) {
      return {
        id: wallet.id,
        address: wallet.address,
        eligible: true,
        proof: supplied,
        mintParams: found.entry.mintParams,
      };
    }

    if (!rootMatched) {
      return {
        id: wallet.id,
        address: wallet.address,
        eligible: false,
        reason: "rebuilt root does not match chain",
      };
    }

    const proof = proofFor(tree, found.leaf);
    if (!proof || !verifyProof(proof, found.leaf, onChainRoot)) {
      return { id: wallet.id, address: wallet.address, eligible: false, reason: "proof failed" };
    }

    return {
      id: wallet.id,
      address: wallet.address,
      eligible: true,
      proof,
      mintParams: found.entry.mintParams,
    };
  });

  return {
    root: onChainRoot,
    rootMatched,
    entryCount: entries.length,
    rows,
    eligible: rows.filter((r) => r.eligible),
  };
}

export function encodeMintAllowList(
  nftContract: string,
  feeRecipient: string,
  quantity: number,
  params: MintParams,
  proof: string[]
): string {
  const iface = new Contract(SEADROP_ADDRESS, ALLOWLIST_ABI).interface;
  return iface.encodeFunctionData("mintAllowList", [
    nftContract,
    feeRecipient,
    // Zero means "credit the caller", keeping the proof bound to msg.sender.
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
    proof,
  ]);
}

/** Tag written by /check so selectors can target an eligible subset. */
export function eligibilityTag(nftContract: string): string {
  return `eligible:${nftContract.toLowerCase()}`;
}
