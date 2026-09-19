# hoodoracle

Session-aware price feeds for tokenised equities. **Live on Robinhood Chain
mainnet.**

```
contract  0x65cf45524407a5e700188a8a8178d5d5c0c38d30
chain     Robinhood Chain (4663)
```

Robinhood Chain went live on 1 July 2026 as an Arbitrum Orbit L2 and trades
tokenised US equities around the clock, with DeFi lending on top. The shares
those tokens represent price for six and a half hours a day. **Roughly a third
of every week has no price discovery at all**, and a tokenised position can be
lent against or liquidated in every hour of it.

Every other oracle returns one number and hides which regime it came from.
hoodoracle returns the number together with how it was obtained and how much to
trust it right now.

## Sourcing

No single upstream. Providers are pluggable and the oracle runs on whichever are
configured, so no vendor's terms or uptime become ours.

| Provider | Key needed | Reports print time | Terms | Default |
|---|---|---|---|---|
| Yahoo Finance | no | yes | unofficial | **on** |
| Alpaca (IEX) | free | yes | free-tier | off |
| Finnhub | free | yes | free-tier | off |
| Twelve Data | free | no | free-tier | off |
| DIA | no | no | evaluation-only | off |

The consensus price is the **median** across whichever resolved, so one bad feed
cannot drag it. `maxDeviationBps` is the real spread between them and widens the
band directly. Only providers that report genuine print times may establish
freshness; the rest can contribute a price but not a timestamp.

DIA is off by default. Their own configuration documents the free tier as
evaluation-only, and their RWA endpoint stamps some tickers with fetch time
rather than print time. Set `DIA_ENABLED=true` to include it as a cross-check.

Yahoo is marked `unofficial`: it needs no key and reports a real
`regularMarketTime`, which makes it the best free source for freshness, but it
is not licensed for commercial redistribution. Fine for building, not a
production source. Add a licensed vendor before going live.

## Quick start

```bash
npm install
cp .env.local.example .env.local   # or let it generate an ephemeral dev key
npm run dev
```

```bash
curl localhost:3000/api/quote/HOOD
```

## What it returns

```jsonc
{
  "quote": {
    "ticker": "HOOD",
    "price": 119.885308,        // what to use
    "anchorPrice": 119.83,      // last price actually seen on tape
    "confidenceBps": 86,        // ±0.86%
    "session": 3,               // CLOSED
    "provenance": 1,            // DERIVED
    "lastTradeTime": 1789775964,
    "driftBps": 4.3,
    "method": "Tape is shut. Close from 1 source drifted by a 0.45 beta against
               a -0.07% blended BTC/ETH move measured over the same 4.7h window."
  },
  "signature": "0x7e6e…",
  "signer": "0xA139…"
}
```

A consumer contract reads `provenance` before it reads `price`.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/quotes` | Every instrument, priced against one proxy snapshot |
| `GET /api/quote/:ticker` | One instrument, signed, with digest and signer |
| `GET /api/health` | Upstream reachability, signer, session. 503 when upstream is down |

## Pages

| Route | |
|---|---|
| `/` | Live feed board with session state and countdown |
| `/why` | The problem, the weekly calendar, the model |
| `/docs` | Field semantics, confidence model, signature verification |
| `/playground` | Live API calls against the running service |
| `/integrate` | Solidity interface and consumer policy examples |
| `/feed/:ticker` | Per-instrument detail with the signed payload |

## The confidence model

```
live print:
  bps = BASE[session] + maxDeviationBps       // 8 regular, 35 pre/post

gap (DERIVED or STALE):
  sigma = overnightSigmaBps * (hours/17.5)^k  // both fitted
  bps   = 1.96 * sigma + maxDeviationBps      // two-sided 95%
  bps   = max(bps, BASE[CLOSED])              // never tighter than a live one
