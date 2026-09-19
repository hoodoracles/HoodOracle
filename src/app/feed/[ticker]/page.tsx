"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Band, Glyph, Tag, fillFor, useOrigin } from "@/components/ui";

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
      <div className="stack-lg" style={{ paddingTop: 50 }}>
        <div className="card fill-coral">
          <div className="stat-k">{ticker}</div>
          <h1 className="d3" style={{ marginBottom: 10 }}>
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
      <div style={{ paddingTop: 60 }} className="muted">
        Loading {ticker}…
      </div>
    );
  }

  const q = d.quote;
  const fill = fillFor(d.readable.provenance, q.confidenceBps);

  return (
    <div className="stack-lg" style={{ paddingTop: 50 }}>
      <section>
        <Link href="/" className="small muted">
          ← all feeds
        </Link>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 16,
            flexWrap: "wrap",
            margin: "14px 0 26px",
          }}
        >
          <h1 className="d1" style={{ fontSize: "clamp(44px,8vw,86px)" }}>
            {q.ticker}
          </h1>
          <span className="muted" style={{ fontSize: 16 }}>
            {d.instrument.name}
          </span>
          <Tag onDark>{d.readable.session}</Tag>
          <Tag onDark>{d.readable.provenance}</Tag>
        </div>

        <div className={`card fill-${fill}`} style={{ padding: 30 }}>
          <Glyph kind="rings" />
          <div
            style={{
              display: "flex",
              gap: 44,
              flexWrap: "wrap",
              marginBottom: 24,
            }}
          >
            <div>
              <div className="stat-k">Published price</div>
              <div className="stat-n">${q.price.toFixed(2)}</div>
            </div>
            <div>
              <div className="stat-k">Confidence</div>
              <div className="stat-n">{d.readable.confidencePct}</div>
            </div>
            <div style={{ minWidth: 220, flex: 1 }}>
              <div className="stat-k">Assume this range</div>
              <div className="stat-n" style={{ fontSize: 22 }}>
                ${d.readable.band[0].toFixed(2)} — $
                {d.readable.band[1].toFixed(2)}
              </div>
            </div>
          </div>

          <Band bps={q.confidenceBps} />

          <p style={{ marginTop: 20, marginBottom: 0, fontSize: 13.5 }}>
            <strong>How this number was reached.</strong> {q.method}
          </p>
        </div>
      </section>

      <section className="grid g4">
        <div className="card">
          <div className="stat-k">Anchor, on tape</div>
          <div className="stat-n">${q.anchorPrice.toFixed(2)}</div>
          <div className="stat-s">last observed close</div>
        </div>
        <div className="card">
          <div className="stat-k">Drift applied</div>
          <div className="stat-n">
            {q.driftBps === 0
              ? "none"
              : `${q.driftBps > 0 ? "+" : ""}${q.driftBps.toFixed(1)}`}
            {q.driftBps === 0 ? "" : <span style={{ fontSize: 18 }}>bps</span>}
          </div>
          <div className="stat-s">
            fitted β {d.calibration.beta.toFixed(3)} · R²{" "}
            {d.calibration.r2.toFixed(2)}
          </div>
        </div>
        <div className="card">
          <div className="stat-k">Last print</div>
          <div className="stat-n">{d.readable.staleness}</div>
          <div className="stat-s">ago</div>
        </div>
        <div className="card">
          <div className="stat-k">{d.readable.nextSession} in</div>
          <div className="stat-n">{d.readable.opensIn}</div>
          <div className="stat-s">next session change</div>
        </div>
      </section>

      <section>
        <h2 className="d2" style={{ marginBottom: 16 }}>
          Sources and calibration
        </h2>
        <div className="grid g2">
          <div className="card">
            <div className="card-head">
              <span className="card-title">
                Providers that resolved ({q.sourceCount})
              </span>
            </div>
            {d.sources.map((s) => (
              <div
                key={s.source}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "8px 0",
                  borderBottom: "1px solid var(--line-soft)",
                }}
              >
                <span>{s.source}</span>
                <span className="muted">${s.price.toFixed(4)}</span>
              </div>
            ))}
            <div className="stat-s" style={{ marginTop: 12 }}>
              dispersion {q.maxDeviationBps.toFixed(2)} bps
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Fitted on real gaps</span>
            </div>
            <div className="grid g2" style={{ gap: 10 }}>
              <div>
                <div className="stat-k">Beta</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {d.calibration.beta.toFixed(3)}
                </div>
                <div className="stat-s">prior was {d.calibration.priorBeta}</div>
              </div>
              <div>
                <div className="stat-k">Coverage</div>
                <div
                  style={{ fontSize: 20, fontWeight: 700, color: "var(--mint)" }}
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
        <h2 className="d2" style={{ marginBottom: 16 }}>
          Signed payload
        </h2>
        <div className="card">
          <div className="card-head">
            <span className="card-title">
              price and band signed by the same key
            </span>
          </div>
          <div style={{ fontSize: 12 }}>
            {(
              [
                ["signer", d.signer],
                ["digest", d.digest],
                ["signature", d.signature],
                ["lastTradeTime", String(q.lastTradeTime)],
                ["publishTime", String(q.publishTime)],
              ] as const
            ).map(([k, v]) => (
              <div
                key={k}
                style={{
                  display: "grid",
                  gridTemplateColumns: "130px 1fr",
                  gap: 12,
                  padding: "7px 0",
                  borderBottom: "1px solid var(--line-soft)",
                }}
              >
                <span className="muted">{k}</span>
                <span style={{ wordBreak: "break-all" }}>{v}</span>
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
