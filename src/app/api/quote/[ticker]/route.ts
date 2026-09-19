import { NextResponse } from "next/server";
import { buildQuote } from "@/lib/quote";
import { moveSince } from "@/lib/providers";
import { signQuote } from "@/lib/sign";
import { findInstrument, UNIVERSE } from "@/lib/universe";
import { PROVENANCE_NAME, SESSION_NAME } from "@/lib/types";
import { describeGap } from "@/lib/session";
import { ProviderError } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await ctx.params;
  const inst = findInstrument(ticker);

  if (!inst) {
    return NextResponse.json(
      {
        error: `unknown ticker "${ticker}"`,
        supported: UNIVERSE.map((i) => i.ticker),
      },
      { status: 404 },
    );
  }

  try {
    const { quote, proxies, sources, failures, calibration } =
      await buildQuote(inst);
    const signed = await signQuote(quote);

    return NextResponse.json(
      {
        ...signed,
        readable: {
          session: SESSION_NAME[quote.session],
          nextSession: SESSION_NAME[quote.nextSession],
          provenance: PROVENANCE_NAME[quote.provenance],
          confidencePct: `±${(quote.confidenceBps / 100).toFixed(2)}%`,
          band: [
            Number(
              (quote.price * (1 - quote.confidenceBps / 10_000)).toFixed(4),
            ),
            Number(
              (quote.price * (1 + quote.confidenceBps / 10_000)).toFixed(4),
            ),
          ],
          staleness: describeGap(quote.stalenessSeconds),
          opensIn: describeGap(quote.nextSessionInSeconds),
        },
        instrument: { name: inst.name, kind: inst.kind },
        calibration,
        proxies: proxies.map((p) => ({
          key: p.key,
          price: Number(p.latest.toFixed(2)),
          moveSinceGapPct: Number(
            (moveSince(p, quote.lastTradeTime) * 100).toFixed(3),
          ),
        })),
        sources,
        sourceFailures: failures,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const upstream = err instanceof ProviderError;
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "quote failed",
        ticker: inst.ticker,
      },
      { status: upstream ? 502 : 500 },
    );
  }
}
