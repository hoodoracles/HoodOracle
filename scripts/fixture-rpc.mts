// A fixture chain, for testing the coverage ledger against resolved data.
//
// The live contract has only ever published during one weekend, so every
// closure on it is still open and the interesting half of /coverage — the half
// with scores in it — cannot be exercised on mainnet until the tape reopens.
// Waiting two days to find out whether a table renders is not a test strategy.
//
// This serves just enough JSON-RPC for viem to read logs from: eth_chainId,
// eth_blockNumber and eth_getLogs. The logs themselves are encoded with the
// real event ABI, so decoding, the bisect path, the scoring and the page are
// all the production ones. Only the chain is synthetic.
//
// Deterministic: same seed, same archive, same numbers, every run.
//
//   npx tsx scripts/fixture-rpc.mts [--port 8599] [--seed 7] [--gaps 40]

import { createServer } from "node:http";
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toHex,
  type Hex,
} from "viem";
import { UNIVERSE } from "../src/lib/universe.ts";
import { calibrationFor, gapSigmaBps, Z_95 } from "../src/lib/calibration.ts";
import { toScaled } from "../src/lib/sign.ts";
import { Provenance, Session } from "../src/lib/types.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const PORT = arg("port", 8599);
const SEED = arg("seed", 7);
const GAPS = arg("gaps", 40);
const CHAIN_ID = 4663;
const CONTRACT =
  "0x65cf45524407a5e700188a8a8178d5d5c0c38d30".toLowerCase() as Hex;
const SIGNER = "0xA139E54E6c88420cb5546c64130d1Ba145Ff9C8A" as Hex;

/** mulberry32. Small, fast, and identical across runs. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);

/** Box-Muller. The residual the band is fitted against is Gaussian by design. */
function gauss(): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const QUOTE_POSTED_TOPIC = keccak256(
  toHex("QuotePosted(string,uint128,uint64,uint8,uint8,uint64,address)"),
);

// Non-indexed parameters, in declaration order. `ticker` is indexed and so
// lives in topics[1] as a hash, not here.
const DATA_PARAMS = parseAbiParameters(
  "uint128 price, uint64 confidenceBps, uint8 session, uint8 provenance, uint64 publishTime, address signer",
);

interface FakeLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  blockHash: Hex;
  transactionIndex: Hex;
  removed: boolean;
}

let block = 0;
const logs: FakeLog[] = [];

function emit(
  ticker: string,
  price: number,
  confidenceBps: number,
  session: Session,
  provenance: Provenance,
  publishTime: number,
) {
  block++;
  logs.push({
    address: CONTRACT,
    topics: [QUOTE_POSTED_TOPIC, keccak256(toHex(ticker))],
    data: encodeAbiParameters(DATA_PARAMS, [
      toScaled(price),
      BigInt(confidenceBps),
      session,
      provenance,
      BigInt(publishTime),
      SIGNER,
    ]),
    blockNumber: toHex(block),
    transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex,
    logIndex: "0x0",
    blockHash: `0x${(block + 1e6).toString(16).padStart(64, "0")}` as Hex,
    transactionIndex: "0x0",
    removed: false,
  });
}

// ------------------------------------------------------------- the archive
//
// A plausible history: alternating overnight and weekend closures, each one
// published into several times as the band widens, then resolved by a live
// print drawn from the distribution the band is fitted to. Because the draw is
// Gaussian at the calibrated sigma, coverage should come out near 95% on its
// own rather than being forced there.

const DAY = 86_400;
const START = 1_750_000_000;
const price: Record<string, number> = {};
for (const i of UNIVERSE) {
  price[i.ticker] = { HOOD: 120, COIN: 195, NVDA: 222, TSLA: 364, AAPL: 336, MSTR: 154, SPY: 640, TLT: 88 }[i.ticker] ?? 100;
}

