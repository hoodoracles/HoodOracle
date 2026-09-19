# @hoodoracle/sdk

Session-aware price feeds for tokenised equities on **Robinhood Chain** (4663).

Every other equity oracle hands you a number. This one hands you a number,
**how it was obtained**, and **how wide the uncertainty is right now** — and
those two extra fields are the entire point, so this package exists to make
them hard to ignore and impossible to decode wrongly.

```bash
npm install @hoodoracle/sdk viem
```

## The thirty-second version

```ts
import { HoodOracle } from "@hoodoracle/sdk";

const oracle = new HoodOracle();          // mainnet, no config needed

// Throws unless this is an observed print from a live session.
const price = await oracle.price("HOOD");
```

`price()` refuses by default. On a Saturday it throws:

```
QuoteRejected: hoodoracle: HOOD rejected — provenance is DERIVED: the tape
was shut and this price is a model output, not an observed print
```

That is the library working. A tokenised share trades every hour of the week;
the share behind it prices six and a half hours a day. Roughly a third of every
week has no price discovery at all, and the number you get in that window is a
model output, not a fact. Everything here is built so you cannot confuse the
two by accident.

## What a quote carries

| Field | Meaning |
|---|---|
| `price` | 8-decimal integer. `12000000000n` is $120.00 |
| `confidenceBps` | Two-sided band. `424n` is ±4.24% |
| `provenance` | `TRADED` · `DERIVED` · `STALE` |
| `session` | `REGULAR` · `PRE` · `POST` · `CLOSED` · `HOLIDAY` |
| `sourceCount` | Independent upstreams behind the anchor |
| `maxDeviationBps` | Spread between the highest and lowest source |
| `lastTradeTime` | Unix seconds of the last real print |
| `publishTime` | Unix seconds the quote was computed |

