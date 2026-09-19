"use client";

import { useCallback, useEffect, useState } from "react";
import { Band, Tag, useOrigin } from "@/components/ui";

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
    <div className="stack-lg" style={{ paddingTop: 50 }}>
      <div>
        <div className="eyebrow" style={{ marginBottom: 18 }}>
          Playground
        </div>
        <h1 className="d1" style={{ fontSize: "clamp(40px,7vw,78px)", marginBottom: 20 }}>
          Call the oracle.
        </h1>
        <p className="lede">
          Live requests against the running service. No key required. Every
          response is signed, so the price and its band travel together and
          neither can be stripped from the other.
        </p>
      </div>

      <section className="card">
        <div className="card-head">
          <span className="card-title">Instrument</span>
          <span style={{ marginLeft: "auto" }} className="muted small">
            {status !== null ? `HTTP ${status}` : ""} {ms !== null ? `· ${ms}ms` : ""}
          </span>
        </div>
        <div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {TICKERS.map((t) => (
              <button
                key={t}
                className="btn"
                onClick={() => setTicker(t)}
                style={
                  t === ticker
                    ? {
                        background: "var(--violet)",
                        borderColor: "var(--violet)",
                        color: "#fff",
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
            <pre>
              <span className="c">$</span> curl {origin}/api/quote/
              <span className="n">{ticker}</span>
            </pre>
          </div>
        </div>
      </section>

      {meta.price !== undefined ? (
        <section className="grid g4">
          <div className="card fill-cream">
            <div className="stat-k">Price</div>
            <div className="stat-n">${meta.price.toFixed(2)}</div>
          </div>
          <div className="card fill-amber">
            <div className="stat-k">Confidence</div>
            <div className="stat-n">±{((meta.bps ?? 0) / 100).toFixed(2)}%</div>
            <div style={{ marginTop: 14 }}>
              <Band bps={meta.bps ?? 0} />
            </div>
          </div>
          <div className="card">
            <div className="stat-k">Provenance</div>
            <div className="stat-n" style={{ fontSize: 26 }}>{meta.prov}</div>
          </div>
          <div className="card">
            <div className="stat-k">Session</div>
            <div className="stat-n" style={{ fontSize: 26 }}>{meta.session}</div>
          </div>
        </section>
      ) : null}

      <section className="card">
        <div className="card-head">
          <span className="card-title">Response</span>
          <button
            className="btn"
            style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 11.5 }}
            onClick={() => void navigator.clipboard?.writeText(raw)}
          >
            Copy JSON
          </button>
        </div>
        <div>
          <pre style={{ maxHeight: 460, overflowY: "auto" }}>
            {raw || "…"}
          </pre>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">Other endpoints</span>
        </div>
        <div>
          <pre>
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
