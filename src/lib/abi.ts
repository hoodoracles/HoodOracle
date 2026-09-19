// Minimal ABI for the pieces the service itself calls.
//
// The full artifact lives in out/ after `forge build`, which is not committed,
// so the runtime carries only what it needs.

export const HOOD_ORACLE_ABI = [
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
