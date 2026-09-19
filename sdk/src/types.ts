/**
 * The vocabulary. These are the whole point of the oracle.
 *
 * Every other equity feed hands you a number. This one hands you a number, how
 * it was obtained, and how much to trust it right now — and those two extra
 * fields are useless if an integrator has to guess the enum ordering from a
 * docs page. Hence a package.
 *
 * The numeric values are consensus with HoodOracle.sol and must not be
 * reordered. `scripts/sdktest.mts` in the repo asserts they still match the
 * server's own enums.
 */

/** Which part of the US equity trading day the quote was taken in. */
export enum Session {
  /** 09:30-16:00 ET. Real price discovery. */
  REGULAR = 0,
  /** 04:00-09:30 ET. Thin but real. */
  PRE = 1,
  /** 16:00-20:00 ET. Thin but real. */
  POST = 2,
  /** Overnight and weekend. No discovery at all. */
  CLOSED = 3,
  /** NYSE holiday. No discovery at all. */
  HOLIDAY = 4,
}

/** How the price was actually obtained. Read this before you settle on it. */
export enum Provenance {
  /** An observed print from a live session. The only value safe to liquidate on. */
  TRADED = 0,
  /** The tape was shut. Last close, drifted against a 24/7 proxy. A model output. */
  DERIVED = 1,
  /** No usable anchor. The last known value, unmodelled. */
  STALE = 2,
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

/** Prices are carried on-chain as integers with this many decimals. */
export const PRICE_DECIMALS = 8;

/**
 * A quote exactly as the contract stores it.
 *
 * Integers throughout, because that is what is on chain and because the band
 * arithmetic has to be exact. `toDecimal()` converts for display; do not
 * convert before comparing.
 */
export interface OnChainQuote {
  /** 8 decimals. 12000000000n is $120.00. */
  price: bigint;
  /** Two-sided band, in basis points. 424n is ±4.24%. */
  confidenceBps: bigint;
  session: Session;
  provenance: Provenance;
  /** How many independent upstreams agreed on the anchor. */
  sourceCount: number;
  /** Spread between the highest and lowest source, in bps. */
  maxDeviationBps: bigint;
  /** Unix seconds of the last on-tape print. */
  lastTradeTime: bigint;
  /** Unix seconds the quote was computed. */
  publishTime: bigint;
}

/** The richer shape the HTTP API returns, before it is packed for the chain. */
export interface ApiQuote {
  ticker: string;
  price: number;
  anchorPrice: number;
  confidenceBps: number;
  session: Session;
  provenance: Provenance;
  sourceCount: number;
  maxDeviationBps: number;
  lastTradeTime: number;
  publishTime: number;
  stalenessSeconds: number;
  method: string;
  driftBps: number;
  nextSessionInSeconds: number;
  nextSession: Session;
}

/** An API quote with the signature that makes it postable on chain. */
export interface SignedQuote {
  quote: ApiQuote;
  /** EIP-191 signature over the quote digest. */
  signature: `0x${string}`;
  /** The address that produced it. Check this against the contract's allow list. */
  signer: `0x${string}`;
  /** The digest that was signed, for independent verification. */
  digest: `0x${string}`;
}

/** Convert an 8-decimal integer price to a JS number. Display only. */
export function toDecimal(price: bigint): number {
  return Number(price) / 10 ** PRICE_DECIMALS;
}

/** Convert a JS number to the 8-decimal integer the contract expects. */
export function toScaled(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`cannot scale ${value} as a price`);
  }
  // Through a string, so the eighth decimal is not decided by float drift.
  const [whole, frac = ""] = value.toFixed(PRICE_DECIMALS).split(".");
  return (
    BigInt(whole) * 10n ** BigInt(PRICE_DECIMALS) +
    BigInt(frac.padEnd(PRICE_DECIMALS, "0"))
  );
}
