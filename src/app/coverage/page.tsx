// The track record.
//
// Every other page on this site explains what the band is meant to do. This
// one is the only page that can be wrong about it in public, which is the
// point: a 95% interval that is never scored is a decoration.
//
// Rendered on the server straight from the chain. There is no database behind
// it — see src/lib/ledger.ts.

import Link from "next/link";
import { Band } from "@/components/ui";
import { loadLedger, type CoverageStats, type Resolution } from "@/lib/ledger";
import { calibrationFor } from "@/lib/calibration";
import { describeGap } from "@/lib/session";
import { UNIVERSE } from "@/lib/universe";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Track record — hoodoracle",
  description:
    "Every band hoodoracle has published, scored against the print that settled it. Computed from Robinhood Chain event logs, with no database in between.",
};

/**
 * The backtest figure, sample-weighted, read from calibration.json.
 *
 * Derived rather than written down: `npm run calibrate` rewrites that file
 * whenever the fit is redone, and a hardcoded "94.9% over 3,990 gaps" on this
 * page would quietly become a lie the first time it does.
 */
function backtest(): { coveragePct: number; samples: number } {
  let hits = 0;
  let n = 0;
  for (const i of UNIVERSE) {
    const c = calibrationFor(i.ticker);
    if (c.coveragePct == null || !c.samples) continue;
    hits += (c.coveragePct / 100) * c.samples;
    n += c.samples;
  }
  return { coveragePct: n ? (hits / n) * 100 : 0, samples: n };
}

function pct(v: number | null, dp = 1): string {
  return v === null ? "—" : `${v.toFixed(dp)}%`;
}

