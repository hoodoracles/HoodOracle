// Quote signing.
//
// Each quote is hashed over exactly the fields the on-chain contract reads, so
// a consumer can verify the band and the provenance were signed by the same
// key that signed the price. Signing off-chain and posting on demand is the
// pull model: a weekend price does not change for 62 hours, so publishing it on
// a heartbeat would be paying gas to say nothing.

import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  verifyMessage,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Quote, SignedQuote } from "./types";

/**
 * True when a real signing key is configured.
 *
 * This matters more than it looks. Without a key the service still produces
 * well-formed signatures, but from an address the deployed contract has never
 * allow-listed, so every quote it publishes is rejected on-chain. A deployment
 * in that state looks entirely healthy from the outside, which is how it
 * reached production once already. Health and the quote endpoints read this so
 * the failure is loud instead of silent.
 */
export function isSignerConfigured(): boolean {
  const raw = process.env.ORACLE_SIGNER_KEY;
  return Boolean(raw && /^0x[0-9a-fA-F]{64}$/.test(raw));
}

function loadKey(): Hex {
  const raw = process.env.ORACLE_SIGNER_KEY;
  if (raw && /^0x[0-9a-fA-F]{64}$/.test(raw)) return raw as Hex;
  if (raw) {
    throw new Error(
      "ORACLE_SIGNER_KEY is set but is not a 32-byte hex private key",
    );
  }
  // No key configured: run with an ephemeral one so the app still boots in
  // development. Signatures will not be stable across restarts.
  if (!globalThis.__hoodoracleDevKey) {
    globalThis.__hoodoracleDevKey = generatePrivateKey();
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        "[hoodoracle] ORACLE_SIGNER_KEY not set, using an ephemeral dev key. " +
          "Signatures will change on restart and will NOT be accepted by any " +
          "deployed contract. Set one in .env.local or the host's environment.",
      );
    }
  }
  return globalThis.__hoodoracleDevKey;
}

declare global {
  // eslint-disable-next-line no-var
  var __hoodoracleDevKey: Hex | undefined;
}

/** The exact tuple the on-chain verifier reconstructs. */
const QUOTE_PARAMS = parseAbiParameters(
  "string ticker, uint128 price, uint64 confidenceBps, uint8 session, uint8 provenance, uint8 sourceCount, uint64 maxDeviationBps, uint64 lastTradeTime, uint64 publishTime",
);

/** Prices are carried on-chain with 8 decimals. */
export const PRICE_DECIMALS = 8;
const SCALE = 10n ** BigInt(PRICE_DECIMALS);

export function toScaled(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`cannot scale non-finite price: ${value}`);
  }
  // Round through a string to avoid float drift at the 8th decimal.
  const [whole, frac = ""] = value.toFixed(PRICE_DECIMALS).split(".");
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(PRICE_DECIMALS, "0"));
}

export function quoteDigest(q: Quote): Hex {
  return keccak256(
    encodeAbiParameters(QUOTE_PARAMS, [
      q.ticker,
      toScaled(q.price),
      BigInt(q.confidenceBps),
      q.session,
      q.provenance,
      q.sourceCount,
      BigInt(Math.round(q.maxDeviationBps)),
      BigInt(q.lastTradeTime),
      BigInt(q.publishTime),
    ]),
  );
}

export async function signQuote(q: Quote): Promise<SignedQuote> {
  const account = privateKeyToAccount(loadKey());
  const digest = quoteDigest(q);
  // Signed as an EIP-191 message so the contract can recover with
  // toEthSignedMessageHash, which is the cheapest path on-chain.
  const signature = await account.signMessage({ message: { raw: digest } });
  return { quote: q, signature, signer: account.address, digest };
}

export async function verifySignedQuote(s: SignedQuote): Promise<boolean> {
  if (quoteDigest(s.quote) !== s.digest) return false;
  return verifyMessage({
    address: s.signer,
    message: { raw: s.digest },
    signature: s.signature,
  });
}

export function signerAddress(): Hex {
  return privateKeyToAccount(loadKey()).address;
}
