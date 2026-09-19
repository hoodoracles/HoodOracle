import { NextResponse } from "next/server";
import { isSignerConfigured, signerAddress } from "@/lib/sign";
import { UNIVERSE } from "@/lib/universe";
import { classifySession, describeGap, nextSessionChange } from "@/lib/session";
import { SESSION_NAME } from "@/lib/types";
import { fetchConsensus, ALL_PROVIDERS } from "@/lib/providers";
import { cacheStats } from "@/lib/cache";
import { CALIBRATION } from "@/lib/calibration";

export const dynamic = "force-dynamic";

/**
 * Ask the chain whether it will actually accept what we sign.
 *
 * A deployment can be perfectly healthy by every other measure and still be
 * publishing quotes no contract will take, because the signer is not
 * allow-listed. That is a silent failure worth one RPC call.
 */
async function checkSignerTrusted(
  oracle: string,
  rpc: string,
  signer: string,
): Promise<boolean | null> {
  try {
    // isSigner(address) selector, then the address left-padded to 32 bytes.
    const data = "0x7df73e27" + signer.slice(2).toLowerCase().padStart(64, "0");
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: oracle, data }, "latest"],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    const json = (await res.json()) as { result?: string };
    if (!json.result) return null;
    return BigInt(json.result) === 1n;
  } catch {
    return null;
  }
}

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

  const signerConfigured = isSignerConfigured();
  const signer = signerAddress();

  const oracle = process.env.NEXT_PUBLIC_ORACLE_ADDRESS;
  const rpc = process.env.NEXT_PUBLIC_ORACLE_RPC;
  const signerTrusted =
    oracle && rpc ? await checkSignerTrusted(oracle, rpc, signer) : null;

  const problems: string[] = [];
  if (!upstreamOk) problems.push("no provider resolved");
  if (!signerConfigured) {
    problems.push(
      "ORACLE_SIGNER_KEY is not set, so quotes are signed with an ephemeral key " +
        "that no deployed contract will accept",
    );
  }
  if (signerTrusted === false) {
    problems.push(
      `signer ${signer} is not allow-listed on ${oracle}, so postQuote will revert with UnknownSigner`,
    );
  }
  if (!oracle) {
    problems.push(
      "NEXT_PUBLIC_ORACLE_ADDRESS is not set, so the on-chain panel is hidden and the signer cannot be checked against the chain",
    );
  }

  const healthy = upstreamOk && signerConfigured && signerTrusted !== false;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      problems,
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
      signing: {
        signer,
        configured: signerConfigured,
        /** null when there is no contract configured to ask. */
        trustedOnChain: signerTrusted,
        contract: oracle ?? null,
      },
      build: {
        // Vercel injects these. Without them we can only infer the deployed
        // version by probing for routes, which is a poor way to find out a
        // deploy never happened.
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        env: process.env.VERCEL_ENV ?? "development",
        /** Routes that exist in this build, so a stale deploy is obvious. */
        routes: [
          "/api/health",
          "/api/quotes",
          "/api/quote/[ticker]",
          "/api/cron/publish",
        ],
      },
      calibration: {
        generatedAt: CALIBRATION.generatedAt,
        timeExponent: CALIBRATION.timeExponent,
        instruments: Object.keys(CALIBRATION.instruments).length,
      },
      session: SESSION_NAME[classifySession(now)],
      nextSession: SESSION_NAME[nextSessionChange(now).nextSession],
      changesIn: describeGap(nextSessionChange(now).inSeconds),
      instruments: UNIVERSE.length,
      cache: cacheStats().size,
      latencyMs: Date.now() - started,
    },
    {
      status: healthy ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
