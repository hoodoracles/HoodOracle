/**
 * The keeper: batch relaying and staleness discovery.
 *
 * Optional everywhere. It mints no authority — every quote it forwards is
 * still checked against the oracle's own signer allow-list — so anything done
 * through it could have been done without it, just in more transactions.
 *
 * Two reasons to use it:
 *
 *   Posting several quotes lands them in ONE block. Eight separate
 *   transactions land across eight, and a consumer reading mid-round gets a
 *   snapshot that never existed: HOOD from one block, TLT from forty later,
 *   when the two were priced against a single proxy reading.
 *
 *   `needsUpdate` answers "what is stale" on-chain, for free, so anyone can
 *   run a keeper without access to whatever scheduler happens to be posting
 *   today.
 */

import {
  createPublicClient,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { HOOD_ORACLE_KEEPER_ABI } from "./abi-keeper.js";
import { robinhoodChain } from "./chain.js";
import { Provenance, Session, type SignedQuote, toScaled } from "./types.js";

export interface KeeperOptions {
  address: Address;
  chain?: Chain;
  rpcUrl?: string;
  publicClient?: PublicClient;
}

/** What the keeper knows about one ticker, in a single consistent read. */
export interface TickerStatus {
  ticker: string;
  exists: boolean;
  price: bigint;
  confidenceBps: bigint;
  session: Session;
  provenance: Provenance;
  publishTime: bigint;
  ageSeconds: bigint;
  stale: boolean;
}

export class HoodOracleKeeper {
  readonly address: Address;
  readonly chain: Chain;
  readonly client: PublicClient;

  constructor(options: KeeperOptions) {
    this.address = options.address;
    this.chain = options.chain ?? robinhoodChain;
    this.client =
      options.publicClient ??
      createPublicClient({
        chain: this.chain,
        transport: http(options.rpcUrl ?? this.chain.rpcUrls.default.http[0]),
      });
  }

  /** The oracle this keeper reads and writes. Worth checking before trusting one. */
  async oracle(): Promise<Address> {
    return (await this.client.readContract({
      address: this.address,
      abi: HOOD_ORACLE_KEEPER_ABI,
      functionName: "oracle",
    })) as Address;
  }

  /**
   * Which tickers should be posted again.
   * @param maxAge Seconds. 0 uses the oracle's own `maxQuoteAge`.
   */
  async needsUpdate(
    tickers: readonly string[],
    maxAge = 0,
  ): Promise<Record<string, boolean>> {
    const out = (await this.client.readContract({
      address: this.address,
      abi: HOOD_ORACLE_KEEPER_ABI,
      functionName: "needsUpdate",
      args: [tickers as string[], BigInt(maxAge)],
    })) as readonly boolean[];
    return Object.fromEntries(tickers.map((t, i) => [t, out[i]]));
  }

  /**
   * Everything about a set of tickers, from one block.
   *
   * Eight separate `getQuote` calls are eight network round trips that can
   * interleave with a post, so a keeper built on them can act on a view of
   * the feed that never existed at any single instant.
   */
  async status(
    tickers: readonly string[],
    maxAge = 0,
  ): Promise<TickerStatus[]> {
    const out = (await this.client.readContract({
      address: this.address,
      abi: HOOD_ORACLE_KEEPER_ABI,
      functionName: "status",
      args: [tickers as string[], BigInt(maxAge)],
    })) as readonly {
      exists: boolean;
      price: bigint;
      confidenceBps: bigint;
      session: number;
      provenance: number;
      publishTime: bigint;
      ageSeconds: bigint;
      stale: boolean;
    }[];

    return out.map((s, i) => ({
      ticker: tickers[i],
      exists: s.exists,
      price: s.price,
      confidenceBps: s.confidenceBps,
      session: s.session as Session,
      provenance: s.provenance as Provenance,
      publishTime: s.publishTime,
      ageSeconds: s.ageSeconds,
      stale: s.stale,
    }));
  }

  /**
   * Ask the chain which of these would actually be accepted, without sending.
   *
   * `postQuotes` reports per-quote success in its return value, and nothing
   * observes that without a receipt. An eth_call costs nothing and answers
   * the same question first, so a stale or forged quote is caught before it
   * is paid for rather than after.
   */
  async simulate(
    signed: readonly SignedQuote[],
    account: Account | Address,
  ): Promise<Record<string, boolean>> {
    const { tickers, tuples, sigs } = pack(signed);
    const sim = await this.client.simulateContract({
      address: this.address,
      abi: HOOD_ORACLE_KEEPER_ABI,
      functionName: "postQuotes",
      args: [tickers, tuples, sigs],
      account,
    });
    const result = sim.result as readonly boolean[];
    return Object.fromEntries(tickers.map((t, i) => [t, result[i]]));
  }

  /**
   * Relay several signed quotes in one transaction.
   *
   * A quote the oracle refuses is recorded rather than thrown, so one raced
   * ticker does not discard the rest. Call `simulate` first if you want to
   * know which before you spend the gas.
   */
  async postQuotes(
    wallet: WalletClient,
    signed: readonly SignedQuote[],
    account?: Account | Address,
  ): Promise<Hex> {
    const acct = account ?? wallet.account;
    if (!acct) throw new Error("postQuotes needs an account");
    const { tickers, tuples, sigs } = pack(signed);

    return wallet.writeContract({
      address: this.address,
      abi: HOOD_ORACLE_KEEPER_ABI,
      functionName: "postQuotes",
      chain: this.chain,
      account: acct,
      args: [tickers, tuples, sigs],
    });
  }
}

function pack(signed: readonly SignedQuote[]) {
  if (signed.length === 0) throw new Error("empty batch");
  return {
    tickers: signed.map((s) => s.quote.ticker),
    tuples: signed.map((s) => ({
      price: toScaled(s.quote.price),
      confidenceBps: BigInt(s.quote.confidenceBps),
      session: s.quote.session,
      provenance: s.quote.provenance,
      sourceCount: s.quote.sourceCount,
      maxDeviationBps: BigInt(Math.round(s.quote.maxDeviationBps)),
      lastTradeTime: BigInt(s.quote.lastTradeTime),
      publishTime: BigInt(s.quote.publishTime),
    })),
    sigs: signed.map((s) => s.signature),
  };
}
