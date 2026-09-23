"use client";

import { useEffect, useState } from "react";
import { Tag } from "./ui";

type Read =
  | { answering: true; value: string; updatedAt?: number }
  | { answering: false; reason: string; detail: string };

interface FeedState {
  asOf: string;
  session: string;
  ticker: string;
  feedRead: Read;
  morphoPrice: Read;
}

const WHY: Record<string, string> = {
  REGULAR: "Regular session.",
  PRE: "Pre-market: the tape is open but no live print has reached the feed.",
  POST: "After-hours: no live print has reached the feed.",
  CLOSED: "The stock market is shut. Every price now is a model.",
  HOLIDAY: "Market holiday. Every price now is a model.",
};

/**
 * The live NVDA feed, read the way Morpho reads it. Answering means borrows
 * and liquidations can happen; refusing means they cannot, and says why.
 */
export function FeedStatus() {
  const [s, setS] = useState<FeedState | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/feed", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => alive && (setS(j), setErr(false)))
        .catch(() => alive && setErr(true));
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const f = s?.feedRead;
  const m = s?.morphoPrice;

  return (
    <div className="card" style={{ margin: "18px 0 22px" }}>
      <div className="card-head">
        <span className="card-title">Right now · {s?.ticker ?? "NVDA"} feed and Morpho price()</span>
        <Tag live box>
          {s ? s.session : "reading"}
        </Tag>
      </div>
      {err && !s ? (
        <div className="stat-s">The chain did not answer. Retrying.</div>
      ) : !f || !m ? (
        <div className="stat-s">Reading the chain…</div>
      ) : f.answering ? (
        <>
          <div className="stat-n q-tight">${f.value}</div>
          <div className="stat-s">
            Answering: a live print, priced per token with the multiplier.
            Morpho&apos;s price() is answering too, so borrows and liquidations
            run on this number.
          </div>
        </>
      ) : (
        <>
          <div className="stat-n q-vwide" style={{ fontSize: 26 }}>
            Refusing · {f.reason}
          </div>
          <div className="stat-s">
            {WHY[s!.session] ?? ""} The feed will not answer because {f.detail}.
            Morpho&apos;s price() {m.answering ? "answered" : `reverts with the same ${m.reason}`}, so
            nobody can borrow against or be liquidated on this price. Repay and
            supply still work.
          </div>
        </>
      )}
    </div>
  );
}
