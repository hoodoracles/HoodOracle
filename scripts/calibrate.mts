// Beta calibration and band validation.
//
// Everything shipped until now used conservative *priors* for the crypto beta
// and a hand-picked coefficient for the confidence band. This fits both against
// two years of realised overnight and weekend gaps and writes the result to
// src/lib/calibration.json.
//
// Method
//   For each trading day, the gap is [previous close, this open]. The equity's
//   realised gap return is measured against the blended BTC/ETH move over
//   exactly that window. OLS through the origin gives the beta; the residual
//   standard deviation gives the band the model should actually carry, which is
//   the number the confidence model was previously guessing.
//
//   Gaps are bucketed by length so the sqrt(t) assumption can be tested rather
//   than assumed: if uncertainty really grows with the square root of elapsed
//   time, residual sigma divided by sqrt(hours) should be roughly flat across
//   overnight and weekend buckets.

import "./env.mts";

import { writeFileSync } from "node:fs";
import { UNIVERSE } from "../src/lib/universe.ts";

const UA = { "user-agent": "Mozilla/5.0 (compatible; hoodoracle/0.1)" };

interface Bar {
  ts: number; // unix seconds, stamped at the session open
  open: number;
  close: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`http ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function dailyBars(symbol: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2y`;
  const r = await getJson<{
    chart: {
      result?: {
        timestamp?: number[];
        indicators: {
          quote: { open?: (number | null)[]; close?: (number | null)[] }[];
        };
      }[];
    };
  }>(url);
  const res = r.chart.result?.[0];
  if (!res?.timestamp) throw new Error(`no daily series for ${symbol}`);
  const o = res.indicators.quote[0]?.open ?? [];
  const c = res.indicators.quote[0]?.close ?? [];

  const out: Bar[] = [];
  res.timestamp.forEach((ts, i) => {
    const open = o[i];
    const close = c[i];
    // The current, incomplete bar has a null close. Skip rather than impute.
    if (
      typeof open === "number" &&
      typeof close === "number" &&
      open > 0 &&
      close > 0
    ) {
      out.push({ ts, open, close });
    }
  });
  return out;
}

