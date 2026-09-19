import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { isSignerConfigured, signerAddress } from "@/lib/sign";
import { UNIVERSE } from "@/lib/universe";
import { classifySession, describeGap, nextSessionChange } from "@/lib/session";
import { SESSION_NAME } from "@/lib/types";
import { fetchConsensus, ALL_PROVIDERS } from "@/lib/providers";
import { cacheStats } from "@/lib/cache";
import { CALIBRATION } from "@/lib/calibration";
import { lastCall } from "@/lib/lastcall";

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

/** Native balance, in ether, or null when the RPC will not answer. */
async function getBalanceEth(
  rpc: string,
  address: string,
): Promise<number | null> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    const json = (await res.json()) as { result?: string };
    if (!json.result) return null;
    return Number(BigInt(json.result)) / 1e18;
  } catch {
    return null;
  }
}

/**
 * Can the scheduled relayer actually run?
 *
 * Three things have to be true at once and each fails silently on its own: the
 * secret has to be set (or the endpoint refuses every caller, including the
 * scheduler), the key has to be present and well formed, and the address it
 * derives to has to hold gas. A relayer with no balance answers 200 and posts
 * nothing but failures.
 *
 * Environment variables on Vercel only reach *new* deployments, so a value
 * added in the dashboard and never redeployed reads as absent here. That is the
 * case this block exists to make visible.
 */
async function checkRelayer(rpc: string | undefined) {
  const key = process.env.RELAYER_KEY;
  const keyValid = !!key && /^0x[0-9a-fA-F]{64}$/.test(key);

  let address: string | null = null;
  if (keyValid) {
    try {
      address = privateKeyToAccount(key as Hex).address;
    } catch {
      address = null;
    }
  }

  const balanceEth =
    address && rpc ? await getBalanceEth(rpc, address) : null;

  // Kept out of the top-level `problems` on purpose. An API-only deployment
  // that never publishes on-chain is a legitimate configuration, so a missing
  // relayer must not turn the whole service 503.
  const blockers: string[] = [];
  if (!process.env.CRON_SECRET) {
    blockers.push(
      "CRON_SECRET is not set in this deployment, so /api/cron/publish refuses " +
        "every caller. If you added it after the last deploy, redeploy: Vercel " +
        "applies environment changes only to new deployments.",
    );
  }
  if (!keyValid) {
    blockers.push(
      key
        ? "RELAYER_KEY is set but is not a 0x-prefixed 32-byte hex key"
        : "RELAYER_KEY is not set in this deployment, so nothing can pay gas",
    );
  }
  if (balanceEth === 0) {
    blockers.push(
      `relayer ${address} holds no gas, so every postQuote will fail to send`,
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    /**
     * Best-effort: in-process, so null means "no call reached this instance",
     * not "no call happened". Still the fastest way to tell a scheduler that
     * never fired from one whose header is wrong.
     */
    lastCall: lastCall(),
    cronSecretSet: !!process.env.CRON_SECRET,
    keyConfigured: keyValid,
    /** Public either way — it is the `from` on every transaction it sends. */
    address,
    balanceEth,
  };
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
  const relayer = await checkRelayer(rpc);

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
      relayer,
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
