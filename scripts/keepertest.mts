// End-to-end proof of the batch relay and the staleness view.
//
// The forge suite proves the contract's logic against synthetic quotes. This
// proves the whole path: real prices from the live providers, signed by the
// real signer, encoded by the real TypeScript encoder, batched through the
// keeper on a real EVM, and read back. If the Solidity digest and the
// TypeScript encoder disagree by one byte, nothing here recovers.
//
// Needs anvil on 8545.
//
//   anvil --silent &
//   npm run test:keeper

import "./env.mts";

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import { buildQuotes } from "../src/lib/quote.ts";
import { signQuote, toScaled } from "../src/lib/sign.ts";
import { UNIVERSE } from "../src/lib/universe.ts";
import { PROVENANCE_NAME, SESSION_NAME } from "../src/lib/types.ts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";

// anvil's well-known accounts. Deployer pays, signer signs.
const DEPLOYER =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const SIGNER =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

process.env.ORACLE_SIGNER_KEY = SIGNER;

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const oracleArtifact = JSON.parse(
  readFileSync("out/HoodOracle.sol/HoodOracle.json", "utf8"),
);
const keeperArtifact = JSON.parse(
  readFileSync("out/HoodOracleKeeper.sol/HoodOracleKeeper.json", "utf8"),
);

const deployer = privateKeyToAccount(DEPLOYER);
const signer = privateKeyToAccount(SIGNER);
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = createWalletClient({
  account: deployer,
  chain: foundry,
  transport: http(RPC),
});

console.log("\n=== deploy ===");
let hash = await wallet.deployContract({
  abi: oracleArtifact.abi,
  bytecode: oracleArtifact.bytecode.object as Hex,
  args: [signer.address],
});
const oracle = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
console.log(`  oracle  ${oracle}`);

hash = await wallet.deployContract({
  abi: keeperArtifact.abi,
  bytecode: keeperArtifact.bytecode.object as Hex,
  args: [oracle],
});
const rcKeeper = await pub.waitForTransactionReceipt({ hash });
const keeper = rcKeeper.contractAddress!;
console.log(`  keeper  ${keeper}  (${rcKeeper.gasUsed} gas)`);
console.log(`  signer  ${signer.address}`);

// ------------------------------------------------------------ real quotes

console.log("\n=== build and sign real quotes ===");
const { quotes, errors } = await buildQuotes(UNIVERSE);
for (const e of errors) console.log(`  ! ${e.ticker}: ${e.error.slice(0, 70)}`);
check("priced the whole universe", quotes.length === UNIVERSE.length, `got ${quotes.length}`);

const signed = await Promise.all(quotes.map((q) => signQuote(q)));
const tickers = quotes.map((q) => q.ticker);
const tuples = quotes.map((q) => ({
  price: toScaled(q.price),
  confidenceBps: BigInt(q.confidenceBps),
  session: q.session,
  provenance: q.provenance,
  sourceCount: q.sourceCount,
  maxDeviationBps: BigInt(Math.round(q.maxDeviationBps)),
  lastTradeTime: BigInt(q.lastTradeTime),
  publishTime: BigInt(q.publishTime),
}));
const sigs = signed.map((s) => s.signature);

for (const q of quotes.slice(0, 3)) {
  console.log(
    `  ${q.ticker.padEnd(5)} $${q.price.toFixed(2).padStart(9)}  ±${(q.confidenceBps / 100).toFixed(2)}%  ` +
      `${SESSION_NAME[q.session]}/${PROVENANCE_NAME[q.provenance]}`,
  );
}

// ------------------------------------------------- needsUpdate, before

console.log("\n=== needsUpdate before anything is posted ===");
const staleBefore = (await pub.readContract({
  address: keeper,
  abi: keeperArtifact.abi,
  functionName: "needsUpdate",
  args: [tickers, 3600n],
})) as boolean[];
check(
  "every ticker reports stale",
  staleBefore.every(Boolean),
  `${staleBefore.filter(Boolean).length}/${staleBefore.length}`,
);

