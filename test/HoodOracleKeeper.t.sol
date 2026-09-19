// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {HoodOracle} from "../contracts/HoodOracle.sol";
import {HoodOracleKeeper, IHoodOracle} from "../contracts/HoodOracleKeeper.sol";

/**
 * Tests for the batch relay and the staleness view.
 *
 * No forge-std. HoodOracle.sol imports nothing and neither does the keeper, so
 * a test suite that drags in a submodule tree to get `assertEq` would be the
 * only dependency in the repository. The cheatcode interface below is the
 * whole of what is needed.
 */
interface Vm {
    function sign(uint256 pk, bytes32 digest)
        external
        pure
        returns (uint8 v, bytes32 r, bytes32 s);

    function addr(uint256 pk) external pure returns (address);

    function warp(uint256 ts) external;

    function expectRevert(bytes4 selector) external;

    /// @dev Needed for an error that carries arguments: the selector alone
    ///      does not match a revert whose data includes them.
    function expectRevert(bytes calldata revertData) external;

    function prank(address who) external;
}

contract HoodOracleKeeperTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    HoodOracle oracle;
    HoodOracleKeeper keeper;

    uint256 constant SIGNER_PK = 0xA11CE;
    uint256 constant WRONG_PK = 0xBAD;
    address signer;

    string[] tickers;

    // Anchored well clear of zero so `publishTime + maxAge` comparisons are
    // not accidentally satisfied by an uninitialised block timestamp.
    uint64 constant T0 = 1_750_000_000;

    function setUp() public {
        signer = vm.addr(SIGNER_PK);
        oracle = new HoodOracle(signer);
        keeper = new HoodOracleKeeper(address(oracle));

        tickers.push("HOOD");
        tickers.push("COIN");
        tickers.push("NVDA");
        tickers.push("TSLA");

        vm.warp(T0 + 100);
    }

    // ------------------------------------------------------------ helpers

    function _quote(uint128 price, uint64 publishTime)
        internal
        pure
        returns (IHoodOracle.Quote memory)
    {
        return
            IHoodOracle.Quote({
                price: price,
                confidenceBps: 420,
                session: 3, // CLOSED
                provenance: 1, // DERIVED
                sourceCount: 2,
                maxDeviationBps: 10,
                lastTradeTime: publishTime - 60,
                publishTime: publishTime
            });
    }

    /// @dev Must mirror HoodOracle._digest exactly or nothing recovers.
    function _digest(string memory ticker, IHoodOracle.Quote memory q)
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

    function _sign(
        uint256 pk,
        string memory ticker,
        IHoodOracle.Quote memory q
    ) internal pure returns (bytes memory) {
        bytes32 ethSigned = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                _digest(ticker, q)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    function _batch(uint64 publishTime)
        internal
        view
        returns (IHoodOracle.Quote[] memory qs, bytes[] memory sigs)
    {
        qs = new IHoodOracle.Quote[](tickers.length);
        sigs = new bytes[](tickers.length);
        for (uint256 i; i < tickers.length; ++i) {
            qs[i] = _quote(uint128((i + 1) * 100e8), publishTime);
            sigs[i] = _sign(SIGNER_PK, tickers[i], qs[i]);
        }
    }

    function _assert(bool cond, string memory what) internal pure {
        require(cond, what);
    }

    // --------------------------------------------------------- happy path

    function test_postsEveryQuoteInOneTransaction() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);

        bool[] memory posted = keeper.postQuotes(tickers, qs, sigs);

        for (uint256 i; i < tickers.length; ++i) {
            _assert(posted[i], "each input reports success");
            HoodOracle.Quote memory stored = oracle.getQuote(tickers[i]);
            _assert(stored.price == qs[i].price, "price landed");
            _assert(stored.publishTime == qs[i].publishTime, "publishTime landed");
            _assert(stored.provenance == 1, "provenance survived");
        }
    }

    /// The whole point of batching: one block, one snapshot.
    function test_allLandInTheSameBlock() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);
        keeper.postQuotes(tickers, qs, sigs);

        uint64 first = oracle.getQuote(tickers[0]).publishTime;
        for (uint256 i = 1; i < tickers.length; ++i) {
            _assert(
                oracle.getQuote(tickers[i]).publishTime == first,
                "one consistent snapshot"
            );
        }
    }

    // ------------------------------------------------- partial success
    //
    // The reason try/catch is in the loop at all.

    function test_alreadyPostedTickerDoesNotDiscardTheRest() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);

        // Another relayer wins the race on HOOD.
        oracle.postQuote(tickers[0], _toOracle(qs[0]), sigs[0]);

        bool[] memory posted = keeper.postQuotes(tickers, qs, sigs);

        _assert(!posted[0], "the raced ticker reports failure");
        for (uint256 i = 1; i < tickers.length; ++i) {
            _assert(posted[i], "the other seven still land");
            _assert(
                oracle.getQuote(tickers[i]).price == qs[i].price,
                "and are stored"
            );
        }
    }

    function test_oneBadSignatureDoesNotDiscardTheRest() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);

        // Signed by a key the oracle has never allow-listed.
        sigs[2] = _sign(WRONG_PK, tickers[2], qs[2]);

        bool[] memory posted = keeper.postQuotes(tickers, qs, sigs);

        _assert(!posted[2], "the forged one is refused");
        _assert(posted[0] && posted[1] && posted[3], "the honest ones land");
    }

    function test_aQuoteWithAZeroPriceIsIsolated() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);
        qs[1].price = 0;
        sigs[1] = _sign(SIGNER_PK, tickers[1], qs[1]);

        bool[] memory posted = keeper.postQuotes(tickers, qs, sigs);
        _assert(!posted[1], "zero price refused");
        _assert(posted[0] && posted[2] && posted[3], "neighbours unaffected");
    }

    function test_aBandOverTheCeilingIsIsolated() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);
        qs[3].confidenceBps = 5000; // over maxAcceptableBps (1500)
        sigs[3] = _sign(SIGNER_PK, tickers[3], qs[3]);

        bool[] memory posted = keeper.postQuotes(tickers, qs, sigs);
        _assert(!posted[3], "too-wide band refused");
        _assert(posted[0] && posted[1] && posted[2], "neighbours unaffected");
    }

    function test_everyQuoteFailingIsNotARevert() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);
        for (uint256 i; i < sigs.length; ++i) {
            sigs[i] = _sign(WRONG_PK, tickers[i], qs[i]);
        }

        bool[] memory posted = keeper.postQuotes(tickers, qs, sigs);
        for (uint256 i; i < posted.length; ++i) {
            _assert(!posted[i], "all refused, reported not thrown");
        }
    }

    // ------------------------------------------------------------- guards

    function test_lengthMismatchReverts() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);
        IHoodOracle.Quote[] memory short = new IHoodOracle.Quote[](2);
        short[0] = qs[0];
        short[1] = qs[1];

        vm.expectRevert(HoodOracleKeeper.LengthMismatch.selector);
        keeper.postQuotes(tickers, short, sigs);
    }

    function test_emptyBatchReverts() public {
        string[] memory none = new string[](0);
        vm.expectRevert(HoodOracleKeeper.EmptyBatch.selector);
        keeper.postQuotes(none, new IHoodOracle.Quote[](0), new bytes[](0));
    }

    function test_oversizedBatchReverts() public {
        uint256 n = keeper.MAX_BATCH() + 1;
        string[] memory many = new string[](n);
        for (uint256 i; i < n; ++i) many[i] = "HOOD";

        vm.expectRevert(
            abi.encodeWithSelector(HoodOracleKeeper.BatchTooLarge.selector, n)
        );
        keeper.postQuotes(many, new IHoodOracle.Quote[](n), new bytes[](n));
    }

    // ---------------------------------------------------------- discovery

    function test_neverPostedTickerNeedsUpdate() public view {
        bool[] memory stale = keeper.needsUpdate(tickers, 3600);
        for (uint256 i; i < stale.length; ++i) {
            _assert(stale[i], "nothing posted yet, so everything is stale");
        }
    }

    function test_unknownSymbolDoesNotBlindTheKeeper() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);
        keeper.postQuotes(tickers, qs, sigs);

        string[] memory probe = new string[](2);
        probe[0] = "HOOD";
        probe[1] = "ZZZZNOTREAL";

        bool[] memory stale = keeper.needsUpdate(probe, 3600);
        _assert(!stale[0], "the fresh one reads fresh");
        _assert(stale[1], "the unknown one reads stale, not a revert");
    }

    function test_freshQuoteDoesNotNeedUpdateUntilItAges() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);
        keeper.postQuotes(tickers, qs, sigs);

        bool[] memory fresh = keeper.needsUpdate(tickers, 3600);
        for (uint256 i; i < fresh.length; ++i) {
            _assert(!fresh[i], "inside the window");
        }

        vm.warp(T0 + 60 + 3601);
        bool[] memory aged = keeper.needsUpdate(tickers, 3600);
        for (uint256 i; i < aged.length; ++i) {
            _assert(aged[i], "past the window");
        }
    }

    function test_zeroMaxAgeFallsBackToTheOracleLimit() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);
        keeper.postQuotes(tickers, qs, sigs);

        // The oracle ships maxQuoteAge = 30 minutes.
        _assert(oracle.maxQuoteAge() == 1800, "assumed default");

        vm.warp(T0 + 60 + 1700);
        _assert(!keeper.needsUpdate(tickers, 0)[0], "inside the oracle window");

        vm.warp(T0 + 60 + 1900);
        _assert(keeper.needsUpdate(tickers, 0)[0], "past the oracle window");
    }

    function test_statusReportsTheFullPicture() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);
        keeper.postQuotes(tickers, qs, sigs);
        vm.warp(T0 + 60 + 500);

        string[] memory probe = new string[](2);
        probe[0] = "HOOD";
        probe[1] = "ZZZZNOTREAL";

        HoodOracleKeeper.Status[] memory st = keeper.status(probe, 3600);

        _assert(st[0].exists, "stored ticker exists");
        _assert(st[0].price == qs[0].price, "price reported");
        _assert(st[0].confidenceBps == 420, "band reported");
        _assert(st[0].provenance == 1, "provenance reported");
        _assert(st[0].ageSeconds == 500, "age computed from publishTime");
        _assert(!st[0].stale, "not stale inside the window");

        _assert(!st[1].exists, "unknown ticker flagged absent");
        _assert(st[1].stale, "and stale");
        _assert(st[1].ageSeconds == 0, "with no fabricated age");
    }

    // --------------------------------------------------------------- gas

    /// Not an assertion so much as a record. Printed by `forge test -vv`.
    function test_gasBatchVersusIndividual() public {
        (IHoodOracle.Quote[] memory qs, bytes[] memory sigs) = _batch(T0 + 60);

        // Both sides get their own fresh oracle. Reusing `oracle` for one and
        // a new deployment for the other compares a warm contract against a
        // cold one and flatters whichever went second.
        HoodOracle oracleA = new HoodOracle(signer);
        HoodOracle oracleB = new HoodOracle(signer);
        HoodOracleKeeper keeperA = new HoodOracleKeeper(address(oracleA));

        uint256 before = gasleft();
        keeperA.postQuotes(tickers, qs, sigs);
        uint256 batched = before - gasleft();

        before = gasleft();
        for (uint256 i; i < tickers.length; ++i) {
            oracleB.postQuote(tickers[i], _toOracle(qs[i]), sigs[i]);
        }
        uint256 individually = before - gasleft();

        // Execution gas only; the saving the relayer actually sees is this
        // plus 21,000 per transaction avoided, which a test cannot observe.
        emit log_named_uint("batched   (execution gas)", batched);
        emit log_named_uint("individual(execution gas)", individually);
        emit log_named_uint("base gas saved off-chain  ", 21000 * (tickers.length - 1));
    }

    event log_named_uint(string key, uint256 val);

    // The two Quote structs are identical but nominally distinct types.
    function _toOracle(IHoodOracle.Quote memory q)
        internal
        pure
        returns (HoodOracle.Quote memory)
    {
        return
            HoodOracle.Quote({
                price: q.price,
                confidenceBps: q.confidenceBps,
                session: q.session,
                provenance: q.provenance,
                sourceCount: q.sourceCount,
                maxDeviationBps: q.maxDeviationBps,
                lastTradeTime: q.lastTradeTime,
                publishTime: q.publishTime
            });
    }
}