```

Every parameter is **fitted**, not chosen. `npm run calibrate` regresses two
years of realised close-to-open gaps against the blended BTC/ETH move over the
identical window and writes `src/lib/calibration.json`.

### The √t model was wrong

The first version widened the band by `√t`, on the standard argument that
uncertainty under a random walk grows with the square root of elapsed time.
Fitting `σ ∝ hours^k` against real gaps gives:

```
median k = 0.107        (√t would be 0.50)
```

A weekend is ~3.7x the clock hours of an overnight gap, yet its realised
dispersion is only a few percent wider. Calendar time is a poor clock for market
risk: information arrives around the close and the open, not evenly through
Saturday.

The practical consequence is that **almost all of the weekend's uncertainty
exists the moment the bell rings.** A protocol that widens gradually through a
weekend is mispricing Friday evening. The old model went ±0.53% → ±6.84% across
a weekend; the fitted one goes ±3.60% → ±4.80%, which is what actually happens.

### Fitted parameters

| Ticker | Fitted β | Prior β | R² | Overnight σ | Weekend σ | Coverage |
|---|---|---|---|---|---|---|
| HOOD | 0.690 | 0.45 | 0.379 | 215 | 232 | 93.8% |
| COIN | 0.791 | 0.60 | 0.557 | 180 | 165 | 93.4% |
| NVDA | 0.275 | 0.20 | 0.148 | 150 | 184 | 95.0% |
| TSLA | 0.357 | 0.25 | 0.172 | 188 | 218 | 95.2% |
| AAPL | 0.115 | 0.12 | 0.064 | 104 | 124 | 96.4% |
| MSTR | 0.950 | 0.80 | 0.645 | 169 | 195 | 94.2% |
| SPY | 0.128 | 0.15 | 0.241 | 55 | 62 | 95.8% |
| TLT | 0.001 | 0.00 | -0.002 | 57 | 65 | 95.6% |

Every prior was too low except AAPL and TLT. R² is the share of gap variance the
crypto proxy explains: 56% for COIN, essentially zero for TLT, which is why TLT
gets no drift applied at all.

**Coverage** is the validation that matters. The band claims to be a 95%
interval, so every historical gap is replayed and counted. All eight land
between 93.4% and 96.4% across ~500 gaps each. That number is the difference
between a calibrated band and a guess.

### Off-hours drift

The proxy move is measured over **exactly the window the tape was shut**, from
BTC and ETH hourly closes. An earlier version scaled a 24h return by
`gapHours/24`, which assumed the move was spread evenly across the day and
stopped accumulating past 24 hours. Measuring the actual window removes both
fudges. Where the series does not reach back far enough, drift is zero rather
than extrapolated.

## Tests

```bash
npm run calibrate       # refit betas and bands, writes calibration.json
npm run typecheck       # tsc, clean
npm run test:unit       # session classifier + live provider quotes + signing
npm run test:providers  # provider registry, consensus, proxy series
npm run test:weekend    # confidence widening across the dark window
npm run test:browser    # Playwright across every page, console errors, mobile
npm run test:onchain    # deploy to anvil, post a real signed quote, read back
```

`test:browser` needs `npm run dev` running. `test:onchain` needs `anvil` and
`npm run dev` running, plus `forge build` first.

### What the on-chain test proves

```
deploy        1,364,579 gas
post quote       88,073 gas
round-trip    MATCH          price survives the encode/sign/recover path
policy guard  PASS           getPriceIfTraded reverts on a DERIVED quote
replay guard  PASS           re-posting the same quote is rejected
```

The digest is `keccak256` over the abi-encoded tuple, computed identically in
`src/lib/sign.ts` and `HoodOracle._digest`. If those disagree by one byte the
signature will not recover, which is why the on-chain test exists.

## Three real bugs this build caught

**Upstream timestamps cannot be trusted.** DIA's RWA endpoint stamps some
tickers with fetch time rather than print time. Query `HOOD` at midnight UTC on
a Saturday and the timestamp looks live. `lastTradableInstant()` reconciles
every upstream timestamp against the exchange calendar instead: if the tape is
shut, the true last print is the close of the last open session, whatever the
upstream says.

**The band must not collapse at a session boundary.** Without the
`max(bps, BASE[CLOSED])` line, the band dropped from ±7.00% to ±3.74% the
moment the session label flipped from CLOSED to PRE on Monday morning, even
though the data had not improved at all. A stale anchor does not become
trustworthy because the opening bell rang.

**A renamed API field crashed the dashboard.** Switching the proxy from a scaled
24h return to a gap-window measurement renamed `return24hPct` to
`moveSinceGapPct`; the UI still read the old name and died on `.toFixed` of
`undefined`. The browser suite caught it as a hard page timeout rather than a
silent regression, which is the argument for driving a real browser in tests.

## Deploying

Two independent deployments: the contract to a chain, and the service to a host.

### Targets

Chain IDs and RPCs below were verified live with `eth_chainId`, not copied from
docs.

| Target | Chain | ID | RPC |
|---|---|---|---|
| `local` | Anvil | 31337 | `http://127.0.0.1:8545` |
| `arb-sepolia` | Arbitrum Sepolia | 421614 | `sepolia-rollup.arbitrum.io/rpc` |
| `rh-testnet` | Robinhood Chain Testnet | 46630 | `rpc.testnet.chain.robinhood.com` |
| `arbitrum` | Arbitrum One | 42161 | `arb1.arbitrum.io/rpc` |
| `rh-mainnet` | Robinhood Chain | 4663 | `rpc.mainnet.chain.robinhood.com` |

