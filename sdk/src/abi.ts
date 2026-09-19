/** The HoodOracle interface, as deployed. */
export const HOOD_ORACLE_ABI = [
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
    name: "getPrice",
    stateMutability: "view",
    inputs: [{ name: "ticker", type: "string" }],
    outputs: [
      { name: "price", type: "uint128" },
      { name: "publishTime", type: "uint64" },
    ],
  },
  {
    // The function a liquidation path should call. Reverts rather than
    // returning a modelled weekend price.
    type: "function",
    name: "getPriceIfTraded",
    stateMutability: "view",
    inputs: [
      { name: "ticker", type: "string" },
      { name: "maxBps", type: "uint64" },
    ],
    outputs: [{ name: "price", type: "uint128" }],
  },
  {
    type: "function",
    name: "getBandedPrice",
    stateMutability: "view",
    inputs: [
      { name: "ticker", type: "string" },
      { name: "lower", type: "bool" },
    ],
    outputs: [{ name: "price", type: "uint128" }],
  },
  {
    type: "function",
    name: "isLive",
    stateMutability: "view",
    inputs: [
      { name: "ticker", type: "string" },
      { name: "maxBps", type: "uint64" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isSigner",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "maxQuoteAge",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "maxAcceptableBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    // Anyone may relay. Only the signature is trusted.
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
    type: "event",
    name: "QuotePosted",
    inputs: [
      { name: "ticker", type: "string", indexed: true },
      { name: "price", type: "uint128", indexed: false },
      { name: "confidenceBps", type: "uint64", indexed: false },
      { name: "session", type: "uint8", indexed: false },
      { name: "provenance", type: "uint8", indexed: false },
      { name: "publishTime", type: "uint64", indexed: false },
      { name: "signer", type: "address", indexed: false },
    ],
  },
] as const;
