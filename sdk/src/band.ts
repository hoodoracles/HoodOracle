/**
 * Band arithmetic and the policies built on it.
 *
 * This file is the reason the package exists. A consumer who only wants a
 * number can read `getPrice` and skip all of it; a consumer who wants to not
 * be wrong on a Sunday needs the band, the provenance and the session, and
 * needs to combine them the same way the contract does.
 *
 * Everything here is integer arithmetic on the 8-decimal on-chain price,
 * mirroring HoodOracle.getBandedPrice. Converting to a float first is not
 * merely imprecise, it changes answers: 100 * (1 + 50/10_000) evaluates to
 * 100.49999999999999, so a price sitting exactly on a ±0.50% edge falls the
 * wrong side of the comparison.
 */

import { Provenance, Session, type OnChainQuote } from "./types.js";

/** The two-sided interval, as integers. */
export function band(q: Pick<OnChainQuote, "price" | "confidenceBps">): {
  lower: bigint;
  upper: bigint;
} {
  const adj = (q.price * q.confidenceBps) / 10_000n;
  return { lower: q.price - adj, upper: q.price + adj };
}

/**
 * The cautious edge, for valuing a position.
 *
 * Valuing *collateral* takes the lower edge: if the true price is anywhere in
 * the band, assume the borrower has less than they claim. Valuing *debt* takes
 * the upper edge, for the same reason in the other direction. Getting this
 * backwards is the classic way to turn an honest band into extra leverage.
 */
export function conservativePrice(
  q: Pick<OnChainQuote, "price" | "confidenceBps">,
  kind: "collateral" | "debt",
): bigint {
  const b = band(q);
  return kind === "collateral" ? b.lower : b.upper;
}

/** True when trades could actually print in this session. */
export function isTradingSession(s: Session): boolean {
  return s === Session.REGULAR || s === Session.PRE || s === Session.POST;
}

/**
 * How old a quote may be, by default, when an observed print is required.
 *
 * The oracle's own `maxQuoteAge`: it will not accept a quote older than this,
 * so nothing older can have been posted as fresh. The contract does not apply
 * it on read, though — `getPriceIfTraded` and `isLive` check provenance, not
 * age — so a relayer that stops leaves its last TRADED quote reading as live
 * indefinitely. On 21–23 Sep 2026 that was a Monday morning print, served for
 * 42 hours through two closes. A live print with no age limit is not a live
 * print, so the default path carries one.
 */
export const DEFAULT_TRADED_MAX_AGE = 1800;

export interface Policy {
  /** Widest band still acceptable, in bps. Omit for no ceiling. */
  maxBps?: number;
  /**
   * Reject a quote whose publishTime is older than this many seconds.
   * Defaults to DEFAULT_TRADED_MAX_AGE while `requireTraded` is on, and to
   * no limit when it is off. Pass `Infinity` to opt out explicitly.
   */
  maxAgeSeconds?: number;
  /**
   * Require an observed print. Defaults to true, which is the safe default:
   * an integrator who has not thought about provenance should get the
   * conservative behaviour rather than a modelled weekend price.
   */
  requireTraded?: boolean;
  /** Minimum independent upstreams behind the anchor. */
  minSources?: number;
  /** Clock to compare publishTime against. Defaults to now. */
  now?: number;
}

export interface Verdict {
  ok: boolean;
  /** Every reason it failed, not just the first. */
  reasons: string[];
}

/**
 * Check a quote against a policy.
 *
 * Returns every failed condition rather than short-circuiting, because when a
 * feed stops being usable at 3am the operator wants the whole picture in one
 * log line, not to fix one condition and rerun to discover the next.
 */
export function check(q: OnChainQuote, policy: Policy = {}): Verdict {
  const {
    maxBps,
    requireTraded = true,
    maxAgeSeconds = requireTraded ? DEFAULT_TRADED_MAX_AGE : undefined,
    minSources,
    now = Math.floor(Date.now() / 1000),
  } = policy;
  const reasons: string[] = [];

  if (q.publishTime === 0n) reasons.push("no quote has ever been posted");

  if (requireTraded && q.provenance !== Provenance.TRADED) {
    reasons.push(
      q.provenance === Provenance.DERIVED
        ? "provenance is DERIVED: the tape was shut and this price is a model output, not an observed print"
        : "provenance is STALE: no usable anchor, this is just the last known value",
    );
  }

  if (maxBps !== undefined && q.confidenceBps > BigInt(maxBps)) {
    reasons.push(
      `band is ±${(Number(q.confidenceBps) / 100).toFixed(2)}%, wider than the ±${(maxBps / 100).toFixed(2)}% limit`,
    );
  }

  if (maxAgeSeconds !== undefined && q.publishTime !== 0n) {
    const age = now - Number(q.publishTime);
    if (age > maxAgeSeconds) {
      reasons.push(`quote is ${age}s old, older than the ${maxAgeSeconds}s limit`);
    }
  }

  if (minSources !== undefined && q.sourceCount < minSources) {
    reasons.push(
      `only ${q.sourceCount} source${q.sourceCount === 1 ? "" : "s"} behind the anchor, ${minSources} required`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}

export class QuoteRejected extends Error {
  readonly reasons: string[];
  constructor(ticker: string, reasons: string[]) {
    super(`hoodoracle: ${ticker} rejected — ${reasons.join("; ")}`);
    this.name = "QuoteRejected";
    this.reasons = reasons;
  }
}

/**
 * Return the price, or throw with the reasons.
 *
 * The throwing form exists so the safe path is the short one. Code that reads
 * a price and checks it afterwards tends to grow a branch that forgets, and
 * the forgetting is silent; code that has to catch cannot forget.
 */
export function priceOrThrow(
  ticker: string,
  q: OnChainQuote,
  policy: Policy = {},
): bigint {
  const v = check(q, policy);
  if (!v.ok) throw new QuoteRejected(ticker, v.reasons);
  return q.price;
}

/** Seconds since the quote was computed. */
export function ageSeconds(q: OnChainQuote, now = Date.now() / 1000): number {
  return Math.max(0, Math.floor(now) - Number(q.publishTime));
}

/** Plain-language reading of a band width, matching the site's thresholds. */
export function describeBand(bps: number | bigint): string {
  const n = Number(bps);
  if (n <= 120) return "tight enough to settle against";
  if (n <= 220) return "ordinary";
  if (n <= 330) return "wide — size down";
  return "very wide — do not settle";
}
