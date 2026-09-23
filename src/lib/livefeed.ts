import type { Hex } from "viem";

/** The live Morpho example on Robinhood Chain mainnet, deployed 23 Sep 2026. */
export const LIVE_FEED = {
  ticker: "NVDA",
  feed: "0x334f71f9c9ff4efe730cf7b6e6b06c14c4b6a719" as Hex,
  morphoOracle: "0xc65d284Efa6A3Df34540CBC8BA7C7fcbD0258604" as Hex,
  marketId: "0x1484485e9ebcd3c5b70c18ab30369ace2a2807e36962fd46f6c19be79a84a2c4",
} as const;
