"use client";

import Link from "next/link";

import { use, useCallback, useEffect, useState } from "react";
import { Band, ProvTag, SessionTag, Stat, bandColor, useOrigin } from "@/components/ui";

interface Payload {
  quote: {
    ticker: string;
    price: number;
    anchorPrice: number;
    confidenceBps: number;
    driftBps: number;
    sourceCount: number;
    maxDeviationBps: number;
    lastTradeTime: number;
    publishTime: number;
    stalenessSeconds: number;
    method: string;
  };
  signature: string;
  signer: string;
  digest: string;
  readable: {
    session: string;
    nextSession: string;
    provenance: string;
    confidencePct: string;
    band: [number, number];
    staleness: string;
    opensIn: string;
  };
  instrument: { name: string; kind: string };
  calibration: {
    beta: number;
    priorBeta: number;
    r2: number;
    samples: number;
    coveragePct: number | null;
    calibrated: boolean;
  };
  proxies: { key: string; price: number; moveSinceGapPct: number }[];
  error?: string;
}

export default function FeedPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = use(params);
  const origin = useOrigin();
  const [d, setD] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/quote/${ticker}`, { cache: "no-store" });
      const json = (await res.json()) as Payload;
      if (!res.ok) throw new Error(json.error ?? `status ${res.status}`);
      setD(json);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }, [ticker]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  if (err) {
    return (
      <div className="stack" style={{ paddingTop: 20 }}>
        <h1 style={{ fontSize: 24 }}>{ticker}</h1>
        <div className="panel">
          <div className="panel-body" style={{ color: "var(--bad)" }}>
            {err}
          </div>
        </div>
        <Link className="btn" href="/">
          Back to feeds
        </Link>
      </div>
    );
  }

  if (!d) {
    return (
      <div className="stack" style={{ paddingTop: 20 }}>
        <div className="muted">Loading {ticker}…</div>
      </div>
    );
  }

  const q = d.quote;
  const color = bandColor(q.confidenceBps);

  return (
    <div className="stack" style={{ paddingTop: 16 }}>
      <div>
        <Link href="/" className="small muted">
          ← all feeds
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 8,
          }}
        >
          <h1 style={{ fontSize: 30 }}>{q.ticker}</h1>
          <span className="muted">{d.instrument.name}</span>
          <SessionTag session={d.readable.session} />
          <ProvTag provenance={d.readable.provenance} />
        </div>
      </div>

      <section className="panel">
        <div className="panel-body">
          <div
            style={{
              display: "flex",
              gap: 30,
              flexWrap: "wrap",
              alignItems: "flex-end",
            }}
          >
            <div>
              <div className="stat-label">Published price</div>
              <div className="mono-lg">${q.price.toFixed(2)}</div>
            </div>
            <div>
              <div className="stat-label">Confidence band</div>
              <div className="mono-lg" style={{ color }}>
                {d.readable.confidencePct}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="stat-label">Range a consumer should assume</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>
                ${d.readable.band[0].toFixed(2)} — $
                {d.readable.band[1].toFixed(2)}
              </div>
              <div style={{ marginTop: 8 }}>
                <Band bps={q.confidenceBps} />
              </div>
            </div>
          </div>

          <div
            className="callout"
            style={{ borderLeftColor: color, background: "transparent" }}
          >
            <strong>How this number was reached.</strong> {q.method}
          </div>
        </div>
      </section>

      <section className="grid grid-4">
        <Stat
          label="Anchor (on-tape)"
          value={`$${q.anchorPrice.toFixed(2)}`}
          sub="last observed close"
        />
        <Stat
          label="Drift applied"
          value={
            q.driftBps === 0
              ? "none"
              : `${q.driftBps > 0 ? "+" : ""}${q.driftBps.toFixed(1)}bps`
          }
          sub={`fitted beta ${d.calibration.beta.toFixed(3)} · R² ${d.calibration.r2.toFixed(2)}`}
          color={q.driftBps === 0 ? undefined : "var(--accent)"}
        />
        <Stat
          label="Last print"
          value={d.readable.staleness}
          sub="ago"
          color={q.stalenessSeconds > 3600 ? "var(--warn)" : undefined}
        />
        <Stat
          label={`${d.readable.nextSession} in`}
          value={d.readable.opensIn}
          sub="next session change"
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Signed payload</span>
          <span className="muted small">
            verify the band and the price came from the same key
          </span>
        </div>
        <div className="panel-body">
          <table className="prose-table" style={{ width: "100%", fontSize: 12 }}>
            <tbody>
              {[
                ["signer", d.signer],
                ["digest", d.digest],
                ["signature", d.signature],
                ["lastTradeTime", String(q.lastTradeTime)],
                ["publishTime", String(q.publishTime)],
                ["sourceCount", String(q.sourceCount)],
                ["maxDeviationBps", String(q.maxDeviationBps)],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td
                    style={{
                      color: "var(--text-faint)",
                      padding: "5px 12px 5px 0",
                      whiteSpace: "nowrap",
                      verticalAlign: "top",
                    }}
                  >
                    {k}
                  </td>
                  <td
                    style={{
                      wordBreak: "break-all",
                      padding: "5px 0",
                      color: "var(--n-800)",
                    }}
                  >
                    {v}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {d.proxies.length ? (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Proxy used for drift</span>
          </div>
          <div className="panel-body grid grid-2">
            {d.proxies.map((p) => (
              <Stat
                key={p.key}
                label={`${p.key} · since close`}
                value={`${p.moveSinceGapPct >= 0 ? "+" : ""}${p.moveSinceGapPct.toFixed(3)}%`}
                sub={`$${p.price.toLocaleString("en-US")}`}
                color={p.moveSinceGapPct >= 0 ? "var(--ok)" : "var(--bad)"}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Fetch this feed</span>
        </div>
        <div className="panel-body">
          <pre className="code">
            <span className="c"># signed quote, ready to post on-chain</span>
            {"\n"}curl {origin}/api/quote/{q.ticker}
          </pre>
        </div>
      </section>
    </div>
  );
}
