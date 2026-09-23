// Tests for @hoodoracle/sdk.
//
// The SDK carries its own copy of the enums, the ABI and the digest encoder so
// that installing it does not drag the server in. That duplication is the
// whole risk: three definitions of the same tuple, in three places, and a
// single reordered field makes every signature fail to recover while
// everything still typechecks and the tests that only exercise one side still
// pass.
//
// So this file checks agreement rather than behaviour in isolation:
//
//   A  The SDK's enums equal the server's enums.
//   B  The SDK's digest equals the server's digest, on real quotes.
//   C  The SDK's band equals what the deployed contract returns, on chain.
//   D  The SDK reads the live contract and the live API, and the signature
//      it verifies offline is accepted by the contract's own allow list.
//   E  The policy layer refuses what it should refuse.
//
//   npm run test:sdk
//   npm run test:sdk -- --offline   skip anything needing the network

import "./env.mts";

import { createPublicClient, defineChain, http, type Hex } from "viem";

import {
  Session as SdkSession,
  Provenance as SdkProvenance,
  HOOD_ORACLE_ABI as SDK_ABI,
  HoodOracle,
  QuoteRejected,
  band as sdkBand,
  check as sdkCheck,
  conservativePrice,
  describeBand,
  fetchQuote,
  priceOrThrow,
  HoodOracleKeeper,
  HOOD_ORACLE_KEEPER_ADDRESS,
  quoteDigest as sdkDigest,
  toScaled as sdkToScaled,
  toDecimal,
  verifyQuote,
  TICKERS,
} from "../sdk/dist/esm/index.js";

import { Session, Provenance } from "../src/lib/types.ts";
import { quoteDigest as serverDigest, toScaled as serverToScaled } from "../src/lib/sign.ts";
import { UNIVERSE } from "../src/lib/universe.ts";
import { buildQuote } from "../src/lib/quote.ts";

const OFFLINE = process.argv.includes("--offline");

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}
function eq(label: string, got: unknown, want: unknown) {
  check(label, Object.is(got, want), `got=${String(got)} want=${String(want)}`);
}

// ------------------------------------------------------- A. enum agreement

console.log("\n=== A. the SDK and the server agree on the vocabulary ===\n");

eq("Session.REGULAR", SdkSession.REGULAR, Session.REGULAR);
eq("Session.PRE", SdkSession.PRE, Session.PRE);
eq("Session.POST", SdkSession.POST, Session.POST);
eq("Session.CLOSED", SdkSession.CLOSED, Session.CLOSED);
eq("Session.HOLIDAY", SdkSession.HOLIDAY, Session.HOLIDAY);
eq("Provenance.TRADED", SdkProvenance.TRADED, Provenance.TRADED);
eq("Provenance.DERIVED", SdkProvenance.DERIVED, Provenance.DERIVED);
eq("Provenance.STALE", SdkProvenance.STALE, Provenance.STALE);

// A reordering that kept the same count would pass the checks above only if
// every value happened to line up, so also pin the count.
eq(
  "no session values were added",
  Object.values(SdkSession).filter((v) => typeof v === "number").length,
  5,
);
eq(
  "no provenance values were added",
  Object.values(SdkProvenance).filter((v) => typeof v === "number").length,
  3,
);

eq(
  "the SDK ships the same universe",
  TICKERS.join(","),
  UNIVERSE.map((i) => i.ticker).join(","),
);

// --------------------------------------------------------- B. digest parity

console.log("\n=== B. the digest encoders agree ===\n");

for (const v of [0, 0.00000001, 1, 120.12345678, 99999.99999999]) {
  eq(`toScaled(${v})`, sdkToScaled(v), serverToScaled(v));
}
eq("toDecimal round-trips", toDecimal(sdkToScaled(120.12345678)), 120.12345678);

// Hand-built quotes covering each enum value, so a reordered field shows up as
// a digest mismatch rather than passing on the one case that happens to align.
{
  let mismatches = 0;
  let n = 0;
  for (const ticker of ["HOOD", "TLT", "MSTR"]) {
    for (const session of [0, 1, 2, 3, 4]) {
      for (const provenance of [0, 1, 2]) {
        const q = {
          ticker,
          price: 123.45678901,
          anchorPrice: 123.4,
          confidenceBps: 424,
          session,
          provenance,
          sourceCount: 3,
          maxDeviationBps: 17.6,
          lastTradeTime: 1_750_000_000,
          publishTime: 1_750_003_600,
          stalenessSeconds: 3600,
          method: "",
          driftBps: 0,
          nextSessionInSeconds: 0,
          nextSession: 0,
        };
        n++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (sdkDigest(q as any) !== serverDigest(q as any)) mismatches++;
      }
    }
  }
  check(
    `digest matches across ${n} enum combinations`,
    mismatches === 0,
    `mismatches=${mismatches}`,
  );
}

