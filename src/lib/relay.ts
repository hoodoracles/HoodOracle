// What the relayer considers worth a transaction, and what "the feed has
// stopped" means.
//
// Shared by /api/cron/publish, which acts on it, and /api/health, which alarms
// on it. They used to be separate, and the health check had no opinion about
// the chain at all: from Sunday 20 Sep 11:00 UTC the scheduler stopped calling
// the relayer, the on-chain quotes froze, and /api/health answered "ok" for
// 42 hours. The frozen quotes were TRADED, so getPriceIfTraded went on serving
// Monday morning's print through two closes. Nothing could have alerted on it.

import { Provenance, Session, PROVENANCE_NAME, SESSION_NAME } from "./types";
import {
  classifySession,
  describeGap,
  isTradingSession,
  lastTradableInstant,
} from "./session";

// Thresholds are tunable per chain: what is worth a transaction on a cheap L2
// is not worth one elsewhere. Defaults suit an Orbit chain where a post costs a
// fraction of a cent.
export const PRICE_MOVE_BPS = Number(process.env.CRON_PRICE_MOVE_BPS ?? 10);
export const BAND_MOVE_BPS = Number(process.env.CRON_BAND_MOVE_BPS ?? 15);

/** Refresh after this long even if nothing moved, while the tape is shut. */
export const MAX_ONCHAIN_AGE = Number(process.env.CRON_MAX_ONCHAIN_AGE ?? 3 * 3600);

/**
 * The same, while trades can print.
 *
 * A TRADED quote claims to be a live print, and neither getPriceIfTraded nor
 * isLive checks its age, so on-chain it stays "live" until something replaces
 * it. Three hours is fine for a weekend price that is not moving; it is not
 * fine for a print a liquidation path will act on. This keeps a live-session
 * quote well inside the oracle's own 30-minute maxQuoteAge, with room for a
 * late or skipped scheduler run.
 */
export const MAX_LIVE_AGE = Number(process.env.CRON_MAX_LIVE_AGE ?? 15 * 60);

/**
 * How late the scheduler may be before health calls the feed stalled.
 * Three missed runs at a five-minute cadence.
 */
export const STALL_GRACE = 15 * 60;

/** The fields of an on-chain quote the relay decision reads. */
export interface StoredQuote {
  price: bigint;
  confidenceBps: bigint;
  session: number;
  provenance: number;
  publishTime: bigint;
}

/** The fields of a freshly built quote the relay decision reads. */
export interface FreshQuote {
  price: number;
  confidenceBps: number;
  session: Session;
  provenance: Provenance;
  publishTime: number;
}

export type Decision = { post: true; reason: string } | { post: false; reason: string };

/**
 * Whether a fresh quote is worth a transaction over what the chain holds.
 *
 * A change of provenance or session always is, whatever the price did. Those
 * two fields are what a consumer's policy branches on — TRADED against
 * DERIVED is the difference between liquidating and refusing to — so leaving
 * the old value in place because the price barely moved would be serving the
 * wrong answer to the only question that matters.
 */