The band is not a guess. It is fitted on two years of realised close-to-open
gaps and validated by a coverage test; the live score is published at
[/coverage](https://www.hoodoracle.org/coverage).

## Three things you can now write

**Only liquidate on a genuinely traded price.**

```ts
import { HoodOracle, QuoteRejected } from "@hoodoracle/sdk";

try {
  const price = await oracle.price("HOOD", { maxBps: 150, maxAgeSeconds: 900 });
  liquidate(position, price);
} catch (e) {
  if (e instanceof QuoteRejected) return; // not now — e.reasons says why
  throw e;
}
```

**Value collateral at the cautious end of the band.**

```ts
const floor = await oracle.conservativePrice("HOOD", "collateral"); // lower edge
const ceil  = await oracle.conservativePrice("HOOD", "debt");       // upper edge
```

Collateral takes the low edge and debt the high edge. Getting that backwards
turns an honest band into extra leverage.

**Pause new loans while the stock market is shut.**

```ts
import { Provenance } from "@hoodoracle/sdk";

const q = await oracle.getQuote("HOOD");
if (q.provenance !== Provenance.TRADED) return closeNewBorrows();
```

## Checking without throwing

```ts
const { ok, reasons } = await oracle.check("HOOD", {
  maxBps: 200,
  minSources: 2,
  maxAgeSeconds: 1800,
});
// reasons lists every failed condition, not just the first
```

## Fresher than the chain

The on-chain value is only as current as the last relay. The API signs on
demand, and **anyone may relay** — the contract trusts the signature, not the
sender. So if you need a newer number than the scheduler has posted, fetch it,
verify it, and post it yourself.

```ts
import { fetchQuote, verifyQuote } from "@hoodoracle/sdk";

const signed = await fetchQuote("HOOD");   // verified on arrival by default
await verifyQuote(signed);                 // or check it yourself, offline

await oracle.postQuote(walletClient, signed);  // you pay the gas
```

`verifyQuote` rebuilds the digest from the quote's own fields rather than
trusting the `digest` the server sends alongside it — so it catches a server
that signed something other than what it showed you. A valid signature still
tells you nothing about whether that key is *trusted*: check with
`oracle.isSigner(signed.signer)`.

## Batching, and finding out what is stale

`HoodOracleKeeper` is a helper contract beside the oracle. It mints no
authority — every quote it forwards is still checked against the oracle's own
signer allow-list — so anything done through it could have been done without
it, just in more transactions.

```ts
import { HoodOracleKeeper, HOOD_ORACLE_KEEPER_ADDRESS } from "@hoodoracle/sdk";

const keeper = new HoodOracleKeeper({ address: HOOD_ORACLE_KEEPER_ADDRESS });

// What should be posted again? A free view call, no permission needed.
const stale = await keeper.needsUpdate(["HOOD", "COIN", "TLT"]);
// { HOOD: false, COIN: false, TLT: true }

// Everything about a set of tickers, from one block.
const rows = await keeper.status(["HOOD", "COIN"]);
// [{ ticker, exists, price, confidenceBps, provenance, ageSeconds, stale }, …]
```

Posting several at once:

```ts
// Ask the chain what it would accept before paying for it.
const willLand = await keeper.simulate(signedQuotes, account);

await keeper.postQuotes(wallet, signedQuotes);
```

Batching saves ~21% of the gas, but the reason to use it is that every quote
lands in **one block**. Posted separately they land across as many blocks, so
a consumer reading mid-round gets a snapshot that never existed — one ticker
from one block and another from forty later, when both were priced against a
single proxy reading.

A quote the oracle refuses is reported `false` rather than thrown. The oracle
rejects anything not strictly newer than what it stores and anyone may relay,
so two relayers racing on one ticker is ordinary; if that reverted the batch,
one already-posted ticker would discard all the others.

`status` exists because separate `getQuote` calls are separate network round
trips that can interleave with a post, so code built on them can act on a view
of the feed that never existed at any instant.

## React

```tsx
import { useOnChainQuote } from "@hoodoracle/sdk/react";
import { Provenance, toDecimal } from "@hoodoracle/sdk";

function Price({ ticker }: { ticker: string }) {
  const { data, verdict, bounds } = useOnChainQuote(ticker, {
    policy: { maxBps: 200 },
  });
  if (!data) return <span>…</span>;

  return (
    <span>
      ${toDecimal(data.price).toFixed(2)}
      {" "}({toDecimal(bounds!.lower).toFixed(2)}–{toDecimal(bounds!.upper).toFixed(2)})
      {!verdict!.ok && <em title={verdict!.reasons.join("; ")}> not settleable</em>}
    </span>
  );
}
```

React is an optional peer dependency; the core entry point never imports it.

## Prices are integers

`price` and the band edges are `bigint` at 8 decimals, because that is what is
on chain and because the band arithmetic has to be exact. `band()` mirrors
`HoodOracle.getBandedPrice` — `(price * confidenceBps) / 10000` in integer
arithmetic — and the test suite asserts the local result equals the contract's
on every tracked ticker.

This is not pedantry. In floating point, `100 * (1 + 50/10000)` is
`100.49999999999999`, so a price sitting exactly on a ±0.50% edge falls the
wrong side of the comparison. Use `toDecimal()` for display, never before a
comparison.

## API

**Client** — `new HoodOracle({ address?, chain?, rpcUrl?, publicClient? })`
`getQuote` · `getQuotes` · `price` · `check` · `band` · `conservativePrice` ·
`isLive` · `isSigner` · `limits` · `postQuote`

**Keeper** — `new HoodOracleKeeper({ address, chain?, rpcUrl?, publicClient? })`
`needsUpdate` · `status` · `simulate` · `postQuotes` · `oracle`

**Pure helpers** — `band` · `conservativePrice` · `check` · `priceOrThrow` ·
`ageSeconds` · `describeBand` · `isTradingSession` · `toDecimal` · `toScaled`

**HTTP** — `fetchQuote` · `fetchBoard` · `fetchCoverage`

**Verification** — `quoteDigest` · `recoverSigner` · `verifyQuote`

**Constants** — `robinhoodChain` · `robinhoodChainTestnet` ·
`HOOD_ORACLE_ADDRESS` · `HOOD_ORACLE_KEEPER_ADDRESS` · `HOOD_ORACLE_ABI` ·
`HOOD_ORACLE_KEEPER_ABI` · `TICKERS` · `Session` · `Provenance`

## Caveats

The contract is **unaudited**. The default upstream is not licensed for
commercial redistribution. There is one signer and one relayer, so there is no
redundancy yet. Read [/docs](https://www.hoodoracle.org/docs) before
putting real money behind it.

ISC.
