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
import { HOOD_ORACLE_ABI } from "@/lib/abi";
import { buildQuotes } from "@/lib/quote";
import { signQuote, isSignerConfigured, toScaled } from "@/lib/sign";
import { UNIVERSE } from "@/lib/universe";
import { SESSION_NAME } from "@/lib/types";
import { classifySession } from "@/lib/session";
import { callerAgent, recordCall } from "@/lib/lastcall";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Thresholds are tunable per chain: what is worth a transaction on a cheap L2
// is not worth one elsewhere. Defaults suit an Orbit chain where a post costs a
// fraction of a cent.
const PRICE_MOVE_BPS = Number(process.env.CRON_PRICE_MOVE_BPS ?? 10);
const BAND_MOVE_BPS = Number(process.env.CRON_BAND_MOVE_BPS ?? 15);
const MAX_ONCHAIN_AGE = Number(process.env.CRON_MAX_ONCHAIN_AGE ?? 3 * 3600);

interface StoredQuote {
  price: bigint;
  confidenceBps: bigint;
  publishTime: bigint;
}

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
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
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
    const s = stored[i];
    if (!s || s.publishTime === 0n) {
      toPost.push({ index: i, reason: "no quote on chain yet" });
      return;
    }
    if (BigInt(q.publishTime) <= s.publishTime) {
      skipped.push({ ticker: q.ticker, reason: "not newer than stored" });
      return;
    }

    const age = nowSec - Number(s.publishTime);
    const onChainPrice = Number(s.price) / 1e8;
    const priceMoveBps =
      onChainPrice > 0
        ? Math.abs((q.price - onChainPrice) / onChainPrice) * 10_000
        : Infinity;
    const bandMoveBps = Math.abs(q.confidenceBps - Number(s.confidenceBps));

    if (age >= MAX_ONCHAIN_AGE) {
      toPost.push({ index: i, reason: `on-chain quote is ${Math.round(age / 60)}m old` });
    } else if (priceMoveBps >= PRICE_MOVE_BPS) {
      toPost.push({ index: i, reason: `price moved ${priceMoveBps.toFixed(1)}bps` });
    } else if (bandMoveBps >= BAND_MOVE_BPS) {
      toPost.push({ index: i, reason: `band moved ${bandMoveBps.toFixed(0)}bps` });
    } else {
      skipped.push({
        ticker: q.ticker,
        reason: `unchanged (${priceMoveBps.toFixed(1)}bps price, ${bandMoveBps.toFixed(0)}bps band)`,
      });
    }
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

  for (const { index, reason } of toPost) {
    const q = quotes[index];
    try {
      const signed = await signQuote(q);
      const hash = await wallet.writeContract({
        address: oracle as Hex,
        abi: HOOD_ORACLE_ABI,
        functionName: "postQuote",
        args: [
          q.ticker,
          {
            price: toScaled(q.price),
            confidenceBps: BigInt(q.confidenceBps),
            session: q.session,
            provenance: q.provenance,
            sourceCount: q.sourceCount,
            maxDeviationBps: BigInt(Math.round(q.maxDeviationBps)),
            lastTradeTime: BigInt(q.lastTradeTime),
            publishTime: BigInt(q.publishTime),
          },
          signed.signature,
        ],
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
      posted,
      skipped,
      failed,
      quoteErrors: errors,
    },
    {
      // A run where every send threw used to answer 200, so a scheduler logged
      // it as "Successful" and nobody found out until someone read the chain.
      // The status has to carry the outcome, because the status is the only
      // part of this a scheduler looks at.
      //
      // Skipping everything is still 200: that is the materiality filter doing
      // its job, not a fault.
      status: failed.length > 0 ? 502 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}
