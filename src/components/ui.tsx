"use client";

import { useEffect, useState } from "react";

/* The card fill is the meaning: you should know how much to trust a number
   before you have read it. */

export type Fill = "cream" | "mint" | "amber" | "coral" | "violet";

/**
 * Fill by how wide the band is, not by provenance.
 *
 * Provenance is already on the card as a tag, and every feed shares it while
 * the tape is shut — so keying the fill to it made eight identical cards. Band
 * width is the more actionable signal anyway: it is what a consumer sizes
 * against, and it varies per instrument, so the board reads at a glance.
 */
export function fillFor(_provenance: string, bps?: number): Fill {
  if (bps === undefined) return "cream";
  if (bps <= 120) return "mint";   // tight enough to lean on
  if (bps <= 220) return "cream";  // ordinary
  if (bps <= 330) return "amber";  // wide, size down
  return "coral";                  // very wide, do not settle
}

export function sessionFill(session: string): Fill {
  if (session === "REGULAR") return "mint";
  if (session === "PRE" || session === "POST") return "cream";
  return "violet";
}

export function Tag({
  children,
  live,
  onDark,
}: {
  children: React.ReactNode;
  live?: boolean;
  onDark?: boolean;
}) {
  return (
    <span className={`tag${onDark ? " tag-on-dark" : ""}`}>
      {live ? <span className="dot pulse" /> : null}
      {children}
    </span>
  );
}

/**
 * The confidence interval, drawn to scale.
 *
 * Scaled on a square root so a 0.96% band and a 3.8% band are visibly
 * different. Linear scaling against the 15% publish ceiling made every
 * realistic band an identical sliver, which defeats the point of drawing it.
 */
export function Band({ bps, label }: { bps: number; label?: boolean }) {
  // Square-root scale against the 15% publish ceiling: linear made every
  // realistic band an identical sliver, which defeats drawing it at all.
  const half = Math.min(46, Math.sqrt(bps / 1500) * 46);
  return (
    <div className="band-wrap">
      <div className="band" style={{ ["--pct" as string]: `${half}%` }}>
        <span className="band-fill" />
        <span className="band-edge" style={{ left: `calc(50% - ${half}%)` }} />
        <span className="band-edge" style={{ left: `calc(50% + ${half}%)` }} />
        <span className="band-mid" />
      </div>
      {label ? (
        <span className="band-num">±{(bps / 100).toFixed(2)}%</span>
      ) : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  fill,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  fill?: Fill;
}) {
  return (
    <div className={`card${fill ? ` fill-${fill}` : ""}`}>
      <div className="stat-k">{label}</div>
      <div className="stat-n">{value}</div>
      {sub ? <div className="stat-s">{sub}</div> : null}
    </div>
  );
}

export function countdown(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * The page origin, but only after mount. Reading window.location during render
 * makes the server and client markup disagree, which React reports as a
 * hydration failure.
 */
export function useOrigin(): string {
  const [origin, setOrigin] = useState("https://your-host");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
}

/** Decorative marks that bleed out of a card corner, as the reference does. */
export function Glyph({ kind }: { kind: "burst" | "bolt" | "rings" | "wave" }) {
  if (kind === "burst") {
    return (
      <svg className="card-glyph" viewBox="0 0 100 100" aria-hidden="true">
        <path
          d="M50 0 L58 34 L88 14 L68 44 L100 50 L68 56 L88 86 L58 66 L50 100 L42 66 L12 86 L32 56 L0 50 L32 44 L12 14 L42 34 Z"
          fill="currentColor"
        />
      </svg>
    );
  }
  if (kind === "bolt") {
    return (
      <svg className="card-glyph" viewBox="0 0 100 100" aria-hidden="true">
        <path d="M58 0 L20 56 L46 56 L38 100 L80 40 L52 40 Z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "rings") {
    return (
      <svg className="card-glyph" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="5" />
        <circle cx="50" cy="50" r="30" fill="none" stroke="currentColor" strokeWidth="5" />
        <circle cx="50" cy="50" r="13" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="card-glyph" viewBox="0 0 100 100" aria-hidden="true">
      <path
        d="M0 60 Q 25 20 50 60 T 100 60"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
      />
      <path
        d="M0 84 Q 25 44 50 84 T 100 84"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
      />
    </svg>
  );
}
