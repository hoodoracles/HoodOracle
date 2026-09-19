// End-to-end on-chain proof.
//
// Deploys HoodOracle to a local EVM, pulls a real signed quote from the running
// service, posts it, and reads it back. This is the test that matters: if the
// Solidity digest and the TypeScript encoder disagree by a single byte, the
// signature will not recover and nothing downstream works.

import { readFileSync } from "node:fs";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const API = process.env.API_URL ?? "http://localhost:3000";

// anvil's first well-known account
const ANVIL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const artifact = JSON.parse(
  readFileSync("out/HoodOracle.sol/HoodOracle.json", "utf8"),
);
const ABI = artifact.abi;
const BYTECODE = artifact.bytecode.object as Hex;

const ABI_MIN = parseAbi([
  "function postQuote(string ticker, (uint128,uint64,uint8,uint8,uint8,uint64,uint64,uint64) q, bytes signature)",
  "function getQuote(string ticker) view returns ((uint128,uint64,uint8,uint8,uint8,uint64,uint64,uint64))",
  "function getPriceIfTraded(string ticker, uint64 maxBps) view returns (uint128)",
  "function getBandedPrice(string ticker, bool lower) view returns (uint128)",
  "function isLive(string ticker, uint64 maxBps) view returns (bool)",
  "function setSigner(address signer, bool allowed)",
]);
void ABI_MIN;

const key = (process.env.ANVIL_PK ?? ANVIL_KEY) as Hex;
const account = privateKeyToAccount(key);

const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: foundry, transport: http(RPC) });

function log(s = "") {
  console.log(s);
}

// 1 ------------------------------------------------------------- fetch quote
const res = await fetch(`${API}/api/quote/HOOD`);
if (!res.ok) throw new Error(`api ${res.status}`);
const signed = await res.json();
const q = signed.quote;

log("=== signed quote from the service ===");
log(`  ticker        ${q.ticker}`);
log(`  price         $${q.price}`);
log(`  confidenceBps ${q.confidenceBps}`);
log(`  session       ${signed.readable.session} (${q.session})`);
log(`  provenance    ${signed.readable.provenance} (${q.provenance})`);
log(`  signer        ${signed.signer}`);
log();

// 2 ----------------------------------------------------------------- deploy
log("=== deploy ===");
const hash = await wallet.deployContract({
  abi: ABI,
  bytecode: BYTECODE,
  args: [signed.signer as Hex],
});
const receipt = await pub.waitForTransactionReceipt({ hash });
const oracle = receipt.contractAddress!;
log(`  HoodOracle    ${oracle}`);
log(`  gas           ${receipt.gasUsed}`);
log(`  allow-listed  ${signed.signer}`);
log();

// 3 -------------------------------------------------------------- post quote
const PRICE_SCALE = 10n ** 8n;
function scale(v: number): bigint {
  const [w, f = ""] = v.toFixed(8).split(".");
  return BigInt(w) * PRICE_SCALE + BigInt(f.padEnd(8, "0"));
}

const tuple = {
  price: scale(q.price),
  confidenceBps: BigInt(q.confidenceBps),
  session: q.session,
  provenance: q.provenance,
  sourceCount: q.sourceCount,
  maxDeviationBps: BigInt(Math.round(q.maxDeviationBps)),
  lastTradeTime: BigInt(q.lastTradeTime),
  publishTime: BigInt(q.publishTime),
};

log("=== post on-chain ===");
const postHash = await wallet.writeContract({
  address: oracle,
  abi: ABI,
  functionName: "postQuote",
  args: [q.ticker, tuple, signed.signature as Hex],
});
const postRc = await pub.waitForTransactionReceipt({ hash: postHash });
log(`  status        ${postRc.status}`);
log(`  gas           ${postRc.gasUsed}`);
if (postRc.status !== "success") throw new Error("postQuote reverted");
log("  signature recovered to the allow-listed signer");
log();

// 4 -------------------------------------------------------------- read back
log("=== read back ===");
const stored = (await pub.readContract({
  address: oracle,
  abi: ABI,
  functionName: "getQuote",
  args: [q.ticker],
})) as Record<string, bigint | number>;

const onChainPrice = Number(stored.price) / 1e8;
log(`  price         $${onChainPrice.toFixed(6)}`);
log(`  confidenceBps ${stored.confidenceBps}`);
log(`  provenance    ${stored.provenance}`);

const priceMatches = Math.abs(onChainPrice - q.price) < 1e-6;
log(`  round-trip    ${priceMatches ? "MATCH" : "MISMATCH"}`);

const lower = (await pub.readContract({
  address: oracle,
  abi: ABI,
  functionName: "getBandedPrice",
  args: [q.ticker, true],
})) as bigint;
const upper = (await pub.readContract({
  address: oracle,
  abi: ABI,
  functionName: "getBandedPrice",
  args: [q.ticker, false],
})) as bigint;
log(
  `  banded        $${(Number(lower) / 1e8).toFixed(2)} — $${(Number(upper) / 1e8).toFixed(2)}`,
);

const live = (await pub.readContract({
  address: oracle,
  abi: ABI,
  functionName: "isLive",
  args: [q.ticker, 100n],
})) as boolean;
log(`  isLive(100bp) ${live}`);
log();

// 5 ------------------------------------------------- policy guard actually bites
log("=== policy guard ===");
let reverted = false;
let reason = "";
try {
  await pub.readContract({
    address: oracle,
    abi: ABI,
    functionName: "getPriceIfTraded",
    args: [q.ticker, 50n],
  });
} catch (e) {
  reverted = true;
  reason = (e as Error).message.split("\n").find((l) => /revert|reason/i.test(l)) ?? "reverted";
}

const expectReject = q.provenance !== 0;
log(`  getPriceIfTraded on a ${signed.readable.provenance} quote`);
log(`  reverted      ${reverted}`);
log(`  ${reverted === expectReject ? "PASS" : "FAIL"}: a liquidation path cannot read a modelled weekend price`);
if (reason) log(`  reason        ${reason.trim().slice(0, 90)}`);
log();

// 6 ------------------------------------------------------------ replay guard
log("=== replay guard ===");
let replayBlocked = false;
try {
  await wallet.writeContract({
    address: oracle,
    abi: ABI,
    functionName: "postQuote",
    args: [q.ticker, tuple, signed.signature as Hex],
  });
} catch {
  replayBlocked = true;
}
log(`  re-post same quote blocked: ${replayBlocked ? "PASS" : "FAIL"}`);

const allOk = priceMatches && reverted === expectReject && replayBlocked;
log();
log(allOk ? "ALL PASS" : "FAILURES");
process.exit(allOk ? 0 : 1);
