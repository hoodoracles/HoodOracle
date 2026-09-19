/**
 * @hoodoracle/sdk
 *
 * Session-aware price feeds for tokenised equities, on Robinhood Chain.
 *
 *   import { HoodOracle } from "@hoodoracle/sdk";
 *
 *   const oracle = new HoodOracle();
 *   const price = await oracle.price("HOOD");   // throws unless TRADED
 *
 * React bindings live at "@hoodoracle/sdk/react".
 */

export {
  Session,
  Provenance,
  SESSION_NAME,
  PROVENANCE_NAME,
  PRICE_DECIMALS,
  toDecimal,
  toScaled,
  type OnChainQuote,
  type ApiQuote,
  type SignedQuote,
} from "./types.js";

export {
  robinhoodChain,
  robinhoodChainTestnet,
  HOOD_ORACLE_ADDRESS,
  HOOD_ORACLE_KEEPER_ADDRESS,
  DEFAULT_API_URL,
  TICKERS,
  type Ticker,
} from "./chain.js";

export { HOOD_ORACLE_ABI } from "./abi.js";
export { HOOD_ORACLE_KEEPER_ABI } from "./abi-keeper.js";

export {
  band,
  conservativePrice,
  isTradingSession,
  check,
  priceOrThrow,
  ageSeconds,
  describeBand,
  QuoteRejected,
  type Policy,
  type Verdict,
} from "./band.js";

export { HoodOracle, NoQuote, type HoodOracleOptions } from "./client.js";

export {
  HoodOracleKeeper,
  type KeeperOptions,
  type TickerStatus,
} from "./keeper.js";

export {
  fetchQuote,
  fetchBoard,
  fetchCoverage,
  ApiError,
  type ApiOptions,
} from "./api.js";

export { quoteDigest, recoverSigner, verifyQuote } from "./verify.js";
