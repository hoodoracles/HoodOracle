import { NextResponse } from "next/server";
import { buildQuotes } from "@/lib/quote";
import { moveSince } from "@/lib/providers";
import { UNIVERSE } from "@/lib/universe";
import { PROVENANCE_NAME, SESSION_NAME } from "@/lib/types";
import { classifySession, describeGap, nextSessionChange } from "@/lib/session";
import { CALIBRATION, calibrationFor } from "@/lib/calibration";

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date();
  const { quotes, errors, proxies } = await buildQuotes(UNIVERSE, now);
  const session = classifySession(now);
  const next = nextSessionChange(now);

  return NextResponse.json(
    {
      asOf: now.toISOString(),
      market: {
        session: SESSION_NAME[session],
        nextSession: SESSION_NAME[next.nextSession],
        changesIn: describeGap(next.inSeconds),
        changesInSeconds: next.inSeconds,
      },
      proxies: proxies.map((p) => ({
        key: p.key,
        price: Number(p.latest.toFixed(2)),
        moveSinceGapPct: quotes.length
          ? Number((moveSince(p, quotes[0].lastTradeTime) * 100).toFixed(3))
          : 0,
      })),
      calibration: {
        generatedAt: CALIBRATION.generatedAt,
        timeExponent: CALIBRATION.timeExponent,
        method: CALIBRATION.method,
      },
      quotes: quotes.map((q) => ({
        ...q,
        beta: calibrationFor(q.ticker).beta,
        r2: calibrationFor(q.ticker).r2,
        coveragePct: calibrationFor(q.ticker).coveragePct,
        sessionName: SESSION_NAME[q.session],
        provenanceName: PROVENANCE_NAME[q.provenance],
        confidencePct: Number((q.confidenceBps / 100).toFixed(2)),
        staleness: describeGap(q.stalenessSeconds),
      })),
      errors,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
