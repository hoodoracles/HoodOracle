// Core types for the hoodoracle quote pipeline.

/** Which part of the US equity trading day a timestamp falls in. */
export enum Session {
  REGULAR = 0, // 09:30-16:00 ET, real price discovery
  PRE = 1, // 04:00-09:30 ET, thin but real
  POST = 2, // 16:00-20:00 ET, thin but real
  CLOSED = 3, // overnight + weekend, no discovery
  HOLIDAY = 4, // NYSE holiday, no discovery
}

/** How the price we are serving was actually obtained. */
export enum Provenance {
  TRADED = 0, // observed print from a live session
  DERIVED = 1, // modelled from last close + a still-trading proxy
  STALE = 2, // no usable anchor, last known value only
}

export const SESSION_NAME: Record<Session, string> = {
  [Session.REGULAR]: "REGULAR",
  [Session.PRE]: "PRE",
  [Session.POST]: "POST",
  [Session.CLOSED]: "CLOSED",
  [Session.HOLIDAY]: "HOLIDAY",
};

export const PROVENANCE_NAME: Record<Provenance, string> = {
  [Provenance.TRADED]: "TRADED",
  [Provenance.DERIVED]: "DERIVED",
  [Provenance.STALE]: "STALE",
};

/** A fully classified quote, ready to sign and publish. */
export interface Quote {
  ticker: string;
  /** Price in USD. */
  price: number;
  /** Anchor price actually observed on-tape (pre-derivation). */
  anchorPrice: number;
  /** Two-sided uncertainty band, in basis points. */
  confidenceBps: number;
  session: Session;
  provenance: Provenance;
  /** How many independent upstream sources agreed. */
  sourceCount: number;
  /** Spread between the highest and lowest source, in bps. */
  maxDeviationBps: number;
  /** Unix seconds of the last on-tape print we could find. */
  lastTradeTime: number;
  /** Unix seconds this quote was computed. */
  publishTime: number;
  /** Seconds since the anchor print. */
  stalenessSeconds: number;
  /** Human-readable note on how the number was reached. */
  method: string;
  /** Proxy adjustment applied during derivation, in bps. Zero when TRADED. */
  driftBps: number;
  /** Seconds until the next session change. */
  nextSessionInSeconds: number;
  nextSession: Session;
}

/** A quote plus its signature, as returned by the API. */
export interface SignedQuote {
  quote: Quote;
  /** EIP-191 signature over the abi-encoded quote digest. */
  signature: `0x${string}`;
  /** Address that produced the signature. */
  signer: `0x${string}`;
  /** The digest that was signed, for independent verification. */
  digest: `0x${string}`;
}

export interface SourceReading {
  source: string;
  price: number;
  timestamp: number;
}