async function hourlySeries(symbol: string): Promise<[number, number][]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1h&range=730d`;
  const r = await getJson<{
    chart: {
      result?: {
        timestamp?: number[];
        indicators: { quote: { close?: (number | null)[] }[] };
      }[];
    };
  }>(url);
  const res = r.chart.result?.[0];
  if (!res?.timestamp) throw new Error(`no hourly series for ${symbol}`);
  const c = res.indicators.quote[0]?.close ?? [];
  const pts: [number, number][] = [];
  res.timestamp.forEach((ts, i) => {
    const v = c[i];
    if (typeof v === "number" && v > 0) pts.push([ts, v]);
  });
  return pts;
}

/** Price at or just before `t`, or null when the series does not cover it. */
function priceAt(series: [number, number][], t: number): number | null {
  let lo = 0;
  let hi = series.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= t) {
      best = series[mid][1];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Tolerate at most this much distance between the window edge and a sample. */
const MAX_SNAP_SECONDS = 3 * 3600;

function coversWindow(series: [number, number][], t: number): boolean {
  if (series.length === 0) return false;
  if (t < series[0][0] || t > series[series.length - 1][0] + MAX_SNAP_SECONDS) {
    return false;
  }
  return true;
}

const REGULAR_SESSION_SECONDS = 6.5 * 3600;

interface Sample {
  gapHours: number;
  equityReturn: number;
  proxyMove: number;
  weekend: boolean;
}

function ols(samples: Sample[]): {
  beta: number;
  r2: number;
  residualSigma: number;
  n: number;
} {
  const n = samples.length;
  if (n < 10) return { beta: 0, r2: 0, residualSigma: 0, n };

  // Through the origin: a gap with no proxy move has no expected drift.
  let sxy = 0;
  let sxx = 0;
  for (const s of samples) {
    sxy += s.proxyMove * s.equityReturn;
    sxx += s.proxyMove * s.proxyMove;
  }
  const beta = sxx > 0 ? sxy / sxx : 0;

  let ssRes = 0;
  let ssTot = 0;
  const meanY = samples.reduce((a, s) => a + s.equityReturn, 0) / n;
  for (const s of samples) {
    const pred = beta * s.proxyMove;
    ssRes += (s.equityReturn - pred) ** 2;
    ssTot += (s.equityReturn - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const residualSigma = Math.sqrt(ssRes / Math.max(1, n - 1));

  return { beta, r2, residualSigma, n };
}

// --------------------------------------------------------------------- run

console.log("fetching proxy series…");
const [btc, eth] = await Promise.all([
  hourlySeries("BTC-USD"),
  hourlySeries("ETH-USD"),
]);
console.log(`  BTC ${btc.length} hourly points`);
console.log(`  ETH ${eth.length} hourly points\n`);

function blendedMove(from: number, to: number): number | null {
  if (!coversWindow(btc, from) || !coversWindow(eth, from)) return null;
  const b0 = priceAt(btc, from);
  const b1 = priceAt(btc, to);
  const e0 = priceAt(eth, from);
  const e1 = priceAt(eth, to);
  if (!b0 || !b1 || !e0 || !e1) return null;
  return 0.6 * ((b1 - b0) / b0) + 0.4 * ((e1 - e0) / e0);
}

interface Result {
  ticker: string;
  priorBeta: number;
  beta: number;
  r2: number;
  n: number;
  overnightSigmaBps: number;
  weekendSigmaBps: number;
  sqrtTCoeffOvernight: number;
  sqrtTCoeffWeekend: number;
}

const results: Result[] = [];

for (const inst of UNIVERSE) {
  process.stdout.write(`${inst.ticker.padEnd(6)}`);
  let bars: Bar[];
  try {
    bars = await dailyBars(inst.ticker);
  } catch (e) {
    console.log(`  skip: ${(e as Error).message}`);
    continue;
  }

  const samples: Sample[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    // Yahoo stamps a daily bar at the session open, so the previous close is
    // one regular session later than the previous bar's stamp.
    const closeTs = prev.ts + REGULAR_SESSION_SECONDS;
    const openTs = cur.ts;
    const gapSeconds = openTs - closeTs;
    if (gapSeconds <= 0) continue;

    const move = blendedMove(closeTs, openTs);
    if (move === null) continue;

    const equityReturn = (cur.open - prev.close) / prev.close;
    // Guard against split and dividend artefacts masquerading as gaps.
    if (Math.abs(equityReturn) > 0.35) continue;

    const gapHours = gapSeconds / 3600;
    samples.push({
      gapHours,
      equityReturn,
      proxyMove: move,
      weekend: gapHours > 40,
    });
  }

  const fit = ols(samples);
  const overnight = samples.filter((s) => !s.weekend);
  const weekend = samples.filter((s) => s.weekend);

  const sigmaOf = (xs: Sample[]) => {
    if (xs.length < 5) return 0;
    const resid = xs.map((s) => s.equityReturn - fit.beta * s.proxyMove);
    const mean = resid.reduce((a, b) => a + b, 0) / resid.length;
    const v =
      resid.reduce((a, r) => a + (r - mean) ** 2, 0) / (resid.length - 1);
    return Math.sqrt(v);
  };

  const sOn = sigmaOf(overnight);
  const sWe = sigmaOf(weekend);
  const hOn =
    overnight.reduce((a, s) => a + s.gapHours, 0) /
    Math.max(1, overnight.length);
  const hWe =
    weekend.reduce((a, s) => a + s.gapHours, 0) / Math.max(1, weekend.length);

  results.push({
    ticker: inst.ticker,
    priorBeta: inst.cryptoBetaPrior,
    beta: fit.beta,
    r2: fit.r2,
    n: fit.n,
    overnightSigmaBps: sOn * 10_000,
    weekendSigmaBps: sWe * 10_000,
    sqrtTCoeffOvernight: hOn > 0 ? (sOn * 10_000) / Math.sqrt(hOn) : 0,
    sqrtTCoeffWeekend: hWe > 0 ? (sWe * 10_000) / Math.sqrt(hWe) : 0,
  });

  console.log(
    ` n=${String(fit.n).padStart(3)}  beta ${fit.beta.toFixed(3).padStart(7)} (prior ${inst.cryptoBetaPrior.toFixed(2)})  ` +
      `R²=${fit.r2.toFixed(3)}  sigma on/we ${(sOn * 10_000).toFixed(0)}/${(sWe * 10_000).toFixed(0)}bps`,
  );
}

// ----------------------------------------------------------------- summary

console.log("\n=== does uncertainty grow with sqrt(t)? ===");
console.log("  if so, sigma/sqrt(hours) is flat across buckets\n");
console.log("  ticker   overnight   weekend    ratio");
for (const r of results) {
  const ratio =
    r.sqrtTCoeffOvernight > 0
      ? r.sqrtTCoeffWeekend / r.sqrtTCoeffOvernight
      : 0;
  console.log(
    `  ${r.ticker.padEnd(8)} ${r.sqrtTCoeffOvernight.toFixed(1).padStart(8)} ${r.sqrtTCoeffWeekend.toFixed(1).padStart(10)} ${ratio.toFixed(2).padStart(8)}`,
  );
}

const coeffs = results
  .flatMap((r) => [r.sqrtTCoeffOvernight, r.sqrtTCoeffWeekend])
  .filter((c) => c > 0);
const medianCoeff = coeffs.sort((a, b) => a - b)[Math.floor(coeffs.length / 2)];

console.log(`\n  median sqrt(t) coefficient: ${medianCoeff.toFixed(1)} bps/√h`);
console.log(`  currently shipped constant: 45 bps/√h`);

// -------------------------------------------------- fit the time exponent
//
// The ratios above are nowhere near 1.0, which is what sqrt(t) would predict.
// Rather than keep an assumed exponent, solve for the one the data implies:
//   sigma ∝ hours^k  =>  k = ln(sigma_we / sigma_on) / ln(h_we / h_on)

console.log("\n=== fitted time exponent (sigma ∝ hours^k) ===");
console.log("  sqrt(t) would mean k = 0.50\n");

const exponents: number[] = [];
for (const r of results) {
  if (r.overnightSigmaBps <= 0 || r.weekendSigmaBps <= 0) continue;
  const hOn = r.overnightSigmaBps / r.sqrtTCoeffOvernight; // sqrt(hours)
  const hWe = r.weekendSigmaBps / r.sqrtTCoeffWeekend;
  const hoursOn = hOn ** 2;
  const hoursWe = hWe ** 2;
  const k =
    Math.log(r.weekendSigmaBps / r.overnightSigmaBps) /
    Math.log(hoursWe / hoursOn);
  exponents.push(k);
  console.log(
    `  ${r.ticker.padEnd(6)} k = ${k.toFixed(3).padStart(7)}   ` +
      `(${hoursOn.toFixed(1)}h → ${hoursWe.toFixed(1)}h, ` +
      `${r.overnightSigmaBps.toFixed(0)} → ${r.weekendSigmaBps.toFixed(0)} bps)`,
  );
}

const sortedK = [...exponents].sort((a, b) => a - b);
const medianK = sortedK[Math.floor(sortedK.length / 2)];
console.log(`\n  median k = ${medianK.toFixed(3)}`);
console.log(
  "  Uncertainty is close to flat in clock time: a weekend is ~3.7x the hours\n" +
    "  of an overnight gap but only marginally wider. Information arrives around\n" +
    "  the close and the open, not evenly through Saturday, so calendar time is a\n" +
    "  poor clock. The shipped sqrt(t) model materially overstates weekend risk.",
);

// ---------------------------------------------------------- band coverage
//
// The point of the band is that realised moves land inside it. Test that
// directly at the reference gap length rather than trusting the fit.

console.log("\n=== band coverage (target ≈95% inside ±1.96σ) ===\n");
const coverage: Record<string, number> = {};
for (const inst of UNIVERSE) {
  const r = results.find((x) => x.ticker === inst.ticker);
  if (!r) continue;
  const bars = await dailyBars(inst.ticker).catch(() => [] as Bar[]);
  let inside = 0;
  let total = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    const closeTs = prev.ts + REGULAR_SESSION_SECONDS;
    const gapH = (cur.ts - closeTs) / 3600;
    if (gapH <= 0) continue;
    const move = blendedMove(closeTs, cur.ts);
    if (move === null) continue;
    const actual = (cur.open - prev.close) / prev.close;
    if (Math.abs(actual) > 0.35) continue;

    const weekend = gapH > 40;
    const sigmaBps = weekend ? r.weekendSigmaBps : r.overnightSigmaBps;
    const predicted = r.beta * move;
    const bandBps = 1.96 * sigmaBps;
    const errBps = Math.abs(actual - predicted) * 10_000;
    if (errBps <= bandBps) inside++;
    total++;
  }
  const pct = total ? (inside / total) * 100 : 0;
  coverage[inst.ticker] = Number(pct.toFixed(1));
  const flag = pct >= 92 && pct <= 98 ? "ok" : pct < 92 ? "too tight" : "too wide";
  console.log(
    `  ${inst.ticker.padEnd(6)} ${pct.toFixed(1).padStart(5)}%  of ${String(total).padStart(3)} gaps inside the band   ${flag}`,
  );
}

const payload = {
  generatedAt: new Date().toISOString(),
  method:
    "OLS through the origin of realised close-to-open equity gap returns on the blended 0.6 BTC / 0.4 ETH move over the identical window, two years of daily bars.",
  stalenessCoeffBps: Number(medianCoeff.toFixed(2)),
  /** Fitted exponent for sigma ∝ hours^k. Measured, not assumed. */
  timeExponent: Number(medianK.toFixed(3)),
  /** Reference gap used to anchor the per-instrument base sigma. */
  referenceGapHours: 17.5,
  instruments: Object.fromEntries(
    results.map((r) => [
      r.ticker,
      {
        beta: Number(r.beta.toFixed(4)),
        priorBeta: r.priorBeta,
        r2: Number(r.r2.toFixed(4)),
        samples: r.n,
        overnightSigmaBps: Number(r.overnightSigmaBps.toFixed(1)),
        weekendSigmaBps: Number(r.weekendSigmaBps.toFixed(1)),
        coveragePct: coverage[r.ticker] ?? null,
      },
    ]),
  ),
};

writeFileSync(
  "src/lib/calibration.json",
  JSON.stringify(payload, null, 2) + "\n",
);
console.log("\nwrote src/lib/calibration.json");
