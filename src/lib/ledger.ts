// The coverage ledger.
//
// hoodoracle's central claim is that the band means something: publish a 95%
// interval and 95% of the time the truth lands inside it. That claim is
// currently backed by a backtest over 3,990 historical gaps. A backtest is
// evidence about the past; it is not evidence that the thing running in
// production is still right.
//
// This reconstructs what we actually published, from the chain, and scores it
// against what the tape did next.
//
// THE ARCHIVE IS THE CHAIN. There is no database here on purpose. The contract
// keeps only the latest quote per ticker in storage, but every quote it ever
// accepted survives as a QuotePosted log, signed by a key the contract
// allow-listed. So the record cannot be edited after the fact, does not depend
// on any service of ours staying up, and anyone can recompute these numbers
// from Robinhood Chain without asking us for anything. A Postgres mirror would
// be faster and strictly less trustworthy.
//
// One wrinkle worth knowing: the event declares `string indexed ticker`, and an
// indexed dynamic type is stored as keccak256 of its contents, not the string.
// The ticker is therefore not recoverable from the log — it has to be matched
// against hashes of the universe we already know.

import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  keccak256,
  parseAbiItem,
  toHex,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { Provenance, Session } from "./types";
import { UNIVERSE } from "./universe";
import { cached } from "./cache";
import { PRICE_DECIMALS } from "./sign";
import { CALIBRATION } from "./calibration";

export const QUOTE_POSTED_EVENT = parseAbiItem(
  "event QuotePosted(string indexed ticker, uint128 price, uint64 confidenceBps, uint8 session, uint8 provenance, uint64 publishTime, address signer)",
);

const SCALE = 10 ** PRICE_DECIMALS;

/** keccak256(ticker) -> ticker, to undo the indexed-string hashing. */
const TICKER_BY_TOPIC = new Map<string, string>(
  UNIVERSE.map((i) => [keccak256(toHex(i.ticker)), i.ticker]),
);

export interface PublishedQuote {
  ticker: string;
  /**
   * The raw uint128, 8 decimals, exactly as stored.
   *
   * Kept alongside the float because the hit/miss decision is made in integer
   * arithmetic. See `resolve()`.
   */
  priceScaled: bigint;
  /** USD, decoded from the 8-decimal on-chain integer. For display only. */
  price: number;
  confidenceBps: number;
  session: Session;
  provenance: Provenance;
  /** Unix seconds, as signed — not the block timestamp. */
  publishTime: number;
  signer: Hex;
  blockNumber: number;
  txHash: Hex;
  logIndex: number;
}

export interface ChainConfig {
  address: Hex;
  rpcUrl: string;
  chainId: number;
  chainName: string;
}

/** Null rather than throwing: an API-only deployment has no chain configured. */
export function chainConfig(): ChainConfig | null {
  const address = process.env.NEXT_PUBLIC_ORACLE_ADDRESS as Hex | undefined;
  const rpcUrl = process.env.NEXT_PUBLIC_ORACLE_RPC;
  const chainId = Number(process.env.NEXT_PUBLIC_ORACLE_CHAIN_ID ?? 0);
  if (!address || !rpcUrl || !chainId) return null;
  return {
    address,
    rpcUrl,
    chainId,
    chainName: process.env.NEXT_PUBLIC_ORACLE_CHAIN ?? `chain ${chainId}`,
  };
}

export function publicClientFor(cfg: ChainConfig): PublicClient {
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  return createPublicClient({ chain, transport: http(cfg.rpcUrl) });
}

function decode(log: Log): PublishedQuote | null {
  const ticker = TICKER_BY_TOPIC.get(log.topics[1] ?? "");
  // A log for a ticker outside the current universe. Skipping rather than
  // guessing keeps a delisted or renamed symbol from silently polluting the
  // statistics under the wrong name.
  if (!ticker) return null;

  const { args } = decodeEventLog({
    abi: [QUOTE_POSTED_EVENT],
    data: log.data,
    topics: log.topics,
  }) as { args: Record<string, bigint | number | Hex> };

  return {
    ticker,
    priceScaled: args.price as bigint,
    price: Number(args.price as bigint) / SCALE,
    confidenceBps: Number(args.confidenceBps as bigint),
    session: Number(args.session) as Session,
    provenance: Number(args.provenance) as Provenance,
    publishTime: Number(args.publishTime as bigint),
    signer: args.signer as Hex,
    blockNumber: Number(log.blockNumber ?? 0n),
    txHash: (log.transactionHash ?? "0x") as Hex,
    logIndex: log.logIndex ?? 0,
  };
}

