// Post signed quotes to a deployed HoodOracle.
//
//   npm run publish -- arb-sepolia 0xOracleAddress
//   npm run publish -- arb-sepolia 0xOracleAddress --watch
//
// This is the relayer. In the pull model a consumer posts a quote itself when it
// needs one, so this is for keeping a public feed warm rather than a
// requirement. Quotes that would revert are skipped rather than sent, so a
// weekend run does not burn gas failing.

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveTarget } from "./chains.mts";

const [targetName, address, ...flags] = process.argv.slice(2);
const watch = flags.includes("--watch");

if (!targetName || !address) {
  console.error("usage: npm run publish -- <target> <oracleAddress> [--watch]");
  process.exit(1);
}

const target = resolveTarget(targetName);
const API = process.env.API_URL ?? "http://localhost:3000";
const INTERVAL_MS = Number(process.env.PUBLISH_INTERVAL_MS ?? 60_000);

const deployerKey = process.env.DEPLOYER_KEY as Hex | undefined;
if (!deployerKey || !/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
  console.error("DEPLOYER_KEY missing or malformed");
  process.exit(1);
}

const artifact = JSON.parse(
  readFileSync("out/HoodOracle.sol/HoodOracle.json", "utf8"),
);
const ABI = artifact.abi;

const rpc = process.env.RPC_URL ?? target.chain.rpcUrls.default.http[0];
const account = privateKeyToAccount(deployerKey);
const pub = createPublicClient({ chain: target.chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: target.chain, transport: http(rpc) });

const oracle = address as Hex;
const SCALE = 10n ** 8n;

function scale(v: number): bigint {
  const [w, f = ""] = v.toFixed(8).split(".");
  return BigInt(w) * SCALE + BigInt(f.padEnd(8, "0"));
}

interface ApiQuote {
  ticker: string;
  price: number;
  confidenceBps: number;
  session: number;
  provenance: number;
  sourceCount: number;
  maxDeviationBps: number;
  lastTradeTime: number;
  publishTime: number;
}

async function readStoredPublishTime(ticker: string): Promise<bigint> {
  try {
    const q = (await pub.readContract({
      address: oracle,
      abi: ABI,
      functionName: "getQuote",
      args: [ticker],
    })) as { publishTime: bigint };
    return q.publishTime;
  } catch {
    return 0n; // nothing posted yet
  }
}

async function publishOnce(): Promise<void> {
  const res = await fetch(`${API}/api/quotes`);
  if (!res.ok) {
    console.error(`api ${res.status}`);
    return;
  }
  const body = (await res.json()) as {
    market: { session: string };
    quotes: ApiQuote[];
  };

  console.log(
    `\n${new Date().toISOString()}  session=${body.market.session}  ${body.quotes.length} feeds`,
  );

  for (const q of body.quotes) {
    const stored = await readStoredPublishTime(q.ticker);

    // The contract rejects a quote that is not strictly newer. Check here so a
    // no-op run costs nothing instead of reverting on-chain.
    if (stored >= BigInt(q.publishTime)) {
      console.log(`  ${q.ticker.padEnd(5)} skip, not newer than stored`);
      continue;
    }

    const signedRes = await fetch(`${API}/api/quote/${q.ticker}`);
    if (!signedRes.ok) {
      console.log(`  ${q.ticker.padEnd(5)} skip, api ${signedRes.status}`);
      continue;
    }
    const signed = await signedRes.json();
    const sq = signed.quote as ApiQuote;

    const tuple = {
      price: scale(sq.price),
      confidenceBps: BigInt(sq.confidenceBps),
      session: sq.session,
      provenance: sq.provenance,
      sourceCount: sq.sourceCount,
      maxDeviationBps: BigInt(Math.round(sq.maxDeviationBps)),
      lastTradeTime: BigInt(sq.lastTradeTime),
      publishTime: BigInt(sq.publishTime),
    };

    try {
      // Simulate first: a revert costs nothing here but would cost gas on-chain.
      await pub.simulateContract({
        address: oracle,
        abi: ABI,
        functionName: "postQuote",
        args: [sq.ticker, tuple, signed.signature as Hex],
        account,
      });
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      console.log(`  ${sq.ticker.padEnd(5)} skip, would revert: ${msg.slice(0, 70)}`);
      continue;
    }

    const hash = await wallet.writeContract({
      address: oracle,
      abi: ABI,
      functionName: "postQuote",
      args: [sq.ticker, tuple, signed.signature as Hex],
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(
      `  ${sq.ticker.padEnd(5)} $${sq.price.toFixed(2).padStart(9)}  ±${(sq.confidenceBps / 100).toFixed(2)}%  gas=${rc.gasUsed}  ${hash.slice(0, 12)}…`,
    );
  }

  const bal = await pub.getBalance({ address: account.address });
  console.log(`  balance ${formatEther(bal)} ETH`);
}

console.log(`publisher    ${target.chain.name} (${target.chain.id})`);
console.log(`oracle       ${oracle}`);
console.log(`relayer      ${account.address}`);
console.log(`api          ${API}`);

await publishOnce();

if (watch) {
  console.log(`\nwatching, every ${INTERVAL_MS / 1000}s. ctrl-c to stop.`);
  setInterval(() => {
    void publishOnce().catch((e) => console.error(String(e).slice(0, 200)));
  }, INTERVAL_MS);
}
