// Minimal ABI for the pieces the service itself calls.
//
// The full artifact lives in out/ after `forge build`, which is not committed,
// so the runtime carries only what it needs.

export const HOOD_ORACLE_ABI = [
  // Declared so a never-posted ticker decodes as NoQuote rather than a bare
  // selector, which /api/health would otherwise read as the RPC failing.
  { type: "error", name: "NoQuote", inputs: [{ name: "ticker", type: "string" }] },
  {
    type: "function",
    name: "postQuote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ticker", type: "string" },
      {
        name: "q",
        type: "tuple",
        components: [
          { name: "price", type: "uint128" },
          { name: "confidenceBps", type: "uint64" },
          { name: "session", type: "uint8" },
          { name: "provenance", type: "uint8" },
          { name: "sourceCount", type: "uint8" },
          { name: "maxDeviationBps", type: "uint64" },
          { name: "lastTradeTime", type: "uint64" },
          { name: "publishTime", type: "uint64" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getQuote",
    stateMutability: "view",
    inputs: [{ name: "ticker", type: "string" }],
    outputs: [
      {
        name: "q",
        type: "tuple",
        components: [
          { name: "price", type: "uint128" },
          { name: "confidenceBps", type: "uint64" },
          { name: "session", type: "uint8" },
          { name: "provenance", type: "uint8" },
          { name: "sourceCount", type: "uint8" },
          { name: "maxDeviationBps", type: "uint64" },
          { name: "lastTradeTime", type: "uint64" },
          { name: "publishTime", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "isSigner",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const QUOTE_TUPLE = {
  name: "q",
  type: "tuple",
  components: [
    { name: "price", type: "uint128" },
    { name: "confidenceBps", type: "uint64" },
    { name: "session", type: "uint8" },
    { name: "provenance", type: "uint8" },
    { name: "sourceCount", type: "uint8" },
    { name: "maxDeviationBps", type: "uint64" },
    { name: "lastTradeTime", type: "uint64" },
    { name: "publishTime", type: "uint64" },
  ],
} as const;

/**
 * HoodOracleKeeper: batch relaying and staleness discovery.
 *
 * A helper beside the oracle, not a replacement for it. It mints no authority
 * — every quote it forwards is still checked against the oracle's own signer
 * allow-list — so it is optional everywhere it appears.
 */
export const HOOD_ORACLE_KEEPER_ABI = [
  {
    type: "function",
    name: "postQuotes",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tickers", type: "string[]" },
      { ...QUOTE_TUPLE, name: "quotes", type: "tuple[]" },
      { name: "signatures", type: "bytes[]" },
    ],
    // Per-quote success, in the order supplied. A failure here is recorded
    // rather than thrown, so one raced ticker cannot discard the batch.
    outputs: [{ name: "posted", type: "bool[]" }],
  },
  {
    type: "function",
    name: "needsUpdate",
    stateMutability: "view",
    inputs: [
      { name: "tickers", type: "string[]" },
      { name: "maxAge", type: "uint64" },
    ],
    outputs: [{ name: "stale", type: "bool[]" }],
  },
  {
    type: "function",
    name: "status",
    stateMutability: "view",
    inputs: [
      { name: "tickers", type: "string[]" },
      { name: "maxAge", type: "uint64" },
    ],
    outputs: [
      {
        name: "out",
        type: "tuple[]",
        components: [
          { name: "exists", type: "bool" },
          { name: "price", type: "uint128" },
          { name: "confidenceBps", type: "uint64" },
          { name: "session", type: "uint8" },
          { name: "provenance", type: "uint8" },
          { name: "publishTime", type: "uint64" },
          { name: "ageSeconds", type: "uint64" },
          { name: "stale", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "oracle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "MAX_BATCH",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
