/**
 * The HTTP side: signed quotes, fresher than whatever is on chain.
 *
 * The on-chain value is only as current as the last relay. The API signs on
 * demand, so a consumer that needs the newest possible number fetches here,
 * verifies the signature locally, and either uses it off-chain or relays it
 * themselves with `HoodOracle.postQuote`.
 *
 * A signature is what makes that safe. Without it this is just an HTTP
 * endpoint you have to trust; with it, the quote carries the same
 * authentication the contract checks, and `verifyQuote` lets you confirm it
 * without a network call.
 */

import { DEFAULT_API_URL } from "./chain.js";
import { verifyQuote } from "./verify.js";
import type { SignedQuote } from "./types.js";

export interface ApiOptions {
  baseUrl?: string;
  /** Pass your own fetch for timeouts, retries, or a proxy. */
  fetch?: typeof globalThis.fetch;
  /**
   * Verify the signature before returning. On by default: an unverified
   * signed quote is strictly worse than an unsigned one, because it looks
   * trustworthy.
   */
  verify?: boolean;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`hoodoracle api: ${message}`);
    this.name = "ApiError";
    this.status = status;
  }
}

async function get<T>(path: string, options: ApiOptions): Promise<T> {
  const f = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
  const res = await f(`${base}${path}`, {
    signal: options.signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = `${res.status} ${body.error}`;
    } catch {
      /* a non-JSON error body is still an error */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

/** One signed quote, fresh. */
export async function fetchQuote(
  ticker: string,
  options: ApiOptions = {},
): Promise<SignedQuote> {
  const body = await get<SignedQuote>(
    `/api/quote/${encodeURIComponent(ticker)}`,
    options,
  );
  if (options.verify !== false) {
    const ok = await verifyQuote(body);
    if (!ok) {
      throw new ApiError(
        200,
        `signature on ${ticker} did not verify against ${body.signer}`,
      );
    }
  }
  return body;
}

/** Every tracked instrument in one call. Unsigned: a board, not a settlement input. */
export async function fetchBoard(options: ApiOptions = {}): Promise<{
  asOf: string;
  market: { session: string; nextSession: string; changesIn: string };
  quotes: {
    ticker: string;
    price: number;
    confidenceBps: number;
    sessionName: string;
    provenanceName: string;
  }[];
}> {
  return get("/api/quotes", options);
}

/** The published track record. See /coverage. */
export async function fetchCoverage(options: ApiOptions = {}): Promise<{
  atReopen: {
    n: number;
    hits: number;
    coveragePct: number | null;
    ci: { lower: number; upper: number } | null;
  };
  perTicker: Record<string, { n: number; hits: number; coveragePct: number | null }>;
  nominalPct: number;
}> {
  return get("/api/coverage", options);
}