// ------------------------------------------------------------- the batch

console.log("\n=== batch post ===");
const batchHash = await wallet.writeContract({
  address: keeper,
  abi: keeperArtifact.abi,
  functionName: "postQuotes",
  args: [tickers, tuples, sigs],
});
const batchRc = await pub.waitForTransactionReceipt({ hash: batchHash });
check("transaction succeeded", batchRc.status === "success");
console.log(`  gas     ${batchRc.gasUsed}`);
console.log(`  block   ${batchRc.blockNumber}`);

// Every QuotePosted from this one transaction.
const postedLogs = batchRc.logs.filter(
  (l) => l.address.toLowerCase() === oracle.toLowerCase(),
);
check(
  `all ${UNIVERSE.length} quotes emitted from one transaction`,
  postedLogs.length === UNIVERSE.length,
  `got ${postedLogs.length}`,
);

// The point of batching: one block, one consistent snapshot.
const blocks = new Set(postedLogs.map((l) => l.blockNumber));
check("all in a single block", blocks.size === 1, `blocks=${[...blocks].join(",")}`);

console.log("\n=== read back ===");
let matched = 0;
for (let i = 0; i < tickers.length; i++) {
  const stored = (await pub.readContract({
    address: oracle,
    abi: oracleArtifact.abi,
    functionName: "getQuote",
    args: [tickers[i]],
  })) as { price: bigint; confidenceBps: bigint; publishTime: bigint; provenance: number };
  if (
    stored.price === tuples[i].price &&
    stored.confidenceBps === tuples[i].confidenceBps &&
    stored.publishTime === tuples[i].publishTime
  ) {
    matched++;
  } else {
    console.log(`  ! ${tickers[i]} mismatch`);
  }
}
check(
  "every quote round-tripped byte-exact",
  matched === tickers.length,
  `${matched}/${tickers.length}`,
);

// ------------------------------------------------- needsUpdate, after

console.log("\n=== needsUpdate after posting ===");
const staleAfter = (await pub.readContract({
  address: keeper,
  abi: keeperArtifact.abi,
  functionName: "needsUpdate",
  args: [tickers, 3600n],
})) as boolean[];
check("nothing reports stale", staleAfter.every((s) => !s));

const probe = [...tickers, "ZZZZNOTREAL"];
const staleProbe = (await pub.readContract({
  address: keeper,
  abi: keeperArtifact.abi,
  functionName: "needsUpdate",
  args: [probe, 3600n],
})) as boolean[];
check(
  "an unknown symbol reads stale rather than reverting the call",
  staleProbe[staleProbe.length - 1] === true &&
    staleProbe.slice(0, -1).every((s) => !s),
);

// ---------------------------------------------------------------- status

console.log("\n=== status ===");
const status = (await pub.readContract({
  address: keeper,
  abi: keeperArtifact.abi,
  functionName: "status",
  args: [probe, 3600n],
})) as {
  exists: boolean;
  price: bigint;
  confidenceBps: bigint;
  provenance: number;
  ageSeconds: bigint;
  stale: boolean;
}[];
check("status covers every input", status.length === probe.length);
check("known tickers exist", status.slice(0, -1).every((s) => s.exists));
check("unknown ticker is flagged absent", status[status.length - 1].exists === false);
check(
  "prices match the batch",
  status.slice(0, -1).every((s, i) => s.price === tuples[i].price),
);
console.log(
  `  HOOD  $${(Number(status[0].price) / 1e8).toFixed(2)}  ±${(Number(status[0].confidenceBps) / 100).toFixed(2)}%  ` +
    `age ${status[0].ageSeconds}s  stale=${status[0].stale}`,
);

// ------------------------------------------- the race, which must not revert

