export const metadata = {
  title: "Integrate — hoodoracle",
  description:
    "Post signed quotes on-chain and read them with session-aware policy.",
};

export default function Integrate() {
  return (
    <div className="prose" style={{ paddingTop: 50 }}>
      <div className="eyebrow">Integration</div>
      <h1 className="d1" style={{ margin: "18px 0 26px" }}>Integrate</h1>

      <p>
        Quotes are signed off-chain and posted on demand. Anyone may relay a
        quote; only the signature is trusted. The contract is live on Robinhood
        Chain mainnet, an Arbitrum Orbit L2, so the same Solidity deploys to
        Arbitrum unchanged.
      </p>

      <h2>1 · From TypeScript, use the SDK</h2>

      <p>
        The enum ordering, the digest encoding and the band arithmetic all have
        to match the contract exactly, and all three are easy to get subtly
        wrong by hand. <code>@hoodoracle/sdk</code> ships them, and defaults to
        refusing a price that is not an observed print.
      </p>

      <pre>{`npm install @hoodoracle/sdk viem`}</pre>

      <pre>{`import { HoodOracle, QuoteRejected } from "@hoodoracle/sdk";

const oracle = new HoodOracle();   `}<span className="c">{`// mainnet, no config needed`}</span>{`

try {
  `}<span className="c">{`// Throws unless this is a live print inside 150bps.`}</span>{`
  const price = await oracle.price("HOOD", { maxBps: 150 });
  liquidate(position, price);
} catch (e) {
  `}<span className="c">{`// On a Saturday: "provenance is DERIVED: the tape was shut and`}</span>{`
  `}<span className="c">{`// this price is a model output, not an observed print"`}</span>{`
  if (e instanceof QuoteRejected) return;
  throw e;
}

`}<span className="c">{`// Value collateral at the pessimistic edge, debt at the other.`}</span>{`
const floor = await oracle.conservativePrice("HOOD", "collateral");`}</pre>

      <p className="small muted">
        React bindings at <code>@hoodoracle/sdk/react</code>. Prices are{" "}
        <code>bigint</code> at 8 decimals throughout, because the band
        comparison has to be exact — see the SDK readme for why floats change
        answers here.
      </p>

      <h2>2 · Read the consumer interface</h2>

      <p>
        The function a liquidation path should call is{" "}
        <code>getPriceIfTraded</code>. It refuses to return a
        modelled weekend price at all, rather than returning one and hoping the
        caller checks.
      </p>

      <pre>{`interface IHoodOracle {
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

      <h2>3 · Write policy that was previously impossible</h2>

      <pre>{`contract LendingMarket {
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

      <h2>4 · Relay a quote on-chain</h2>

      <p>
        The on-chain value is only as current as the last relay, and anyone may
        post. From the SDK that is{" "}
        <code>oracle.postQuote(wallet, signed)</code>; by hand it is the tuple
        below, which has to be packed in exactly this field order or the
        signature will not recover.
      </p>

      <pre>{`import { createWalletClient, http } from "viem";
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

      <h2>5 · Batch, and find out what is stale</h2>

      <p>
        <code>HoodOracleKeeper</code> sits beside the oracle. It mints no
        authority — every quote it forwards is still checked against the
        oracle&apos;s own signer allow-list, and it holds no funds and has no
        owner — so anything done through it could have been done without it,
        just in more transactions.
      </p>

      <pre>{`keeper  0xc984336bf8f5218c601bbb1a83a070262b694aee`}</pre>

      <pre>{`interface IHoodOracleKeeper {
    `}<span className="c">{`// Posts several quotes in one transaction. A quote the oracle`}</span>{`
    `}<span className="c">{`// refuses is reported false, not thrown, so one raced ticker`}</span>{`
    `}<span className="c">{`// cannot discard the rest of the batch.`}</span>{`
    function postQuotes(string[] calldata tickers, Quote[] calldata qs, bytes[] calldata sigs)
        external returns (bool[] memory posted);

    `}<span className="c">{`// Free. maxAge = 0 uses the oracle's own maxQuoteAge.`}</span>{`
    function needsUpdate(string[] calldata t, uint64 maxAge) external view returns (bool[] memory);
    function status(string[] calldata t, uint64 maxAge) external view returns (Status[] memory);
}`}</pre>

      <p>
        Batching saves about 21% of the gas, but the reason to use it is that
        all eight quotes land in <strong>one block</strong>. Posted separately
        they land across eight, so a consumer reading mid-round gets a snapshot
        that never existed: HOOD from one block and TLT from forty later, when
        both were priced against a single proxy reading.
      </p>

      <p>
        <code>needsUpdate</code> matters for a different reason. Which tickers
        are stale used to be known only to the scheduler posting them, behind a
        shared secret — one cron job as a single point of failure for a feed
        anyone is allowed to write to. Now anyone can run a keeper.
      </p>

      <pre>{`import { HoodOracleKeeper } from "@hoodoracle/sdk";

const keeper = new HoodOracleKeeper({ address: KEEPER });

`}<span className="c">{`// What should be posted again? Free to ask, no permission needed.`}</span>{`
const stale = await keeper.needsUpdate(["HOOD", "COIN", "TLT"]);

`}<span className="c">{`// Check what the chain would accept before paying for it.`}</span>{`
const willLand = await keeper.simulate(signedQuotes, account);

await keeper.postQuotes(wallet, signedQuotes);`}</pre>

      <h2>Guards the contract enforces</h2>

      <div className="tbl"><table>
        <thead>
          <tr>
            <th>Guard</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>UnknownSigner</code>
            </td>
            <td>Only allow-listed signers are accepted.</td>
          </tr>
          <tr>
            <td>
              <code>NotNewer</code>
            </td>
            <td>
              Blocks replay of an older quote, including re-posting a stale
              favourable price.
            </td>
          </tr>
          <tr>
            <td>
              <code>QuoteTooOld</code> /{" "}
              <code>QuoteFromFuture</code>
            </td>
            <td>
              Bounds clock skew in both directions. 60s of forward tolerance,
              configurable age limit backwards.
            </td>
          </tr>
          <tr>
            <td>
              <code>BandTooWide</code>
            </td>
            <td>
              A quote past the publish ceiling is rejected rather than stored.
            </td>
          </tr>
          <tr>
            <td>
              <code>ZeroPrice</code>
            </td>
            <td>
              Upstream returns <code>Price: 0</code> for
              unsupported tickers. That must never reach storage.
            </td>
          </tr>
          <tr>
            <td>
              <code>InvalidEnum</code>
            </td>
            <td>
              Out-of-range session or provenance bytes are refused, so a
              consumer&apos;s switch cannot fall through.
            </td>
          </tr>
        </tbody>
      </table></div>

      <div className="note note-warn">
        <strong>Not audited.</strong> This is an evaluation build. The contract
        has not been audited. The confidence model <em>is</em> calibrated, on two
        years of realised gaps with observed coverage between 93.4% and 96.4%,
        but a fit on ordinary days does not anticipate a structural break. Do not
        settle real money against it yet.
      </div>

      <p className="small muted">
        Contract source: <code>contracts/HoodOracle.sol</code>
      </p>
    </div>
  );
}