export function decide(
  q: FreshQuote,
  s: StoredQuote | null,
  nowSec: number,
): Decision {
  if (!s || s.publishTime === 0n) return { post: true, reason: "no quote on chain yet" };
  if (BigInt(q.publishTime) <= s.publishTime) {
    return { post: false, reason: "not newer than stored" };
  }

  if (q.provenance !== s.provenance) {
    return {
      post: true,
      reason: `provenance ${PROVENANCE_NAME[s.provenance as Provenance]} -> ${PROVENANCE_NAME[q.provenance]}`,
    };
  }
  if (q.session !== s.session) {
    return {
      post: true,
      reason: `session ${SESSION_NAME[s.session as Session]} -> ${SESSION_NAME[q.session]}`,
    };
  }

  const age = nowSec - Number(s.publishTime);
  const maxAge = isTradingSession(q.session) ? MAX_LIVE_AGE : MAX_ONCHAIN_AGE;
  if (age >= maxAge) {
    return { post: true, reason: `on-chain quote is ${Math.round(age / 60)}m old` };
  }

  const onChainPrice = Number(s.price) / 1e8;
  const priceMoveBps =
    onChainPrice > 0 ? Math.abs((q.price - onChainPrice) / onChainPrice) * 10_000 : Infinity;
  if (priceMoveBps >= PRICE_MOVE_BPS) {
    return { post: true, reason: `price moved ${priceMoveBps.toFixed(1)}bps` };
  }

  const bandMoveBps = Math.abs(q.confidenceBps - Number(s.confidenceBps));
  if (bandMoveBps >= BAND_MOVE_BPS) {
    return { post: true, reason: `band moved ${bandMoveBps.toFixed(0)}bps` };
  }

  return {
    post: false,
    reason: `unchanged (${priceMoveBps.toFixed(1)}bps price, ${bandMoveBps.toFixed(0)}bps band)`,
  };
}

/**
 * What is wrong with the feed as the chain holds it, one line per ticker.
 *
 * Empty means a working relayer would have left exactly this state behind.
 * Two faults, because they fail differently:
 *
 *   - too old: the relayer refreshes at least every MAX_LIVE_AGE while trades
 *     can print and every MAX_ONCHAIN_AGE otherwise, so anything older than
 *     that plus STALL_GRACE means the relayer has stopped.
 *   - TRADED while the tape is shut: the chain is asserting a live print that
 *     cannot exist. This is the dangerous one, because getPriceIfTraded and
 *     isLive will both pass it.
 */
export function stallProblems(
  stored: { ticker: string; quote: StoredQuote | null }[],
  now: Date,
): string[] {
  const nowSec = Math.floor(now.getTime() / 1000);
  const shutFor = nowSec - Math.floor(lastTradableInstant(now).getTime() / 1000);
  const live = shutFor === 0;
  // The tighter live-session deadline starts at the open, not at the last
  // weekend heartbeat, or every open would alarm before its first run. The
  // weekend deadline still applies to the quote's whole age: a quote that was
  // already overdue before the bell gets no grace from it.
  const openedAt = live ? liveSince(now) : 0;

  const problems: string[] = [];
  for (const { ticker, quote } of stored) {
    if (!quote || quote.publishTime === 0n) {
      problems.push(`${ticker} has never been posted on chain`);
      continue;
    }
    const age = nowSec - Number(quote.publishTime);
    const liveOverdue =
      live && nowSec - Math.max(Number(quote.publishTime), openedAt) > MAX_LIVE_AGE + STALL_GRACE;
    const overdue = age > MAX_ONCHAIN_AGE + STALL_GRACE;

    if (!live && quote.provenance === Provenance.TRADED && shutFor > STALL_GRACE) {
      problems.push(
        `${ticker} is TRADED on chain but the tape has been shut for ${describeGap(shutFor)}; ` +
          `getPriceIfTraded is serving a ${describeGap(age)} old print`,
      );
    } else if (overdue || liveOverdue) {
      const within = overdue ? MAX_ONCHAIN_AGE : MAX_LIVE_AGE;
      problems.push(
        `${ticker} on-chain quote is ${describeGap(age)} old; the relayer refreshes within ` +
          `${describeGap(within)}, so it has stopped`,
      );
    }
  }
  return problems;
}

/** Unix seconds at which the current run of PRE, REGULAR and POST began. */
function liveSince(now: Date): number {
  let t = now.getTime() - (now.getTime() % 60_000);
  // Bounded by the longest trading day, 04:00-20:00 ET.
  for (let i = 0; i < 17 * 60; i++) {
    if (!isTradingSession(classifySession(new Date(t - 60_000)))) break;
    t -= 60_000;
  }
  return Math.floor(t / 1000);
}
