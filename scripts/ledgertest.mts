// Tests for the coverage ledger.
//
// Two halves, because they prove different things.
//
//   A  Deterministic. A hand-built archive with answers worked out by hand,
//      covering the cases that are easy to get subtly wrong: a band that is
//      missed by one cent, the pairing of a closure with the print that ends
//      it, several closures for one ticker, a closure still open at the end of
//      the archive, and the difference between scoring the last band before a
//      reopen and scoring all of them.
//
//   B  Real data. Two years of actual closes and opens for the whole universe,
//      turned into the quotes the live engine would have published just before
//      each reopen, then scored through the same buildLedger() the site calls.
//      If the scoring is right this reproduces the calibration's own coverage
//      figure. It is the end-to-end check that the ledger measures what the
//      backtest measured, on real prices, through production code.
//
//   npm run test:ledger
//   npm run test:ledger -- --unit    skip the network half

import "./env.mts";

import { buildLedger, wilson, type PublishedQuote } from "../src/lib/ledger.ts";
import { Provenance, Session } from "../src/lib/types.ts";
import { toScaled } from "../src/lib/sign.ts";
import { UNIVERSE } from "../src/lib/universe.ts";
import {
  CALIBRATION,
  calibrationFor,
  gapSigmaBps,
  Z_95,
} from "../src/lib/calibration.ts";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

function eq(label: string, got: unknown, want: unknown) {
  check(label, Object.is(got, want), `got=${String(got)} want=${String(want)}`);
}

function near(label: string, got: number | null, want: number, tol: number) {
  check(
    label,
    got !== null && Math.abs(got - want) <= tol,
    `got=${got === null ? "null" : got.toFixed(3)} want=${want}±${tol}`,
  );
}

// --------------------------------------------------------------- fixtures

let seq = 0;
function q(
  ticker: string,
  price: number,
  bps: number,
  provenance: Provenance,
  publishTime: number,
): PublishedQuote {
  seq++;
  return {
    ticker,
    // Through the same scaler the signer uses, so the fixture is exactly what
    // the chain would hold rather than a float that merely looks like it.
    priceScaled: toScaled(price),
    price,
    confidenceBps: bps,
    session:
      provenance === Provenance.TRADED ? Session.REGULAR : Session.CLOSED,
    provenance,
    publishTime,
    signer: "0x000000000000000000000000000000000000dEaD",
    blockNumber: seq,
    txHash: `0x${seq.toString(16).padStart(64, "0")}` as `0x${string}`,
    logIndex: 0,
  };
}

const T = 1_750_000_000;
const H = 3600;

console.log("\n=== A. deterministic scoring ===\n");

// A single closure. Band is 100.00 ±1% = [99, 101]. The reopen prints 100.50,
// which is inside. The band published earlier is ±0.5% = [99.5, 100.5]; 100.50
// is exactly the edge and the comparison is inclusive, so that one hits too.
{
  const archive = [
    q("HOOD", 100, 50, Provenance.DERIVED, T + 1 * H),
    q("HOOD", 100, 100, Provenance.DERIVED, T + 2 * H),
    q("HOOD", 100.5, 20, Provenance.TRADED, T + 3 * H),
  ];
  const l = buildLedger(archive);
  eq("one closure produces one episode", l.episodes.length, 1);
  eq("episode holds both closed quotes", l.episodes[0].quotes.length, 2);
  eq("atReopen scores the last band", l.atReopen.n, 1);
  eq("  and it hits", l.atReopen.hits, 1);
  eq("allDuringClosure scores both", l.allDuringClosure.n, 2);
  eq("  inclusive edge counts as a hit", l.allDuringClosure.hits, 2);
  near("error is +50bps", l.episodes[0].atReopen.errorBps, 50, 0.01);
  near("ratio is 0.5 of the band", l.episodes[0].atReopen.ratio, 0.5, 0.001);
  eq("no pending runs", l.pending.length, 0);
  eq("lead time is one hour", l.episodes[0].atReopen.leadSeconds, H);
}

// A miss by a hair. Band ±1% on 100 is [99, 101]; the print is 101.01.
{
  const l = buildLedger([
    q("HOOD", 100, 100, Provenance.DERIVED, T),
    q("HOOD", 101.01, 20, Provenance.TRADED, T + H),
  ]);
  eq("a print just outside the band misses", l.atReopen.hits, 0);
  eq("  and is still counted", l.atReopen.n, 1);
  check(
    "  ratio exceeds 1.0 on a miss",
    (l.episodes[0].atReopen.ratio ?? 0) > 1,
    `ratio=${l.episodes[0].atReopen.ratio.toFixed(4)}`,
  );
}

