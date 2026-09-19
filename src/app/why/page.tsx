import Link from "next/link";
import CAL from "@/lib/calibration.json";

export const metadata = {
  title: "The problem — hoodoracle",
  description:
    "Tokenised equities trade 24/7. The underlying stocks price 6.5 hours a day. What happens in the gap.",
};

const CALENDAR = [
  ["Mon–Fri", "09:30–16:00 ET", "Regular", "real price discovery", "ok"],
  ["Mon–Fri", "04:00–09:30 ET", "Pre-market", "thin but real", "warn"],
  ["Mon–Fri", "16:00–20:00 ET", "After-hours", "thin but real", "warn"],
  ["Mon–Fri", "20:00–04:00 ET", "Dark", "8h a night, nothing", "bad"],
  ["Fri 20:00 → Sun 18:00", "", "Dark", "~46 continuous hours", "bad"],
  ["Sun 18:00 → Mon 04:00", "", "Futures only", "ES/NQ reopen on Globex", "warn"],
  ["~10 days a year", "", "Holiday", "full closure", "bad"],
];

export default function Why() {
  return (
    <div className="prose" style={{ paddingTop: 50 }}>
      <div className="eyebrow">The problem</div>
      <h1 className="d1" style={{ margin: "18px 0 26px" }}>
        A third of every week has no price.
      </h1>

      <p>
        Robinhood Chain went live on 1 July 2026 as an Arbitrum Orbit L2, and it
        trades tokenised US equities and ETFs around the clock, alongside DeFi
        lending. The shares those tokens represent trade for six and a half
        hours a day, five days a week.
      </p>

      <p>Here is the actual week:</p>

      <div className="tbl"><table>
        <thead>
          <tr>
            <th>When</th>
            <th>Hours</th>
            <th>State</th>
            <th>What it means</th>
          </tr>
        </thead>
        <tbody>
          {CALENDAR.map(([when, hours, state, meaning, tone]) => (
            <tr key={when + state}>
              <td style={{ whiteSpace: "nowrap" }}>{when}</td>
              <td className="muted" style={{ whiteSpace: "nowrap" }}>
                {hours}
              </td>
              <td>
                <span className="tag tag-box">{state}</span>
              </td>
              <td className="muted">{meaning}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <p>
        Roughly a third of every week has no price discovery at all. A tokenised
        position can be lent against, liquidated, or traded in every hour of it.
      </p>

      <h2>What oracles do today</h2>

      <p>
        They return one number. A lending market reading{" "}
        <code>HOOD = 119.83</code> cannot tell a live
        consolidated print from Friday&apos;s close warmed over for two days. So
        it has to assume the worst at all times, and prices that assumption into
        everyone&apos;s loan-to-value.
      </p>

      <div className="note note-warn">
        <strong>This is not hypothetical.</strong> While building this we found
        a real oracle whose equity endpoint stamps some tickers with fetch time
        rather than print time. Query it at midnight UTC on a Saturday and the
        timestamp looks live. A naive consumer would treat a two-day-old close
        as a fresh print. hoodoracle reconciles every upstream timestamp against
        the exchange calendar instead of trusting it, and records per provider
        whether its timestamps may be used for freshness at all.
      </div>

      <h2>What we publish instead</h2>

      <p>
        Not a price. A price plus its epistemics, so the consumer can decide for
        itself:
      </p>

      <pre>{`struct Quote {
    uint128 price;
    uint64  confidence;    `}<span className="c">{`// bps band, widens as the tape goes cold`}</span>{`
    uint8   session;       `}<span className="c">{`// REGULAR|PRE|POST|CLOSED|HOLIDAY`}</span>{`
    uint8   provenance;    `}<span className="c">{`// TRADED|DERIVED|STALE`}</span>{`
    uint8   sourceCount;
    uint64  maxDeviationBps;
    uint64  lastTradeTime;
}`}</pre>

      <p>Now a protocol can write policy that was previously impossible:</p>

      <ul>
        <li>
          allow liquidations only when{" "}
          <code>provenance == TRADED</code>
        </li>
        <li>
          scale loan-to-value by <code>confidence</code>
        </li>
        <li>
          halt on <code>maxDeviationBps</code> above a
          threshold
        </li>
        <li>
          widen spreads automatically through the weekend instead of guessing
        </li>
      </ul>

      <h2>Where the number comes from when nothing trades</h2>

      <p>
        Crypto is the only liquid thing still open through a US weekend, so it
        is the proxy of last resort. We take the last close and apply a
        per-instrument beta against the blended BTC/ETH move measured over
        exactly the window the tape was shut. Both the beta and the band are{" "}
        <strong>fitted</strong>, against two years of realised close-to-open
        gaps.
      </p>

      <h3>The square-root-of-time model was wrong</h3>

      <p>
        The first version of this widened the band by{" "}
        <code>√t</code>, on the standard argument that
        uncertainty under a random walk grows with the square root of elapsed
        time. Fitting it against real gaps showed that is not what equities do.
      </p>

      <p>
        Solving for the exponent in <code>σ ∝ hours^k</code>{" "}
        across all eight instruments gives{" "}
        <strong>k = {CAL.timeExponent.toFixed(3)}</strong>, not 0.5. A weekend
        is roughly 3.7 times the clock hours of an overnight gap, yet its
        realised dispersion is only a few percent wider.
      </p>

      <div className="tbl"><table>
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Overnight σ</th>
            <th>Weekend σ</th>
            <th>Fitted k</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(CAL.instruments).map(([t, c]) => (
            <tr key={t}>
              <td>{t}</td>
              <td className="muted">{c.overnightSigmaBps.toFixed(0)} bps</td>
              <td className="muted">{c.weekendSigmaBps.toFixed(0)} bps</td>
              <td>
                {(
                  Math.log(c.weekendSigmaBps / c.overnightSigmaBps) /
                  Math.log(66.6 / 17.5)
                ).toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <p>
        Calendar time is a poor clock for market risk. Information arrives
        around the close and the open, not evenly through Saturday. The
        practical consequence is that{" "}
        <strong>
          almost all of the weekend&apos;s uncertainty exists the moment the
          bell rings
        </strong>
        , and waiting two more days adds little. A protocol that widens
        gradually through a weekend is mispricing Friday evening. The old model
        went ±0.53% to ±6.84% across a weekend; the fitted one goes ±3.60% to
        ±4.80%, which is what actually happens.
      </p>

      <h3>The band is validated, not asserted</h3>

      <p>
        The band is a two-sided 95% interval,{" "}
        <code>1.96 σ</code>. Whether that is honest is a
        testable question, so it is tested: every historical gap is replayed and
        counted against the published band.
      </p>

      <div className="tbl"><table>
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Fitted β</th>
            <th>Prior β</th>
            <th>R²</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(CAL.instruments).map(([t, c]) => (
            <tr key={t}>
              <td>{t}</td>
              <td>{c.beta.toFixed(3)}</td>
              <td className="muted">{c.priorBeta.toFixed(2)}</td>
              <td className="muted">{c.r2.toFixed(3)}</td>
              <td
                style={{
                  color:
                    c.coveragePct && c.coveragePct >= 92 && c.coveragePct <= 98
                      ? "var(--ok)"
                      : "var(--warn)",
                }}
              >
                {c.coveragePct?.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <p>
        Every instrument lands between 93.4% and 96.4% against a 95% target,
        across roughly 500 gaps each. Every prior was too low except AAPL and
        TLT. The R² column matters too: crypto explains 56% of COIN&apos;s
        overnight moves and essentially none of TLT&apos;s, which is why TLT
        gets no drift applied at all.
      </p>

      <div className="note note-warn">
        <strong>What calibration does not fix.</strong> These betas are fitted
        on two years ending September 2026 and describe that regime. They do not
        anticipate a structural break, and a single headline can move a stock
        far outside any band fitted on ordinary days. The band is an honest
        summary of normal gaps, not a guarantee.
      </div>

      <h2>No single upstream</h2>

      <p>
        Sourcing is pluggable. An earlier build read prices from DIA directly,
        which made their terms and their uptime ours. Providers are now adapters
        behind one interface and the oracle runs on whichever are configured, so
        no vendor becomes load-bearing.
      </p>

      <p>
        The published price is the <strong>median</strong> across whichever
        resolved, so one bad feed cannot drag it, and their disagreement widens
        the band directly through{" "}
        <code>maxDeviationBps</code>. Only providers that
        report genuine print times may establish freshness; the rest can
        contribute a price but not a timestamp.
      </p>

      <p>
        That distinction is not academic. DIA&apos;s RWA endpoint stamps several
        tickers with fetch time, so it is registered as a source of prices but
        never of freshness, and it is off by default because their own
        configuration documents the free tier as evaluation-only.
      </p>

      <p className="muted small">
        The current default, Yahoo&apos;s chart endpoint, needs no key and
        reports a real last-print time, which makes it the best free source for
        freshness. It is not licensed for commercial redistribution. Add a
        licensed vendor before production.
      </p>

      <hr className="rule" />
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
        <Link className="btn btn-primary" href="/playground">
          Try the API
        </Link>
        <Link className="btn" href="/docs">
          Read the docs
        </Link>
      </div>
    </div>
  );
}
