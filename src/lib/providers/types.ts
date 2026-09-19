// Provider interface.
//
// Sourcing is pluggable so the system does not rest on any single upstream.
// Earlier builds called DIA directly, which made their terms and their uptime
// our terms and our uptime. Now DIA is one optional provider among several and
// the oracle runs with it switched off entirely.

export interface Reading {
  /** Provider key, e.g. "yahoo". */
  source: string;
  price: number;
  /**
   * Unix seconds of the last actual print, where the provider reports one.
   * null when the provider only stamps fetch time, which must not be mistaken
   * for a print time.
   */
  lastTradeTime: number | null;
  /** Extended-hours price, where the provider distinguishes it. */
  extendedPrice?: number;
  /** Previous session close, used for sanity checks. */
  previousClose?: number;
  volume?: number;
}

export interface Provider {
  key: string;
  label: string;
  /** False when the provider needs a key that is not configured. */
  enabled: boolean;
  /** Why it is disabled, for the health endpoint. */
  disabledReason?: string;
  /**
   * True when this provider reports genuine last-trade times. Providers that
   * only stamp fetch time cannot be used to establish freshness.
   */
  reportsTradeTime: boolean;
  /** Commercial terms, surfaced so the limitation is never invisible. */
  terms: "open" | "free-tier" | "evaluation-only" | "unofficial";
  fetch(symbol: string): Promise<Reading>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

/** Shared guarded JSON fetch. */
export async function getJson<T>(
  provider: string,
  url: string,
  init?: RequestInit,
  timeoutMs = 12_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        accept: "application/json",
        // Some public endpoints reject a default agent outright.
        "user-agent": "Mozilla/5.0 (compatible; hoodoracle/0.1)",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new ProviderError(provider, `http ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      provider,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Reject the null-result shapes upstreams use for unsupported symbols. */
export function assertPrice(
  provider: string,
  price: unknown,
  symbol: string,
): number {
  const n = typeof price === "number" ? price : Number(price);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ProviderError(
      provider,
      `no usable price for ${symbol} (got ${String(price)})`,
    );
  }
  return n;
}
