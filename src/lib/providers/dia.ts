// DIA RWA endpoint.
//
// Disabled by default. DIA's own configuration documents the free tier as
// evaluation-only, and their RWA endpoint stamps some tickers with fetch time
// rather than print time, so it cannot be used to establish freshness.
// Set DIA_ENABLED=true to include it as a cross-check.

import { assertPrice, getJson, type Provider, type Reading } from "./types";

// Fixed: DIA is an optional cross-check, not a configurable upstream.
const BASE = "https://api.diadata.org";
const ENABLED = process.env.DIA_ENABLED === "true";

interface DiaRwa {
  Ticker: string;
  Price: number;
  Timestamp: string;
}

export const dia: Provider = {
  key: "dia",
  label: "DIA",
  enabled: ENABLED,
  disabledReason: ENABLED
    ? undefined
    : "off by default: DIA's free tier is evaluation-only. set DIA_ENABLED=true to include",
  // DIA stamps fetch time for several tickers, so its timestamps are not
  // trustworthy as print times.
  reportsTradeTime: false,
  terms: "evaluation-only",

  async fetch(symbol: string): Promise<Reading> {
    const url = `${BASE}/v1/rwa/Equities/${encodeURIComponent(symbol)}`;
    const data = await getJson<DiaRwa>("dia", url);
    const price = assertPrice("dia", data.Price, symbol);
    return { source: "dia", price, lastTradeTime: null };
  },
};
