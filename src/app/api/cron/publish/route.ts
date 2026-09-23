// Relayer endpoint.
//
// A blockchain cannot fetch anything. The contract holds whatever was last
// pushed to it, so something off-chain has to submit a transaction or the
// on-chain quote freezes while the API stays current. This is that something,
// shaped so an external scheduler (cron-job.org, Vercel Cron, anything that can
// make an authenticated request) can drive it.
//
// Two things make it safe to expose:
//   - it requires a shared secret, because every call spends gas
//   - it only posts what has materially changed, so a quiet weekend costs almost
//     nothing even at a one-minute schedule
//
// Transactions are sent with explicit nonces and NOT awaited. Waiting on eight
// receipts sequentially takes longer than a serverless invocation is allowed to
// live, and the receipt tells us nothing we cannot read back next run.

import { NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HOOD_ORACLE_ABI, HOOD_ORACLE_KEEPER_ABI } from "@/lib/abi";
import { buildQuotes } from "@/lib/quote";
import { signQuote, isSignerConfigured, toScaled } from "@/lib/sign";
import { UNIVERSE } from "@/lib/universe";
import { SESSION_NAME } from "@/lib/types";
import { classifySession } from "@/lib/session";
import { callerAgent, recordCall } from "@/lib/lastcall";
import { decide, type StoredQuote } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Constant-time compare, so a wrong secret leaks nothing by timing. */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // With no secret configured the endpoint stays shut rather than open.
  if (!secret) return false;

  const auth = req.headers.get("authorization");
  if (auth) {
    // Both spellings. Pasting the raw secret into a scheduler's Authorization
    // field, without the "Bearer " prefix, is the commonest way to configure
    // this wrongly, and rejecting it buys no security: the value compared is
    // the same secret either way.
    const offered = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (secretEquals(offered.trim(), secret)) return true;
  }

  const x = req.headers.get("x-cron-secret");
  if (x && secretEquals(x.trim(), secret)) return true;

  // Vercel Cron signs its own requests with this header. Guarded on presence
  // rather than compared against a sentinel: the previous sentinel was a NUL
  // character, which is not something to leave in a source file.
  const vercelSecret = process.env.VERCEL_CRON_SECRET;
  if (vercelSecret && auth === `Bearer ${vercelSecret}`) return true;

  const key = new URL(req.url).searchParams.get("key");
  return !!key && secretEquals(key, secret);
}

/**
 * Which credential-bearing fields the caller sent: names only, never values.
 * A scheduler that is firing but rejected needs to know whether its header
 * arrived at all. That is the difference between "fix the value" and "the
 * header is not being sent".
 */
function offeredCredentials(req: Request): string[] {
  const seen: string[] = [];
  if (req.headers.get("authorization")) seen.push("authorization");
  if (req.headers.get("x-cron-secret")) seen.push("x-cron-secret");
  if (new URL(req.url).searchParams.get("key")) seen.push("?key=");
  return seen;
}

export async function GET(req: Request) {
  return handleSafely(req);
}
export async function POST(req: Request) {
  return handleSafely(req);
}

/**
 * An unexpected throw is a transient fault until proven otherwise (an RPC
 * that dropped a call, an upstream that timed out) and a 500 would count
 * toward the scheduler disabling the job. Report it in the body instead;
 * a fault that persists shows up as a stale chain on /api/health.
 */
