import { NextResponse } from "next/server";
import { signerAddress } from "@/lib/sign";
import { UNIVERSE } from "@/lib/universe";
import { classifySession, describeGap, nextSessionChange } from "@/lib/session";
import { SESSION_NAME } from "@/lib/types";
import { fetchConsensus, ALL_PROVIDERS } from "@/lib/providers";
import { cacheStats } from "@/lib/cache";

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date();
  const started = Date.now();

  let upstreamOk = false;
  let upstreamError: string | null = null;
  try {
    await fetchConsensus(UNIVERSE[0].ticker);
    upstreamOk = true;
  } catch (e) {
    upstreamError = e instanceof Error ? e.message : String(e);
  }

  const next = nextSessionChange(now);
  return NextResponse.json(
    {
      status: upstreamOk ? "ok" : "degraded",
      time: now.toISOString(),
      upstream: { ok: upstreamOk, error: upstreamError },
      providers: ALL_PROVIDERS.map((p) => ({
        key: p.key,
        label: p.label,
        enabled: p.enabled,
        terms: p.terms,
        reportsTradeTime: p.reportsTradeTime,
        ...(p.disabledReason ? { disabledReason: p.disabledReason } : {}),
      })),
      signer: signerAddress(),
      session: SESSION_NAME[classifySession(now)],
      nextSession: SESSION_NAME[next.nextSession],
      changesIn: describeGap(next.inSeconds),
      instruments: UNIVERSE.length,
      cache: cacheStats().size,
      latencyMs: Date.now() - started,
    },
    { status: upstreamOk ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
