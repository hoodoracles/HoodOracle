// What is actually on the chain right now.
//
// The relayer does not report to anything: it fires transactions and forgets
// them. So the only honest way to answer "is the schedule working?" is to read
// the contract and the relayer account, and watch whether they move on their
// own. A rising nonce and a falling balance prove transactions are being sent;
// a fresh publishTime proves they are landing and being accepted.
//
//   npm run state            one snapshot
//   npm run state -- --watch re-reads every 60s until interrupted

import "./env.mts";

import { createPublicClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HOOD_ORACLE_ABI } from "../src/lib/abi.ts";
import { UNIVERSE } from "../src/lib/universe.ts";

const SESSION = ["REGULAR", "PRE", "POST", "CLOSED", "HOLIDAY"];
const PROVENANCE = ["TRADED", "DERIVED", "STALE"];

const address = process.env.NEXT_PUBLIC_ORACLE_ADDRESS as Hex | undefined;
const rpcUrl = process.env.NEXT_PUBLIC_ORACLE_RPC;
const chainId = Number(process.env.NEXT_PUBLIC_ORACLE_CHAIN_ID ?? 0);

if (!address || !rpcUrl || !chainId) {
  console.error(
    "set NEXT_PUBLIC_ORACLE_ADDRESS, NEXT_PUBLIC_ORACLE_RPC and NEXT_PUBLIC_ORACLE_CHAIN_ID",
  );
  process.exit(1);
}

const chain = defineChain({
  id: chainId,
  name: process.env.NEXT_PUBLIC_ORACLE_CHAIN ?? `chain ${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const pub = createPublicClient({ chain, transport: http(rpcUrl) });

const relayerKey = process.env.RELAYER_KEY as Hex | undefined;
const relayer =
  relayerKey && /^0x[0-9a-fA-F]{64}$/.test(relayerKey)
    ? privateKeyToAccount(relayerKey).address
    : undefined;

interface Stored {
  price: bigint;
  confidenceBps: bigint;
  session: number;
  provenance: number;
  sourceCount: number;
  maxDeviationBps: bigint;
  lastTradeTime: bigint;
  publishTime: bigint;
}

function ago(seconds: number): string {
  if (seconds < 0) return "in the future";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  return `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

async function snapshot() {
  const now = Math.floor(Date.now() / 1000);

  const rows = await Promise.all(
    UNIVERSE.map(async (inst) => {
      try {
        const q = (await pub.readContract({
          address: address as Hex,
          abi: HOOD_ORACLE_ABI,
          functionName: "getQuote",
          args: [inst.ticker],
        })) as Stored;
        return { ticker: inst.ticker, q };
      } catch {
        return { ticker: inst.ticker, q: null };
      }
    }),
  );

  console.log(
    `\n${new Date().toISOString()}  contract ${address}  chain ${chainId}`,
  );
  console.log(
    "ticker    price      band     prov      session   published    age",
  );
  console.log("─".repeat(72));

  let newest = 0;
  for (const { ticker, q } of rows) {
    if (!q || q.publishTime === 0n) {
      console.log(`${ticker.padEnd(9)} — nothing posted yet`);
      continue;
    }
    const pt = Number(q.publishTime);
    newest = Math.max(newest, pt);
    console.log(
      ticker.padEnd(9) +
        `$${(Number(q.price) / 1e8).toFixed(2)}`.padEnd(11) +
        `±${(Number(q.confidenceBps) / 100).toFixed(2)}%`.padEnd(9) +
        (PROVENANCE[q.provenance] ?? "?").padEnd(10) +
        (SESSION[q.session] ?? "?").padEnd(10) +
        new Date(pt * 1000).toISOString().slice(11, 19).padEnd(13) +
        ago(now - pt),
    );
  }

  if (relayer) {
    const [bal, nonce] = await Promise.all([
      pub.getBalance({ address: relayer }),
      pub.getTransactionCount({ address: relayer }),
    ]);
    console.log("─".repeat(72));
    console.log(
      `relayer ${relayer}\n  balance ${(Number(bal) / 1e18).toFixed(9)} ETH   nonce ${nonce}   (nonce rises only when it sends)`,
    );
    return { newest, nonce, balance: bal };
  }
  return { newest, nonce: -1, balance: 0n };
}

const watch = process.argv.includes("--watch");
const first = await snapshot();

if (watch) {
  console.log("\nwatching every 60s — ctrl-c to stop\n");
  setInterval(async () => {
    const s = await snapshot();
    if (s.nonce > first.nonce) {
      console.log(
        `\n  ✓ relayer sent ${s.nonce - first.nonce} transaction(s) since the first read`,
      );
    }
  }, 60_000);
}
