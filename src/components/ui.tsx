"use client";

import { useEffect, useState } from "react";

/**
 * Severity of a confidence band, as a class name.
 *
 * This is the only thing on the site allowed to introduce colour, and it tints
 * just the band drawing and its number. Filling whole cards with it — the
 * previous approach — turned a risk signal into wallpaper: every card was
 * coloured, so no colour meant anything.
 *
 * The thresholds are the ones a consumer actually sizes against. Under 1.2% is
 * tight enough to lean on; past 3.3% the band is wider than most intraday
 * ranges and settling against it is not defensible.
 */
export function bandClass(bps?: number): string {
  if (bps === undefined) return "q-ok";
  if (bps <= 120) return "q-tight";
  if (bps <= 220) return "q-ok";
  if (bps <= 330) return "q-wide";
  return "q-vwide";
}

/** Plain-language reading of the same thresholds, for a tooltip or caption. */
export function bandVerdict(bps: number): string {
  if (bps <= 120) return "tight enough to settle against";
  if (bps <= 220) return "ordinary";
  if (bps <= 330) return "wide — size down";
  return "very wide — do not settle";
}

export function Tag({
  children,
  live,
  box,
}: {
  children: React.ReactNode;
  live?: boolean;
  box?: boolean;
}) {
  return (
    <span className={`tag${box ? " tag-box" : ""}`}>
      {live ? <span className="dot pulse" /> : null}
      {children}
    </span>
  );
}

/**
 * The confidence interval, drawn to scale.
 *
 * Square-root scale against the 15% publish ceiling. Linear made every
 * realistic band an identical two-pixel sliver, which defeats drawing it at
 * all; the root spreads 0.9% and 3.9% far enough apart to compare by eye.
 */
export function Band({
  bps,
  label,
  width,
  full,
}: {
  bps: number;
  label?: boolean;
  /** Overrides the default 96px drawing width. */
  width?: number;
  /**
   * Stretch to the container. A percentage width cannot do this on its own:
   * the wrapper is an inline-flex sized to its content, so a 100% child
   * resolves against a width that depends on the child, and collapses.
   */
  full?: boolean;
}) {
  const half = Math.min(46, Math.sqrt(bps / 1500) * 46);
  return (
    <span
      className={`band-wrap ${bandClass(bps)}${full ? " band-full" : ""}`}
      title={`±${(bps / 100).toFixed(2)}% — ${bandVerdict(bps)}`}
    >
      <span className="band" style={width ? { width } : undefined}>
        <span className="band-track" />
        <span className="band-fill" style={{ ["--pct" as string]: `${half}%` }} />
        <span className="band-edge" style={{ left: `calc(50% - ${half}%)` }} />
        <span className="band-edge" style={{ left: `calc(50% + ${half}%)` }} />
        <span className="band-mid" />
      </span>
      {label ? (
        <span className="band-num">±{(bps / 100).toFixed(2)}%</span>
      ) : null}
    </span>
  );
}

/** One figure in a fact-sheet strip. Deliberately unboxed. */
export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div>
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
