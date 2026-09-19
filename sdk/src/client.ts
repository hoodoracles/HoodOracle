/**
 * On-chain reads.
 *
 * Defaults to the deployed contract on Robinhood Chain mainnet, so
 * `new HoodOracle()` works with no configuration. Pass a `publicClient` to use
 * your own transport, or `address`/`chain` to point at a different deployment.
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
import { HOOD_ORACLE_ABI } from "./abi.js";
import { HOOD_ORACLE_ADDRESS, robinhoodChain } from "./chain.js";
import {
  band,
  check,
  conservativePrice,
  priceOrThrow,
  type Policy,
  type Verdict,
} from "./band.js";
import {
  Provenance,
  Session,
  type OnChainQuote,
  type SignedQuote,
  toScaled,
} from "./types.js";

export interface HoodOracleOptions {
  address?: Address;
  chain?: Chain;
  rpcUrl?: string;
  /** Bring your own transport, rate limiting or caching. */
  publicClient?: PublicClient;
}

/** A quote that was never posted. Distinct from a stale one. */
export class NoQuote extends Error {
  constructor(ticker: string) {
    super(`hoodoracle: no quote has been posted for ${ticker}`);
    this.name = "NoQuote";
  }
}

export class HoodOracle {
  readonly address: Address;
  readonly chain: Chain;
  readonly client: PublicClient;

  constructor(options: HoodOracleOptions = {}) {
    this.address = options.address ?? (HOOD_ORACLE_ADDRESS as Address);
    this.chain = options.chain ?? robinhoodChain;
    this.client =
      options.publicClient ??
      createPublicClient({
        chain: this.chain,
        transport: http(options.rpcUrl ?? this.chain.rpcUrls.default.http[0]),
      });
  }

  /** The full quote: price, provenance, session, band. */
  async getQuote(ticker: string): Promise<OnChainQuote> {
    try {
      const q = (await this.client.readContract({
        address: this.address,
        abi: HOOD_ORACLE_ABI,
        functionName: "getQuote",
        args: [ticker],
      })) as {
        price: bigint;
        confidenceBps: bigint;
        session: number;
        provenance: number;
        sourceCount: number;
        maxDeviationBps: bigint;
        lastTradeTime: bigint;
        publishTime: bigint;
      };
      return {
        price: q.price,
        confidenceBps: q.confidenceBps,
        session: q.session as Session,
        provenance: q.provenance as Provenance,
        sourceCount: q.sourceCount,
        maxDeviationBps: q.maxDeviationBps,
        lastTradeTime: q.lastTradeTime,
        publishTime: q.publishTime,
      };
    } catch (e) {
      // The contract reverts NoQuote(ticker) for an instrument that has never
      // been posted. Surfacing that as a named error beats handing back a
      // decoding failure that looks like an RPC problem.
      if (e instanceof Error && /NoQuote/.test(e.message)) {
        throw new NoQuote(ticker);
      }
      throw e;
    }
  }

  /** Several tickers in one round trip. */
  async getQuotes(tickers: readonly string[]): Promise<Record<string, OnChainQuote>> {
    const results = await Promise.all(
      tickers.map(async (t) => [t, await this.getQuote(t)] as const),
    );
    return Object.fromEntries(results);
  }

  /**
   * The price, but only if a policy allows it.
   *
   * Defaults to `requireTraded: true`, so the no-arguments call refuses a
   * modelled weekend price rather than returning one and hoping the caller
   * checks.
   */
  async price(ticker: string, policy: Policy = {}): Promise<bigint> {
    return priceOrThrow(ticker, await this.getQuote(ticker), policy);
  }

  /** Check without throwing. */
  async check(ticker: string, policy: Policy = {}): Promise<Verdict> {
    return check(await this.getQuote(ticker), policy);
  }

  /** The two-sided interval, as integers. */
  async band(ticker: string): Promise<{ lower: bigint; upper: bigint }> {
    return band(await this.getQuote(ticker));
  }

  /** The cautious edge, for valuing collateral or debt. */
  async conservativePrice(
    ticker: string,
    kind: "collateral" | "debt",
  ): Promise<bigint> {
    return conservativePrice(await this.getQuote(ticker), kind);
  }

  /** Cheap on-chain predicate: live print, inside `maxBps`. */
  async isLive(ticker: string, maxBps: number): Promise<boolean> {
    return (await this.client.readContract({
      address: this.address,
      abi: HOOD_ORACLE_ABI,
      functionName: "isLive",
      args: [ticker, BigInt(maxBps)],
    })) as boolean;
  }

  /** Whether the contract trusts a given signing key. */
  async isSigner(address: Address): Promise<boolean> {
    return (await this.client.readContract({
      address: this.address,
      abi: HOOD_ORACLE_ABI,
      functionName: "isSigner",
      args: [address],
    })) as boolean;
  }

  /** The contract's own staleness and width ceilings. */
  async limits(): Promise<{ maxQuoteAge: bigint; maxAcceptableBps: bigint }> {
    const [maxQuoteAge, maxAcceptableBps] = await Promise.all([
      this.client.readContract({
        address: this.address,
        abi: HOOD_ORACLE_ABI,
        functionName: "maxQuoteAge",
      }) as Promise<bigint>,
      this.client.readContract({
        address: this.address,
        abi: HOOD_ORACLE_ABI,
        functionName: "maxAcceptableBps",
      }) as Promise<bigint>,
    ]);
    return { maxQuoteAge, maxAcceptableBps };
  }

  /**
   * Relay a signed quote on-chain.
   *
   * Anyone may do this — the contract trusts the signature, not the sender —
   * so a consumer who needs a fresher on-chain value than the scheduler has
   * posted can fetch one from the API and post it themselves. You pay the gas.
   */
  async postQuote(
    wallet: WalletClient,
    signed: SignedQuote,
    account?: Account | Address,
  ): Promise<Hex> {
    const q = signed.quote;
    const acct = account ?? wallet.account;
    if (!acct) throw new Error("postQuote needs an account");

    return wallet.writeContract({
      address: this.address,
      abi: HOOD_ORACLE_ABI,
      functionName: "postQuote",
      chain: this.chain,
      account: acct,
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
    });
  }
}
