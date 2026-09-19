"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Band,
  Glyph,
  Stat,
  countdown,
  fillFor,
  sessionFill,
} from "@/components/ui";
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

const GLYPHS = ["burst", "bolt", "rings", "wave"] as const;

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

  return (
    <div className="stack-lg" style={{ paddingTop: 60 }}>
      {/* ───────────────────────────────────────────────────────────── hero */}
      <section>
        <div className="eyebrow" style={{ marginBottom: 22 }}>
          Session-aware oracle · live on Robinhood Chain
        </div>

        <h1 className="d1" style={{ maxWidth: "13ch", marginBottom: 28 }}>
          Price any equity.
          <br />
          Know the{" "}
          <span
            className="chip chip-band"
            style={{ background: "var(--amber)", color: "var(--amber-ink)" }}
            aria-hidden="true"
          >
            <i className="cap" />
            <i className="bar" />
            <i className="dot" />
            <i className="bar" />
            <i className="cap" />
          </span>{" "}
          <span style={{ color: "var(--amber)" }}>error bar.</span>
        </h1>

        <p className="lede" style={{ marginBottom: 30 }}>
          Tokenised equities trade around the clock. The shares behind them price
          for six and a half hours a day. Every oracle in production returns one
          number and hides which of those regimes it came from.
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
      </section>

      {/* ────────────────────────────────────────────────────── market state */}
      <section className="grid g4">
        <div
          className={`card fill-${market ? sessionFill(market.session) : "violet"}`}
        >
          <Glyph kind="rings" />
          <div className="stat-k">US market session</div>
          <div className="stat-n" style={{ fontSize: "clamp(26px,4vw,40px)" }}>
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

      {/* ───────────────────────────────────────────────────────────── feeds */}
      <section>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            flexWrap: "wrap",
            marginBottom: 18,
          }}
        >
          <h2 className="d2">Live feeds</h2>
          {data ? (
            <span className="muted small">
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
          <div className="card fill-coral">
            <strong>Could not load feeds.</strong> {error}
          </div>
        ) : null}

        <div className="grid g4">
          {(data?.quotes ?? []).map((q, i) => (
            <Link
              key={q.ticker}
              href={`/feed/${q.ticker}`}
              className={`feed-card fill-${fillFor(q.provenanceName, q.confidenceBps)}`}
            >
              <Glyph kind={GLYPHS[i % GLYPHS.length]} />

              <div className="feed-top">
                <div style={{ flex: 1 }}>
                  <div className="feed-sym">{q.ticker}</div>
                  <div className="feed-name">{NAMES[q.ticker] ?? ""}</div>
                </div>
                <span className="tag">{q.provenanceName}</span>
              </div>

              <div className="feed-px">${q.price.toFixed(2)}</div>

              <Band bps={q.confidenceBps} label />

              <div className="feed-meta">
                <span>{q.staleness} ago</span>
                <span>{q.sourceCount} src</span>
                <span style={{ marginLeft: "auto" }}>
                  {q.driftBps === 0
                    ? "no drift"
                    : `${q.driftBps > 0 ? "+" : ""}${q.driftBps.toFixed(1)}bps`}
                </span>
              </div>
            </Link>
          ))}

          {!data && !error
            ? Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="card" style={{ height: 210 }}>
                  <div className="muted small">loading…</div>
                </div>
              ))
            : null}
        </div>

        {data?.errors.length ? (
          <div className="card fill-coral" style={{ marginTop: 14 }}>
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
          <h2 className="d2" style={{ marginBottom: 8 }}>
            The only markets still open
          </h2>
          <p className="lede" style={{ marginBottom: 18 }}>
            Crypto is the proxy of last resort. Moves are measured over exactly
            the window the equity tape has been shut, not scaled from a 24-hour
            return.
          </p>
          <div className="grid g2">
            {data.proxies.map((p) => (
              <div key={p.key} className="card">
                <Glyph kind="wave" />
                <div className="stat-k">{p.key} · since the close</div>
                <div
                  className="stat-n"
                  style={{
                    color:
                      p.moveSinceGapPct >= 0 ? "var(--mint)" : "var(--coral)",
                  }}
                >
                  {p.moveSinceGapPct >= 0 ? "+" : ""}
                  {p.moveSinceGapPct.toFixed(3)}%
                </div>
                <div className="stat-s">${p.price.toLocaleString("en-US")}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ───────────────────────────────────────────────────────── calibrated */}
      <section className="card fill-violet" style={{ padding: 32 }}>
        <Glyph kind="burst" />
        <div className="eyebrow" style={{ color: "#fff", opacity: 0.66 }}>
          Why the bands are believable
        </div>
        <h2 className="d3" style={{ margin: "14px 0", maxWidth: "20ch" }}>
          Fitted on 3,990 real gaps, then checked.
        </h2>
        <p style={{ maxWidth: "58ch", opacity: 0.88, marginBottom: 24 }}>
          Every beta and every interval comes from regressing two years of
          realised close-to-open moves. Coverage is the test that matters: replay
          each historical gap and count how many landed inside the published
          band. A 95% interval should catch about 95%.
        </p>
        <div style={{ display: "flex", gap: 44, flexWrap: "wrap" }}>
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
        </div>
        <div style={{ marginTop: 26 }}>
          <Link className="btn" href="/why">
            Read the finding
          </Link>
        </div>
      </section>
    </div>
  );
}
