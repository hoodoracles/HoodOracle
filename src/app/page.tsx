"use client";

import Link from "next/link";

import { useCallback, useEffect, useState } from "react";
import { Band, ProvTag, SessionTag, Stat, countdown } from "@/components/ui";
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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/quotes", { cache: "no-store" });
      if (!res.ok) throw new Error(`api returned ${res.status}`);
      const json = (await res.json()) as ApiResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
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

  const derived = data?.quotes.filter((q) => q.provenanceName !== "TRADED").length ?? 0;
  const widest = data?.quotes.reduce(
    (a, q) => Math.max(a, q.confidenceBps),
    0,
  );

  return (
    <div className="stack">
      {/* hero ------------------------------------------------------------ */}
      <section style={{ paddingTop: 14 }}>
        <div className="eyebrow">Session-aware oracle · tokenised equities</div>
        <h1 style={{ fontSize: 34, margin: "10px 0 12px", maxWidth: "20ch" }}>
          Price any equity.
          <br />
          <span style={{ color: "var(--accent)" }}>Know what it is worth.</span>
        </h1>
        <p
          style={{
            color: "var(--n-800)",
            maxWidth: "68ch",
            margin: "0 0 18px",
            fontSize: 13.5,
          }}
        >
          Robinhood Chain trades tokenised equities around the clock. The
          underlying stocks price for six and a half hours a day. Every feed
          below carries its session, how the number was obtained, and how wide
          the uncertainty is right now.
        </p>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
          <Link className="btn btn-primary" href="/playground">
            Try the API
          </Link>
          <Link className="btn" href="/why">
            Why this exists
          </Link>
          <Link className="btn" href="/docs">
            Docs
          </Link>
        </div>
      </section>

      {/* market state ----------------------------------------------------- */}
      <section className="grid grid-4">
        <Stat
          label="US market session"
          value={market ? <SessionTag session={market.session} /> : "—"}
          sub={
            market
              ? tapeOpen
                ? "Prices are printing"
                : "No price discovery"
              : "loading"
          }
        />
        <Stat
          label={market ? `${market.nextSession} opens in` : "Next session"}
          value={market ? countdown(secsLeft) : "—"}
          sub={tapeOpen ? "until session change" : "tape reopens then"}
          color={tapeOpen ? undefined : "var(--warn)"}
        />
        <Stat
          label="Feeds modelled"
          value={data ? `${derived}/${data.quotes.length}` : "—"}
          sub={
            derived > 0
              ? "derived or stale, not live prints"
              : "all live prints"
          }
          color={derived > 0 ? "var(--accent)" : "var(--ok)"}
        />
        <Stat
          label="Widest band"
          value={widest !== undefined ? `±${(widest / 100).toFixed(2)}%` : "—"}
          sub="across all feeds"
          color={
            widest !== undefined && widest > 400 ? "var(--warn)" : undefined
          }
        />
      </section>

      {/* closed-tape explainer -------------------------------------------- */}
      {market && !tapeOpen ? (
        <div className="callout">
          <strong>The tape is shut.</strong> Nothing below is a live print. Each
          price is the last close drifted against BTC and ETH, which are the
          only liquid things still trading, and banded to reflect how little
          that proxy actually tells us. A consumer contract should read{" "}
          <code className="inline">provenance</code> before it reads{" "}
          <code className="inline">price</code>.
        </div>
      ) : null}

      {/* feeds ------------------------------------------------------------ */}
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Live feeds</span>
          {data ? (
            <span className="muted small">
              as of {new Date(data.asOf).toUTCString().replace("GMT", "UTC")}
            </span>
          ) : null}
          <span style={{ marginLeft: "auto" }} className="muted small">
            {loading ? "loading…" : "auto-refresh 20s"}
          </span>
        </div>

        {error ? (
          <div className="panel-body" style={{ color: "var(--bad)" }}>
            {error}
          </div>
        ) : null}

        <div className="table-wrap">
          <table className="feeds">
            <thead>
              <tr>
                <th>Instrument</th>
                <th className="num">Price</th>
                <th className="num">Anchor</th>
                <th className="num">Drift</th>
                <th className="num">Confidence</th>
                <th>Provenance</th>
                <th className="num">Last print</th>
                <th className="num">Src</th>
              </tr>
            </thead>
            <tbody>
              {(data?.quotes ?? []).map((q) => (
                <tr key={q.ticker}>
                  <td>
                    <Link
                      href={`/feed/${q.ticker}`}
                      className="ticker-cell"
                      style={{ color: "inherit" }}
                    >
                      <span className="ticker-sym">{q.ticker}</span>
                      <span className="ticker-name">
                        {NAMES[q.ticker] ?? ""}
                      </span>
                    </Link>
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    ${q.price.toFixed(2)}
                  </td>
                  <td className="num muted">${q.anchorPrice.toFixed(2)}</td>
                  <td
                    className="num"
                    style={{
                      color:
                        q.driftBps > 0
                          ? "var(--ok)"
                          : q.driftBps < 0
                            ? "var(--bad)"
                            : "var(--text-faint)",
                    }}
                  >
                    {q.driftBps === 0
                      ? "—"
                      : `${q.driftBps > 0 ? "+" : ""}${q.driftBps.toFixed(1)}bps`}
                  </td>
                  <td className="num">
                    <Band bps={q.confidenceBps} />
                  </td>
                  <td>
                    <ProvTag provenance={q.provenanceName} />
                  </td>
                  <td className="num muted">{q.staleness} ago</td>
                  <td className="num muted">{q.sourceCount}</td>
                </tr>
              ))}
              {!data && !error ? (
                <tr>
                  <td colSpan={8} className="muted" style={{ padding: 22 }}>
                    Loading feeds from DIA…
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {data?.errors.length ? (
          <div
            className="panel-body small"
            style={{ borderTop: "1px solid var(--line)", color: "var(--bad)" }}
          >
            {data.errors.map((e) => (
              <div key={e.ticker}>
                {e.ticker}: {e.error}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <OnChainPanel />

      {/* proxy ------------------------------------------------------------ */}
      {data?.proxies.length ? (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Off-hours proxy</span>
            <span className="muted small">
              the only liquid markets still open
            </span>
          </div>
          <div className="panel-body">
            <div className="grid grid-2">
              {data.proxies.map((p) => (
                <div key={p.key} className="stat">
                  <div className="stat-label">{p.key} · since close</div>
                  <div
                    className="stat-value"
                    style={{
                      color:
                        p.moveSinceGapPct >= 0 ? "var(--ok)" : "var(--bad)",
                    }}
                  >
                    {p.moveSinceGapPct >= 0 ? "+" : ""}
                    {p.moveSinceGapPct.toFixed(3)}%
                  </div>
                  <div className="stat-sub">
                    ${p.price.toLocaleString("en-US")}
                  </div>
                </div>
              ))}
            </div>
            <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
              Measured over exactly the window the equity tape has been shut,
              not a scaled 24h return. Crypto is a weak proxy for equities and
              is used only to drift a stale close, damped by a per-instrument
              beta. The beta values are conservative priors, not regression
              estimates. They must be calibrated against realised closes before
              any derived number is used for settlement.
            </p>
          </div>
        </section>
      ) : null}
    </div>
  );
}
