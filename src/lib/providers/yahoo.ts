// Yahoo Finance chart endpoint.
//
// No key required, and it reports a genuine regularMarketTime rather than fetch
// time, which makes it the most useful free source for establishing freshness.
//
// Terms: unofficial. Yahoo does not license this endpoint for commercial
// redistribution. Fine for building and evaluation, not a production source.
// It is marked "unofficial" so that limitation travels with the data.

import { assertPrice, getJson, ProviderError, type Provider, type Reading } from "./types";

interface YahooChart {
  chart: {
    result?: {
      meta: {
        regularMarketPrice?: number;
        regularMarketTime?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketVolume?: number;
        fulldayPrice?: number;
        postMarketPrice?: number;
        preMarketPrice?: number;
      };
    }[];
    error?: { description?: string } | null;
  };
}

export const yahoo: Provider = {
  key: "yahoo",
  label: "Yahoo Finance",
  enabled: true,
  reportsTradeTime: true,
  terms: "unofficial",

  async fetch(symbol: string): Promise<Reading> {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&range=1d`;
    const data = await getJson<YahooChart>("yahoo", url);

    const result = data.chart.result?.[0];
    if (!result) {
      throw new ProviderError(
        "yahoo",
        data.chart.error?.description ?? `no result for ${symbol}`,
      );
    }

    const m = result.meta;
    const price = assertPrice("yahoo", m.regularMarketPrice, symbol);

    // regularMarketTime is the last regular-session print, not a fetch stamp.
    const t = m.regularMarketTime;
    const lastTradeTime = typeof t === "number" && t > 0 ? t : null;

    return {
      source: "yahoo",
      price,
      lastTradeTime,
      extendedPrice:
        m.postMarketPrice ?? m.preMarketPrice ?? m.fulldayPrice ?? undefined,
      previousClose: m.chartPreviousClose ?? m.previousClose,
      volume: m.regularMarketVolume,
    };
  },
};
