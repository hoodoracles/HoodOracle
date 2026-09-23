export const metadata = {
  title: "Docs — hoodoracle",
  description: "API reference, field semantics, and the confidence model.",
};

export default function Docs() {
  return (
    <div className="prose" style={{ paddingTop: 50 }}>
      <div className="eyebrow">Reference</div>
      <h1 className="d1" style={{ margin: "18px 0 26px" }}>Docs</h1>

      <p>
        Three endpoints, no auth, JSON only. Every quote is signed so a consumer
        can verify the price, the band and the provenance all came from the same
        key.
      </p>

      <h2>Endpoints</h2>

      <div className="tbl"><table>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Returns</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>GET /api/quotes</code>
            </td>
            <td>Every tracked instrument, priced against one proxy snapshot.</td>
          </tr>
          <tr>
            <td>
              <code>GET /api/quote/:ticker</code>
            </td>
            <td>One instrument, signed, with the digest and signer address.</td>
          </tr>
          <tr>
            <td>
              <code>GET /api/health</code>
            </td>
            <td>
              Upstream reachability, signer address, current session. Returns
              503 when upstream is down.
            </td>
          </tr>
        </tbody>
      </table></div>

      <h2>Quote fields</h2>

      <div className="tbl"><table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>price</code>
            </td>
            <td>
              The number to use. Equal to <code>anchorPrice</code>{" "}
              when provenance is TRADED or STALE; drifted when DERIVED.
            </td>
          </tr>
          <tr>
            <td>
              <code>anchorPrice</code>
            </td>
            <td>The last price actually observed on tape, before modelling.</td>
          </tr>
          <tr>
            <td>
              <code>confidenceBps</code>
            </td>
            <td>
              Two-sided uncertainty in basis points. Capped at 1500; beyond that
              a quote is not worth publishing.
            </td>
          </tr>
          <tr>
            <td>
              <code>session</code>
            </td>
            <td>0 REGULAR · 1 PRE · 2 POST · 3 CLOSED · 4 HOLIDAY</td>
          </tr>
          <tr>
            <td>
              <code>provenance</code>
            </td>
            <td>0 TRADED · 1 DERIVED · 2 STALE</td>
          </tr>
          <tr>
            <td>
              <code>lastTradeTime</code>
            </td>
            <td>
              Unix seconds of the last print, reconciled against the exchange
              calendar rather than taken from upstream.
            </td>
          </tr>
          <tr>
            <td>
              <code>driftBps</code>
            </td>
            <td>How far the anchor was moved by the model. Zero when TRADED.</td>
          </tr>
          <tr>
            <td>
              <code>maxDeviationBps</code>
            </td>
            <td>Spread between the highest and lowest source reading.</td>
          </tr>
        </tbody>
      </table></div>

      <h2>Provenance, and how to treat each value</h2>

      <div className="tbl"><table>
        <thead>
          <tr>
            <th>Value</th>
            <th>Means</th>
            <th>Safe to</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span className="tag tag-box" style={{ color: "var(--q-tight)" }}>TRADED</span>
            </td>
            <td>Observed print, session open, under 5 minutes old.</td>
            <td>Settle, liquidate, mark.</td>
          </tr>
          <tr>
            <td>
              <span className="tag tag-box" style={{ color: "var(--q-wide)" }}>DERIVED</span>
            </td>
            <td>Tape shut. Last close drifted against a 24/7 proxy.</td>
            <td>Mark to market, display, size positions. Not liquidate.</td>
          </tr>
          <tr>
            <td>
              <span className="tag tag-box" style={{ color: "var(--q-vwide)" }}>STALE</span>
            </td>
            <td>
              No usable anchor, or the tape is open and upstream stopped
              printing.
            </td>
            <td>
              Nothing automatic. During an open session this signals an upstream
              fault, so we deliberately do not model over it.
            </td>
          </tr>
        </tbody>
      </table></div>

      <h2>The confidence model</h2>

      <pre>{`live print:
  bps = BASE[session] + maxDeviationBps       `}<span className="c">{`// 8 regular, 35 pre/post`}</span>{`

gap (DERIVED or STALE):
  sigma = overnightSigmaBps * (hours/17.5)^k  `}<span className="c">{`// k and sigma both fitted`}</span>{`
  bps   = 1.96 * sigma + maxDeviationBps      `}<span className="c">{`// two-sided 95%`}</span>{`
  bps   = max(bps, BASE[CLOSED])              `}<span className="c">{`// never tighter than a live one`}</span>{`

bps = clamp(bps, 1, 1500)`}</pre>

      <p>
        Both <code>sigma</code> and{" "}
        <code>k</code> come from{" "}
        <code>calibration.json</code>, fitted by{" "}
        <code>npm run calibrate</code> against two years of
        realised close-to-open gaps. The measured exponent is{" "}
        <strong>k ≈ 0.107</strong>, not the 0.5 a random walk in calendar time
        would imply. See <a href="/why">the problem</a> for why.
      </p>

      <p>
        The model&apos;s own error is deliberately <em>not</em> added on top.
        The residual sigma is what remains after applying the beta, so it
        already contains it; adding a drift term would double-count and break
        the validated coverage.
      </p>

      <p>
        The floor exists because of a bug caught in testing: without it, the
        band collapsed the moment the session label flipped from CLOSED to PRE
        on Monday morning, even though the underlying data had not improved at
        all. A stale anchor does not become trustworthy because the opening bell
        rang.
      </p>

      <h3>Coverage</h3>

      <p>
        The band claims to be a 95% interval, so that claim is tested by
        replaying every historical gap and counting how many landed inside it.
        All eight instruments fall between 93.4% and 96.4%, across roughly 500
        gaps each. Re-run <code>npm run calibrate</code> to
        reproduce.
      </p>

      <h2>Verifying a signature</h2>

      <pre>{`import { verifyMessage } from "viem";

const r = await fetch("/api/quote/HOOD").then((r) => r.json());

const ok = await verifyMessage({
  address:   r.signer,
  message:   { raw: r.digest },
  signature: r.signature,
});`}</pre>

      <p>
        The digest is <code>keccak256</code> over the
        abi-encoded tuple{" "}
        <code>
          (string ticker, uint128 price, uint64 confidenceBps, uint8 session,
          uint8 provenance, uint8 sourceCount, uint64 maxDeviationBps, uint64
          lastTradeTime, uint64 publishTime)
        </code>
        , with price scaled to 8 decimals. That is exactly the tuple the
        on-chain verifier reconstructs, so the band cannot be stripped from the
        price without invalidating the signature.
      </p>

      <h2>Limits</h2>

      <ul>
        <li>
          <code>getPriceIfTraded</code> and <code>isLive</code> check
          provenance, not age. The contract holds whatever was last relayed, so
          if relaying stops, a TRADED quote keeps reading as live. Check{" "}
          <code>publishTime</code> in any path that acts on a price. The SDK
          does this by default. <code>/api/health</code> reports a stalled
          feed with a 503.
        </li>
        <li>
          The default provider is Yahoo&apos;s unofficial endpoint: no key, real
          print times, but not licensed for commercial redistribution. Add a
          licensed vendor before production.
        </li>
        <li>
          Betas are fitted on two years ending September 2026 and describe that
          regime. They do not anticipate a structural break.
        </li>
        <li>
          The proxy move is measured over exactly the gap window from hourly
          series. Where the series does not reach back far enough, drift is zero
          rather than extrapolated.
        </li>
        <li>
          <code>sourceCount</code> reflects providers that
          actually resolved. With only Yahoo enabled it is 1 and{" "}
          <code>maxDeviationBps</code> is necessarily 0. Add
          a second provider key for those fields to carry signal.
        </li>
      </ul>
    </div>
  );
}
