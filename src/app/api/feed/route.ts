// The live Morpho example, read the way Morpho reads it.
//
// Reports whether the NVDA HoodOracleFeed is answering right now and, if not,
// why, decoded from the revert. Blockscout shows a refusal as a bare selector
// (0x4f079835), which tells an integrator nothing. The reason is the product.

import { NextResponse } from "next/server";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  type Hex,
} from "viem";
import { HOOD_ORACLE_FEED_ABI } from "@/lib/abi";
import { PROVENANCE_NAME, SESSION_NAME, type Provenance } from "@/lib/types";
import { classifySession } from "@/lib/session";
import { cached } from "@/lib/cache";
import { LIVE_FEED } from "@/lib/livefeed";

export const dynamic = "force-dynamic";

type Read =
  | { answering: true; value: string; updatedAt?: number }
  | { answering: false; reason: string; detail: string };

function refusal(e: unknown): Read {
  const revert =
    e instanceof BaseError
      ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null)
      : null;
  const name = revert?.data?.errorName;
  const args = (revert?.data?.args ?? []) as readonly unknown[];
  if (name === "NotLivePrint") {
    const p = PROVENANCE_NAME[Number(args[0]) as Provenance] ?? String(args[0]);
    return { answering: false, reason: `NotLivePrint(${p})`, detail: `the stored quote is ${p}, not an observed print` };
  }
  if (name === "StaleQuote") {
    return { answering: false, reason: "StaleQuote", detail: "the last live print is older than 30 minutes" };
  }
  if (name === "BandTooWide") {
    return { answering: false, reason: "BandTooWide", detail: `the band is ${args[0]}bps, over the ${args[1]}bps ceiling` };
  }
  if (name) return { answering: false, reason: name, detail: "" };
  return { answering: false, reason: "unreadable", detail: e instanceof Error ? e.message.split("\n")[0] : String(e) };
}

export async function GET() {
  const rpc = process.env.NEXT_PUBLIC_ORACLE_RPC;
  if (!rpc) return NextResponse.json({ error: "NEXT_PUBLIC_ORACLE_RPC not set" }, { status: 503 });

  const body = await cached("feed:nvda", 10_000, async () => {
    const client = createPublicClient({ transport: http(rpc) });
    const now = new Date();

    const feed: Read = await client
      .readContract({ address: LIVE_FEED.feed, abi: HOOD_ORACLE_FEED_ABI, functionName: "latestRoundData" })
      .then(([, answer, , updatedAt]) => ({
        answering: true as const,
        value: (Number(answer) / 1e8).toFixed(4),
        updatedAt: Number(updatedAt),
      }))
      .catch(refusal);

    const morpho: Read = await client
      .readContract({ address: LIVE_FEED.morphoOracle, abi: HOOD_ORACLE_FEED_ABI, functionName: "price" })
      .then((p) => ({ answering: true as const, value: p.toString() }))
      .catch(refusal);

    return {
      asOf: now.toISOString(),
      session: SESSION_NAME[classifySession(now)],
      ...LIVE_FEED,
      feedRead: feed,
      morphoPrice: morpho,
    };
  });

  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
