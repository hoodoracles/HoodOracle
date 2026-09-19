"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Band, Tag, bandClass, bandVerdict, useOrigin } from "@/components/ui";

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
  sources: { source: string; price: number }[];
  proxies: { key: string; price: number; moveSinceGapPct: number }[];
  error?: string;
}

const kvRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "140px 1fr",
  gap: 12,
  padding: "8px 0",
  borderBottom: "1px solid var(--line-2)",
};

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
      <div className="stack-lg" style={{ paddingTop: 56 }}>
        <div className="note" style={{ borderLeftColor: "var(--q-vwide)" }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            {ticker}
          </div>
          <h1 className="d3" style={{ marginBottom: 8 }}>
            Could not price this instrument.
          </h1>
          <p style={{ margin: 0 }}>{err}</p>
        </div>
        <div>
          <Link className="btn" href="/">
            Back to feeds
          </Link>
        </div>
      </div>
    );
  }

  if (!d) {
    return (
      <div style={{ paddingTop: 64 }} className="muted">
        Loading {ticker}…
      </div>
    );
  }

  const q = d.quote;

  return (
    <div className="stack-lg" style={{ paddingTop: 56 }}>
      <section>
        <Link href="/" className="small muted">
          ← all feeds
        </Link>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            flexWrap: "wrap",
            margin: "14px 0 26px",
          }}
        >
          <h1 className="d1" style={{ fontSize: "clamp(38px,6vw,64px)" }}>
            {q.ticker}
          </h1>
          <span className="muted" style={{ fontSize: 16 }}>
            {d.instrument.name}
          </span>
          <Tag box>{d.readable.session}</Tag>
          <Tag box>{d.readable.provenance}</Tag>
        </div>

        <div className="card" style={{ padding: 30 }}>
          <div
            style={{
              display: "flex",
              gap: 48,
              flexWrap: "wrap",
              marginBottom: 26,
            }}
          >
            <div>
              <div className="stat-k">Published price</div>
              <div className="stat-n">${q.price.toFixed(2)}</div>
            </div>
            <div>
              <div className="stat-k">Confidence</div>
              <div className={`stat-n ${bandClass(q.confidenceBps)}`}>
                {d.readable.confidencePct}
              </div>
            </div>
            <div style={{ minWidth: 240, flex: 1 }}>
              <div className="stat-k">Assume this range</div>
              <div className="stat-n" style={{ fontSize: 24 }}>
                ${d.readable.band[0].toFixed(2)} — $
                {d.readable.band[1].toFixed(2)}
              </div>
              <div className="stat-s">{bandVerdict(q.confidenceBps)}</div>
            </div>
          </div>

          <Band bps={q.confidenceBps} width={320} label />

          <p
            style={{
              marginTop: 22,
              marginBottom: 0,
              fontSize: 14,
              color: "var(--ink-2)",
              maxWidth: "76ch",
            }}
          >
            <strong style={{ color: "var(--ink)" }}>
              How this number was reached.
            </strong>{" "}
            {q.method}
          </p>
        </div>
      </section>

      <section className="stats">
        <div>
          <div className="stat-k">Anchor, on tape</div>
          <div className="stat-n">${q.anchorPrice.toFixed(2)}</div>
          <div className="stat-s">last observed close</div>
        </div>
        <div>
          <div className="stat-k">Drift applied</div>
          <div className="stat-n">
            {q.driftBps === 0
              ? "none"
              : `${q.driftBps > 0 ? "+" : ""}${q.driftBps.toFixed(1)}`}
            {q.driftBps === 0 ? "" : <span style={{ fontSize: 17 }}>bps</span>}
          </div>
          <div className="stat-s">
            fitted β {d.calibration.beta.toFixed(3)} · R²{" "}
            {d.calibration.r2.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="stat-k">Last print</div>
          <div className="stat-n">{d.readable.staleness}</div>
          <div className="stat-s">ago</div>
        </div>
        <div>
          <div className="stat-k">{d.readable.nextSession} in</div>
          <div className="stat-n">{d.readable.opensIn}</div>
          <div className="stat-s">next session change</div>
        </div>
      </section>

      <section>
        <div className="sec-head">
          <h2 className="d2">Sources and calibration</h2>
          <span className="sec-rule" />
        </div>
        <div className="grid g2">
          <div className="card">
            <div className="card-title">
              Providers that resolved ({q.sourceCount})
            </div>
            {d.sources.map((s) => (
              <div
                key={s.source}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "9px 0",
                  borderBottom: "1px solid var(--line-2)",
                  fontSize: 13.5,
                }}
              >
                <span>{s.source}</span>
                <span className="mono muted">${s.price.toFixed(4)}</span>
              </div>
            ))}
            <div className="stat-s" style={{ marginTop: 14 }}>
              dispersion {q.maxDeviationBps.toFixed(2)} bps
            </div>
          </div>

          <div className="card">
            <div className="card-title">Fitted on real gaps</div>
            <div className="grid g2" style={{ gap: 10 }}>
              <div>
                <div className="stat-k">Beta</div>
                <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>
                  {d.calibration.beta.toFixed(3)}
                </div>
                <div className="stat-s">
                  prior was {d.calibration.priorBeta}
                </div>
              </div>
              <div>
                <div className="stat-k">Coverage</div>
                <div
                  className="mono"
                  style={{
                    fontSize: 22,
                    fontWeight: 600,
                    color: "var(--q-tight)",
                  }}
                >
                  {d.calibration.coveragePct?.toFixed(1)}%
                </div>
                <div className="stat-s">{d.calibration.samples} gaps</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="sec-head">
          <h2 className="d2">Signed payload</h2>
          <span className="sec-rule" />
        </div>
        <div className="card">
          <div className="card-title">
            price and band signed by the same key
          </div>
          <div className="mono" style={{ fontSize: 12 }}>
            {(
              [
                ["signer", d.signer],
                ["digest", d.digest],
                ["signature", d.signature],
                ["lastTradeTime", String(q.lastTradeTime)],
                ["publishTime", String(q.publishTime)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} style={kvRow}>
                <span className="muted">{k}</span>
                <span style={{ wordBreak: "break-all", color: "var(--ink)" }}>
                  {v}
                </span>
              </div>
            ))}
          </div>
          <pre style={{ marginBottom: 0 }}>
            <span className="c"># fetch it yourself</span>
            {"\n"}curl {origin}/api/quote/{q.ticker}
          </pre>
        </div>
      </section>
    </div>
  );
}
