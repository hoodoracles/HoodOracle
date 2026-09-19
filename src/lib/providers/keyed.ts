// Providers that need a free API key.
//
// Each is enabled only when its key is present, so the oracle degrades to
// whatever is configured rather than failing. Keys are free to obtain and take
// a couple of minutes; none require a commercial agreement.

import { assertPrice, getJson, type Provider, type Reading } from "./types";

// ---------------------------------------------------------------- finnhub
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

interface FinnhubQuote {
  c: number; // current
  pc: number; // previous close
  t: number; // unix seconds of last trade
}

export const finnhub: Provider = {
  key: "finnhub",
  label: "Finnhub",
  enabled: Boolean(FINNHUB_KEY),
  disabledReason: FINNHUB_KEY ? undefined : "set FINNHUB_API_KEY (free at finnhub.io)",
  reportsTradeTime: true,
  terms: "free-tier",

  async fetch(symbol: string): Promise<Reading> {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
    const d = await getJson<FinnhubQuote>("finnhub", url);
    return {
      source: "finnhub",
      price: assertPrice("finnhub", d.c, symbol),
      lastTradeTime: typeof d.t === "number" && d.t > 0 ? d.t : null,
      previousClose: d.pc > 0 ? d.pc : undefined,
    };
  },
};

// ------------------------------------------------------------ twelve data
const TWELVE_KEY = process.env.TWELVEDATA_API_KEY;

interface TwelveQuote {
  price?: string;
  code?: number;
  message?: string;
}

export const twelvedata: Provider = {
  key: "twelvedata",
  label: "Twelve Data",
  enabled: Boolean(TWELVE_KEY),
  disabledReason: TWELVE_KEY
    ? undefined
    : "set TWELVEDATA_API_KEY (free at twelvedata.com)",
  reportsTradeTime: false,
  terms: "free-tier",

  async fetch(symbol: string): Promise<Reading> {
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVE_KEY}`;
    const d = await getJson<TwelveQuote>("twelvedata", url);
    return {
      source: "twelvedata",
      price: assertPrice("twelvedata", d.price, symbol),
      lastTradeTime: null,
    };
  },
};

// ----------------------------------------------------------------- alpaca
const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_API_SECRET;

interface AlpacaTrade {
  trade?: { p: number; t: string };
}

export const alpaca: Provider = {
  key: "alpaca",
  label: "Alpaca (IEX)",
  enabled: Boolean(ALPACA_KEY && ALPACA_SECRET),
  disabledReason:
    ALPACA_KEY && ALPACA_SECRET
      ? undefined
      : "set ALPACA_API_KEY and ALPACA_API_SECRET (free at alpaca.markets)",
  reportsTradeTime: true,
  terms: "free-tier",

  async fetch(symbol: string): Promise<Reading> {
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`;
    const d = await getJson<AlpacaTrade>("alpaca", url, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_KEY ?? "",
        "APCA-API-SECRET-KEY": ALPACA_SECRET ?? "",
      },
    });
    const ms = d.trade?.t ? Date.parse(d.trade.t) : NaN;
    return {
      source: "alpaca",
      price: assertPrice("alpaca", d.trade?.p, symbol),
      lastTradeTime: Number.isFinite(ms) ? Math.floor(ms / 1000) : null,
    };
  },
};