// Downside miss, to be sure the comparison is two-sided.
{
  const l = buildLedger([
    q("HOOD", 100, 100, Provenance.DERIVED, T),
    q("HOOD", 98.5, 20, Provenance.TRADED, T + H),
  ]);
  eq("a print below the band also misses", l.atReopen.hits, 0);
  check(
    "  error is signed negative",
    l.episodes[0].atReopen.errorBps < 0,
    `errorBps=${l.episodes[0].atReopen.errorBps.toFixed(1)}`,
  );
}

// Several closures for one ticker: each must pair with its own reopen, not
// with the last one in the archive.
{
  const l = buildLedger([
    q("COIN", 200, 100, Provenance.DERIVED, T),
    q("COIN", 201, 20, Provenance.TRADED, T + H), //  hit   (199-203)
    q("COIN", 201, 100, Provenance.DERIVED, T + 2 * H),
    q("COIN", 250, 20, Provenance.TRADED, T + 3 * H), // miss (198.99-203.01)
    q("COIN", 250, 100, Provenance.DERIVED, T + 4 * H),
    q("COIN", 251, 20, Provenance.TRADED, T + 5 * H), //  hit
  ]);
  eq("three closures, three episodes", l.episodes.length, 3);
  eq("each pairs with its own reopen", l.atReopen.n, 3);
  eq("  two hit, one missed", l.atReopen.hits, 2);
  near("  coverage is 2/3", l.atReopen.coveragePct, 66.667, 0.01);
}

// Interleaved tickers must not contaminate each other.
{
  const l = buildLedger([
    q("HOOD", 100, 100, Provenance.DERIVED, T),
    q("AAPL", 300, 100, Provenance.DERIVED, T + 1),
    q("HOOD", 100.2, 20, Provenance.TRADED, T + H),
    q("AAPL", 400, 20, Provenance.TRADED, T + H + 1), // wild miss
  ]);
  eq("two tickers, two episodes", l.episodes.length, 2);
  eq("HOOD hits", l.perTicker.HOOD.hits, 1);
  eq("AAPL misses", l.perTicker.AAPL.hits, 0);
  eq("AAPL is still measured", l.perTicker.AAPL.n, 1);
  near("overall is 1/2", l.atReopen.coveragePct, 50, 0.01);
}

// An unresolved closure is pending, never a miss. Counting "not yet observed"
// as a failure is the single most tempting way to make this statistic lie.
{
  const l = buildLedger([
    q("TLT", 90, 100, Provenance.DERIVED, T),
    q("TLT", 90, 100, Provenance.DERIVED, T + H),
  ]);
  eq("no episodes without a reopen", l.episodes.length, 0);
  eq("the run is pending", l.pending.length, 1);
  eq("  with both quotes", l.pending[0].quotes, 2);
  eq("coverage is null, not zero", l.atReopen.coveragePct, null);
  eq("  and n is zero", l.atReopen.n, 0);
  eq("  and the CI is null", l.atReopen.ci, null);
}

// Consecutive live prints are not a forecast and must not be scored.
{
  const l = buildLedger([
    q("SPY", 500, 20, Provenance.TRADED, T),
    q("SPY", 530, 20, Provenance.TRADED, T + H), // way outside the tight band
    q("SPY", 530, 20, Provenance.TRADED, T + 2 * H),
  ]);
  eq("live prints produce no episodes", l.episodes.length, 0);
  eq("  and no resolutions", l.atReopen.n, 0);
  eq("  and nothing pending", l.pending.length, 0);
}

// STALE is a claim about an unobservable price too, so it is scored.
{
  const l = buildLedger([
    q("NVDA", 150, 200, Provenance.STALE, T),
    q("NVDA", 151, 20, Provenance.TRADED, T + H),
  ]);
  eq("STALE quotes are scored", l.atReopen.n, 1);
  eq("  and can hit", l.atReopen.hits, 1);
}

// Out-of-order logs must be sorted before pairing, or a closure pairs with a
// print that happened before it.
{
  const l = buildLedger([
    q("MSTR", 400, 20, Provenance.TRADED, T + 2 * H),
    q("MSTR", 395, 200, Provenance.DERIVED, T + H),
  ]);
  eq("unsorted input still pairs correctly", l.episodes.length, 1);
  eq("  predicted precedes resolved", l.episodes[0].atReopen.leadSeconds, H);
}

