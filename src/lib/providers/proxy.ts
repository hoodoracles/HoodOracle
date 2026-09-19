// The 24/7 risk proxy.
//
// Crypto is the only liquid thing still trading through a US weekend, so it is
// the proxy of last resort for drifting a stale equity close.
//
// An earlier version took a 24h return and scaled it by gapHours/24, which was
// a fudge in two directions: it assumed the move was distributed evenly across
// the day, and it stopped accumulating past 24 hours. Pulling the hourly series
// instead lets us measure the proxy's move over exactly the window the equity
// tape was shut, which is the quantity the model actually wants.

import { cached } from "../cache";
import { getJson, ProviderError } from "./types";

export interface ProxySeries {
  key: string;
  label: string;
  /** [unixSeconds, price], ascending. */
  points: [number, number][];
  latest: number;
  weight: number;
}

interface YahooSeries {
  chart: {
    result?: {
      timestamp?: number[];
      indicators: { quote: { close?: (number | null)[] }[] };
      meta: { regularMarketPrice?: number };
    }[];
  };
}

const PROXY_DEFS = [
  { key: "BTC", label: "Bitcoin", symbol: "BTC-USD", weight: 0.6 },
  { key: "ETH", label: "Ether", symbol: "ETH-USD", weight: 0.4 },
];

const TTL_MS = 60_000;

export function fetchProxies(): Promise<ProxySeries[]> {
  return cached("proxy-series", TTL_MS, fetchProxiesUncached);
}

async function fetchProxiesUncached(): Promise<ProxySeries[]> {
  const settled = await Promise.allSettled(
    PROXY_DEFS.map(async (d): Promise<ProxySeries> => {
      // 7 days of hourly closes covers any weekend or holiday gap.
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${d.symbol}` +
        `?interval=1h&range=7d`;
      const raw = await getJson<YahooSeries>("proxy", url);
      const r = raw.chart.result?.[0];
      if (!r?.timestamp) throw new ProviderError("proxy", `no series for ${d.symbol}`);

      const closes = r.indicators.quote[0]?.close ?? [];
      const points: [number, number][] = [];
      r.timestamp.forEach((t, i) => {
        const c = closes[i];
        if (typeof c === "number" && Number.isFinite(c) && c > 0) {
          points.push([t, c]);
        }
      });

      if (points.length < 2) {
        throw new ProviderError("proxy", `series too short for ${d.symbol}`);
      }

      const latest = r.meta.regularMarketPrice ?? points[points.length - 1][1];
      return { key: d.key, label: d.label, points, latest, weight: d.weight };
    }),
  );

  return settled
    .filter(
      (s): s is PromiseFulfilledResult<ProxySeries> => s.status === "fulfilled",
    )
    .map((s) => s.value);
}

/**
 * The proxy's fractional move from `sinceUnix` to now.
 *
 * Returns 0 when the series does not reach back that far, rather than
 * extrapolating: a drift we cannot observe is a drift we do not apply.
 */
export function moveSince(series: ProxySeries, sinceUnix: number): number {
  const before = series.points.filter((p) => p[0] <= sinceUnix);
  if (before.length === 0) return 0;
  const anchor = before[before.length - 1][1];
  if (!(anchor > 0)) return 0;
  return (series.latest - anchor) / anchor;
}

/** Weighted blend of each proxy's move over the same window. */
export function blendedMoveSince(
  proxies: ProxySeries[],
  sinceUnix: number,
): number {
  const total = proxies.reduce((a, p) => a + p.weight, 0);
  if (total === 0) return 0;
  return (
    proxies.reduce((a, p) => a + moveSince(p, sinceUnix) * p.weight, 0) / total
  );
}

/** Realised volatility of the blend over the last `hours`, as a fraction. */
export function recentVolatility(proxies: ProxySeries[], hours = 24): number {
  if (proxies.length === 0) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  const p = proxies[0];
  const window = p.points.filter((x) => x[0] >= cutoff).map((x) => x[1]);
  if (window.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < window.length; i++) {
    rets.push((window[i] - window[i - 1]) / window[i - 1]);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  // Scale the hourly standard deviation up to the window length.
  return Math.sqrt(variance) * Math.sqrt(rets.length);
}