### Contract

```bash
forge build

export DEPLOYER_KEY=0x...          # pays gas
export ORACLE_SIGNER_KEY=0x...     # its address gets allow-listed

npm run deploy -- rh-testnet
npm run publish -- rh-testnet 0xDeployedAddress --watch
```

The deployer and signer are deliberately separate keys. The deployer is a hot
wallet that can be rotated; the signer is what the system's trust rests on.

Guards in the deploy script: it verifies the RPC's actual chain ID matches the
target before spending anything, checks the balance covers the estimate, and
refuses a live chain without `DEPLOY_CONFIRM=yes`.

The publisher simulates every call before sending, so a quote that would revert
is skipped rather than paid for.

### Measured costs

```
deploy      1,364,579 gas
post quote     88,073 gas  (cold slot)
post quote     53,861 gas  (warm slot, subsequent updates)
```

At 0.01 gwei, typical for an Arbitrum Orbit L2, a deploy is a fraction of a
cent and a quote update is negligible. Cost is not a constraint here.

### Live deployment

```
Robinhood Chain mainnet (4663)
contract   0x65cf45524407a5e700188a8a8178d5d5c0c38d30
deploy tx  0x009c3ff1f3147998762689fc224be5c9d03eb2c006b4538309a38ef3c7f0b8d8
block      66662545
deploy     1,364,579 gas   0.0000938 ETH
8 feeds posted, ~88k gas each
```

Read it without any local setup:

```bash
cast call 0x65cf45524407a5e700188a8a8178d5d5c0c38d30 \
  "getQuote(string)((uint128,uint64,uint8,uint8,uint8,uint64,uint64,uint64))" \
  "HOOD" --rpc-url https://rpc.mainnet.chain.robinhood.com

# the liquidation path refuses a modelled weekend price
cast call 0x65cf45524407a5e700188a8a8178d5d5c0c38d30 \
  "getPriceIfTraded(string,uint64)(uint128)" "HOOD" 50 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
# -> execution reverted: not a live print
```

### Service

Any Node host. Vercel autodetects Next.js, so no config file is needed.

```bash
# 1. import the repo at vercel.com/new
# 2. set the env vars below in Project Settings -> Environment Variables
# 3. deploy
```

| Variable | Required | Notes |
|---|---|---|
| `ORACLE_SIGNER_KEY` | **yes** | 32-byte hex. Without it the app boots with an ephemeral key, so signatures change on every cold start and nothing the contract already trusts will verify. |
| `NEXT_PUBLIC_ORACLE_ADDRESS` | no | Shows the live on-chain panel on the dashboard. |
| `NEXT_PUBLIC_ORACLE_CHAIN` | no | Display name, e.g. `Robinhood Chain`. |
| `NEXT_PUBLIC_ORACLE_CHAIN_ID` | no | e.g. `4663`. |
| `NEXT_PUBLIC_ORACLE_RPC` | no | Used in the copy-paste `cast` examples. |
| `FINNHUB_API_KEY` | no | Enables a second provider, free at finnhub.io. |
| `TWELVEDATA_API_KEY` | no | Enables a third provider, free at twelvedata.com. |
| `ALPACA_API_KEY` / `ALPACA_API_SECRET` | no | Enables Alpaca (IEX), free at alpaca.markets. |
| `DIA_ENABLED` | no | `true` adds DIA as a cross-check. Off by default. |

