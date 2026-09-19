// Deployment targets.
//
// Chain IDs and RPCs below were verified live with eth_chainId, not copied from
// documentation. Re-check before a mainnet deploy.

import { defineChain, type Chain } from "viem";
import { arbitrum, arbitrumSepolia, foundry } from "viem/chains";

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  testnet: true,
});

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
});

export interface Target {
  key: string;
  chain: Chain;
  /** Where to get gas for a first deploy. */
  funding: string;
  live: boolean;
}

export const TARGETS: Record<string, Target> = {
  local: {
    key: "local",
    chain: foundry,
    funding: "anvil funds accounts automatically",
    live: false,
  },
  "arb-sepolia": {
    key: "arb-sepolia",
    chain: arbitrumSepolia,
    funding:
      "Sepolia faucet, then bridge at bridge.arbitrum.io, or an Arbitrum Sepolia faucet directly",
    live: false,
  },
  "rh-testnet": {
    key: "rh-testnet",
    chain: robinhoodTestnet,
    funding: "Robinhood Chain testnet faucet, see docs.robinhood.com/chain",
    live: false,
  },
  arbitrum: {
    key: "arbitrum",
    chain: arbitrum,
    funding: "real ETH bridged to Arbitrum One",
    live: true,
  },
  "rh-mainnet": {
    key: "rh-mainnet",
    chain: robinhoodMainnet,
    funding: "real ETH bridged to Robinhood Chain",
    live: true,
  },
};

export function resolveTarget(name: string): Target {
  const t = TARGETS[name];
  if (!t) {
    throw new Error(
      `unknown target "${name}". one of: ${Object.keys(TARGETS).join(", ")}`,
    );
  }
  return t;
}