/**
 * Fetch logs over a range, halving on failure.
 *
 * Every RPC caps eth_getLogs differently — by block span, by result count, or
 * by response bytes — and some report the cap in the error while others just
 * time out. Bisecting discovers whatever the real limit is without needing it
 * configured, and costs one extra round trip per doubling. At today's volume
 * the whole history comes back in a single call and this never recurses.
 */
async function getLogsBisect(
  client: PublicClient,
  address: Hex,
  from: bigint,
  to: bigint,
  depth = 0,
): Promise<Log[]> {
  if (from > to) return [];
  try {
    return (await client.getLogs({
      address,
      event: QUOTE_POSTED_EVENT,
      fromBlock: from,
      toBlock: to,
    })) as Log[];
  } catch (err) {
    // A single block that still fails is a real RPC fault, not a range limit.
    if (from === to || depth > 24) throw err;
    const mid = from + (to - from) / 2n;
    const [a, b] = await Promise.all([
      getLogsBisect(client, address, from, mid, depth + 1),
      getLogsBisect(client, address, mid + 1n, to, depth + 1),
    ]);
    return [...a, ...b];
  }
}

interface Archive {
  quotes: PublishedQuote[];
  scannedTo: bigint;
  chainId: number;
  address: Hex;
}

let archive: Archive | null = null;

/**
 * Re-scan this many blocks below the last scan on every extension.
 *
 * Cheap insurance against a reorg having rewritten the tail after we cached it.
 * Duplicates are removed by (txHash, logIndex), so overlapping is free.
 */
const REORG_OVERLAP = 500n;

/** How long a completed scan is served without touching the RPC. */
const ARCHIVE_TTL_MS = 30_000;

/**
 * Every quote the contract has ever accepted, oldest first.
 *
 * Extended incrementally: the first call walks the full history, later calls
 * ask only for blocks since the last scan. The cache is per serverless
 * instance and is a pure optimisation — a cold instance rebuilds from the
 * chain and gets the same answer.
 */
export async function loadArchive(
  cfg: ChainConfig,
  opts: { fresh?: boolean } = {},
): Promise<PublishedQuote[]> {
  const key = `ledger:${cfg.chainId}:${cfg.address.toLowerCase()}`;
  if (opts.fresh) archive = null;

  return cached(key, opts.fresh ? 0 : ARCHIVE_TTL_MS, async () => {
    const client = publicClientFor(cfg);
    const head = await client.getBlockNumber();

    // Any change of target invalidates the whole cache: quotes from a
    // different deployment are not comparable.
    const reusable =
      archive &&
      archive.chainId === cfg.chainId &&
      archive.address.toLowerCase() === cfg.address.toLowerCase();

    const from = reusable
      ? archive!.scannedTo > REORG_OVERLAP
        ? archive!.scannedTo - REORG_OVERLAP
        : 0n
      : 0n;

    const fetched = await getLogsBisect(client, cfg.address, from, head);
    const decoded = fetched
      .map(decode)
      .filter((q): q is PublishedQuote => q !== null);

    const merged = new Map<string, PublishedQuote>();
    if (reusable) {
      for (const q of archive!.quotes) merged.set(`${q.txHash}:${q.logIndex}`, q);
    }
    for (const q of decoded) merged.set(`${q.txHash}:${q.logIndex}`, q);

    const quotes = [...merged.values()].sort(
      (a, b) =>
        a.blockNumber - b.blockNumber ||
        a.logIndex - b.logIndex ||
        a.publishTime - b.publishTime,
    );

    archive = { quotes, scannedTo: head, chainId: cfg.chainId, address: cfg.address };
    return quotes;
  });
}

// ---------------------------------------------------------------- scoring

/**
 * One band, put to the test.
 *
 * `predicted` is a quote published while the tape was shut. `resolved` is the
 * first live print that followed it. If the model is honest, 95% of these
 * should have `hit === true`.
 */
export interface Resolution {
  ticker: string;
  predictedAt: number;
  predictedPrice: number;
  confidenceBps: number;
  lower: number;
  upper: number;
  session: Session;
  provenance: Provenance;
  resolvedAt: number;
  resolvedPrice: number;
  /** Seconds between publishing the band and the print that tested it. */
  leadSeconds: number;
  hit: boolean;
  /** Signed realised move, in bps. Positive means the print came in above. */
  errorBps: number;
  /** |errorBps| / confidenceBps. Above 1.0 is a miss. */
  ratio: number;
  txHash: Hex;
}