console.log("\n=== re-posting the same batch (the race) ===");
const replayHash = await wallet.writeContract({
  address: keeper,
  abi: keeperArtifact.abi,
  functionName: "postQuotes",
  args: [tickers, tuples, sigs],
});
const replayRc = await pub.waitForTransactionReceipt({ hash: replayHash });
check(
  "an entirely already-posted batch does not revert",
  replayRc.status === "success",
);
const replayPosted = replayRc.logs.filter(
  (l) => l.address.toLowerCase() === oracle.toLowerCase(),
);
check("and posts nothing", replayPosted.length === 0, `emitted ${replayPosted.length}`);

// One fresh, seven stale: the partial case, on real data.
console.log("\n=== partial batch: one new, the rest already posted ===");
const bumped = quotes.map((q, i) =>
  i === 0 ? { ...q, publishTime: q.publishTime + 1 } : q,
);
const bumpedSigned = await Promise.all(bumped.map((q) => signQuote(q)));
const bumpedTuples = bumped.map((q) => ({
  price: toScaled(q.price),
  confidenceBps: BigInt(q.confidenceBps),
  session: q.session,
  provenance: q.provenance,
  sourceCount: q.sourceCount,
  maxDeviationBps: BigInt(Math.round(q.maxDeviationBps)),
  lastTradeTime: BigInt(q.lastTradeTime),
  publishTime: BigInt(q.publishTime),
}));
const partialHash = await wallet.writeContract({
  address: keeper,
  abi: keeperArtifact.abi,
  functionName: "postQuotes",
  args: [tickers, bumpedTuples, bumpedSigned.map((s) => s.signature)],
});
const partialRc = await pub.waitForTransactionReceipt({ hash: partialHash });
const partialPosted = partialRc.logs.filter(
  (l) => l.address.toLowerCase() === oracle.toLowerCase(),
);
check("the one newer quote lands", partialPosted.length === 1, `emitted ${partialPosted.length}`);
check("the transaction still succeeds", partialRc.status === "success");

// --------------------------------------------- the TRADED path, end to end
//
// Everything above, and everything on mainnet, is DERIVED: the oracle has only
// ever run while the tape was shut, so the path a lending market actually
// depends on — a live print, a tight band, getPriceIfTraded returning rather
// than reverting — has never executed against a real chain. Nor has the
// ledger's resolution logic, which needs a TRADED quote to score a closure
// against and has so far been exercised only by fixtures and a replay.
//
// A synthetic live print on a local chain closes both. It is not published
// anywhere public, so it cannot pollute the real record.

