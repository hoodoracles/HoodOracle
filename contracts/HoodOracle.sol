// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * @title HoodOracle
 * @notice Session-aware price feed for tokenised equities.
 *
 * Tokenised equities trade around the clock. The underlying shares price for
 * six and a half hours a day. Every other oracle returns one number and hides
 * which of those regimes it came from, so a consumer must assume the worst at
 * all times.
 *
 * This contract carries the price together with how it was obtained and how
 * wide the uncertainty is, so a lending market can set policy per regime
 * instead of pricing weekend risk into every loan.
 *
 * Quotes are signed off-chain and posted on demand (pull, not push): a weekend
 * price does not change for 62 hours, so publishing it on a heartbeat would be
 * paying gas to say nothing.
 */
contract HoodOracle {
    // ------------------------------------------------------------------ types

    enum Session {
        REGULAR,
        PRE,
        POST,
        CLOSED,
        HOLIDAY
    }

    enum Provenance {
        TRADED, // observed print from a live session
        DERIVED, // tape shut, last close drifted against a 24/7 proxy
        STALE // no usable anchor
    }

    struct Quote {
        uint128 price; // 8 decimals
        uint64 confidenceBps; // two-sided band
        uint8 session;
        uint8 provenance;
        uint8 sourceCount;
        uint64 maxDeviationBps;
        uint64 lastTradeTime;
        uint64 publishTime;
    }

    // ------------------------------------------------------------------ state

    address public owner;

    /// @notice Addresses permitted to sign quotes.
    mapping(address => bool) public isSigner;

    /// @notice Latest accepted quote per ticker.
    mapping(string => Quote) private _quotes;

    /// @notice Reject a quote whose publishTime is older than this. 0 disables.
    uint64 public maxQuoteAge = 30 minutes;

    /// @notice Reject a quote whose band exceeds this. 0 disables.
    uint64 public maxAcceptableBps = 1500;

    // ----------------------------------------------------------------- events

    event QuotePosted(
        string indexed ticker,
        uint128 price,
        uint64 confidenceBps,
        uint8 session,
        uint8 provenance,
        uint64 publishTime,
        address signer
    );
    event SignerSet(address indexed signer, bool allowed);
    event OwnerChanged(address indexed from, address indexed to);
    event LimitsChanged(uint64 maxQuoteAge, uint64 maxAcceptableBps);

    // ----------------------------------------------------------------- errors

    error NotOwner();
    error UnknownSigner(address recovered);
    error QuoteTooOld(uint64 publishTime, uint64 nowTs);
    error QuoteFromFuture(uint64 publishTime, uint64 nowTs);
    error BandTooWide(uint64 confidenceBps);
    error NotNewer(uint64 incoming, uint64 stored);
    error NoQuote(string ticker);
    error BadSignatureLength(uint256 length);
    error ZeroPrice();
    error InvalidEnum();

    // ------------------------------------------------------------------ setup

    constructor(address initialSigner) {
        owner = msg.sender;
        if (initialSigner != address(0)) {
            isSigner[initialSigner] = true;
            emit SignerSet(initialSigner, true);
        }
        emit OwnerChanged(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setSigner(address signer, bool allowed) external onlyOwner {
        isSigner[signer] = allowed;
        emit SignerSet(signer, allowed);
    }

    function transferOwnership(address to) external onlyOwner {
        emit OwnerChanged(owner, to);
        owner = to;
    }

    function setLimits(uint64 age, uint64 bps) external onlyOwner {
        maxQuoteAge = age;
        maxAcceptableBps = bps;
        emit LimitsChanged(age, bps);
    }

    // ------------------------------------------------------------------- post

    /**
     * @notice Post a signed quote. Anyone may relay; only the signature matters.
     * @param ticker    Instrument symbol, e.g. "HOOD".
     * @param q         The quote as signed.
     * @param signature 65-byte EIP-191 signature over the quote digest.
     */
    function postQuote(
        string calldata ticker,
        Quote calldata q,
        bytes calldata signature
    ) external {
        if (q.price == 0) revert ZeroPrice();
        if (q.session > uint8(Session.HOLIDAY)) revert InvalidEnum();
        if (q.provenance > uint8(Provenance.STALE)) revert InvalidEnum();

        uint64 nowTs = uint64(block.timestamp);
        // Allow a little clock skew forward, but never accept a far-future quote.
        if (q.publishTime > nowTs + 60) {
            revert QuoteFromFuture(q.publishTime, nowTs);
        }
        if (maxQuoteAge != 0 && q.publishTime + maxQuoteAge < nowTs) {
            revert QuoteTooOld(q.publishTime, nowTs);
        }
        if (maxAcceptableBps != 0 && q.confidenceBps > maxAcceptableBps) {
            revert BandTooWide(q.confidenceBps);
        }

        Quote storage stored = _quotes[ticker];
        if (stored.publishTime >= q.publishTime) {
            revert NotNewer(q.publishTime, stored.publishTime);
        }

        address recovered = _recover(_digest(ticker, q), signature);
        if (!isSigner[recovered]) revert UnknownSigner(recovered);

        _quotes[ticker] = q;

        emit QuotePosted(
            ticker,
            q.price,
            q.confidenceBps,
            q.session,
            q.provenance,
            q.publishTime,
            recovered
        );
    }

    // ------------------------------------------------------------------- read

    /// @notice The full quote. Reverts if nothing has been posted.
    function getQuote(string calldata ticker)
        external
        view
        returns (Quote memory q)
    {
        q = _quotes[ticker];
        if (q.publishTime == 0) revert NoQuote(ticker);
    }

    /// @notice Price only, for consumers that have already checked the band.
    function getPrice(string calldata ticker)
        external
        view
        returns (uint128 price, uint64 publishTime)
    {
        Quote memory q = _quotes[ticker];
        if (q.publishTime == 0) revert NoQuote(ticker);
        return (q.price, q.publishTime);
    }

    /**
     * @notice Price, but only if it is an observed print from a live session
     *         and the band is inside `maxBps`.
     * @dev    This is the function a liquidation path should call. It refuses to
     *         return a modelled weekend price at all, rather than returning one
     *         and trusting the caller to check.
     */
    function getPriceIfTraded(string calldata ticker, uint64 maxBps)
        external
        view
        returns (uint128 price)
    {
        Quote memory q = _quotes[ticker];
        if (q.publishTime == 0) revert NoQuote(ticker);
        require(q.provenance == uint8(Provenance.TRADED), "not a live print");
        require(q.confidenceBps <= maxBps, "band too wide");
        return q.price;
    }

    /**
     * @notice The conservative edge of the band, for collateral valuation.
     * @param  lower true for the pessimistic edge when valuing collateral,
     *         false for the pessimistic edge when valuing debt.
     */
    function getBandedPrice(string calldata ticker, bool lower)
        external
        view
        returns (uint128 price)
    {
        Quote memory q = _quotes[ticker];
        if (q.publishTime == 0) revert NoQuote(ticker);
        uint256 adj = (uint256(q.price) * q.confidenceBps) / 10_000;
        return lower
            ? uint128(uint256(q.price) - adj)
            : uint128(uint256(q.price) + adj);
    }

    /// @notice True when the quote is a live print inside the given band.
    function isLive(string calldata ticker, uint64 maxBps)
        external
        view
        returns (bool)
    {
        Quote memory q = _quotes[ticker];
        return
            q.publishTime != 0 &&
            q.provenance == uint8(Provenance.TRADED) &&
            q.confidenceBps <= maxBps;
    }

    // -------------------------------------------------------------- internals

    /// @dev Must match the off-chain encoder exactly, or signatures will not recover.
    function _digest(string calldata ticker, Quote calldata q)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    ticker,
                    q.price,
                    q.confidenceBps,
                    q.session,
                    q.provenance,
                    q.sourceCount,
                    q.maxDeviationBps,
                    q.lastTradeTime,
                    q.publishTime
                )
            );
    }

    function _recover(bytes32 digest, bytes calldata sig)
        internal
        pure
        returns (address)
    {
        if (sig.length != 65) revert BadSignatureLength(sig.length);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;

        bytes32 ethSigned = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        return ecrecover(ethSigned, v, r, s);
    }
}