export interface CoverageStats {
  n: number;
  hits: number;
  /** null when n is 0 — an unmeasured rate is not 0%. */
  coveragePct: number | null;
  /** Wilson 95% interval on the coverage proportion. */
  ci: { lower: number; upper: number } | null;
  /** Mean |errorBps| / confidenceBps. Near 0.5 means the band is well sized. */
  meanRatio: number | null;
}

/**
 * Wilson score interval.
 *
 * With a handful of samples the naive proportion is close to meaningless —
 * "100% (3 of 3)" and "95% (3,990 of 4,200)" are not the same statement, and
 * printing both as a bare percentage invites the reader to treat them alike.
 * Wilson stays inside [0,1] and stays sane at the extremes, which the normal
 * approximation does not.
 */
export function wilson(
  hits: number,
  n: number,
  z = 1.96,
): { lower: number; upper: number } | null {
  if (n === 0) return null;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lower: Math.max(0, (centre - spread) / d) * 100,
    upper: Math.min(1, (centre + spread) / d) * 100,
  };
}

function summarise(rs: Resolution[]): CoverageStats {
  const n = rs.length;
  const hits = rs.filter((r) => r.hit).length;
  return {
    n,
    hits,
    coveragePct: n ? (hits / n) * 100 : null,
    ci: wilson(hits, n),
    meanRatio: n ? rs.reduce((s, r) => s + r.ratio, 0) / n : null,
  };
}

/**
 * Decide a single band, in integer arithmetic.
 *
 * The edges are computed the way HoodOracle.getBandedPrice computes them —
 * `(price * confidenceBps) / 10_000` in uint256, truncating — so the interval
 * scored here is byte-for-byte the interval a consumer reading the contract
 * would be handed. Doing it in floating point instead is not merely imprecise,
 * it changes answers: `100 * (1 + 50/10_000)` evaluates to 100.49999999999999,
 * so a print at exactly 100.50 on a ±0.50% band scores as a miss. Boundary
 * cases are rare but they are not random — they cluster wherever the band is
 * doing its job — and silently dropping them biases coverage downward.
 */
function resolve(
  predicted: PublishedQuote,
  resolvedBy: PublishedQuote,
): Resolution {
  const adj =
    (predicted.priceScaled * BigInt(predicted.confidenceBps)) / 10_000n;
  const lowerScaled = predicted.priceScaled - adj;
  const upperScaled = predicted.priceScaled + adj;
  const got = resolvedBy.priceScaled;

  const errorBps =
    predicted.priceScaled === 0n
      ? 0
      : (Number(got - predicted.priceScaled) / Number(predicted.priceScaled)) *
        10_000;

  return {
    ticker: predicted.ticker,
    predictedAt: predicted.publishTime,
    predictedPrice: predicted.price,
    confidenceBps: predicted.confidenceBps,
    lower: Number(lowerScaled) / SCALE,
    upper: Number(upperScaled) / SCALE,
    session: predicted.session,
    provenance: predicted.provenance,
    resolvedAt: resolvedBy.publishTime,
    resolvedPrice: resolvedBy.price,
    leadSeconds: resolvedBy.publishTime - predicted.publishTime,
    hit: got >= lowerScaled && got <= upperScaled,
    errorBps,
    ratio: predicted.confidenceBps
      ? Math.abs(errorBps) / predicted.confidenceBps
      : Infinity,
    txHash: predicted.txHash,
  };
}

/** A stretch of shut tape, and the print that ended it. */
export interface Episode {
  ticker: string;
  /** Every non-TRADED quote published during the closure, in order. */
  quotes: PublishedQuote[];
  /** The live print that resolved it. */
  reopen: PublishedQuote;
  /** Scoring the last band published before the print. */
  atReopen: Resolution;
  /** Scoring every band published during the closure. */
  all: Resolution[];
}

export interface Ledger {
  /** Every quote read off the chain. */
  quotes: PublishedQuote[];
  episodes: Episode[];
  /**
   * THE HEADLINE. One score per closure, using the last band published before
   * the tape reopened.
   *
   * This is the live analogue of the backtest and the only apples-to-apples
   * comparison with it. The fitted sigma is anchored on a *complete*
   * close-to-open gap, so the band is only claiming to cover the full gap once
   * the full gap has elapsed — which is exactly the last quote before the
   * reopen.
   */
  atReopen: CoverageStats;
  /**
   * Every band published during a closure, scored against the eventual reopen.
   *
   * Expect this to read lower than `atReopen`, and that is not a bug. The band
   * widens with elapsed staleness, so a quote published an hour into a 62-hour
   * weekend carries an overnight-sized band against a weekend-sized move. It is
   * reported because a consumer reading the feed on Saturday morning gets that
   * quote, not the Monday one, and should be able to see how the band behaves
   * there.
   */
  allDuringClosure: CoverageStats;
  perTicker: Record<string, CoverageStats>;
  /** Unresolved closures: published, tape has not reopened yet. */
  pending: { ticker: string; quotes: number; since: number }[];
  nominalPct: number;
  firstPublish: number | null;
  lastPublish: number | null;
  signers: Hex[];

