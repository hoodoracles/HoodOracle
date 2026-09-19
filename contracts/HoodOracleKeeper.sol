// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * @title HoodOracleKeeper
 * @notice Batch relaying and staleness discovery for HoodOracle.
 *
 * Two problems, one helper, and deliberately no change to the oracle itself.
 *
 * BATCHING. The relayer posts one transaction per ticker, so a full round is
 * eight transactions and eight times the 21,000 base gas. Worse, they land in
 * different blocks: a consumer reading mid-round gets HOOD from one block and
 * TLT from forty blocks later, which is a torn snapshot of a set that was
 * priced against a single proxy reading. Posting them together fixes both.
 *
 * DISCOVERY. Which tickers are stale is currently known only to the scheduler
 * that posts them, behind a shared secret. That makes one cron job a single
 * point of failure for a feed anyone is allowed to write to — and it has
 * frozen production once already. `needsUpdate` puts the same question
 * on-chain, for free, so a third party can run a keeper without asking us.
 *
 * WHY NOT REDEPLOY THE ORACLE. `postQuote` authenticates the signature, not
 * `msg.sender`, so a contract may relay on anyone's behalf and no permission
 * is needed to build this alongside. Adding these functions to the oracle
 * instead would mint a new address, orphan every integrator, force the signer
 * to be re-allow-listed, and reset the published coverage archive that the
 * whole track record is built on. None of that buys anything the caller can
 * observe.
 *
 * This contract holds no funds, has no owner and stores nothing.
 */

interface IHoodOracle {
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

    function postQuote(
        string calldata ticker,
        Quote calldata q,
        bytes calldata signature
    ) external;

    function getQuote(string calldata ticker)
        external
        view
        returns (Quote memory);

    function maxQuoteAge() external view returns (uint64);

    function maxAcceptableBps() external view returns (uint64);
}

contract HoodOracleKeeper {
    IHoodOracle public immutable oracle;

    /**
     * @notice Ceiling on batch size.
     *
     * The universe is eight. This is headroom, not a target: an unbounded loop
     * over caller-supplied arrays is a transaction that can be made to exceed
     * the block gas limit, and a batch that always reverts is a batch that
     * never posts.
     */
    uint256 public constant MAX_BATCH = 32;

    event BatchPosted(address indexed relayer, uint256 posted, uint256 failed);

    error LengthMismatch();
    error EmptyBatch();
    error BatchTooLarge(uint256 size);

    constructor(address _oracle) {
        require(_oracle != address(0), "oracle required");
        oracle = IHoodOracle(_oracle);
    }

    // --------------------------------------------------------------- post

    /**
     * @notice Relay several signed quotes in one transaction.
     * @return posted Per-input success, in the order supplied.
     *
     * @dev Each post is attempted independently and a failure is recorded
     *      rather than thrown.
     *
     *      This matters more than it looks. The oracle rejects a quote that is
     *      not strictly newer than the stored one, and anyone may relay, so
     *      two relayers racing on the same ticker is an ordinary event, not an
     *      error. Were this loop to bubble the revert, one already-posted
     *      ticker would discard the other seven — turning a harmless race into
     *      a whole round of lost updates, and burning the gas anyway.
     *
     *      The same reasoning covers a single malformed signature in an
     *      otherwise good batch.
     */
    function postQuotes(
        string[] calldata tickers,
        IHoodOracle.Quote[] calldata quotes,
        bytes[] calldata signatures
    ) external returns (bool[] memory posted) {
        uint256 n = tickers.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n);
        if (quotes.length != n || signatures.length != n) {
            revert LengthMismatch();
        }

        posted = new bool[](n);
        uint256 ok;

        for (uint256 i; i < n; ++i) {
            try oracle.postQuote(tickers[i], quotes[i], signatures[i]) {
                posted[i] = true;
                unchecked {
                    ++ok;
                }
            } catch {
                // Left false. The reason is not captured: a revert string
                // costs memory and gas to bubble, and the caller can always
                // re-read the quote to find out what happened. What the
                // relayer needs from a batch is which ones landed.
                posted[i] = false;
            }
        }

        emit BatchPosted(msg.sender, ok, n - ok);
    }

    // ---------------------------------------------------------- discovery

    /**
     * @notice Which of these tickers should be posted again.
     * @param maxAge Seconds after which a stored quote counts as stale. Pass 0
     *        to use the oracle's own `maxQuoteAge`.
     *
     * @dev A ticker that has never been posted reverts inside the oracle, and
     *      is reported here as needing an update — which is exactly what it
     *      needs. Catching rather than propagating also means one unknown
     *      symbol in the array does not blind a keeper to the other seven.
     */
    function needsUpdate(string[] calldata tickers, uint64 maxAge)
        external
        view
        returns (bool[] memory stale)
    {
        uint256 n = tickers.length;
        if (n > MAX_BATCH) revert BatchTooLarge(n);

        uint64 limit = maxAge == 0 ? oracle.maxQuoteAge() : maxAge;
        stale = new bool[](n);

        for (uint256 i; i < n; ++i) {
            try oracle.getQuote(tickers[i]) returns (IHoodOracle.Quote memory q) {
                // A limit of 0 with the oracle's age check disabled means
                // nothing is ever stale on time alone.
                stale[i] =
                    limit != 0 &&
                    uint256(q.publishTime) + uint256(limit) < block.timestamp;
            } catch {
                stale[i] = true;
            }
        }
    }

    struct Status {
        bool exists;
        uint128 price;
        uint64 confidenceBps;
        uint8 session;
        uint8 provenance;
        uint64 publishTime;
        /// @dev Seconds since publishTime. Zero when nothing is stored.
        uint64 ageSeconds;
        bool stale;
    }

    /**
     * @notice Everything a keeper needs about a set of tickers, in one call.
     * @dev Eight `getQuote` round trips over JSON-RPC is eight network hops
     *      that can interleave with a post, so a keeper built on them can act
     *      on a view of the feed that never existed at any single instant.
     *      One call is one block.
     */
    function status(string[] calldata tickers, uint64 maxAge)
        external
        view
        returns (Status[] memory out)
    {
        uint256 n = tickers.length;
        if (n > MAX_BATCH) revert BatchTooLarge(n);

        uint64 limit = maxAge == 0 ? oracle.maxQuoteAge() : maxAge;
        out = new Status[](n);

        for (uint256 i; i < n; ++i) {
            try oracle.getQuote(tickers[i]) returns (IHoodOracle.Quote memory q) {
                uint64 age = block.timestamp > q.publishTime
                    ? uint64(block.timestamp - q.publishTime)
                    : 0;
                out[i] = Status({
                    exists: true,
                    price: q.price,
                    confidenceBps: q.confidenceBps,
                    session: q.session,
                    provenance: q.provenance,
                    publishTime: q.publishTime,
                    ageSeconds: age,
                    stale: limit != 0 && age > limit
                });
            } catch {
                out[i] = Status({
                    exists: false,
                    price: 0,
                    confidenceBps: 0,
                    session: 0,
                    provenance: 0,
                    publishTime: 0,
                    ageSeconds: 0,
                    stale: true
                });
            }
        }
    }
}