console.log("\n=== the TRADED path ===");
{
  const hood = quotes.find((q) => q.ticker === "HOOD")!;
  const live = {
    ...hood,
    // A real print, seconds old, with the tight band a live session carries.
    provenance: 0, // TRADED
    session: 0, // REGULAR
    confidenceBps: 14,
    lastTradeTime: hood.publishTime + 30,
    publishTime: hood.publishTime + 30,
  };
  const liveSigned = await signQuote(live as typeof hood);
  const liveTuple = {
    price: toScaled(live.price),
    confidenceBps: BigInt(live.confidenceBps),
    session: live.session,
    provenance: live.provenance,
    sourceCount: live.sourceCount,
    maxDeviationBps: BigInt(Math.round(live.maxDeviationBps)),
    lastTradeTime: BigInt(live.lastTradeTime),
    publishTime: BigInt(live.publishTime),
  };

  // Before: the liquidation path must refuse.
  let refusedBefore = false;
  try {
    await pub.readContract({
      address: oracle,
      abi: oracleArtifact.abi,
      functionName: "getPriceIfTraded",
      args: ["HOOD", 200n],
    });
  } catch {
    refusedBefore = true;
  }
  check("getPriceIfTraded refuses a DERIVED quote", refusedBefore);

  const h = await wallet.writeContract({
    address: oracle,
    abi: oracleArtifact.abi,
    functionName: "postQuote",
    args: ["HOOD", liveTuple, liveSigned.signature],
  });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  check("a TRADED quote posts", rc.status === "success");

  const px = (await pub.readContract({
    address: oracle,
    abi: oracleArtifact.abi,
    functionName: "getPriceIfTraded",
    args: ["HOOD", 200n],
  })) as bigint;
  check(
    "getPriceIfTraded now RETURNS a price",
    px === liveTuple.price,
    `$${Number(px) / 1e8}`,
  );

  const isLive = (await pub.readContract({
    address: oracle,
    abi: oracleArtifact.abi,
    functionName: "isLive",
    args: ["HOOD", 200n],
  })) as boolean;
  check("isLive is true", isLive);

  // The band ceiling still bites on a live print.
  let tooTight = false;
  try {
    await pub.readContract({
      address: oracle,
      abi: oracleArtifact.abi,
      functionName: "getPriceIfTraded",
      args: ["HOOD", 10n],
    });
  } catch {
    tooTight = true;
  }
  check("and still refuses when the band is wider than asked", tooTight);

  // ---- the ledger resolves a real closure, from real chain logs
  const { buildLedger, loadArchive } = await import("../src/lib/ledger.ts");
  const archive = await loadArchive(
    {
      address: oracle,
      rpcUrl: RPC,
      chainId: foundry.id,
      chainName: "anvil",
    },
    { fresh: true },
  );
  const ledger = buildLedger(archive);
  const hoodEp = ledger.episodes.filter((e) => e.ticker === "HOOD");

  check(
    "the ledger resolves a closure once a live print lands",
    hoodEp.length === 1,
    `episodes=${hoodEp.length}`,
  );
  if (hoodEp.length === 1) {
    const r = hoodEp[0].atReopen;
    check(
      "  and scores it against the print, not the model",
      r.resolvedPrice === live.price,
      `resolved=$${r.resolvedPrice} predicted=$${r.predictedPrice}`,
    );
    check(
      "  with the band the closure actually carried",
      r.confidenceBps === hood.confidenceBps,
      `${r.confidenceBps}bps`,
    );
    // Same price, so the print sits dead centre and must count as a hit.
    check("  an unchanged price is a hit", r.hit === true);
    console.log(
      `  HOOD ±${(r.confidenceBps / 100).toFixed(2)}% [${r.lower.toFixed(2)}–${r.upper.toFixed(2)}] ` +
        `resolved $${r.resolvedPrice.toFixed(2)}  err ${r.errorBps.toFixed(0)}bps  hit=${r.hit}`,
    );
  }
  check(
    "other tickers stay pending, not scored",
    ledger.pending.length === UNIVERSE.length - 1,
    `pending=${ledger.pending.length}`,
  );
  check(
    "coverage is now a real number",
    ledger.atReopen.coveragePct !== null,
    `${ledger.atReopen.coveragePct}% over ${ledger.atReopen.n}`,
  );
}

// ------------------------------------------------------------------ gas

console.log("\n=== gas: batch vs one-at-a-time ===");
// A fresh pair so both sides write into cold storage.
hash = await wallet.deployContract({
  abi: oracleArtifact.abi,
  bytecode: oracleArtifact.bytecode.object as Hex,
  args: [signer.address],
});
const oracleB = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;

let individualTotal = 0n;
for (let i = 0; i < tickers.length; i++) {
  const h = await wallet.writeContract({
    address: oracleB,
    abi: oracleArtifact.abi,
    functionName: "postQuote",
    args: [tickers[i], tuples[i], sigs[i]],
  });
  individualTotal += (await pub.waitForTransactionReceipt({ hash: h })).gasUsed;
}

const saved = individualTotal - batchRc.gasUsed;
const pct = Number((saved * 10000n) / individualTotal) / 100;
console.log(`  one-at-a-time  ${individualTotal} gas across ${tickers.length} transactions`);
console.log(`  batched        ${batchRc.gasUsed} gas in 1 transaction`);
console.log(`  saved          ${saved} gas  (${pct.toFixed(1)}%)`);
check("batching is cheaper", saved > 0n, `saved ${saved}`);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log();