  /**
   * Unix seconds at which the running calibration was fitted.
   *
   * `npm run calibrate` rewrites the betas and sigmas, and quotes published
   * before that moment were banded by a different model. The archive has
   * already straddled one such change: the very first HOOD quote on chain
   * carries 162bps, and the next one, eighty minutes later, carries 376bps at
   * barely more staleness. Nothing about the market did that — the parameters
   * underneath changed.
   */
  calibratedAt: number;
  /**
   * The same headline, restricted to bands the *current* model produced.
   *
   * Both are reported because they answer different questions. `atReopen` is
   * the track record: what consumers were actually handed, warts included, and
   * it is not ours to retouch. `sinceCalibration` is the diagnostic: is the
   * model running right now well calibrated? Publishing only the first would
   * be uninformative, and publishing only the second would be marking our own
   * homework by discarding the quotes we have since decided we do not like.
   */
  sinceCalibration: CoverageStats;
  /** Resolutions whose band predates the running calibration. */
  beforeCalibration: number;
}

/**
 * Score the archive.
 *
 * The rule: a quote whose provenance is not TRADED is a claim about a price
 * nobody can observe yet. The first TRADED quote that follows it for the same
 * ticker is the observation that settles the claim.
 *
 * Live prints are not scored against each other. A TRADED band is source
 * dispersion plus execution noise around a price that already exists — it is
 * not a forecast, so asking whether the *next* print landed inside it would be
 * testing a claim the oracle never made.
 */
export function buildLedger(quotes: PublishedQuote[], nominalPct = 95): Ledger {
  const byTicker = new Map<string, PublishedQuote[]>();
  for (const q of quotes) {
    const list = byTicker.get(q.ticker);
    if (list) list.push(q);
    else byTicker.set(q.ticker, [q]);
  }

  const episodes: Episode[] = [];
  const pending: Ledger["pending"] = [];

  for (const [ticker, list] of byTicker) {
    const ordered = [...list].sort((a, b) => a.publishTime - b.publishTime);
    let run: PublishedQuote[] = [];

    for (const q of ordered) {
      if (q.provenance === Provenance.TRADED) {
        if (run.length) {
          episodes.push({
            ticker,
            quotes: run,
            reopen: q,
            atReopen: resolve(run[run.length - 1], q),
            all: run.map((p) => resolve(p, q)),
          });
          run = [];
        }
      } else {
        run.push(q);
      }
    }

    // A run still open at the end of the archive has not been tested yet.
    if (run.length) {
      pending.push({ ticker, quotes: run.length, since: run[0].publishTime });
    }
  }

  episodes.sort((a, b) => a.reopen.publishTime - b.reopen.publishTime);

  const atReopenAll = episodes.map((e) => e.atReopen);
  const duringAll = episodes.flatMap((e) => e.all);

  const perTicker: Record<string, CoverageStats> = {};
  for (const ticker of byTicker.keys()) {
    perTicker[ticker] = summarise(
      atReopenAll.filter((r) => r.ticker === ticker),
    );
  }

  const times = quotes.map((q) => q.publishTime);

  const calibratedAt = Math.floor(
    new Date(CALIBRATION.generatedAt).getTime() / 1000,
  );
  const current = atReopenAll.filter((r) => r.predictedAt >= calibratedAt);

  return {
    quotes,
    episodes,
    atReopen: summarise(atReopenAll),
    allDuringClosure: summarise(duringAll),
    perTicker,
    pending: pending.sort((a, b) => a.since - b.since),
    nominalPct,
    firstPublish: times.length ? Math.min(...times) : null,
    lastPublish: times.length ? Math.max(...times) : null,
    signers: [...new Set(quotes.map((q) => q.signer))],
    calibratedAt,
    sinceCalibration: summarise(current),
    beforeCalibration: atReopenAll.length - current.length,
  };
}

/** Read the chain and score it in one call. */
export async function loadLedger(
  opts: { fresh?: boolean } = {},
): Promise<{ ledger: Ledger; config: ChainConfig } | null> {
  const cfg = chainConfig();
  if (!cfg) return null;
  const quotes = await loadArchive(cfg, opts);
  return { ledger: buildLedger(quotes), config: cfg };
}