The signer key is the one secret that matters: it is what the deployed contract
allow-lists. Rotate it with `setSigner(newAddress, true)` on the contract before
changing it in the host, never after.

### Keeping the chain fresh

A blockchain cannot fetch anything. The contract holds whatever was last pushed
to it, so without a relayer the on-chain quote freezes while the API stays
current, and a consumer contract reads an increasingly old number.

Two ways to drive it.

**Scheduled HTTP (recommended).** `GET /api/cron/publish` builds, signs and
posts in one short invocation. Point any scheduler at it — cron-job.org, Vercel
Cron, GitHub Actions, a `curl` in crontab:

```
URL     https://<your-host>/api/cron/publish
Header  Authorization: Bearer <CRON_SECRET>
Every   5 minutes
```

A scheduler only needs to make an authenticated request; it never holds a key.
The endpoint does, in `RELAYER_KEY`.

#### Setting up cron-job.org

The free tier allows a one-minute minimum interval and custom request headers,
which is everything this needs.

1. **Create job** → Title `hoodoracle publish`, URL
   `https://<your-host>/api/cron/publish`.
2. **Schedule** → *Every 5 minutes* (`*/5 * * * *`). Times are UTC.
3. **Advanced → Headers** → add `Authorization` with value
   `Bearer <CRON_SECRET>`. Put the secret in the header, not the `?key=` query
   parameter: query strings are logged by proxies and show up in referrers.
4. **Advanced** → request method `GET`, enable *Save responses* so a failed run
   leaves a body you can read, and turn on failure notifications.
5. Save, then use **Test run**. A correct setup returns HTTP 200 with a JSON
   body containing `ok`, `posted`, `skipped` and `balanceEth`.