// A band published before the running calibration was fitted tests a model
// that is no longer in use. It stays in the headline, because it is what a
// consumer was handed, and it is excluded from the current-model figure.
{
  const cutoff = Math.floor(new Date(CALIBRATION.generatedAt).getTime() / 1000);
  const l = buildLedger([
    // Old model: far too narrow, and it misses.
    q("HOOD", 100, 20, Provenance.DERIVED, cutoff - 7200),
    q("HOOD", 103, 20, Provenance.TRADED, cutoff - 3600),
    // Current model: properly sized, and it hits.
    q("HOOD", 103, 400, Provenance.DERIVED, cutoff + 3600),
    q("HOOD", 104, 20, Provenance.TRADED, cutoff + 7200),
  ]);
  eq("calibratedAt is read from calibration.json", l.calibratedAt, cutoff);
  eq("headline keeps both closures", l.atReopen.n, 2);
  eq("  and reports the real 1 of 2", l.atReopen.hits, 1);
  eq("one resolution predates the calibration", l.beforeCalibration, 1);
  eq("current-model figure covers only the newer one", l.sinceCalibration.n, 1);
  eq("  which hit", l.sinceCalibration.hits, 1);
  near("  so it reads 100%", l.sinceCalibration.coveragePct, 100, 0.01);
}

console.log("\n=== A2. Wilson interval ===\n");
{
  eq("no samples gives no interval", wilson(0, 0), null);

  const w3 = wilson(3, 3)!;
  check(
    "3/3 does not claim 100%",
    w3.lower < 50 && w3.upper > 99,
    `[${w3.lower.toFixed(1)}, ${w3.upper.toFixed(1)}]`,
  );

  const wBig = wilson(3800, 4000)!;
  check(
    "3800/4000 is a tight interval",
    wBig.upper - wBig.lower < 2,
    `[${wBig.lower.toFixed(2)}, ${wBig.upper.toFixed(2)}]`,
  );

  const wHalf = wilson(50, 100)!;
  near("50/100 centres on 50%", (wHalf.lower + wHalf.upper) / 2, 50, 0.5);

  const w0 = wilson(0, 10)!;
  check(
    "0/10 stays inside [0,100]",
    w0.lower >= 0 && w0.upper <= 100,
    `[${w0.lower.toFixed(1)}, ${w0.upper.toFixed(1)}]`,
  );
}

// ------------------------------------------------------- B. real data

if (process.argv.includes("--unit")) {
  console.log("\n--unit: skipping the real-data replay\n");
} else {
  console.log("\n=== B. replay against two years of real gaps ===\n");
  await replay();
}

