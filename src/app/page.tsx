"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Band, Stat, Tag, bandClass, countdown } from "@/components/ui";
import { OnChainPanel } from "@/components/onchain";

interface ApiQuote {
  ticker: string;
  price: number;
  anchorPrice: number;
  confidenceBps: number;
  sessionName: string;
  provenanceName: string;
  sourceCount: number;
  staleness: string;
  stalenessSeconds: number;
  driftBps: number;
  method: string;
  lastTradeTime: number;
  beta?: number;
  coveragePct?: number | null;
}

interface ApiResponse {
  asOf: string;
  market: {
    session: string;
    nextSession: string;
    changesIn: string;
    changesInSeconds: number;
  };
  proxies: { key: string; price: number; moveSinceGapPct: number }[];
  quotes: ApiQuote[];
  errors: { ticker: string; error: string }[];
}

const NAMES: Record<string, string> = {
  HOOD: "Robinhood Markets",
  COIN: "Coinbase Global",
  NVDA: "NVIDIA",
  TSLA: "Tesla",
  AAPL: "Apple",
  MSTR: "MicroStrategy",
  SPY: "S&P 500 ETF",
  TLT: "20+Y Treasury ETF",
};

export default function Dashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/quotes", { cache: "no-store" });
      if (!res.ok) throw new Error(`api returned ${res.status}`);
      setData((await res.json()) as ApiResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 20_000);
    const sec = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(sec);
    };
  }, [load]);

  const market = data?.market;
  const secsLeft = market ? Math.max(0, market.changesInSeconds - tick) : 0;
  const tapeOpen =
    market?.session === "REGULAR" ||
    market?.session === "PRE" ||
    market?.session === "POST";
  const modelled =
    data?.quotes.filter((q) => q.provenanceName !== "TRADED").length ?? 0;
  const widest = data?.quotes.reduce((a, q) => Math.max(a, q.confidenceBps), 0);
  const lead = data?.quotes.find((q) => q.ticker === "HOOD") ?? data?.quotes[0];

  return (
    <div className="stack-lg" style={{ paddingTop: 72 }}>
      {/* ───────────────────────────────────────────────────────────── hero */}
      <section className="hero">
        <div>
          <div className="eyebrow" style={{ marginBottom: 20 }}>
            Session-aware oracle · live on Robinhood Chain
          </div>

          <h1 className="d1" style={{ marginBottom: 24 }}>
            Price any equity. Publish the error bar with it.
          </h1>

          <p className="lede" style={{ marginBottom: 30 }}>
            Tokenised equities trade around the clock. The shares behind them
            price for six and a half hours a day. Every oracle in production
            returns one number and hides which of those two regimes it came
            from — so a contract cannot tell a live print from a weekend
            estimate. hoodoracle returns the price, its provenance, and a
            confidence interval fitted on two years of realised gaps.
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Link className="btn btn-primary" href="/playground">
              Try the API
            </Link>
            <Link className="btn" href="/why">
              See the gap
            </Link>
            <Link className="btn" href="/integrate">
              Integrate
            </Link>
          </div>
        </div>

        {/* The claim, demonstrated. This is the actual response the service is
            returning right now, not a mock. */}
        <aside className="hero-card">
          <div className="card-head">
            <span className="card-title">
              GET /api/quote/{lead?.ticker ?? "HOOD"}
            </span>
            <span style={{ marginLeft: "auto" }}>
              <Tag live>live</Tag>
            </span>
          </div>

          {lead ? (
            <>
              <div className="hero-quote">
                <div>
                  <div className="stat-k">price</div>
                  <div className="stat-n" style={{ fontSize: 30 }}>
                    ${lead.price.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="stat-k">95% band</div>
                  <div
                    className={`stat-n ${bandClass(lead.confidenceBps)}`}
                    style={{ fontSize: 30 }}
                  >
                    ±{(lead.confidenceBps / 100).toFixed(2)}%
                  </div>
                </div>
              </div>

              <Band bps={lead.confidenceBps} full />

              <pre style={{ marginBottom: 0, fontSize: 11.5 }}>
                <span className="c">
                  {`// provenance and confidenceBps are the two fields\n`}
                  {`// no other equity oracle returns\n`}
                </span>
                {`{\n`}
                {`  "price": ${lead.price.toFixed(2)},\n`}
                {`  "confidenceBps": ${lead.confidenceBps},\n`}
                {`  "provenance": "${lead.provenanceName}",\n`}
                {`  "session": "${lead.sessionName}",\n`}
                {`  "sourceCount": ${lead.sourceCount}\n}`}
              </pre>
            </>
          ) : (
            <div className="muted small">contacting the service…</div>
          )}
        </aside>
      </section>

      {/* ────────────────────────────────────────────────────── market state */}
      <section className="stats">
        <div>
          <div className="stat-k">US market session</div>
          <div
            className="stat-n"
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            {tapeOpen ? (
              <span
                className="dot pulse"
                style={{
                  width: 8,
                  height: 8,
                  color: "var(--q-tight)",
                  background: "currentColor",
                }}
              />
            ) : null}
            {market?.session ?? "—"}
          </div>
          <div className="stat-s">
            {market
              ? tapeOpen
                ? "prices are printing"
                : "no price discovery"
              : "loading"}
          </div>
        </div>

        <Stat
          label={market ? `${market.nextSession} opens in` : "Next session"}
          value={market ? countdown(secsLeft) : "—"}
          sub="until the tape reopens"
        />
        <Stat
          label="Feeds modelled"
          value={data ? `${modelled}/${data.quotes.length}` : "—"}
          sub={modelled > 0 ? "not live prints" : "all live prints"}
        />
        <Stat
          label="Widest band"
          value={widest !== undefined ? `±${(widest / 100).toFixed(2)}%` : "—"}
          sub="across all feeds"
        />
      </section>

      {/* ───────────────────────────────────────────────────────────── board */}
      <section>
        <div className="sec-head">
          <h2 className="d2">Live feeds</h2>
          <span className="sec-rule" />
          {data ? (
            <span className="sec-note">
              read {new Date(data.asOf).toUTCString().replace("GMT", "UTC")} ·
              refreshes every 20s
            </span>
          ) : null}
        </div>

        {market && !tapeOpen ? (
          <div className="note note-warn" style={{ marginTop: 0 }}>
            <strong>The tape is shut.</strong> Nothing below is a live print.
            Each price is the last close drifted against BTC and ETH — the only
            liquid things still trading — and banded by a figure fitted on two
            years of real gaps. A consumer contract should read{" "}
            <code>provenance</code> before it reads <code>price</code>.
          </div>
        ) : null}

        {error ? (
          <div className="note" style={{ borderLeftColor: "var(--q-vwide)" }}>
            <strong>Could not load feeds.</strong> {error}
          </div>
        ) : null}

        <div className="board scroll-x">
          <table>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Last</th>
                <th>95% confidence band</th>
                <th>Provenance</th>
                <th>Session</th>
                <th>Src</th>
                <th>Drift</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {(data?.quotes ?? []).map((q) => (
                <tr key={q.ticker}>
                  <td>
                    <Link className="row-link" href={`/feed/${q.ticker}`}>
                      {q.ticker}
                    </Link>
                    <div className="row-name">{NAMES[q.ticker] ?? ""}</div>
                  </td>
                  <td className="px">${q.price.toFixed(2)}</td>
                  <td>
                    <Band bps={q.confidenceBps} label />
                  </td>
                  <td>{q.provenanceName}</td>
                  <td>{q.sessionName}</td>
                  <td>{q.sourceCount}</td>
                  <td>
                    {q.driftBps === 0
                      ? "—"
                      : `${q.driftBps > 0 ? "+" : ""}${q.driftBps.toFixed(1)}bps`}
                  </td>
                  <td>{q.staleness}</td>
                </tr>
              ))}

              {!data && !error ? (
                <tr>
                  <td
                    colSpan={8}
                    style={{ textAlign: "center", color: "var(--ink-3)" }}
                  >
                    loading feeds…
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {data?.errors.length ? (
          <div className="note" style={{ borderLeftColor: "var(--q-vwide)" }}>
            {data.errors.map((e) => (
              <div key={e.ticker}>
                <strong>{e.ticker}</strong> {e.error}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ────────────────────────────────────────────────────────── on-chain */}
      <OnChainPanel />

      {/* ───────────────────────────────────────────────────────────── proxy */}
      {data?.proxies.length ? (
        <section>
          <div className="sec-head">
            <h2 className="d2">The only markets still open</h2>
            <span className="sec-rule" />
          </div>
          <p className="lede" style={{ marginBottom: 20 }}>
            Crypto is the proxy of last resort. Moves are measured over exactly
            the window the equity tape has been shut, not scaled down from a
            24-hour return.
          </p>
          <div className="stats" style={{ gridTemplateColumns: "repeat(2,1fr)" }}>
            {data.proxies.map((p) => (
              <div key={p.key}>
                <div className="stat-k">{p.key} · since the close</div>
                <div
                  className="stat-n"
                  style={{
                    color:
                      p.moveSinceGapPct >= 0
                        ? "var(--q-tight)"
                        : "var(--q-vwide)",
                  }}
                >
                  {p.moveSinceGapPct >= 0 ? "+" : ""}
                  {p.moveSinceGapPct.toFixed(3)}%
                </div>
                <div className="stat-s">
                  ${p.price.toLocaleString("en-US")}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ───────────────────────────────────────────────────────── calibrated */}
      <section className="panel">
        <div className="panel-grid">
          <div>
            <div className="eyebrow">Why the bands are believable</div>
            <h2 className="d2" style={{ margin: "14px 0" }}>
              Fitted on 3,990 real gaps, then checked against them.
            </h2>
            <p style={{ color: "var(--ink-2)", margin: 0 }}>
              Every beta and every interval comes from regressing two years of
              realised close-to-open moves. Coverage is the test that matters:
              replay each historical gap and count how many landed inside the
              published band. A 95% interval should catch about 95% of them.
            </p>
            <div style={{ marginTop: 26 }}>
              <Link className="btn" href="/why">
                Read the finding
              </Link>
            </div>
          </div>

          <div className="panel-figs">
            <div>
              <div className="stat-n">93.4—96.4%</div>
              <div className="stat-s">observed coverage, all 8 instruments</div>
            </div>
            <div>
              <div className="stat-n">k = 0.107</div>
              <div className="stat-s">
                measured time exponent, not the assumed 0.50
              </div>
            </div>
            <div>
              <div className="stat-n">3,990</div>
              <div className="stat-s">
                close-to-open gaps in the fitting window
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