// ------------------------------------------------------- band vs contract

console.log("\n=== B2. band arithmetic ===\n");
{
  // The float trap this exists to avoid: 100 * (1 + 50/10000) is
  // 100.49999999999999, so a price exactly on the edge falls outside.
  const b = sdkBand({ price: sdkToScaled(100), confidenceBps: 50n });
  eq("edge is exact at ±0.50% on 100", b.upper, sdkToScaled(100.5));
  eq("  and on the low side", b.lower, sdkToScaled(99.5));

  const c = sdkBand({ price: sdkToScaled(120), confidenceBps: 424n });
  eq("120 @424bps lower", toDecimal(c.lower), 114.912);
  eq("  upper", toDecimal(c.upper), 125.088);

  eq(
    "collateral takes the low edge",
    conservativePrice({ price: sdkToScaled(120), confidenceBps: 424n }, "collateral"),
    c.lower,
  );
  eq(
    "debt takes the high edge",
    conservativePrice({ price: sdkToScaled(120), confidenceBps: 424n }, "debt"),
    c.upper,
  );

  eq("describeBand(80)", describeBand(80), "tight enough to settle against");
  eq("describeBand(424)", describeBand(424), "very wide — do not settle");
}

// ------------------------------------------------------------- E. policy

console.log("\n=== C. the policy layer refuses what it should ===\n");
{
  const derived = {
    price: sdkToScaled(120),
    confidenceBps: 424n,
    session: SdkSession.CLOSED,
    provenance: SdkProvenance.DERIVED,
    sourceCount: 2,
    maxDeviationBps: 0n,
    lastTradeTime: 1_750_000_000n,
    publishTime: BigInt(Math.floor(Date.now() / 1000)),
  };
  const traded = {
    ...derived,
    confidenceBps: 12n,
    session: SdkSession.REGULAR,
    provenance: SdkProvenance.TRADED,
  };

  check(
    "a DERIVED weekend quote is refused by default",
    !sdkCheck(derived).ok,
    sdkCheck(derived).reasons[0]?.slice(0, 60),
  );
  check("a live print passes", sdkCheck(traded).ok);

  check(
    "the refusal names provenance, not just 'invalid'",
    /DERIVED/.test(sdkCheck(derived).reasons.join(" ")),
  );

  check(
    "requireTraded:false allows it through",
    sdkCheck(derived, { requireTraded: false }).ok,
  );
  check(
    "  but maxBps still bites",
    !sdkCheck(derived, { requireTraded: false, maxBps: 200 }).ok,
  );
  eq(
    "  and every reason is reported, not just the first",
    sdkCheck(derived, { maxBps: 200, minSources: 5 }).reasons.length,
    3,
  );

  check(
    "a stale publishTime is caught",
    !sdkCheck(traded, { maxAgeSeconds: 60, now: Number(traded.publishTime) + 600 }).ok,
  );
  // What the chain held from Mon 21 Sep 13:43 to Wed 23 Sep 07:41 UTC: a
  // TRADED print nothing replaced, which getPriceIfTraded went on serving.
  const leftover = { ...traded, publishTime: traded.publishTime - 42n * 3600n };
  check(
    "a TRADED quote 42h old is refused by default",
    !sdkCheck(leftover).ok,
    sdkCheck(leftover).reasons[0]?.slice(0, 60),
  );
  check(
    "  an explicit maxAgeSeconds overrides the default",
    sdkCheck(leftover, { maxAgeSeconds: Infinity }).ok,
  );
  check(
    "  and requireTraded:false carries no default age",
    sdkCheck({ ...leftover, provenance: SdkProvenance.DERIVED }, { requireTraded: false }).ok,
  );
  check(
    "a never-posted quote is caught",
    !sdkCheck({ ...traded, publishTime: 0n }).ok,
  );

  // The throwing form is the one integrators should reach for.
  let threw: unknown = null;
  try {
    priceOrThrow("HOOD", derived);
  } catch (e) {
    threw = e;
  }
  check("priceOrThrow throws QuoteRejected", threw instanceof QuoteRejected);
  check(
    "  and carries the reasons",
    threw instanceof QuoteRejected && threw.reasons.length === 1,
  );
  eq(
    "priceOrThrow returns the price when allowed",
    priceOrThrow("HOOD", traded),
    traded.price,
  );
}

