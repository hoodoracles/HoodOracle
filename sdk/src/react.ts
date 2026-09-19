/**
 * React bindings.
 *
 * A separate entry point (`@hoodoracle/sdk/react`) so the core package stays
 * usable from a bot or a backend without React anywhere near it.
 *
 * Deliberately small. These poll and expose state; they do not own a wallet,
 * a query cache or a context provider, because a consumer who already has
 * TanStack Query or wagmi should be using those and calling the core client
 * directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchQuote, type ApiOptions } from "./api.js";
import { HoodOracle, type HoodOracleOptions } from "./client.js";
import { band, check, type Policy, type Verdict } from "./band.js";
import type { OnChainQuote, SignedQuote } from "./types.js";

export interface QuoteState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Re-fetch now, outside the poll schedule. */
  refresh: () => void;
}

/**
 * Poll the signed HTTP quote.
 *
 * 20s by default, matching the dashboard. Polling rather than streaming
 * because the underlying value changes on a scheduler, not a socket, and a
 * websocket would be a connection to keep alive for data that mostly does not
 * move — a weekend price is unchanged for 62 hours.
 */
export function useQuote(
  ticker: string,
  options: ApiOptions & { pollMs?: number } = {},
): QuoteState<SignedQuote> {
  const { pollMs = 20_000, ...api } = options;
  const [data, setData] = useState<SignedQuote | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Held in a ref so a caller passing an object literal for `options` does
  // not re-subscribe on every render.
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let live = true;
    const controller = new AbortController();

    async function load() {
      try {
        const q = await fetchQuote(ticker, {
          ...apiRef.current,
          signal: controller.signal,
        });
        if (!live) return;
        setData(q);
        setError(null);
      } catch (e) {
        if (!live || controller.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (live) setLoading(false);
      }
    }

    void load();
    const id = pollMs > 0 ? setInterval(() => void load(), pollMs) : undefined;
    return () => {
      live = false;
      controller.abort();
      if (id) clearInterval(id);
    };
  }, [ticker, pollMs, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refresh };
}

/** Poll the on-chain quote, with a policy verdict and the band alongside. */
export function useOnChainQuote(
  ticker: string,
  options: HoodOracleOptions & { pollMs?: number; policy?: Policy } = {},
): QuoteState<OnChainQuote> & {
  verdict: Verdict | null;
  bounds: { lower: bigint; upper: bigint } | null;
} {
  const { pollMs = 30_000, policy, ...clientOptions } = options;
  const [data, setData] = useState<OnChainQuote | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const optionsRef = useRef(clientOptions);
  optionsRef.current = clientOptions;

  // Keyed on the values that actually change identity, so a fresh options
  // object on each render does not rebuild the transport.
  const oracle = useMemo(
    () => new HoodOracle(optionsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clientOptions.address, clientOptions.rpcUrl, clientOptions.chain?.id],
  );

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const q = await oracle.getQuote(ticker);
        if (!live) return;
        setData(q);
        setError(null);
      } catch (e) {
        if (!live) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (live) setLoading(false);
      }
    }
    void load();
    const id = pollMs > 0 ? setInterval(() => void load(), pollMs) : undefined;
    return () => {
      live = false;
      if (id) clearInterval(id);
    };
  }, [oracle, ticker, pollMs, nonce]);

  const verdict = data ? check(data, policy) : null;
  const bounds = data ? band(data) : null;
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, refresh, verdict, bounds };
}
