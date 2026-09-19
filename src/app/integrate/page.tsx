export const metadata = {
  title: "Integrate — hoodoracle",
  description:
    "Post signed quotes on-chain and read them with session-aware policy.",
};

export default function Integrate() {
  return (
    <div className="prose" style={{ paddingTop: 18 }}>
      <div className="eyebrow">Integration</div>
      <h1 style={{ fontSize: 30, margin: "10px 0 16px" }}>Integrate</h1>

      <p>
        Quotes are signed off-chain and posted on demand. Anyone may relay a
        quote; only the signature is trusted. Target chain is Arbitrum, because
        Robinhood Chain is an Arbitrum Orbit L2 and the same Solidity deploys to
        both.
      </p>

      <h2>1 · Read the consumer interface</h2>

      <p>
        The function a liquidation path should call is{" "}
        <code className="inline">getPriceIfTraded</code>. It refuses to return a
        modelled weekend price at all, rather than returning one and hoping the
        caller checks.
      </p>

      <pre className="code">{`interface IHoodOracle {
    struct Quote {
        uint128 price;           `}<span className="c">{`// 8 decimals`}</span>{`
        uint64  confidenceBps;
        uint8   session;         `}<span className="c">{`// 0 REG 1 PRE 2 POST 3 CLOSED 4 HOLIDAY`}</span>{`
        uint8   provenance;      `}<span className="c">{`// 0 TRADED 1 DERIVED 2 STALE`}</span>{`
        uint8   sourceCount;
        uint64  maxDeviationBps;
        uint64  lastTradeTime;
        uint64  publishTime;
    }

    function getQuote(string calldata t) external view returns (Quote memory);
    function getPriceIfTraded(string calldata t, uint64 maxBps) external view returns (uint128);
    function getBandedPrice(string calldata t, bool lower) external view returns (uint128);
    function isLive(string calldata t, uint64 maxBps) external view returns (bool);
}`}</pre>

      <h2>2 · Write policy that was previously impossible</h2>

      <pre className="code">{`contract LendingMarket {
    IHoodOracle public oracle;

    `}<span className="c">{`// Liquidation demands a live print inside 50bps. A weekend`}</span>{`
    `}<span className="c">{`// quote reverts here rather than liquidating on a model.`}</span>{`
    function liquidate(address user, string calldata ticker) external {
        uint128 px = oracle.getPriceIfTraded(ticker, 50);
        _liquidate(user, px);
    }

    `}<span className="c">{`// Collateral is always valued at the pessimistic edge of the`}</span>{`
    `}<span className="c">{`// band, so a wide weekend band automatically reduces borrowing`}</span>{`
    `}<span className="c">{`// power instead of being ignored.`}</span>{`
    function collateralValue(string calldata ticker, uint256 qty)
        public view returns (uint256)
    {
        uint128 conservative = oracle.getBandedPrice(ticker, true);
        return (uint256(conservative) * qty) / 1e8;
    }

    `}<span className="c">{`// New borrows pause while the tape is shut.`}</span>{`
    function borrow(string calldata ticker, uint256 amount) external {
        require(oracle.isLive(ticker, 100), "market shut");
        _borrow(msg.sender, amount);
    }
}`}</pre>

      <h2>3 · Relay a quote on-chain</h2>

      <pre className="code">{`import { createWalletClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";

const r = await fetch("https://your-host/api/quote/HOOD").then((x) => x.json());

await wallet.writeContract({
  address: HOOD_ORACLE,
  abi: hoodOracleAbi,
  functionName: "postQuote",
  args: [
    r.quote.ticker,
    {
      price:           BigInt(Math.round(r.quote.price * 1e8)),
      confidenceBps:   BigInt(r.quote.confidenceBps),
      session:         r.quote.session,
      provenance:      r.quote.provenance,
      sourceCount:     r.quote.sourceCount,
      maxDeviationBps: BigInt(Math.round(r.quote.maxDeviationBps)),
      lastTradeTime:   BigInt(r.quote.lastTradeTime),
      publishTime:     BigInt(r.quote.publishTime),
    },
    r.signature,
  ],
});`}</pre>

      <h2>Guards the contract enforces</h2>

      <table>
        <thead>
          <tr>
            <th>Guard</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code className="inline">UnknownSigner</code>
            </td>
            <td>Only allow-listed signers are accepted.</td>
          </tr>
          <tr>
            <td>
              <code className="inline">NotNewer</code>
            </td>
            <td>
              Blocks replay of an older quote, including re-posting a stale
              favourable price.
            </td>
          </tr>
          <tr>
            <td>
              <code className="inline">QuoteTooOld</code> /{" "}
              <code className="inline">QuoteFromFuture</code>
            </td>
            <td>
              Bounds clock skew in both directions. 60s of forward tolerance,
              configurable age limit backwards.
            </td>
          </tr>
          <tr>
            <td>
              <code className="inline">BandTooWide</code>
            </td>
            <td>
              A quote past the publish ceiling is rejected rather than stored.
            </td>
          </tr>
          <tr>
            <td>
              <code className="inline">ZeroPrice</code>
            </td>
            <td>
              Upstream returns <code className="inline">Price: 0</code> for
              unsupported tickers. That must never reach storage.
            </td>
          </tr>
          <tr>
            <td>
              <code className="inline">InvalidEnum</code>
            </td>
            <td>
              Out-of-range session or provenance bytes are refused, so a
              consumer&apos;s switch cannot fall through.
            </td>
          </tr>
        </tbody>
      </table>

      <div className="callout callout-warn">
        <strong>Not audited.</strong> This is an evaluation build. The contract
        has not been audited and the confidence model has not been calibrated
        against realised opens. Do not settle real money against it.
      </div>

      <p className="small muted">
        Contract source: <code className="inline">contracts/HoodOracle.sol</code>
      </p>
    </div>
  );
}
