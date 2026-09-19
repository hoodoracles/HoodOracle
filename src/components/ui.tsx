"use client";

import { useEffect, useState } from "react";

/** Shared presentational pieces. Kept dumb so pages stay readable. */

export function SessionTag({ session }: { session: string }) {
  const live = session === "REGULAR";
  const thin = session === "PRE" || session === "POST";
  const cls = live ? "tag-ok" : thin ? "tag-warn" : "tag-mute";
  return (
    <span className={`tag ${cls}`}>
      <span className={`dot${live ? " dot-pulse" : ""}`} />
      {session}
    </span>
  );
}

export function ProvTag({ provenance }: { provenance: string }) {
  const cls =
    provenance === "TRADED"
      ? "tag-ok"
      : provenance === "DERIVED"
        ? "tag-accent"
        : "tag-bad";
  const title =
    provenance === "TRADED"
      ? "Observed print from a live session."
      : provenance === "DERIVED"
        ? "Tape is shut. Last close drifted against a 24/7 proxy, and banded accordingly."
        : "No usable anchor. Last known value, unmodelled.";
  return (
    <span className={`tag ${cls}`} title={title}>
      {provenance}
    </span>
  );
}

/** Colour the band by how wide it is: tight is green, wide is a warning. */
export function bandColor(bps: number): string {
  if (bps <= 25) return "var(--ok)";
  if (bps <= 100) return "var(--accent)";
  if (bps <= 400) return "var(--warn)";
  return "var(--bad)";
}

export function Band({ bps }: { bps: number }) {
  // Scale against the 1500bps publish ceiling, but on a square-root curve.
  // Linear scaling made a 0.85% band render as a 3px sliver indistinguishable
  // from a 0.08% one, which hides exactly the difference the bar exists to show.
  const pct = Math.min(100, Math.sqrt(bps / 1500) * 100);
  const color = bandColor(bps);
  return (
    <div className="band">
      <span style={{ color, fontWeight: 600 }}>
        ±{(bps / 100).toFixed(2)}%
      </span>
      <span className="band-track">
        <span
          className="band-fill"
          style={{ width: `${Math.max(3, pct)}%`, background: color }}
        />
      </span>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

/**
 * The page's origin, but only after mount.
 *
 * Reading window.location during render makes the server and client markup
 * disagree, which React reports as a hydration failure. Returning a stable
 * placeholder first and filling it in after mount keeps both passes identical.
 */
export function useOrigin(): string {
  const [origin, setOrigin] = useState("https://your-host");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
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
