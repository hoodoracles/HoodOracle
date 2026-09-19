# hoodoracle

A session-aware price oracle for tokenized equities, delivered on Robinhood Chain.

Built on top of DIA's oracle infrastructure rather than replacing it.

---

## The problem

Robinhood Chain trades tokenized US equities and ETFs **around the clock**.
The underlying stocks price for 6.5 hours a day, 5 days a week.

```
Mon-Fri  09:30-16:00 ET   Regular      real price discovery
Mon-Fri  04:00-09:30      Pre-market   thin but real
Mon-Fri  16:00-20:00      After-hours  thin but real
Mon-Fri  20:00-04:00      DARK         8h/night
Fri 20:00 -> Sun 18:00    DARK         ~46 continuous hours
Sun 18:00 -> Mon 04:00    futures only ES/NQ reopen on Globex
+ ~10 market holidays
```

Roughly a third of every week has no price discovery, yet tokens can be
lent, liquidated and traded throughout it.

Existing oracles return one number and hide which regime it came from.
A lending market reading `HOOD = 118.40` cannot tell a live consolidated
print from Friday's close warmed over for two days, so it must assume the
worst at all times and price that into everyone's LTV.

## The product

Not a price. A price plus its epistemics.

```solidity
struct Quote {
    uint128 price;
    uint64  confidence;    // bps band, widens as the tape goes cold
    uint8   session;       // REGULAR|PRE|POST|CLOSED|HOLIDAY
    uint8   provenance;    // TRADED|DERIVED|STALE
    uint8   sourceCount;   // how many sources agreed
    uint64  maxDeviation;  // how much they disagreed
    uint64  lastTradeTime;
}
```

Consumers can then write real policy: allow liquidations only when
`provenance == TRADED`, scale LTV by `confidence`, halt on
`maxDeviation > threshold`.

One line: **DIA proves where a price came from. hoodoracle proves how much
to trust it right now.**

## Architecture

```
DIA (their problem)              hoodoracle (our product)
---------------------            ------------------------
118 sources, licensing     ->    session classifier
feeders, Lasernet          ->    confidence bands
aggregation, Spectra       ->    provenance labels
raw price for HOOD         ->    delivery on Robinhood Chain
```

```
[1] SOURCE      DIA RWA + assetInfo endpoints
                        v
[2] AGGREGATOR  session classifier, confidence model, deviation
                off-chain, signs each quote
                        v
[3] TRANSPORT   signed quotes, posted on demand (pull, not push)
                        v
[4] CONTRACT    verifies signature, exposes Quote struct
                        v
[5] CONSUMER    lending market / perp / vault
```

Pull rather than push: the price is genuinely unchanged for 60+ hours every
weekend. A heartbeat would be paying gas to say nothing. Same pattern as
DIA's `RequestOracle`.

## Verified facts

Confirmed from the HAR captures and live sources, not assumed.

| Fact | Evidence |
|---|---|
| DIA already prices HOOD | `api.diadata.org/v1/rwa/Equities/HOOD` in capture |
| DIA RWA catalog: 108 feeds | 72 stocks, 19 ETFs, 9 FX, 8 commodities |
| DIA APIs need no auth | verified in capture, 200 responses |
| DIA contracts are open source | `@dia-data/contracts-spectra` on npm |
| DIA RequestOracle on Arb Sepolia | `0x61D217a26D0Bff1D2b4c6f5880e621071326aadC` |
| DIA Lasernet Testnet domain | `100640` |
| Robinhood Chain mainnet live | 2026-07-01, Arbitrum Orbit L2 |
| Robinhood Chain testnet live | 2026-02-10 |
| Robinhood Chain trades equities 24/7 | validates the core thesis |
| Not available to US persons | 120+ other countries |

## Open risks

1. **Chainlink is a day-one Robinhood Chain partner.** We are not entering an
   empty field. The wedge is equity session-awareness specifically, which is
   a detail to a generalist oracle and the whole product here.
2. **DIA's free tier is explicitly not for production.** Their own config:
   "for testing and evaluation only". A production wrapper needs a commercial
   feed agreement. Fine for v1, must be resolved before real money.
3. **Strategic dependency on DIA.** Their pricing and goodwill are upstream of
   the whole product.
4. **Off-hours model must be backtested** against real closes before any
   derived number goes onchain. No extrapolated numbers.

## Chain decision

Arbitrum. Robinhood Chain is an Arbitrum Orbit L2, so it is the same EVM,
Solidity and tooling. DIA's own example targets Arbitrum Sepolia and their
Arbitrum support is live in the capture.

Develop on Arbitrum Sepolia -> prove on Arbitrum mainnet -> port to
Robinhood Chain.

## Stack

- Contracts: Solidity, targeting Arbitrum Orbit
- Aggregator: off-chain service, signs quotes
- Frontend: Next.js (version pinned to latest patched release, verified
  against the advisory database at setup, not assumed)

## Status

Planning. Awaiting further instructions before implementation.
