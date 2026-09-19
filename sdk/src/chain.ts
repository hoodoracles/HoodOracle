import { defineChain } from "viem";

/**
 * Robinhood Chain mainnet.
 *
 * An Arbitrum Orbit L2, live since 1 July 2026, trading tokenised US equities
 * around the clock. The chain ID and RPC below were verified with eth_chainId
 * against the live node, not copied from documentation.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});

export const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  testnet: true,
});

/** The deployed HoodOracle on Robinhood Chain mainnet. */
export const HOOD_ORACLE_ADDRESS =
  "0x65cf45524407a5e700188a8a8178d5d5c0c38d30" as const;

/**
 * The deployed HoodOracleKeeper: batch relaying and staleness discovery.
 *
 * A helper beside the oracle, not part of it. Reading the feed needs only
 * HOOD_ORACLE_ADDRESS; this is for posting several quotes at once, or for
 * asking what is stale without running a scheduler.
 */
export const HOOD_ORACLE_KEEPER_ADDRESS =
  "0xc984336bf8f5218c601bbb1a83a070262b694aee" as const;

/** Where signed quotes are served from. */
export const DEFAULT_API_URL = "https://hoodoracle-neon.vercel.app" as const;

/** The instruments currently priced. */
export const TICKERS = [
  "HOOD",
  "COIN",
  "NVDA",
  "TSLA",
  "AAPL",
  "MSTR",
  "SPY",
  "TLT",
] as const;

export type Ticker = (typeof TICKERS)[number];