Test the wiring first with `?dry=1`, which does everything except send:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-host>/api/cron/publish?dry=1"
```

It exercises auth, config, quote building and the full materiality decision,
then stops at the transaction and reports `wouldPost` instead of `posted`. Use
it to confirm a schedule before letting it spend anything — otherwise the first
test of a new scheduler is also an irreversible mainnet write.

Check `GET /api/health` first. Its `relayer` block reports whether this
deployment can publish at all, without exposing either secret:

```json
"relayer": {
  "ready": true, "blockers": [], "cronSecretSet": true,
  "keyConfigured": true, "address": "0x082E…7d91", "balanceEth": 0.00058
}
```

`relayer.lastCall` records who last hit `/api/cron/publish` and what happened,
which separates the two failures that look identical from outside — a scheduler
that never fires, and one that fires and is rejected:

```json
"lastCall": { "at": "…", "outcome": "unauthorised", "userAgent": "cron-job.org/1.0" }
```

`null` means no call reached *that instance*; it is in-process, so a recycled
serverless instance forgets. `outcome: "unauthorised"` with a scheduler's
user-agent means the job is firing and the header is wrong.

`ready: false` lists exactly what is missing. The most common cause is
environment variables added in the Vercel dashboard **after** the last
deployment — Vercel applies them only to new deployments, so the running build
still sees nothing and the endpoint answers 401 to a correctly configured
scheduler. Redeploy, then re-check.

> **Watch `balanceEth`.** A warm `postQuote` costs about 53k gas. Eight of them
> is ~424k gas, and at the chain's ~0.067 gwei that is ~0.000028 ETH per full
> run. A five-minute schedule is 288 runs a day; most skip on the materiality
> thresholds, but an active session can post most of the universe on most runs.
> Fund the relayer for the cadence you actually want, and alert on the balance.

> **Do not use Vercel Cron for the real cadence on a Hobby plan.** Hobby rejects
> any schedule that would fire more than once a day, and it rejects it *at
> deploy time* — a `vercel.json` asking for `0 */3 * * *` fails the build, so
> the site silently stops updating while the last good deployment keeps serving.
> The entry in `vercel.json` here is a once-daily backstop near the US open. An
> external scheduler drives the five-minute cadence.

**Long-running process.** `npm run publish -- <target> <addr> --watch` does the
same thing from a machine you control. It is a long-lived process holding a
funded key, so it belongs on a VM, not in a serverless function.

#### What the endpoint will not do

Every call spends gas, so it is deliberately stingy:

- **Requires a secret.** With `CRON_SECRET` unset it returns 401 and posts
  nothing, rather than defaulting open.
- **Posts only what moved.** Below a 10bps price move and a 15bps band move it
  skips, so a quiet weekend at a five-minute schedule costs nothing. Tune with
  `CRON_PRICE_MOVE_BPS`, `CRON_BAND_MOVE_BPS`, `CRON_MAX_ONCHAIN_AGE`.
- **Refreshes anyway after 3 hours**, so a feed never silently rots.
- **Sends with explicit nonces and does not await receipts.** Eight sequential
  receipt waits outlive a serverless invocation, and the receipt says nothing
  the next run cannot read back.

Status codes, because a scheduler reads the status and nothing else:

| Code | Meaning |
|---|---|
| `200` | Posted, or skipped everything on the materiality thresholds. Both fine. |
| `401` | Credential missing or wrong. Body names which fields arrived. |
| `502` | At least one send failed. The body's `failed[]` says which and why. |
| `503` | Missing configuration. Body lists the variables. |

A run where every send threw used to answer `200`, so a scheduler logged it as
successful and the failure surfaced only when somebody read the chain.

Extra environment for the relayer:

| Variable | Required | Notes |
|---|---|---|
| `CRON_SECRET` | yes | Shared secret. Without it the endpoint stays shut. |
| `RELAYER_KEY` | yes | Funded key that pays gas. Separate from the signer. |
| `CRON_PRICE_MOVE_BPS` | no | Default 10. |
| `CRON_BAND_MOVE_BPS` | no | Default 15. |
| `CRON_MAX_ONCHAIN_AGE` | no | Default 10800 (3h). |

## Layout

```
contracts/HoodOracle.sol     verifier + session-aware read interface
src/lib/session.ts           NYSE calendar, DST, holidays, early closes
src/lib/quote.ts             the engine: provenance, drift, confidence
src/lib/dia.ts               upstream client, zero-price guard, caching
src/lib/sign.ts              digest + EIP-191 signing
src/app/api/                 three endpoints
scripts/                     unit, weekend, browser and on-chain tests
```

## Limits

This is an evaluation build. Do not settle real money against it.

- **The default provider is unlicensed for commercial use.** Yahoo's endpoint is
  unofficial. Add Alpaca, Finnhub or a paid vendor before production.
- **Betas describe two years ending September 2026.** They do not anticipate a
  structural break, and a single headline can move a stock far outside any band
  fitted on ordinary days. The band is an honest summary of normal gaps, not a
  guarantee.
- **The crypto betas are conservative priors, not regression estimates.** They
  have not been fitted against realised opens. The claim this product makes is
  that a derived price is *labelled and banded*, never that it is correct.
  Calibration is required before settlement use.
- **The contract has not been audited.**
- The proxy uses a 24h return, so a gap longer than 24 hours stops accumulating
  drift. Deliberate: we do not extrapolate past the window we observe.
- `sourceCount` reflects providers that actually resolved. With only Yahoo
  enabled it is 1 and `maxDeviationBps` is necessarily 0. Add a second provider
  key for those fields to carry signal.

## Next

1. Add a second provider key so `sourceCount` and `maxDeviationBps` carry
   signal. Verify genuine independence first: several cheap vendors resell the
   same IEX feed, and three vendors agreeing on one feed is one source wearing
   three hats.
2. Audit the contract.
3. Re-run `npm run calibrate` on a schedule so the fit tracks the regime.
4. Proof of reserve via zkTLS, so the shares behind the tokens are provable and
   not just the price.
