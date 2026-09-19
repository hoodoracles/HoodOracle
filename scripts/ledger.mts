// Read the coverage ledger off the chain and print it.
//
// This is the same computation the /coverage page and /api/coverage serve, run
// against the same source of truth, so a disagreement between this and the site
// means the site is wrong.
//
//   npm run ledger              summary
//   npm run ledger -- --full    every resolution, one per line
//   npm run ledger -- --json    machine readable

import "./env.mts";

import { buildLedger, chainConfig, loadArchive } from "../src/lib/ledger.ts";
import { PROVENANCE_NAME, SESSION_NAME } from "../src/lib/types.ts";
import { describeGap } from "../src/lib/session.ts";

const full = process.argv.includes("--full");
const asJson = process.argv.includes("--json");

const cfg = chainConfig();
if (!cfg) {
  console.error(
    "set NEXT_PUBLIC_ORACLE_ADDRESS, NEXT_PUBLIC_ORACLE_RPC and NEXT_PUBLIC_ORACLE_CHAIN_ID",
  );
  process.exit(1);
}

const started = Date.now();
const quotes = await loadArchive(cfg, { fresh: true });
const took = Date.now() - started;
const ledger = buildLedger(quotes);

if (asJson) {
  console.log(
    JSON.stringify(
      { ...ledger, quotes: ledger.quotes.length, episodes: ledger.episodes.length },
      null,
      2,
    ),
  );
  process.exit(0);
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const pct = (v: number | null) => (v === null ? "  n/a" : `${v.toFixed(1)}%`);

function statLine(label: string, s: ReturnType<typeof buildLedger>["atReopen"]) {
  const ci = s.ci ? `  [${s.ci.lower.toFixed(1)} – ${s.ci.upper.toFixed(1)}]` : "";
  const ratio = s.meanRatio === null ? "" : `  mean |err|/band ${s.meanRatio.toFixed(2)}`;
  console.log(
    `  ${label.padEnd(22)} ${pct(s.coveragePct).padStart(6)}  ${String(s.hits).padStart(4)}/${String(s.n).padEnd(4)}${ci}${ratio}`,
  );
}

console.log(`\n${cfg.chainName} (${cfg.chainId})  ${cfg.address}`);
console.log(`archive  ${quotes.length} quotes in ${took}ms`);
if (ledger.firstPublish && ledger.lastPublish) {
  console.log(
    `window   ${iso(ledger.firstPublish)}  ->  ${iso(ledger.lastPublish)}  (${describeGap(
      ledger.lastPublish - ledger.firstPublish,
    )})`,
  );
}
console.log(`signers  ${ledger.signers.join(", ") || "none"}`);

const prov: Record<string, number> = {};
for (const q of quotes) prov[PROVENANCE_NAME[q.provenance]] = (prov[PROVENANCE_NAME[q.provenance]] ?? 0) + 1;
const sess: Record<string, number> = {};
for (const q of quotes) sess[SESSION_NAME[q.session]] = (sess[SESSION_NAME[q.session]] ?? 0) + 1;
console.log(
  `mix      ${Object.entries(prov).map(([k, v]) => `${k} ${v}`).join("  ")}   |   ${Object.entries(sess).map(([k, v]) => `${k} ${v}`).join("  ")}`,
);

console.log(`\ncoverage  (nominal ${ledger.nominalPct}%)`);
statLine("at reopen", ledger.atReopen);
statLine("all during closure", ledger.allDuringClosure);

const measured = Object.entries(ledger.perTicker).filter(([, s]) => s.n > 0);
if (measured.length) {
  console.log("\nper ticker (at reopen)");
  for (const [ticker, s] of measured.sort((a, b) => b[1].n - a[1].n)) {
    statLine(ticker, s);
  }
}

if (ledger.pending.length) {
  console.log("\npending  (published, tape has not reopened)");
  for (const p of ledger.pending) {
    console.log(
      `  ${p.ticker.padEnd(6)} ${String(p.quotes).padStart(3)} quotes  since ${iso(p.since)}`,
    );
  }
}

if (full && ledger.episodes.length) {
  console.log("\nresolutions (at reopen)");
  console.log(
    "  ticker  predicted          band       -> resolved     err      lead     hit",
  );
  for (const e of ledger.episodes) {
    const r = e.atReopen;
    console.log(
      `  ${r.ticker.padEnd(6)} ${r.predictedPrice.toFixed(2).padStart(9)}  ±${(r.confidenceBps / 100).toFixed(2)}%  -> ${r.resolvedPrice.toFixed(2).padStart(9)}  ${(r.errorBps >= 0 ? "+" : "") + r.errorBps.toFixed(0)}bps`.padEnd(70) +
        `${describeGap(r.leadSeconds).padStart(7)}  ${r.hit ? "yes" : "NO"}`,
    );
  }
}

if (ledger.atReopen.n === 0) {
  console.log(
    "\nNothing resolved yet: every closure in the archive is still open.\n" +
      "The first scores land when the tape reopens and a TRADED quote is posted.",
  );
}
console.log();
