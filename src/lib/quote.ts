// The quote engine.
//
// Takes a consensus reading across independent providers and answers the
// question no oracle currently answers for tokenised equities: how much should
// this number be trusted at this exact moment?

import {
  classifySession,
  isTradingSession,
  lastTradableInstant,
  nextSessionChange,
} from "./session";
import {
  blendedMoveSince,
  fetchConsensus,
  fetchProxies,
  type ProxySeries,
} from "./providers";
import { Provenance, Session, type Quote } from "./types";
import type { Instrument } from "./universe";
import {
  calibrationFor,
  gapSigmaBps,
  isCalibrated,
  Z_95,
} from "./calibration";

/** Band applied to a live print, in bps. */
const BASE_BPS: Record<Session, number> = {
  [Session.REGULAR]: 8,
  [Session.PRE]: 35,
  [Session.POST]: 35,
  [Session.CLOSED]: 45,
  [Session.HOLIDAY]: 55,
};

/** A live print older than this stops counting as live. */
const FRESH_SECONDS = 300;

/** Hard ceiling. Beyond this the number is not worth publishing. */
const MAX_BPS = 1500;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface BuiltQuote {
  quote: Quote;
  calibration: {
    beta: number;
    priorBeta: number;
    r2: number;
    samples: number;
    coveragePct: number | null;
    calibrated: boolean;
  };
  proxies: ProxySeries[];
  sources: { source: string; price: number }[];
  failures: { source: string; error: string }[];
}

export interface BuildOptions {
  now?: Date;
  /**
   * Pre-fetched proxy state. Pass this when pricing a batch so every ticker
   * drifts against the same snapshot, otherwise quotes a second apart are
   * internally inconsistent.
   */
  proxies?: ProxySeries[];
}

