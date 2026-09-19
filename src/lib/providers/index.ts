// Provider registry and aggregation.

import { cached } from "../cache";
import { dia } from "./dia";
import { alpaca, finnhub, twelvedata } from "./keyed";
import { ProviderError, type Provider, type Reading } from "./types";
import { yahoo } from "./yahoo";

export * from "./types";

export const ALL_PROVIDERS: Provider[] = [
  yahoo,
  alpaca,
  finnhub,
  twelvedata,
  dia,
];

export function enabledProviders(): Provider[] {
  return ALL_PROVIDERS.filter((p) => p.enabled);
}

export interface Consensus {
  /** Median across sources. Median rather than mean so one bad feed cannot drag it. */
  price: number;
  readings: Reading[];
  failures: { source: string; error: string }[];
  /** Spread between the highest and lowest reading, in bps. */
  maxDeviationBps: number;
  /**
   * Best available last-trade time: the newest among providers that actually
   * report print times. null when no provider does, in which case the caller
   * must fall back to the exchange calendar.
   */
  lastTradeTime: number | null;
  /** How many independent sources contributed. */
  sourceCount: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const TTL_MS = 20_000;

/** Query every enabled provider and reconcile into one consensus reading. */
export function fetchConsensus(symbol: string): Promise<Consensus> {
  return cached(`consensus:${symbol}`, TTL_MS, () =>
    fetchConsensusUncached(symbol),
  );
}

async function fetchConsensusUncached(symbol: string): Promise<Consensus> {
  const providers = enabledProviders();
  if (providers.length === 0) {
    throw new Error(
      "no providers enabled. Yahoo is on by default; check network access.",
    );
  }

  const settled = await Promise.allSettled(
    providers.map((p) => p.fetch(symbol)),
  );

  const readings: Reading[] = [];
  const failures: { source: string; error: string }[] = [];

  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      readings.push(r.value);
    } else {
      const e = r.reason;
      failures.push({
        source: providers[i].key,
        error:
          e instanceof ProviderError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  });

  if (readings.length === 0) {
    throw new Error(
      `every provider failed for ${symbol}: ${failures
        .map((f) => f.error)
        .join("; ")}`,
    );
  }

  const prices = readings.map((r) => r.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const maxDeviationBps = lo > 0 ? ((hi - lo) / lo) * 10_000 : 0;

  // Only providers that genuinely report print times may establish freshness.
  const tradeTimes = readings
    .filter((r) => {
      const p = providers.find((x) => x.key === r.source);
      return p?.reportsTradeTime && r.lastTradeTime !== null;
    })
    .map((r) => r.lastTradeTime as number);

  return {
    price: median(prices),
    readings,
    failures,
    maxDeviationBps,
    lastTradeTime: tradeTimes.length ? Math.max(...tradeTimes) : null,
    sourceCount: readings.length,
  };
}

export * from "./proxy";