async function replay() {
  const UA = { "user-agent": "Mozilla/5.0 (compatible; hoodoracle/0.1)" };
  const REGULAR_SESSION_SECONDS = 6.5 * 3600;

  async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return (await res.json()) as T;
  }

  async function dailyBars(symbol: string) {
    const r = await getJson<any>(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2y`,
    );
    const res = r.chart.result?.[0];
    if (!res?.timestamp) throw new Error(`no series for ${symbol}`);
    const o = res.indicators.quote[0]?.open ?? [];
    const c = res.indicators.quote[0]?.close ?? [];
    const out: { ts: number; open: number; close: number }[] = [];
    res.timestamp.forEach((ts: number, i: number) => {
      if (typeof o[i] === "number" && typeof c[i] === "number" && o[i] > 0 && c[i] > 0) {
        out.push({ ts, open: o[i], close: c[i] });
      }
    });
    return out;
  }

  async function hourly(symbol: string): Promise<[number, number][]> {
    const r = await getJson<any>(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1h&range=730d`,
    );
    const res = r.chart.result?.[0];
    if (!res?.timestamp) throw new Error(`no hourly for ${symbol}`);
    const c = res.indicators.quote[0]?.close ?? [];
    const pts: [number, number][] = [];
    res.timestamp.forEach((ts: number, i: number) => {
      if (typeof c[i] === "number" && c[i] > 0) pts.push([ts, c[i]]);
    });
    return pts;
  }

  function priceAt(series: [number, number][], t: number): number | null {
    let lo = 0, hi = series.length - 1, best: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid][0] <= t) { best = series[mid][1]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  let btc: [number, number][], eth: [number, number][];
  try {
    [btc, eth] = await Promise.all([hourly("BTC-USD"), hourly("ETH-USD")]);
  } catch (e) {
    console.log(`  SKIP: proxy fetch failed (${(e as Error).message})`);
    console.log("  The deterministic half above is unaffected.\n");
    return;
  }
  console.log(`  proxies: BTC ${btc.length}pts  ETH ${eth.length}pts`);

  function blended(from: number, to: number): number | null {
    const b0 = priceAt(btc, from), b1 = priceAt(btc, to);
    const e0 = priceAt(eth, from), e1 = priceAt(eth, to);
    if (!b0 || !b1 || !e0 || !e1) return null;
    return 0.6 * ((b1 - b0) / b0) + 0.4 * ((e1 - e0) / e0);
  }

  // Build the archive the relayer would have written, had it been running for
  // the last two years: one DERIVED quote just before each reopen, priced and
  // banded by the production functions, then the reopening print.
  const archive: PublishedQuote[] = [];
  let block = 0;

  for (const inst of UNIVERSE) {
    let bars;
    try {
      bars = await dailyBars(inst.ticker);
    } catch (e) {
      console.log(`  ${inst.ticker}: skip (${(e as Error).message})`);
      continue;
    }
    const cal = calibrationFor(inst.ticker);

    for (let i = 1; i < bars.length; i++) {
      const closeTs = bars[i - 1].ts + REGULAR_SESSION_SECONDS;
      const openTs = bars[i].ts;
      const gapSeconds = openTs - closeTs;
      if (gapSeconds <= 0) continue;

      const move = blended(closeTs, openTs);
      if (move === null) continue;

      const gapHours = gapSeconds / 3600;
      // Exactly what src/lib/quote.ts does for a DERIVED quote, minus the
      // live source dispersion, which has no historical equivalent.
      const price = bars[i - 1].close * (1 + move * cal.beta);
      const bps = Math.max(
        45,
        Math.min(1500, Math.round(Z_95 * gapSigmaBps(inst.ticker, gapHours))),
      );

      block += 2;
      archive.push({
        ticker: inst.ticker,
        priceScaled: toScaled(price),
        price,
        confidenceBps: bps,
        session: Session.CLOSED,
        provenance: Provenance.DERIVED,
        publishTime: openTs - 60,
        signer: "0x000000000000000000000000000000000000dEaD",
        blockNumber: block,
        txHash: `0x${block.toString(16).padStart(64, "0")}` as `0x${string}`,
        logIndex: 0,
      });
      archive.push({
        ticker: inst.ticker,
        priceScaled: toScaled(bars[i].open),
        price: bars[i].open,
        confidenceBps: 20,
        session: Session.REGULAR,
        provenance: Provenance.TRADED,
        publishTime: openTs,
        signer: "0x000000000000000000000000000000000000dEaD",
        blockNumber: block + 1,
        txHash: `0x${(block + 1).toString(16).padStart(64, "0")}` as `0x${string}`,
        logIndex: 0,
      });
    }
  }

  const l = buildLedger(archive);
  console.log(
    `  replayed ${archive.length} quotes -> ${l.episodes.length} resolved gaps\n`,
  );

  const s = l.atReopen;
  console.log(
    `  coverage  ${s.coveragePct!.toFixed(2)}%  (${s.hits}/${s.n})  CI [${s.ci!.lower.toFixed(2)} – ${s.ci!.upper.toFixed(2)}]  mean |err|/band ${s.meanRatio!.toFixed(3)}\n`,
  );

  for (const [t, st] of Object.entries(l.perTicker).sort()) {
    const shipped = CALIBRATION.instruments[t]?.coveragePct;
    console.log(
      `    ${t.padEnd(5)} ${st.coveragePct!.toFixed(1).padStart(5)}%  ${String(st.hits).padStart(4)}/${String(st.n).padEnd(4)}` +
        (shipped == null ? "" : `  calibration.json says ${shipped.toFixed(1)}%`),
    );
  }
  console.log();

  // The real assertions.
  check(
    "every gap in the universe resolved",
    l.episodes.length > 3000,
    `episodes=${l.episodes.length}`,
  );
  eq("nothing left pending in a closed replay", l.pending.length, 0);
  check(
    "coverage lands in the 93-97% band the calibration claims",
    s.coveragePct! >= 93 && s.coveragePct! <= 97,
    `got ${s.coveragePct!.toFixed(2)}%`,
  );
  check(
    "the nominal 95% sits inside the Wilson interval",
    s.ci!.lower <= 95 && s.ci!.upper >= 95,
    `[${s.ci!.lower.toFixed(2)}, ${s.ci!.upper.toFixed(2)}]`,
  );
  check(
    "mean error is about half the band, so it is not oversized",
    s.meanRatio! > 0.2 && s.meanRatio! < 0.75,
    `meanRatio=${s.meanRatio!.toFixed(3)}`,
  );

  // Per-ticker agreement with the figure calibrate.mts shipped. Same data,
  // same model; a disagreement means the ledger is scoring something else.
  for (const [t, st] of Object.entries(l.perTicker)) {
    const shipped = CALIBRATION.instruments[t]?.coveragePct;
    if (shipped == null || st.n === 0) continue;
    check(
      `${t} agrees with calibration.json within 3pp`,
      Math.abs(st.coveragePct! - shipped) <= 3,
      `ledger=${st.coveragePct!.toFixed(1)}% shipped=${shipped.toFixed(1)}%`,
    );
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log();
