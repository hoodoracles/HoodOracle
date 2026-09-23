// Deploy a HoodOracleFeed and open a Morpho market on it.
//
//   DEPLOY_CONFIRM=yes npm run deploy:feed -- rh-mainnet
//
// Three transactions, each simulated first:
//   1. HoodOracleFeed for NVDA: live prints only, 30-minute max age, 1% band
//      ceiling, priced per token via NVDA's uiMultiplier.
//   2. A Morpho oracle wrapping it, from Morpho's own ChainlinkOracleV2
//      factory, so the market uses exactly the code path a Chainlink feed
//      would.
//   3. A USDG / NVDA Morpho market at 77% LLTV on the AdaptiveCurveIrm.
//
// Nothing here is owned or upgradeable, and none of it moves funds. It runs
// with DEPLOYER_KEY, falling back to ORACLE_OWNER_KEY, which only pays gas.
// Re-running after a partial run reuses whatever FEED_ADDRESS and
// MORPHO_ORACLE_ADDRESS are set rather than deploying them twice.

import "./env.mts";

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveTarget } from "./chains.mts";

// Robinhood Chain mainnet, verified on-chain 23 Sep 2026.
const MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010" as const;
const IRM = "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1" as const;
const FACTORY = "0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const NVDA_TOKEN = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as const;

const TICKER = "NVDA";
const MAX_AGE = 1800n;
const MAX_BPS = 100n;
const LLTV = 770000000000000000n;

const targetName = process.argv[2];
if (targetName !== "rh-mainnet") {
  console.error("usage: npm run deploy:feed -- rh-mainnet   (the addresses above are mainnet's)");
  process.exit(1);
}
const target = resolveTarget(targetName);
if (process.env.DEPLOY_CONFIRM !== "yes") {
  console.error("refusing to deploy to a live chain without DEPLOY_CONFIRM=yes");
  process.exit(1);
}

const key = (process.env.DEPLOYER_KEY ?? process.env.ORACLE_OWNER_KEY) as Hex | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("set DEPLOYER_KEY (or ORACLE_OWNER_KEY) to a 32-byte hex key");
  process.exit(1);
}
const oracle = process.env.NEXT_PUBLIC_ORACLE_ADDRESS as Hex;

const account = privateKeyToAccount(key);
// DEPLOY_RPC points the whole run at a fork for a dress rehearsal.
const rpc = process.env.DEPLOY_RPC ?? target.chain.rpcUrls.default.http[0];
const pub = createPublicClient({ chain: target.chain, transport: http(rpc), pollingInterval: 400 });
const wallet = createWalletClient({ account, chain: target.chain, transport: http(rpc) });

if ((await pub.getChainId()) !== 4663) {
  console.error("RPC is not Robinhood Chain mainnet");
  process.exit(1);
}

console.log(`deployer  ${account.address}`);
console.log(`balance   ${formatEther(await pub.getBalance({ address: account.address }))} ETH`);

const artifact = JSON.parse(readFileSync("out/HoodOracleFeed.sol/HoodOracleFeed.json", "utf8"));
const FEED_ABI = artifact.abi;

async function waitOk(hash: Hex, what: string) {
  console.log(`  tx ${hash}`);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (r.status !== "success") throw new Error(`${what} reverted`);
  console.log(`  ok, block ${r.blockNumber}, gas ${r.gasUsed}`);
  return r;
}

// 1 ------------------------------------------------------------------ feed
let feed = process.env.FEED_ADDRESS as Hex | undefined;
if (!feed) {
  console.log("\n1. HoodOracleFeed (NVDA, live prints only)");
  const hash = await wallet.deployContract({
    abi: FEED_ABI,
    bytecode: artifact.bytecode.object as Hex,
    args: [oracle, TICKER, NVDA_TOKEN, MAX_AGE, MAX_BPS, true],
  });
  feed = (await waitOk(hash, "feed deploy")).contractAddress!;
}
console.log(`  feed ${feed}`);
console.log(`  "${await pub.readContract({ address: feed, abi: FEED_ABI, functionName: "description" })}"`);

// 2 ---------------------------------------------------------- morpho oracle
const factoryAbi = parseAbi([
  "function createMorphoChainlinkOracleV2(address,uint256,address,address,uint256,address,uint256,address,address,uint256,bytes32) returns (address)",
]);
let morphoOracle = process.env.MORPHO_ORACLE_ADDRESS as Hex | undefined;
if (!morphoOracle) {
  console.log("\n2. Morpho oracle from the ChainlinkOracleV2 factory");
  const args = [
    "0x0000000000000000000000000000000000000000", 1n, feed, "0x0000000000000000000000000000000000000000", 18n,
    "0x0000000000000000000000000000000000000000", 1n, "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000", 6n, keccak256(toHex("hoodoracle NVDA live prints only")),
  ] as const;
  const sim = await pub.simulateContract({ address: FACTORY, abi: factoryAbi, functionName: "createMorphoChainlinkOracleV2", args, account });
  await waitOk(await wallet.writeContract(sim.request), "oracle create");
  morphoOracle = sim.result;
}
console.log(`  morpho oracle ${morphoOracle}`);

// 3 ---------------------------------------------------------------- market
const morphoAbi = parseAbi([
  "function createMarket((address,address,address,address,uint256))",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
]);
const params = [USDG, NVDA_TOKEN, morphoOracle, IRM, LLTV] as const;
const id = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    params,
  ),
);
const lastUpdate = (await pub.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [id] }))[4];
if (lastUpdate === 0n) {
  console.log("\n3. Morpho market USDG / NVDA, 77% LLTV");
  const sim = await pub.simulateContract({ address: MORPHO, abi: morphoAbi, functionName: "createMarket", args: [params], account });
  await waitOk(await wallet.writeContract(sim.request), "createMarket");
} else {
  console.log("\n3. market already exists");
}
console.log(`  market id ${id}`);

console.log(`\nFEED_ADDRESS=${feed}\nMORPHO_ORACLE_ADDRESS=${morphoOracle}\nMORPHO_MARKET_ID=${id}`);