async function handleSafely(req: Request) {
  try {
    return await handle(req);
  } catch (e) {
    const error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    recordCall({
      at: new Date().toISOString(),
      outcome: "error",
      userAgent: callerAgent(req),
    });
    return NextResponse.json(
      { ok: false, error },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}

/**
 * `?dry=1` runs everything except the sending.
 *
 * Without it there is no way to check that a scheduler's header is right, that
 * the key parses and that the thresholds behave, except by spending gas — so
 * the first test of a new schedule is also an irreversible mainnet write. A dry
 * run exercises auth, config, quote building and the full materiality decision,
 * and stops at the transaction.
 */
function isDryRun(req: Request): boolean {
  const v = new URL(req.url).searchParams.get("dry");
  return v !== null && v !== "0" && v !== "false";
}

async function handle(req: Request) {
  if (!authorised(req)) {
    // Recorded so /api/health can distinguish "the scheduler never called"
    // from "the scheduler called and its header was wrong".
    recordCall({
      at: new Date().toISOString(),
      outcome: "unauthorised",
      userAgent: callerAgent(req),
    });
    return NextResponse.json(
      {
        error: "unauthorised",
        // Names only. Enough to debug a scheduler, nothing about the values.
        credentialsOffered: offeredCredentials(req),
        hint:
          offeredCredentials(req).length === 0
            ? "no credential reached this endpoint. send 'Authorization: Bearer <CRON_SECRET>'."
            : "a credential arrived but did not match CRON_SECRET in this deployment. " +
              "If you changed it in the dashboard, redeploy — Vercel applies environment " +
              "changes only to new deployments.",
      },
      { status: 401 },
    );
  }

  const oracle = process.env.NEXT_PUBLIC_ORACLE_ADDRESS as Hex | undefined;
  const rpcUrl = process.env.NEXT_PUBLIC_ORACLE_RPC;
  const chainId = Number(process.env.NEXT_PUBLIC_ORACLE_CHAIN_ID ?? 0);
  const relayerKey = process.env.RELAYER_KEY as Hex | undefined;
  // Optional. Without it the relayer posts one transaction per ticker, which
  // is what it did before the keeper existed and still works.
  const keeper = process.env.NEXT_PUBLIC_KEEPER_ADDRESS as Hex | undefined;

  const missing: string[] = [];
  if (!oracle) missing.push("NEXT_PUBLIC_ORACLE_ADDRESS");
  if (!rpcUrl) missing.push("NEXT_PUBLIC_ORACLE_RPC");
  if (!chainId) missing.push("NEXT_PUBLIC_ORACLE_CHAIN_ID");
  if (!relayerKey || !/^0x[0-9a-fA-F]{64}$/.test(relayerKey)) {
    missing.push("RELAYER_KEY");
  }
  if (!isSignerConfigured()) missing.push("ORACLE_SIGNER_KEY");

  if (missing.length) {
    recordCall({
      at: new Date().toISOString(),
      outcome: "not-configured",
      userAgent: callerAgent(req),
    });
    return NextResponse.json(
      { error: "not configured", missing },
      { status: 503 },
    );
  }

  const chain = defineChain({
    id: chainId,
    name: process.env.NEXT_PUBLIC_ORACLE_CHAIN ?? `chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl as string] } },
  });

  const account = privateKeyToAccount(relayerKey as Hex);
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const { quotes, errors } = await buildQuotes(UNIVERSE, now);

  // One read per ticker to decide what is worth paying for.
  const stored = await Promise.all(
    quotes.map(async (q) => {
      try {
        const s = (await pub.readContract({
          address: oracle as Hex,
          abi: HOOD_ORACLE_ABI,
          functionName: "getQuote",
          args: [q.ticker],
        })) as StoredQuote;
        return s;
      } catch {
        return null; // nothing posted yet
      }
    }),
  );

  const toPost: { index: number; reason: string }[] = [];
  const skipped: { ticker: string; reason: string }[] = [];

  quotes.forEach((q, i) => {
    const d = decide(q, stored[i], nowSec);
    if (d.post) toPost.push({ index: i, reason: d.reason });
    else skipped.push({ ticker: q.ticker, reason: d.reason });
  });

  const dry = isDryRun(req);
  const balance = await pub.getBalance({ address: account.address });

  if (dry) {
    recordCall({
      at: now.toISOString(),
      outcome: "dry-run",
      userAgent: callerAgent(req),
      posted: 0,
      skipped: skipped.length,
    });
    return NextResponse.json(
      {
        ok: true,
        dryRun: true,
        note: "nothing was sent. drop ?dry=1 to publish.",
        time: now.toISOString(),
        session: SESSION_NAME[classifySession(now)],
        relayer: account.address,
        balanceEth: Number(balance) / 1e18,
        mode:
          toPost.length === 0
            ? "nothing to post"
            : keeper && toPost.length > 1
              ? `batch via keeper ${keeper}`
              : "one transaction per ticker",
        wouldPost: toPost.map(({ index, reason }) => ({
          ticker: quotes[index].ticker,
          price: quotes[index].price,
          confidenceBps: quotes[index].confidenceBps,
          reason,
        })),
        skipped,
        quoteErrors: errors,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // Explicit nonces so eight sends do not race each other, and no receipt
  // waiting so the whole run fits inside one invocation.
  let nonce = await pub.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });

  const posted: { ticker: string; hash: string; reason: string }[] = [];
  const failed: { ticker: string; error: string }[] = [];

  /** Pack a quote into the on-chain tuple. */
  function tupleFor(q: (typeof quotes)[number]) {
    return {
      price: toScaled(q.price),
      confidenceBps: BigInt(q.confidenceBps),
      session: q.session,
      provenance: q.provenance,
      sourceCount: q.sourceCount,
      maxDeviationBps: BigInt(Math.round(q.maxDeviationBps)),
      lastTradeTime: BigInt(q.lastTradeTime),
      publishTime: BigInt(q.publishTime),
    };
  }

  // A batch of one is a batch that pays the keeper's call overhead to save
  // nothing, so the helper is only worth using from two upwards.
  const useKeeper = Boolean(keeper) && toPost.length > 1;
  let batchHash: string | null = null;
  // Distinct from `batchHash`: deciding not to send because every quote would
  // be refused is the batch path succeeding, and must not fall through to the
  // one-at-a-time loop and post them all over again.
  let batchHandled = false;

  if (useKeeper) {
    const tickers = toPost.map(({ index }) => quotes[index].ticker);
    const tuples = toPost.map(({ index }) => tupleFor(quotes[index]));
    const signatures = await Promise.all(
      toPost.map(async ({ index }) => (await signQuote(quotes[index])).signature),
    );

    try {
      // Simulate before sending. postQuotes reports per-quote success in its
      // return value, and nothing else can see that without waiting for a
      // receipt — which this endpoint deliberately does not do, because eight
      // sequential receipts outlast the invocation. An eth_call is free and
      // answers the same question, so a bad signature is caught before it is
      // paid for rather than after.
      const sim = await pub.simulateContract({
        address: keeper as Hex,
        abi: HOOD_ORACLE_KEEPER_ABI,
        functionName: "postQuotes",
        args: [tickers, tuples, signatures],
        account,
      });
      const willPost = sim.result as readonly boolean[];

      if (willPost.some(Boolean)) {
        const hash = await wallet.writeContract({
          ...sim.request,
          nonce: nonce++,
        });
        batchHash = hash;
        batchHandled = true;

        toPost.forEach(({ index, reason }, i) => {
          const ticker = quotes[index].ticker;
          if (willPost[i]) {
            posted.push({ ticker, hash, reason });
          } else {
            // Not a failure of ours: almost always another relayer got there
            // first, which the next run's chain read resolves by itself.
            skipped.push({ ticker, reason: "rejected on simulation, likely already posted" });
          }
        });
      } else {
        // Every quote would be refused, so sending is pure gas.
        batchHandled = true;
        toPost.forEach(({ index }) => {
          skipped.push({
            ticker: quotes[index].ticker,
            reason: "whole batch rejected on simulation, nothing sent",
          });
        });
      }
    } catch (e) {
      // The batch itself could not even be simulated or sent. Fall through to
      // one-at-a-time rather than losing the round: a keeper misconfiguration
      // must not be able to stop the feed.
      failed.push({
        ticker: "(batch)",
        error: e instanceof Error ? e.message.split("\n")[0] : String(e),
      });
      batchHandled = false;
    }
  }

  if (!batchHandled) {
    for (const { index, reason } of toPost) {
      const q = quotes[index];
      try {
        const signed = await signQuote(q);
        const hash = await wallet.writeContract({
          address: oracle as Hex,
          abi: HOOD_ORACLE_ABI,
          functionName: "postQuote",
          args: [q.ticker, tupleFor(q), signed.signature],
          nonce: nonce++,
        });
        posted.push({ ticker: q.ticker, hash, reason });
      } catch (e) {
        failed.push({
          ticker: q.ticker,
          error: e instanceof Error ? e.message.split("\n")[0] : String(e),
        });
      }
    }
  }

  recordCall({
    at: now.toISOString(),
    outcome: "published",
    userAgent: callerAgent(req),
    posted: posted.length,
    skipped: skipped.length,
    failed: failed.length,
  });

  return NextResponse.json(
    {
      ok: failed.length === 0,
      time: now.toISOString(),
      session: SESSION_NAME[classifySession(now)],
      relayer: account.address,
      balanceEth: Number(balance) / 1e18,
      mode:
        toPost.length === 0
          ? "nothing to post"
          : batchHash
            ? "batched"
            : "one transaction per ticker",
      batchTx: batchHash,
      posted,
      skipped,
      failed,
      quoteErrors: errors,
    },
    {
      // A failed send answers 200, with ok:false and failed[] in the body.
      //
      // It used to answer 502 so the scheduler would notice, and cron-job.org
      // noticed by switching the job off. On Sunday 20 Sep its last run failed
      // with an HTTP error at 13:55 UTC, the job was disabled for too many
      // failures, and the feed stayed frozen until someone re-enabled it on
      // Wednesday. A failed send costs nothing to retry: the chain did not
      // move, so the next run finds the same quote still material. So the
      // scheduler must keep firing, and the alarm belongs on the outcome:
      // /api/health returns 503 once the chain goes stale, and that is what a
      // monitor watches.
      //
      // 401 and 503 above stay non-2xx. Those need a person either way.
      status: 200,
      headers: { "cache-control": "no-store" },
    },
  );
}