function when(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function Interval({ s }: { s: CoverageStats }) {
  if (!s.ci) return <span className="muted">—</span>;
  return (
    <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
      {s.ci.lower.toFixed(1)} – {s.ci.upper.toFixed(1)}
    </span>
  );
}

export default async function Coverage() {
  let result: Awaited<ReturnType<typeof loadLedger>> = null;
  let rpcError: string | null = null;
  try {
    result = await loadLedger();
  } catch (e) {
    rpcError = e instanceof Error ? e.message : String(e);
  }

  const bt = backtest();

  if (rpcError || !result) {
    return (
      <div className="prose" style={{ paddingTop: 50 }}>
        <div className="eyebrow">Track record</div>
        <h1 className="d1" style={{ margin: "18px 0 26px" }}>
          Was the band right?
        </h1>
        <div className="note note-warn">
          {rpcError
            ? `Could not read the chain: ${rpcError}`
            : "No chain is configured for this deployment, so there is no published record to score."}
        </div>
      </div>
    );
  }

  const { ledger, config } = result;
  const s = ledger.atReopen;
  const resolutions: Resolution[] = ledger.episodes
    .map((e) => e.atReopen)
    .sort((a, b) => b.resolvedAt - a.resolvedAt);
  const pendingQuotes = ledger.pending.reduce((n, p) => n + p.quotes, 0);

  return (
    <div style={{ paddingTop: 50, paddingBottom: 30 }}>
      <div className="prose">
        <div className="eyebrow">Track record</div>
        <h1 className="d1" style={{ margin: "18px 0 22px" }}>
          Was the band right?
        </h1>
        <p className="lede">
          Every quote published while the market was shut is a claim about a
          price nobody could observe yet. When the tape reopens, that claim is
          either right or it isn&rsquo;t. This page scores all of them.
        </p>
        <p>
          The record is the chain. The contract keeps only the latest quote in
          storage, but every quote it ever accepted survives as a{" "}
          <code>QuotePosted</code> log signed by an allow-listed key. So these
          numbers are not ours to adjust after the fact, and you can recompute
          them yourself from {config.chainName} without asking us for anything.
        </p>
      </div>

      {/* ------------------------------------------------ headline */}
      <div className="sec-head" style={{ marginTop: 44 }}>
        <h2>Coverage at reopen</h2>
        <span className="sec-rule" />
        <span className="sec-note">
          nominal {ledger.nominalPct}% · one score per closure
        </span>
      </div>

      {/* .stats rather than .panel-figs: the latter is a vertical stack, which
          is right inside the homepage's two-column panel and wrong across a
          full-width row. */}
      <section className="stats">
        <div>
          <div className="stat-k">Live coverage</div>
          <div
            className="stat-n"
            style={{ color: s.n ? undefined : "var(--ink-4)" }}
          >
            {pct(s.coveragePct)}
          </div>
          <div className="stat-s">
            {s.n ? (
              <>
                {s.hits} of {s.n} · CI <Interval s={s} />
              </>
            ) : (
              "nothing has resolved yet"
            )}
          </div>
        </div>
        <div>
          <div className="stat-k">Backtest</div>
          <div className="stat-n">{bt.coveragePct.toFixed(1)}%</div>
          <div className="stat-s">
            {bt.samples.toLocaleString("en-US")} historical gaps, 2 years
          </div>
        </div>
        <div>
          <div className="stat-k">Quotes on record</div>
          <div className="stat-n">
            {ledger.quotes.length.toLocaleString("en-US")}
          </div>
          <div className="stat-s">
            {ledger.firstPublish ? `since ${when(ledger.firstPublish)}` : "—"}
          </div>
        </div>
        <div>
          <div className="stat-k">Band utilisation</div>
          <div className="stat-n">
            {s.meanRatio === null ? "—" : s.meanRatio.toFixed(2)}
          </div>
          <div className="stat-s">mean |error| ÷ band · 0.5 is well sized</div>
        </div>
      </section>

      {ledger.beforeCalibration > 0 ? (
        <div className="note note-warn" style={{ marginTop: 18 }}>
          <strong>This record straddles a model change.</strong>{" "}
          {ledger.beforeCalibration === s.n ? (
            <>
              Every one of the {s.n} scored band
              {s.n === 1 ? "" : "s"} above was
            </>
          ) : (
            <>
              {ledger.beforeCalibration} of the {s.n} scored bands above{" "}
              {ledger.beforeCalibration === 1 ? "was" : "were"}
            </>
          )}{" "}
          published before the running calibration was fitted on{" "}
          {when(ledger.calibratedAt)}, so{" "}
          {ledger.beforeCalibration === 1 ? "it tests" : "they test"} a model
          that is no longer in use.{" "}
          {ledger.sinceCalibration.n === 0 ? (
            <>Nothing has resolved under the current model yet.</>
          ) : (
            <>
              Restricted to the current model the figure is{" "}
              <strong>{pct(ledger.sinceCalibration.coveragePct)}</strong> over{" "}
              {ledger.sinceCalibration.n} closure
              {ledger.sinceCalibration.n === 1 ? "" : "s"}.
            </>
          )}{" "}
          Both are shown rather than only the flattering one: the headline is
          what consumers were actually handed, and quietly dropping quotes we
          have since decided we dislike would be marking our own homework.
        </div>
      ) : null}

      {s.n === 0 ? (
        <div className="note" style={{ marginTop: 18 }}>
          <strong>Nothing has resolved yet.</strong> {pendingQuotes} quote
          {pendingQuotes === 1 ? "" : "s"} across{" "}
          {ledger.pending.length} instrument
          {ledger.pending.length === 1 ? "" : "s"}{" "}
          {pendingQuotes === 1 ? "is" : "are"} on the chain waiting for the tape
          to reopen. The first scores land with the first live print after that.
          An unresolved claim is counted as pending, never as a miss — treating
          &ldquo;not yet observed&rdquo; as a failure is the easiest way to make
          a statistic like this lie.
        </div>
      ) : null}

      {/* ------------------------------------------------ per instrument */}
      <div className="sec-head" style={{ marginTop: 44 }}>
        <h2>By instrument</h2>
        <span className="sec-rule" />
        <span className="sec-note">live vs backtested</span>
      </div>

      <div className="board">
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Live coverage</th>
              <th>Scored</th>
              <th>95% CI</th>
              <th>Backtest</th>
              <th>Pending</th>
            </tr>
          </thead>
          <tbody>
            {UNIVERSE.map((inst) => {
              const st = ledger.perTicker[inst.ticker];
              const cal = calibrationFor(inst.ticker);
              const pend = ledger.pending.find((p) => p.ticker === inst.ticker);
              return (
                <tr key={inst.ticker}>
                  <td>
                    <Link className="row-link" href={`/feed/${inst.ticker}`}>
                      <strong>{inst.ticker}</strong>
                    </Link>{" "}
                    <span className="row-name">{inst.name}</span>
                  </td>
                  <td
                    style={{
                      color: st?.n ? "var(--ink)" : "var(--ink-4)",
                      fontWeight: st?.n ? 600 : 400,
                    }}
                  >
                    {pct(st?.coveragePct ?? null)}
                  </td>
                  <td className="muted">
                    {st?.n ? `${st.hits}/${st.n}` : "—"}
                  </td>
                  <td>{st ? <Interval s={st} /> : <span className="muted">—</span>}</td>
                  <td className="muted">
                    {cal.coveragePct == null ? "—" : `${cal.coveragePct.toFixed(1)}%`}
                  </td>
                  <td className="muted">{pend ? pend.quotes : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ------------------------------------------------ resolutions */}
      {resolutions.length > 0 ? (
        <>
          <div className="sec-head" style={{ marginTop: 44 }}>
            <h2>Every resolution</h2>
            <span className="sec-rule" />
            <span className="sec-note">newest first</span>
          </div>
          <div className="board">
            <table>
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Published</th>
                  <th>Band</th>
                  <th>Claimed</th>
                  <th>Printed</th>
                  <th>Error</th>
                  <th>Held</th>
                </tr>
              </thead>
              <tbody>
                {resolutions.slice(0, 120).map((r) => (
                  <tr key={`${r.txHash}-${r.predictedAt}`}>
                    <td>
                      <strong>{r.ticker}</strong>
                    </td>
                    <td className="muted">
                      {when(r.predictedAt)}
                      <br />
                      <span style={{ fontSize: 11 }}>
                        {describeGap(r.leadSeconds)} before the print
                      </span>
                    </td>
                    <td>
                      <Band bps={r.confidenceBps} label width={70} />
                    </td>
                    <td className="muted">
                      {r.lower.toFixed(2)} – {r.upper.toFixed(2)}
                    </td>
                    <td style={{ color: "var(--ink)", fontWeight: 600 }}>
                      {r.resolvedPrice.toFixed(2)}
                    </td>
                    <td className={r.hit ? "muted" : "bad"}>
                      {r.errorBps >= 0 ? "+" : ""}
                      {r.errorBps.toFixed(0)} bps
                      <br />
                      <span style={{ fontSize: 11 }}>
                        {(r.ratio * 100).toFixed(0)}% of band
                      </span>
                    </td>
                    <td className={r.hit ? "ok" : "bad"}>
                      {r.hit ? "yes" : "no"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {resolutions.length > 120 ? (
            <p className="small muted" style={{ marginTop: 10 }}>
              Showing the most recent 120 of {resolutions.length}. The full set
              is at <code>/api/coverage?full=1</code>.
            </p>
          ) : null}
        </>
      ) : null}

      {/* ------------------------------------------------ method */}
      <div className="sec-head" style={{ marginTop: 44 }}>
        <h2>How this is scored</h2>
        <span className="sec-rule" />
      </div>

      <div className="prose">
        <p>
          <strong>One score per closure.</strong> A closure is a run of quotes
          published while the tape was shut. It is scored using the last band
          published before the reopening print. That is deliberate: the fitted
          sigma is anchored on a <em>complete</em> close-to-open gap, so the
          band is only claiming to cover the whole gap once the whole gap has
          elapsed. Scoring the last quote is the only apples-to-apples
          comparison with the backtest.
        </p>
        <p>
          <strong>Every band during the closure, too.</strong> Scored against
          the same print, all {ledger.allDuringClosure.n} of them come to{" "}
          {pct(ledger.allDuringClosure.coveragePct)}. Expect this to read lower,
          and it is not a bug: the band widens with elapsed staleness, so a
          quote published an hour into a 62-hour weekend carries an
          overnight-sized band against a weekend-sized move. It is reported
          because a consumer reading the feed on Saturday morning is handed that
          quote, not the Monday one.
        </p>
        <p>
          <strong>Live prints are not scored against each other.</strong> A{" "}
          <code>TRADED</code> band is source dispersion plus execution noise
          around a price that already exists. It is not a forecast, so asking
          whether the next print landed inside it would be testing a claim the
          oracle never made.
        </p>
        <p>
          <strong>The arithmetic matches the contract.</strong> Band edges are
          computed as <code>(price * confidenceBps) / 10000</code> over
          integers, exactly as <code>getBandedPrice</code> does on-chain, so the
          interval scored here is the interval a consumer is actually handed.
          Doing this in floating point is not merely imprecise — it moves
          answers, because a price landing exactly on the edge falls the wrong
          way.
        </p>
        <p>
          <strong>Intervals are Wilson score, 95%.</strong> With a handful of
          samples a bare percentage invites the reader to treat
          &ldquo;3 of 3&rdquo; and &ldquo;3,790 of 3,992&rdquo; as the same
          statement. They are not, and the interval says so.
        </p>
        <p className="small muted">
          Contract{" "}
          <code>
            {config.address}
          </code>{" "}
          on {config.chainName} ({config.chainId}). Signer
          {ledger.signers.length === 1 ? "" : "s"}{" "}
          {ledger.signers.map((x) => (
            <code key={x}>{x}</code>
          ))}
          . Raw data at <Link href="/api/coverage">/api/coverage</Link>, method
          in <code>src/lib/ledger.ts</code>.
        </p>
      </div>
    </div>
  );
}
