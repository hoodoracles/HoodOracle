// The coverage ledger, as JSON.
//
// Everything here is derived from QuotePosted logs on Robinhood Chain. Nothing
// is read from a database, because there isn't one: the point of publishing a
// band is that the claim is on the record, and a record we could quietly edit
// would not be worth much. Anyone can recompute these numbers straight from the
// chain — src/lib/ledger.ts is the whole method.
//
//   /api/coverage              summary
//   /api/coverage?full=1       every resolution and every quote read
//   /api/coverage?fresh=1      bypass the 30s archive cache

import { NextResponse } from "next/server";
import { loadLedger } from "@/lib/ledger";
import { PROVENANCE_NAME, SESSION_NAME } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function flag(url: URL, name: string): boolean {
  const v = url.searchParams.get(name);
  return v !== null && v !== "0" && v !== "false";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const full = flag(url, "full");

  let result;
  try {
    result = await loadLedger({ fresh: flag(url, "fresh") });
  } catch (e) {
    // A dead RPC is not a broken ledger, and returning zeroes would read as
    // "we published nothing" rather than "we could not look".
    return NextResponse.json(
      {
        error: "could not read the chain",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }

  if (!result) {
    return NextResponse.json(
      {
        error: "no chain configured",
        detail:
          "set NEXT_PUBLIC_ORACLE_ADDRESS, NEXT_PUBLIC_ORACLE_RPC and NEXT_PUBLIC_ORACLE_CHAIN_ID",
      },
      { status: 503 },
    );
  }

  const { ledger, config } = result;

  const body = {
    asOf: new Date().toISOString(),
    source: {
      kind: "on-chain event log",
      chain: config.chainName,
      chainId: config.chainId,
      contract: config.address,
      event: "QuotePosted",
      note: "No database. Recomputable by anyone from the chain alone.",
    },
    method: {
      claim:
        "confidenceBps is a two-sided 95% interval. A quote published while the tape is shut is a claim about a price nobody can observe yet; the first live print that follows settles it.",
      atReopen:
        "One score per closure, using the last band published before the tape reopened. The fitted sigma is anchored on a complete close-to-open gap, so this is the only apples-to-apples comparison with the backtest.",
      allDuringClosure:
        "Every band published during a closure, scored against the same reopening print. Reads lower than atReopen by construction: the band widens with elapsed staleness, so a quote published early in a long weekend carries an overnight-sized band against a weekend-sized move.",
      notScored:
        "Consecutive live prints. A TRADED band is dispersion around a price that already exists, not a forecast, so testing the next print against it would test a claim the oracle never made.",
      bandArithmetic:
        "Edges computed as (price * confidenceBps) / 10000 in integer arithmetic, matching HoodOracle.getBandedPrice exactly.",
      interval: "Wilson score, 95%.",
    },
    window: {
      firstPublish: ledger.firstPublish
        ? new Date(ledger.firstPublish * 1000).toISOString()
        : null,
      lastPublish: ledger.lastPublish
        ? new Date(ledger.lastPublish * 1000).toISOString()
        : null,
      quotesRead: ledger.quotes.length,
      signers: ledger.signers,
    },
    nominalPct: ledger.nominalPct,
    atReopen: ledger.atReopen,
    allDuringClosure: ledger.allDuringClosure,
    model: {
      calibratedAt: new Date(ledger.calibratedAt * 1000).toISOString(),
      sinceCalibration: ledger.sinceCalibration,
      beforeCalibration: ledger.beforeCalibration,
      note:
        "npm run calibrate rewrites the betas and sigmas. Bands published before calibratedAt came from a different model, so they are counted in atReopen (that is what consumers were handed) and excluded from sinceCalibration (which asks whether the model running now is calibrated).",
    },
    perTicker: ledger.perTicker,
    pending: ledger.pending.map((p) => ({
      ...p,
      since: new Date(p.since * 1000).toISOString(),
    })),
    episodes: ledger.episodes.length,
    ...(full
      ? {
          resolutions: ledger.episodes.map((e) => ({
            ...e.atReopen,
            sessionName: SESSION_NAME[e.atReopen.session],
            provenanceName: PROVENANCE_NAME[e.atReopen.provenance],
            predictedAt: new Date(e.atReopen.predictedAt * 1000).toISOString(),
            resolvedAt: new Date(e.atReopen.resolvedAt * 1000).toISOString(),
            quotesDuringClosure: e.quotes.length,
          })),
          quotes: ledger.quotes.map((q) => ({
            ...q,
            priceScaled: q.priceScaled.toString(),
            sessionName: SESSION_NAME[q.session],
            provenanceName: PROVENANCE_NAME[q.provenance],
            publishedAt: new Date(q.publishTime * 1000).toISOString(),
          })),
        }
      : {}),
  };

  return NextResponse.json(body, {
    headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" },
  });
}