// ---------------------------------------------------------- D. live checks

if (OFFLINE) {
  console.log("\n--offline: skipping the live chain and API checks\n");
} else {
  console.log("\n=== D. against the live chain ===\n");

  const address = process.env.NEXT_PUBLIC_ORACLE_ADDRESS as Hex | undefined;
  const rpcUrl = process.env.NEXT_PUBLIC_ORACLE_RPC;
  const chainId = Number(process.env.NEXT_PUBLIC_ORACLE_CHAIN_ID ?? 0);

  if (!address || !rpcUrl || !chainId) {
    console.log("  SKIP: no chain configured in the environment");
  } else {
    const oracle = new HoodOracle({ address, rpcUrl });
    eq("client defaults to the configured address", oracle.address, address);

    const chain = defineChain({
      id: chainId,
      name: "target",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const pub = createPublicClient({ chain, transport: http(rpcUrl) });

    let live = 0;
    for (const ticker of ["HOOD", "COIN", "AAPL", "TLT"]) {
      try {
        const q = await oracle.getQuote(ticker);
        live++;

        // The SDK's band, computed locally, against the contract's own.
        const [onLower, onUpper] = (await Promise.all([
          pub.readContract({
            address,
            abi: SDK_ABI,
            functionName: "getBandedPrice",
            args: [ticker, true],
          }),
          pub.readContract({
            address,
            abi: SDK_ABI,
            functionName: "getBandedPrice",
            args: [ticker, false],
          }),
        ])) as [bigint, bigint];

        const local = sdkBand(q);
        check(
          `${ticker}: local band equals getBandedPrice on chain`,
          local.lower === onLower && local.upper === onUpper,
          `local=[${local.lower},${local.upper}] chain=[${onLower},${onUpper}]`,
        );

        // getPrice must agree with getQuote.
        const [p] = (await pub.readContract({
          address,
          abi: SDK_ABI,
          functionName: "getPrice",
          args: [ticker],
        })) as [bigint, bigint];
        eq(`${ticker}: getPrice equals getQuote.price`, p, q.price);

        // isLive must agree with the SDK's own reading of the same fields.
        const onIsLive = await oracle.isLive(ticker, 5000);
        const localIsLive =
          q.provenance === SdkProvenance.TRADED && q.confidenceBps <= 5000n;
        eq(`${ticker}: isLive agrees with the local check`, onIsLive, localIsLive);
      } catch (e) {
        check(`${ticker}: read from chain`, false, (e as Error).message.slice(0, 90));
      }
    }
    check("read at least one live quote", live > 0, `read=${live}`);

    const limits = await oracle.limits();
    check(
      "contract limits are readable and sane",
      limits.maxQuoteAge > 0n && limits.maxAcceptableBps > 0n,
      `age=${limits.maxQuoteAge}s bps=${limits.maxAcceptableBps}`,
    );
  }

  // --------------------------------------------------- the signed API path

  console.log("\n=== E. against the live API ===\n");
  const base = process.env.SDK_TEST_API ?? "https://www.hoodoracle.org";
  console.log(`  base ${base}`);

  try {
    // verify:true is the default; if the digest or the encoder disagreed with
    // the server this call throws rather than returning.
    const signed = await fetchQuote("HOOD", { baseUrl: base });
    check("fetchQuote returned a verified quote", true);
    eq("  digest matches the server's", sdkDigest(signed.quote), signed.digest);
    check("  verifyQuote agrees", await verifyQuote(signed));
    check(
      "  and rejects a wrong expected signer",
      !(await verifyQuote(signed, "0x000000000000000000000000000000000000dEaD")),
    );

    // Tamper with one field. The signature must stop verifying.
    const tampered = {
      ...signed,
      quote: { ...signed.quote, price: signed.quote.price * 1.01 },
    };
    check("  a tampered price fails verification", !(await verifyQuote(tampered)));

    const tamperedBand = {
      ...signed,
      quote: { ...signed.quote, confidenceBps: 10 },
    };
    check("  a tampered band fails verification", !(await verifyQuote(tamperedBand)));

    const tamperedProv = {
      ...signed,
      quote: { ...signed.quote, provenance: SdkProvenance.TRADED },
    };
    check(
      "  a tampered provenance fails verification",
      !(await verifyQuote(tamperedProv)),
    );

    // The signature is valid; is the key one the contract trusts?
    const address = process.env.NEXT_PUBLIC_ORACLE_ADDRESS as Hex | undefined;
    const rpcUrl = process.env.NEXT_PUBLIC_ORACLE_RPC;
    if (address && rpcUrl) {
      const oracle = new HoodOracle({ address, rpcUrl });
      check(
        "  the API signer is allow-listed on chain",
        await oracle.isSigner(signed.signer),
        signed.signer,
      );
    }

    console.log(
      `\n  HOOD  $${signed.quote.price.toFixed(2)}  ±${(signed.quote.confidenceBps / 100).toFixed(2)}%  ` +
        `${SdkSession[signed.quote.session]}/${SdkProvenance[signed.quote.provenance]}  ` +
        `— ${describeBand(signed.quote.confidenceBps)}`,
    );
  } catch (e) {
    check("fetchQuote against the live API", false, (e as Error).message.slice(0, 120));
  }

  // ------------------------------------------------------- the keeper

  console.log("\n=== F. the keeper, on the live chain ===\n");
  {
    const rpcUrl = process.env.NEXT_PUBLIC_ORACLE_RPC;
    const oracleAddress = process.env.NEXT_PUBLIC_ORACLE_ADDRESS as Hex | undefined;
    const keeperAddress = (process.env.NEXT_PUBLIC_KEEPER_ADDRESS ??
      HOOD_ORACLE_KEEPER_ADDRESS) as Hex;

    if (!rpcUrl || !oracleAddress) {
      console.log("  SKIP: no chain configured");
    } else {
      const keeper = new HoodOracleKeeper({ address: keeperAddress, rpcUrl });

      // A keeper wired to some other oracle would answer plausibly and be
      // describing a different feed entirely.
      const wired = await keeper.oracle();
      check(
        "the keeper points at the oracle we read",
        wired.toLowerCase() === oracleAddress.toLowerCase(),
        `${wired} vs ${oracleAddress}`,
      );

      const tickers = [...TICKERS];
      const stale = await keeper.needsUpdate(tickers, 3600);
      check(
        "needsUpdate answers for every ticker",
        Object.keys(stale).length === tickers.length,
      );

      const st = await keeper.status([...tickers, "ZZZZNOTREAL"], 0);
      check("status answers for every input", st.length === tickers.length + 1);
      check(
        "every tracked ticker exists on chain",
        st.slice(0, -1).every((s) => s.exists),
      );
      check(
        "an unknown symbol is reported absent, not thrown",
        st[st.length - 1].exists === false && st[st.length - 1].stale === true,
      );
      check(
        "ages are plausible (under a week)",
        st.slice(0, -1).every((s) => s.ageSeconds < 604800n),
      );

      // The keeper and the plain client must agree — they read the same slot.
      const direct = new HoodOracle({ address: oracleAddress, rpcUrl });
      const hood = await direct.getQuote("HOOD");
      const viaKeeper = st.find((s) => s.ticker === "HOOD")!;
      check(
        "keeper and client report the same HOOD price",
        viaKeeper.price === hood.price,
        `${viaKeeper.price} vs ${hood.price}`,
      );
      check(
        "  and the same band",
        viaKeeper.confidenceBps === hood.confidenceBps,
      );
      check(
        "  and the same provenance",
        viaKeeper.provenance === hood.provenance,
      );

      const fresh = st.filter((s) => s.exists && !s.stale).length;
      console.log(
        `\n  keeper ${keeperAddress}\n  ${fresh}/${tickers.length} fresh against the oracle's own window; ` +
          `oldest ${Math.max(...st.slice(0, -1).map((s) => Number(s.ageSeconds)))}s`,
      );
    }
  }

  // The SDK digest must also match a quote built locally, not just one the
  // server already signed — that catches an encoder that is self-consistent
  // but wrong.
  try {
    const { quote } = await buildQuote(UNIVERSE[0]);
    eq(
      "a locally built quote digests identically in both",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkDigest(quote as any),
      serverDigest(quote),
    );
  } catch (e) {
    check("build a quote locally", false, (e as Error).message.slice(0, 90));
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log();