let t = START;
for (let g = 0; g < GAPS; g++) {
  const weekend = g % 5 === 4;
  const gapSeconds = weekend ? 62 * 3600 : 17.5 * 3600;

  for (const inst of UNIVERSE) {
    const cal = calibrationFor(inst.ticker);
    const close = price[inst.ticker];

    // Several DERIVED quotes through the closure, at the band the engine
    // would carry at each point: sigma scales with elapsed staleness.
    const steps = weekend ? 5 : 3;
    let lastBps = 0;
    for (let s = 1; s <= steps; s++) {
      const elapsed = (gapSeconds * s) / steps;
      const bps = Math.max(
        45,
        Math.min(
          1500,
          Math.round(Z_95 * gapSigmaBps(inst.ticker, elapsed / 3600)),
        ),
      );
      lastBps = bps;
      emit(
        inst.ticker,
        close,
        bps,
        Session.CLOSED,
        Provenance.DERIVED,
        t + elapsed - 60,
      );
    }

    // The print that settles it. Drawn at the sigma the final band implies,
    // so roughly 1 in 20 lands outside by construction.
    const sigma = lastBps / Z_95 / 10_000;
    const open = close * (1 + gauss() * sigma);
    emit(
      inst.ticker,
      open,
      8 + Math.round(rand() * 12),
      Session.REGULAR,
      Provenance.TRADED,
      t + gapSeconds,
    );
    void cal;
    price[inst.ticker] = open;
  }
  t += gapSeconds + 6.5 * 3600;
}

// One closure left deliberately unresolved, so the "pending" path is exercised
// alongside the resolved one rather than only in isolation.
for (const inst of UNIVERSE.slice(0, 3)) {
  emit(inst.ticker, price[inst.ticker], 170, Session.CLOSED, Provenance.DERIVED, t + 3600);
}

const HEAD = block + 10;

// ------------------------------------------------------------------ server

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let calls: { id: unknown; method: string; params: unknown[] }[];
    try {
      const parsed = JSON.parse(body || "{}");
      calls = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }

    const replies = calls.map((c) => {
      switch (c.method) {
        case "eth_chainId":
          return { jsonrpc: "2.0", id: c.id, result: toHex(CHAIN_ID) };
        case "net_version":
          return { jsonrpc: "2.0", id: c.id, result: String(CHAIN_ID) };
        case "eth_blockNumber":
          return { jsonrpc: "2.0", id: c.id, result: toHex(HEAD) };
        case "eth_getLogs": {
          const f = (c.params?.[0] ?? {}) as {
            fromBlock?: string;
            toBlock?: string;
            address?: string;
            topics?: (string | string[] | null)[];
          };
          const from = f.fromBlock && f.fromBlock !== "earliest" ? BigInt(f.fromBlock) : 0n;
          const to =
            f.toBlock && f.toBlock !== "latest" ? BigInt(f.toBlock) : BigInt(HEAD);
          const wantTopic0 = Array.isArray(f.topics?.[0])
            ? (f.topics[0] as string[])[0]
            : (f.topics?.[0] as string | undefined);

          const out = logs.filter((l) => {
            const bn = BigInt(l.blockNumber);
            if (bn < from || bn > to) return false;
            if (f.address && f.address.toLowerCase() !== l.address) return false;
            if (wantTopic0 && wantTopic0.toLowerCase() !== l.topics[0].toLowerCase())
              return false;
            return true;
          });
          return { jsonrpc: "2.0", id: c.id, result: out };
        }
        default:
          return {
            jsonrpc: "2.0",
            id: c.id,
            error: { code: -32601, message: `fixture has no ${c.method}` },
          };
      }
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? replies : replies[0]));
  });
});

server.listen(PORT, () => {
  console.log(
    `fixture chain on http://127.0.0.1:${PORT}  chainId=${CHAIN_ID}  ` +
      `${logs.length} logs  head=${HEAD}  seed=${SEED}  gaps=${GAPS}`,
  );
  console.log(`contract ${CONTRACT}`);
});
