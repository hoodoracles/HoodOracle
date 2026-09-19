"use client";

import { useCallback, useEffect, useState } from "react";
import { bandColor, useOrigin } from "@/components/ui";

const TICKERS = ["HOOD", "COIN", "NVDA", "TSLA", "AAPL", "MSTR", "SPY", "TLT"];

export default function Playground() {
  const [ticker, setTicker] = useState("HOOD");
  const [raw, setRaw] = useState<string>("");
  const [meta, setMeta] = useState<{
    price?: number;
    bps?: number;
    prov?: string;
    session?: string;
  }>({});
  const [ms, setMs] = useState<number | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (t: string) => {
    setBusy(true);
    const t0 = performance.now();
    try {
      const res = await fetch(`/api/quote/${t}`, { cache: "no-store" });
      const json = await res.json();
      setStatus(res.status);
      setMs(Math.round(performance.now() - t0));
      setRaw(JSON.stringify(json, null, 2));
      setMeta({
        price: json?.quote?.price,
        bps: json?.quote?.confidenceBps,
        prov: json?.readable?.provenance,
        session: json?.readable?.session,
      });
    } catch (e) {
      setRaw(String(e));
      setStatus(0);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(ticker);
  }, [ticker, run]);

  const origin = useOrigin();

  return (
    <div className="stack" style={{ paddingTop: 18 }}>
      <div>
        <div className="eyebrow">Playground</div>
        <h1 style={{ fontSize: 30, margin: "10px 0 10px" }}>
          Call the oracle
        </h1>
        <p style={{ color: "var(--n-800)", maxWidth: "64ch", margin: 0 }}>
          Live requests against the running service. No key required. Each
          response is signed, so the price and its band travel together.
        </p>
      </div>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Instrument</span>
          <span style={{ marginLeft: "auto" }} className="muted small">
            {status !== null ? `HTTP ${status}` : ""} {ms !== null ? `· ${ms}ms` : ""}
          </span>
        </div>
        <div className="panel-body">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {TICKERS.map((t) => (
              <button
                key={t}
                className="btn"
                onClick={() => setTicker(t)}
                style={
                  t === ticker
                    ? {
                        background: "var(--accent-dim)",
                        borderColor: "var(--accent-line)",
                        color: "var(--accent-bright)",
                        fontWeight: 700,
                      }
                    : undefined
                }
              >
                {t}
              </button>
            ))}
            <button
              className="btn btn-primary"
              onClick={() => void run(ticker)}
              disabled={busy}
              style={{ marginLeft: "auto" }}
            >
              {busy ? "running…" : "Re-run"}
            </button>
          </div>

          <div style={{ marginTop: 14 }}>
            <pre className="code">
              <span className="c">$</span> curl {origin}/api/quote/
              <span className="n">{ticker}</span>
            </pre>
          </div>
        </div>
      </section>

      {meta.price !== undefined ? (
        <section className="grid grid-4">
          <div className="stat">
            <div className="stat-label">Price</div>
            <div className="stat-value">${meta.price.toFixed(2)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Confidence</div>
            <div
              className="stat-value"
              style={{ color: bandColor(meta.bps ?? 0) }}
            >
              ±{((meta.bps ?? 0) / 100).toFixed(2)}%
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Provenance</div>
            <div className="stat-value" style={{ fontSize: 17 }}>
              {meta.prov}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Session</div>
            <div className="stat-value" style={{ fontSize: 17 }}>
              {meta.session}
            </div>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Response</span>
          <button
            className="btn"
            style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 11.5 }}
            onClick={() => void navigator.clipboard?.writeText(raw)}
          >
            Copy JSON
          </button>
        </div>
        <div className="panel-body">
          <pre className="code" style={{ maxHeight: 460, overflowY: "auto" }}>
            {raw || "…"}
          </pre>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Other endpoints</span>
        </div>
        <div className="panel-body">
          <pre className="code">
            <span className="c"># every instrument, one proxy snapshot</span>
            {`\n`}curl {origin}/api/quotes{`\n\n`}
            <span className="c"># upstream reachability and signer</span>
            {`\n`}curl {origin}/api/health
          </pre>
        </div>
      </section>
    </div>
  );
}
