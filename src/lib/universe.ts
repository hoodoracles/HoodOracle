// The instruments hoodoracle tracks, and what we use to model them off-hours.

export interface Instrument {
  ticker: string;
  name: string;
  kind: "equity" | "etf" | "crypto";
  /**
   * The original hand-chosen prior for this name's sensitivity to the crypto
   * proxy.
   *
   * SUPERSEDED. The engine now reads the fitted beta from calibration.json,
   * produced by `npm run calibrate` against two years of realised gaps. Every
   * prior here turned out to be too low except AAPL and TLT. Kept only so the
   * calibration report can show what changed.
   */
  cryptoBetaPrior: number;
  blurb: string;
}

export const UNIVERSE: Instrument[] = [
  {
    ticker: "HOOD",
    name: "Robinhood Markets Inc.",
    kind: "equity",
    cryptoBetaPrior: 0.45,
    blurb:
      "The reference name for this oracle. Crypto-exposed brokerage, so it carries real overnight sensitivity to the 24/7 proxy.",
  },
  {
    ticker: "COIN",
    name: "Coinbase Global Inc.",
    kind: "equity",
    cryptoBetaPrior: 0.6,
    blurb: "Highest crypto beta in the equity universe.",
  },
  {
    ticker: "NVDA",
    name: "NVIDIA Corporation",
    kind: "equity",
    cryptoBetaPrior: 0.2,
    blurb: "High-beta tech, weak but non-zero overnight crypto correlation.",
  },
  {
    ticker: "TSLA",
    name: "Tesla Inc.",
    kind: "equity",
    cryptoBetaPrior: 0.25,
    blurb: "Retail-heavy flow, moves with risk appetite.",
  },
  {
    ticker: "AAPL",
    name: "Apple Inc.",
    kind: "equity",
    cryptoBetaPrior: 0.12,
    blurb: "Mega-cap defensive. Low overnight drift.",
  },
  {
    ticker: "MSTR",
    name: "MicroStrategy Inc.",
    kind: "equity",
    cryptoBetaPrior: 0.8,
    blurb:
      "Effectively a levered bitcoin holding, so the overnight proxy is unusually informative here.",
  },
  {
    ticker: "SPY",
    name: "S&P 500 ETF Trust",
    kind: "etf",
    cryptoBetaPrior: 0.15,
    blurb: "Broad market benchmark.",
  },
  {
    ticker: "TLT",
    name: "20+ Year Treasury Bond ETF",
    kind: "etf",
    cryptoBetaPrior: 0.0,
    blurb: "Rates instrument. No crypto drift applied.",
  },
];

export function findInstrument(ticker: string): Instrument | undefined {
  return UNIVERSE.find((i) => i.ticker === ticker.toUpperCase());
}
