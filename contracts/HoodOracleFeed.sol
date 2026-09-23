// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * @title HoodOracleFeed
 * @notice A hoodoracle price, behind the interface lending code already speaks.
 *
 * Robinhood Chain's builder docs send every integrator to Chainlink's
 * AggregatorV3Interface, and most lending code reads nothing else: Morpho's
 * MorphoChainlinkOracleV2, Aave-style price routers, CDP engines. A protocol
 * that wants hoodoracle's semantics should not have to rewrite any of that.
 * This contract is the drop-in: point an existing Chainlink slot at it.
 *
 * TWO THINGS IT ADDS OVER THE RAW ORACLE
 *
 * 1. The token's corporate-action multiplier. hoodoracle prices the
 *    underlying share. A Robinhood Stock Token is worth the share price times
 *    `uiMultiplier()` (ERC-8056), which moves on dividends and splits. On
 *    23 Sep 2026 NVDA's was 1.000775 and SPY's 1.001718, so a lender valuing
 *    the token at the share price is off by that much and drifting. The
 *    multiplier is read live on every call, so it can never be stale.
 *
 * 2. A refusal. In strict mode `latestRoundData` reverts unless the quote is
 *    an observed print (TRADED), fresh (inside `maxAge`) and tight (inside
 *    `maxBps`). A Chainlink-shaped feed has no field for "this is a weekend
 *    model output", so the only way to say it through this interface is not
 *    to answer. Morpho calls the oracle on borrow, withdrawCollateral and
 *    liquidate, and never on supply, withdraw or repay. So while the tape is
 *    shut nobody can be liquidated on a guess or borrow against one, while
 *    lenders can still exit and borrowers can still repay or add collateral.
 *
 * The age check is not optional decoration. The oracle's getPriceIfTraded
 * checks provenance but not age, and a relayer that stops leaves its last
 * TRADED quote in storage indefinitely. That happened from 21 to 23 Sep 2026.
 *
 * Plain mode (requireTraded = false, maxAge = 0, maxBps = 0) forwards whatever
 * is stored, which is what a price feed without provenance does. It exists
 * for comparison and for display, not for liquidation.
 *
 * Holds no funds, has no owner, and every parameter is immutable. A
 * different policy is a different deployment.
 */

interface IHoodOracleQuotes {
    struct Quote {
        uint128 price;
        uint64 confidenceBps;
        uint8 session;
        uint8 provenance;
        uint8 sourceCount;
        uint64 maxDeviationBps;
        uint64 lastTradeTime;
        uint64 publishTime;
    }

    function getQuote(string calldata ticker) external view returns (Quote memory);
}

/// @dev ERC-8056 Scaled UI Amount. 1e18 is a multiplier of exactly one.
interface IScaledUiAmount {
    function uiMultiplier() external view returns (uint256);
}

contract HoodOracleFeed {
    uint8 private constant TRADED = 0;

    IHoodOracleQuotes public immutable oracle;
    /// @notice Stock token whose uiMultiplier applies. Zero prices the share.
    address public immutable token;
    /// @notice Seconds a quote stays usable. Zero disables the check.
    uint64 public immutable maxAge;
    /// @notice Widest acceptable band in bps. Zero disables the check.
    uint64 public immutable maxBps;
    bool public immutable requireTraded;

    string public ticker;

    /// @notice Same scale as the oracle's price and as Chainlink's USD feeds.
    uint8 public constant decimals = 8;
    uint256 public constant version = 1;

    error NotLivePrint(uint8 provenance);
    error StaleQuote(uint64 publishTime, uint256 nowTs);
    error BandTooWide(uint64 confidenceBps, uint64 maxBps);
    error NoSuchRound(uint80 roundId);
    error ZeroAddress();

    constructor(
        address oracle_,
        string memory ticker_,
        address token_,
        uint64 maxAge_,
        uint64 maxBps_,
        bool requireTraded_
    ) {
        if (oracle_ == address(0)) revert ZeroAddress();
        oracle = IHoodOracleQuotes(oracle_);
        ticker = ticker_;
        token = token_;
        maxAge = maxAge_;
        maxBps = maxBps_;
        requireTraded = requireTraded_;
    }

    function description() external view returns (string memory) {
        return
            string.concat(
                ticker,
                token == address(0) ? " / USD" : " token / USD",
                requireTraded ? " \xc2\xb7 hoodoracle, live prints only" : " \xc2\xb7 hoodoracle, any provenance"
            );
    }

    /**
     * @notice The latest usable price, or a revert saying why there is none.
     * @dev roundId is the quote's publishTime: monotonic, because the oracle
     *      only accepts strictly newer quotes, and meaningful to a reader.
     */
    function latestRoundData()
        public
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        IHoodOracleQuotes.Quote memory q = oracle.getQuote(ticker);

        if (requireTraded && q.provenance != TRADED) revert NotLivePrint(q.provenance);
        if (maxAge != 0 && block.timestamp > uint256(q.publishTime) + maxAge) {
            revert StaleQuote(q.publishTime, block.timestamp);
        }
        if (maxBps != 0 && q.confidenceBps > maxBps) {
            revert BandTooWide(q.confidenceBps, maxBps);
        }

        uint256 px = q.price;
        if (token != address(0)) px = (px * IScaledUiAmount(token).uiMultiplier()) / 1e18;

        roundId = uint80(q.publishTime);
        answer = int256(px);
        startedAt = q.publishTime;
        updatedAt = q.publishTime;
        answeredInRound = roundId;
    }

    /// @notice Only the latest round is kept; the oracle stores one quote per ticker.
    function getRoundData(uint80 roundId_)
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            latestRoundData();
        if (roundId_ != roundId) revert NoSuchRound(roundId_);
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }

    /// @notice Chainlink's pre-V3 accessor, still read by older integrations.
    function latestAnswer() external view returns (int256 answer) {
        (, answer,,,) = latestRoundData();
    }
}
