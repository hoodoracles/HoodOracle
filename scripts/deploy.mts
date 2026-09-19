// Deploy HoodOracle to a target chain.
//
//   npm run deploy -- arb-sepolia
//   npm run deploy -- rh-testnet
//
// Requires DEPLOYER_KEY (pays gas) and ORACLE_SIGNER_KEY (whose address is
// allow-listed as the quote signer). These are deliberately separate: the
// deployer is a hot wallet that can be rotated, the signer is the key the whole
// system's trust rests on.
//
// A live target refuses to run without DEPLOY_CONFIRM=yes.

import "./env.mts";

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveTarget } from "./chains.mts";

const targetName = process.argv[2];
if (!targetName) {
  console.error("usage: npm run deploy -- <target>");
  console.error("targets: local, arb-sepolia, rh-testnet, arbitrum, rh-mainnet");
  process.exit(1);
}

const target = resolveTarget(targetName);

if (target.live && process.env.DEPLOY_CONFIRM !== "yes") {
  console.error(
    `refusing to deploy to ${target.chain.name} (a live chain) without DEPLOY_CONFIRM=yes`,
  );
  process.exit(1);
}

// ------------------------------------------------------------------ keys
const deployerKey = process.env.DEPLOYER_KEY as Hex | undefined;
if (!deployerKey || !/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
  console.error("DEPLOYER_KEY missing or not a 32-byte hex private key");
  process.exit(1);
}

const signerKey = process.env.ORACLE_SIGNER_KEY as Hex | undefined;
if (!signerKey || !/^0x[0-9a-fA-F]{64}$/.test(signerKey)) {
  console.error(
    "ORACLE_SIGNER_KEY missing. The deployed contract must allow-list the same " +
      "key the service signs quotes with, or nothing it publishes will be accepted.",
  );
  process.exit(1);
}

const deployer = privateKeyToAccount(deployerKey);
const signer = privateKeyToAccount(signerKey);

if (deployer.address === signer.address) {
  console.warn(
    "warning: deployer and signer are the same key. Separate them before production.",
  );
}

// -------------------------------------------------------------- artifact
let artifact: { abi: unknown[]; bytecode: { object: Hex } };
try {
  artifact = JSON.parse(readFileSync("out/HoodOracle.sol/HoodOracle.json", "utf8"));
} catch {
  console.error("no build artifact. run `forge build` first.");
  process.exit(1);
}

// ---------------------------------------------------------------- deploy
const rpc = process.env.RPC_URL ?? target.chain.rpcUrls.default.http[0];
const pub = createPublicClient({ chain: target.chain, transport: http(rpc) });
const wallet = createWalletClient({
  account: deployer,
  chain: target.chain,
  transport: http(rpc),
});

console.log(`target       ${target.chain.name} (chainId ${target.chain.id})`);
console.log(`rpc          ${rpc}`);
console.log(`deployer     ${deployer.address}`);
console.log(`signer       ${signer.address}  <- allow-listed`);

// Confirm the RPC really is the chain we think it is before spending anything.
const actualId = await pub.getChainId();
if (actualId !== target.chain.id) {
  console.error(
    `chain id mismatch: RPC reports ${actualId}, expected ${target.chain.id}. Aborting.`,
  );
  process.exit(1);
}

const balance = await pub.getBalance({ address: deployer.address });
console.log(`balance      ${formatEther(balance)} ETH`);
if (balance === 0n) {
  console.error(`\ndeployer has no gas. funding: ${target.funding}`);
  process.exit(1);
}

// estimateContractGas is for calls; a deploy is estimated from its init code.
const deployData = encodeDeployData({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: [signer.address],
});
const gas = await pub.estimateGas({
  account: deployer,
  data: deployData,
});
const gasPrice = await pub.getGasPrice();
console.log(
  `est. cost    ${formatEther(gas * gasPrice)} ETH  (${gas} gas @ ${gasPrice} wei)`,
);

if (balance < gas * gasPrice) {
  console.error("\ninsufficient balance for deployment");
  process.exit(1);
}

console.log("\ndeploying…");
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: [signer.address],
});
console.log(`tx           ${hash}`);

const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  console.error("deployment reverted");
  process.exit(1);
}

console.log(`\nHoodOracle   ${receipt.contractAddress}`);
console.log(`block        ${receipt.blockNumber}`);
console.log(`gas used     ${receipt.gasUsed}`);
console.log(`\nadd to .env.local:`);
console.log(`  HOOD_ORACLE_ADDRESS=${receipt.contractAddress}`);
console.log(`  HOOD_ORACLE_CHAIN=${target.key}`);
