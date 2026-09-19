/**
 * Signature verification, offline.
 *
 * The digest is rebuilt from the quote's own fields rather than trusting the
 * `digest` the API sends alongside it. If those disagree, the server has
 * signed something other than what it showed you — which is exactly the case
 * worth catching, and exactly the one that comparing the server's digest to
 * itself would miss.
 */

import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import { toScaled, type ApiQuote, type SignedQuote } from "./types.js";

/** The exact tuple HoodOracle._digest reconstructs. Field order is consensus. */
const QUOTE_PARAMS = parseAbiParameters(
  "string ticker, uint128 price, uint64 confidenceBps, uint8 session, uint8 provenance, uint8 sourceCount, uint64 maxDeviationBps, uint64 lastTradeTime, uint64 publishTime",
);

export function quoteDigest(q: ApiQuote): Hex {
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

/** Recover the address that signed a quote. */
export async function recoverSigner(signed: SignedQuote): Promise<Address> {
  return recoverMessageAddress({
    message: { raw: quoteDigest(signed.quote) },
    signature: signed.signature,
  });
}

/**
 * True when the signature is valid and was made by the claimed signer.
 *
 * This says nothing about whether that signer is *trusted* — a valid signature
 * from a key the contract has never allow-listed is worthless. Pass
 * `expectSigner`, or check with `HoodOracle.isSigner`.
 */
export async function verifyQuote(
  signed: SignedQuote,
  expectSigner?: Address,
): Promise<boolean> {
  // The server's own digest must match the one the fields imply.
  if (signed.digest && quoteDigest(signed.quote) !== signed.digest) return false;
  try {
    const recovered = await recoverSigner(signed);
    const want = expectSigner ?? signed.signer;
    return recovered.toLowerCase() === want.toLowerCase();
  } catch {
    return false;
  }
}
