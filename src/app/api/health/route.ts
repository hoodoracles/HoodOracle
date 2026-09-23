import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, type Hex } from "viem";
import { isSignerConfigured, signerAddress } from "@/lib/sign";
import { UNIVERSE } from "@/lib/universe";
import { classifySession, describeGap, nextSessionChange } from "@/lib/session";
import { PROVENANCE_NAME, SESSION_NAME, type Provenance } from "@/lib/types";
import { fetchConsensus, ALL_PROVIDERS } from "@/lib/providers";
import { cacheStats } from "@/lib/cache";
import { CALIBRATION } from "@/lib/calibration";
import { lastCall } from "@/lib/lastcall";
import { HOOD_ORACLE_ABI, HOOD_ORACLE_KEEPER_ABI } from "@/lib/abi";
import { stallProblems, type StoredQuote } from "@/lib/relay";

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

/**
 * Is the batch relay actually on?
 *
 * The keeper is optional and its absence is not a fault — without it the
 * relayer posts one transaction per ticker, which is what it always did. But
 * "configured" and "working" are different things, and the difference is
 * invisible from outside: a keeper address pointing at the wrong oracle, or at
 * nothing at all, answers plausibly right up until it silently posts nowhere.
 * So this checks that it is wired to the oracle we are actually publishing to.
 */
async function checkKeeper(
  oracle: string | undefined,
  rpc: string | undefined,
) {
  const address = process.env.NEXT_PUBLIC_KEEPER_ADDRESS;
  if (!address) {
    return {
      configured: false,
      address: null,
      wiredTo: null,
      wiredCorrectly: null,
      note: "not set — the relayer posts one transaction per ticker",
    };
  }
  if (!rpc || !oracle) {
    return {
      configured: true,
      address,
      wiredTo: null,
      wiredCorrectly: null,
      note: "cannot verify without NEXT_PUBLIC_ORACLE_ADDRESS and _RPC",
    };
  }

  try {
    const wiredTo = (await createPublicClient({
      transport: http(rpc),
    }).readContract({
      address: address as Hex,
      abi: HOOD_ORACLE_KEEPER_ABI,
      functionName: "oracle",
    })) as string;

    const wiredCorrectly = wiredTo.toLowerCase() === oracle.toLowerCase();
    return {
      configured: true,
      address,
      wiredTo,
      wiredCorrectly,
      note: wiredCorrectly
        ? "batching enabled"
        : `points at ${wiredTo}, not the oracle this service publishes to`,
    };
  } catch (e) {
    return {
      configured: true,
      address,
      wiredTo: null,
      wiredCorrectly: false,
      note: `unreadable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
    };
  }
}

/**
 * Is the chain still being fed?
 *
 * Every other check here can pass while the on-chain quotes rot: the service
 * signs, the signer is trusted, the relayer is funded, and the scheduler that
 * is supposed to call it simply stops. That happened on 20 Sep 2026 and this
 * endpoint answered "ok" for 42 hours while getPriceIfTraded served a Monday
 * morning print through two closes. So the chain itself is read, and judged
 * against what a working relayer would have left behind.
 */
async function checkFeed(oracle: string | undefined, rpc: string | undefined) {
  if (!oracle || !rpc) return null;
  const client = createPublicClient({ transport: http(rpc) });

  const stored = await Promise.all(
    UNIVERSE.map(async ({ ticker }) => {
      try {
        const quote = (await client.readContract({
          address: oracle as Hex,
          abi: HOOD_ORACLE_ABI,
          functionName: "getQuote",
          args: [ticker],
        })) as StoredQuote;
        return { ticker, quote, error: null };
      } catch (e) {
        // NoQuote reverts; anything else is the RPC failing to answer.
        const msg = e instanceof Error ? e.message : String(e);
        return /NoQuote/.test(msg)
          ? { ticker, quote: null, error: null }
          : { ticker, quote: null, error: msg.split("\n")[0] };
      }
    }),
  );

  // An RPC that will not answer says nothing about the feed either way.
  if (stored.some((s) => s.error)) {
    return { readable: false, problems: [], oldestAgeSeconds: null, quotes: [] };
  }

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const ages = stored
    .filter((s) => s.quote)
    .map((s) => nowSec - Number(s.quote!.publishTime));

  return {
    readable: true,
    problems: stallProblems(stored, now),
    oldestAgeSeconds: ages.length ? Math.max(...ages) : null,
    quotes: stored.map(({ ticker, quote }) => ({
      ticker,
      provenance: quote ? PROVENANCE_NAME[quote.provenance as Provenance] : null,
      ageSeconds: quote ? nowSec - Number(quote.publishTime) : null,
    })),
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
  const [relayer, keeper, feed] = await Promise.all([
    checkRelayer(rpc),
    checkKeeper(oracle, rpc),
    checkFeed(oracle, rpc),
  ]);

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

  // Only a deployment that is meant to publish can be faulted for a stale
  // chain. An API-only one legitimately never touches it.
  const publishes = relayer.cronSecretSet && relayer.keyConfigured;
  const feedStalled = publishes && !!feed && feed.problems.length > 0;
  if (feedStalled) problems.push(...feed!.problems);

  const healthy =
    upstreamOk && signerConfigured && signerTrusted !== false && !feedStalled;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      problems,
      time: now.toISOString(),
      upstream: { ok: upstreamOk, error: upstreamError },
      keeper,
      feed,
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
