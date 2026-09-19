// Deploy HoodOracleKeeper alongside an existing HoodOracle.
//
//   npm run deploy:keeper -- rh-mainnet
//
// The keeper is a helper, not a replacement: it batches posts and answers
// "what is stale" on-chain, and the oracle it points at is untouched. So this
// mints no new trust — the keeper holds no funds, has no owner, and every
// quote it relays is still authenticated by the oracle's own signature check.
// It cannot post anything a caller could not have posted themselves.
//
// Requires DEPLOYER_KEY and, for a live chain, DEPLOY_CONFIRM=yes.

import "./env.mts";

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveTarget } from "./chains.mts";

const targetName = process.argv[2];
if (!targetName) {
  console.error("usage: npm run deploy:keeper -- <target>");
  process.exit(1);
}
const target = resolveTarget(targetName);

if (target.live && process.env.DEPLOY_CONFIRM !== "yes") {
  console.error(
    `refusing to deploy to ${target.chain.name} (a live chain) without DEPLOY_CONFIRM=yes`,
  );
  process.exit(1);
}

const deployerKey = process.env.DEPLOYER_KEY as Hex | undefined;
if (!deployerKey || !/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
  console.error("DEPLOYER_KEY missing or not a 32-byte hex private key");
  process.exit(1);
}

const oracleAddress = (process.env.KEEPER_ORACLE ??
  process.env.NEXT_PUBLIC_ORACLE_ADDRESS) as Hex | undefined;
if (!oracleAddress || !/^0x[0-9a-fA-F]{40}$/.test(oracleAddress)) {
  console.error(
    "no oracle to point at: set NEXT_PUBLIC_ORACLE_ADDRESS (or KEEPER_ORACLE)",
  );
  process.exit(1);
}

const artifact = JSON.parse(
  readFileSync("out/HoodOracleKeeper.sol/HoodOracleKeeper.json", "utf8"),
);
const ABI = artifact.abi;
const BYTECODE = artifact.bytecode.object as Hex;

const deployer = privateKeyToAccount(deployerKey);
const rpc = target.chain.rpcUrls.default.http[0];
const pub = createPublicClient({ chain: target.chain, transport: http(rpc) });
const wallet = createWalletClient({
  account: deployer,
  chain: target.chain,
  transport: http(rpc),
});

console.log(`\ntarget    ${target.chain.name} (${target.chain.id})`);
console.log(`rpc       ${rpc}`);
console.log(`deployer  ${deployer.address}`);
console.log(`oracle    ${oracleAddress}`);

const balance = await pub.getBalance({ address: deployer.address });
console.log(`balance   ${formatEther(balance)} ETH`);
if (balance === 0n) {
  console.error(`\nno funds. ${target.funding}`);
  process.exit(1);
}

// The oracle has to actually be there. Deploying a keeper pointed at an empty
// address produces a contract whose every call reverts, which looks like a
// keeper bug rather than a configuration one.
const code = await pub.getBytecode({ address: oracleAddress });
if (!code || code === "0x") {
  console.error(`\nno contract at ${oracleAddress} on this chain`);
  process.exit(1);
}
console.log(`oracle code ${(code.length - 2) / 2} bytes — present`);

console.log("\ndeploying…");
const hash = await wallet.deployContract({
  abi: ABI,
  bytecode: BYTECODE,
  args: [oracleAddress],
});
console.log(`tx        ${hash}`);

const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  console.error("deployment reverted");
  process.exit(1);
}
const keeper = receipt.contractAddress!;
console.log(`keeper    ${keeper}`);
console.log(`gas       ${receipt.gasUsed}`);
console.log(`block     ${receipt.blockNumber}`);

// Read it back, so "deployed" means "answers correctly" rather than "the
// transaction succeeded".
const wired = (await pub.readContract({
  address: keeper,
  abi: ABI,
  functionName: "oracle",
})) as Hex;
const maxBatch = (await pub.readContract({
  address: keeper,
  abi: ABI,
  functionName: "MAX_BATCH",
})) as bigint;

const ok = wired.toLowerCase() === oracleAddress.toLowerCase();
console.log(`\nwired to  ${wired}  ${ok ? "OK" : "MISMATCH"}`);
console.log(`MAX_BATCH ${maxBatch}`);
if (!ok) process.exit(1);

console.log(`\nadd to the environment:\n  NEXT_PUBLIC_KEEPER_ADDRESS=${keeper}\n`);