export async function buildQuote(
  inst: Instrument,
  options: BuildOptions = {},
): Promise<BuiltQuote> {
  const now = options.now ?? new Date();
  const consensus = await fetchConsensus(inst.ticker);
  const session = classifySession(now);
  const tradingNow = isTradingSession(session);
  const nowSec = Math.floor(now.getTime() / 1000);

  // Reconcile the reported print time against the calendar. A provider that
  // stamps fetch time cannot manufacture a print while the tape is shut, and
  // even a genuine print time is capped at the last tradable instant.
  const calendarCeiling = Math.floor(lastTradableInstant(now).getTime() / 1000);
  const reported = consensus.lastTradeTime ?? calendarCeiling;
  const lastTradeTime = Math.min(reported, calendarCeiling);
  const stalenessSeconds = Math.max(0, nowSec - lastTradeTime);

  const anchorPrice = consensus.price;
  const maxDeviationBps = consensus.maxDeviationBps;
  const cal = calibrationFor(inst.ticker);

  let price = anchorPrice;
  let provenance: Provenance;
  let driftBps = 0;
  let method: string;
  let proxies: ProxySeries[] = [];

  const isFresh = stalenessSeconds <= FRESH_SECONDS;

  // The proxy is needed whenever the anchor is not live, for the drift model
  // and for the volatility adjustment on the band.
  if (!tradingNow || !isFresh) {
    proxies = options.proxies ?? (await fetchProxies());
  }

  if (tradingNow && isFresh) {
    provenance = Provenance.TRADED;
    method =
      `Live print during the ${sessionWord(session)} session, ` +
      `median of ${consensus.sourceCount} source${consensus.sourceCount === 1 ? "" : "s"}.`;
  } else if (tradingNow) {
    provenance = Provenance.STALE;
    method =
      "Tape is open but the consensus print is stale. Serving the last known value " +
      "unmodelled: during an open session a missing print signals an upstream problem, " +
      "not a calendar gap, so modelling over it would hide the fault.";
  } else {
    // Measure the proxy's move over exactly the window the tape was shut.
    const proxyMove = blendedMoveSince(proxies, lastTradeTime);

    // The fitted beta, not the conservative prior the first build shipped.
    const beta = cal.beta;

    if (proxies.length === 0 || Math.abs(beta) < 0.02) {
      provenance = proxies.length === 0 ? Provenance.STALE : Provenance.DERIVED;
      driftBps = 0;
      price = anchorPrice;
      method =
        proxies.length === 0
          ? "Tape is shut and no proxy resolved. Last close served unchanged."
          : `Tape is shut. Fitted beta is ${beta.toFixed(3)} with R² ${cal.r2.toFixed(3)}, ` +
            "so the proxy carries no usable signal for this instrument and no drift is applied.";
    } else {
      const gapHours = stalenessSeconds / 3600;
      driftBps = proxyMove * beta * 10_000;
      price = anchorPrice * (1 + driftBps / 10_000);
      provenance = Provenance.DERIVED;
      method =
        `Tape is shut. Close from ${consensus.sourceCount} source` +
        `${consensus.sourceCount === 1 ? "" : "s"} drifted by a fitted ` +
        `${beta.toFixed(3)} beta (R² ${cal.r2.toFixed(2)}, ${cal.samples} gaps) ` +
        `against a ${(proxyMove * 100).toFixed(2)}% blended BTC/ETH move measured ` +
        `over the same ${gapHours.toFixed(1)}h window.`;
    }
  }

  // ------------------------------------------------------------ confidence
  //
  // For a live print the band is execution noise plus source disagreement.
  //
  // For a gap it is the fitted residual standard deviation of that instrument's
  // realised close-to-open moves, scaled by the measured time exponent and
  // widened to a two-sided 95% interval. A coverage test over two years
  // confirms 93-96% of historical gaps land inside it.
  //
  // The model's own error is NOT added separately: the residual sigma is what
  // is left after applying the beta, so it already contains it. Adding a drift
  // term on top would double-count and break the validated coverage.
  const gapHours = stalenessSeconds / 3600;
  let bps: number;

  if (provenance === Provenance.TRADED) {
    bps = BASE_BPS[session] + maxDeviationBps;
  } else {
    bps = Z_95 * gapSigmaBps(inst.ticker, gapHours) + maxDeviationBps;
    // A stale quote never prices tighter than a live one in the same session.
    bps = Math.max(bps, BASE_BPS[Session.CLOSED]);
  }

  const confidenceBps = clamp(Math.round(bps), 1, MAX_BPS);
  const next = nextSessionChange(now);

  return {
    calibration: {
      beta: cal.beta,
      priorBeta: cal.priorBeta,
      r2: cal.r2,
      samples: cal.samples,
      coveragePct: cal.coveragePct,
      calibrated: isCalibrated(inst.ticker),
    },
    proxies,
    sources: consensus.readings.map((r) => ({
      source: r.source,
      price: Number(r.price.toFixed(4)),
    })),
    failures: consensus.failures,
    quote: {
      ticker: inst.ticker,
      price: Number(price.toFixed(6)),
      anchorPrice: Number(anchorPrice.toFixed(6)),
      confidenceBps,
      session,
      provenance,
      sourceCount: consensus.sourceCount,
      maxDeviationBps: Number(maxDeviationBps.toFixed(2)),
      lastTradeTime,
      publishTime: nowSec,
      stalenessSeconds,
      method,
      driftBps: Number(driftBps.toFixed(2)),
      nextSessionInSeconds: next.inSeconds,
      nextSession: next.nextSession,
    },
  };
}

/**
 * Price a batch against a single proxy snapshot so the set is internally
 * consistent. Failures are isolated: one dead ticker must not empty the board.
 */
export async function buildQuotes(
  instruments: Instrument[],
  now: Date = new Date(),
): Promise<{
  quotes: Quote[];
  errors: { ticker: string; error: string }[];
  proxies: ProxySeries[];
}> {
  const tapeShut = !isTradingSession(classifySession(now));
  const proxies = tapeShut ? await fetchProxies() : [];

  const settled = await Promise.allSettled(
    instruments.map((i) => buildQuote(i, { now, proxies })),
  );

  const quotes: Quote[] = [];
  const errors: { ticker: string; error: string }[] = [];
  settled.forEach((r, idx) => {
    if (r.status === "fulfilled") quotes.push(r.value.quote);
    else
      errors.push({
        ticker: instruments[idx].ticker,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
  });

  return { quotes, errors, proxies };
}

function sessionWord(s: Session): string {
  switch (s) {
    case Session.REGULAR:
      return "regular";
    case Session.PRE:
      return "pre-market";
    case Session.POST:
      return "after-hours";
    default:
      return "closed";
  }
}
