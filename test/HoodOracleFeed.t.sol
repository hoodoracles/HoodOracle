// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {HoodOracle} from "../contracts/HoodOracle.sol";
import {HoodOracleFeed, IHoodOracleQuotes} from "../contracts/HoodOracleFeed.sol";

interface Vm {
    function sign(uint256 pk, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 pk) external pure returns (address);
    function warp(uint256 ts) external;
    function expectRevert(bytes calldata revertData) external;
}

/// @dev A Robinhood Stock Token as far as the feed can see: ERC-8056 only.
contract MockStockToken {
    uint256 public uiMultiplier = 1e18;

    function setMultiplier(uint256 m) external {
        uiMultiplier = m;
    }
}

contract HoodOracleFeedTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant SIGNER_PK = 0xA11CE;
    uint64 constant T0 = 1_750_000_000;

    uint8 constant REGULAR = 0;
    uint8 constant CLOSED = 3;
    uint8 constant TRADED = 0;
    uint8 constant DERIVED = 1;
    uint8 constant STALE = 2;

    HoodOracle oracle;
    MockStockToken nvda;
    HoodOracleFeed strict;
    HoodOracleFeed plain;

    function setUp() public {
        oracle = new HoodOracle(vm.addr(SIGNER_PK));
        nvda = new MockStockToken();
        // NVDA's real multiplier on 23 Sep 2026.
        nvda.setMultiplier(1_000775159164630595);
        strict = new HoodOracleFeed(address(oracle), "NVDA", address(nvda), 1800, 100, true);
        plain = new HoodOracleFeed(address(oracle), "NVDA", address(nvda), 0, 0, false);
        vm.warp(T0 + 100);
    }

    // ------------------------------------------------------------ helpers

    function _post(uint128 price, uint64 bps, uint8 session, uint8 provenance, uint64 publishTime)
        internal
    {
        HoodOracle.Quote memory q = HoodOracle.Quote({
            price: price,
            confidenceBps: bps,
            session: session,
            provenance: provenance,
            sourceCount: 2,
            maxDeviationBps: 0,
            lastTradeTime: publishTime,
            publishTime: publishTime
        });
        bytes32 digest = keccak256(
            abi.encode(
                "NVDA",
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
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_PK, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        oracle.postQuote("NVDA", q, abi.encodePacked(r, s, v));
    }

    function _answer(HoodOracleFeed f) internal view returns (int256 a, uint256 updatedAt, uint80 round) {
        (round, a,, updatedAt,) = f.latestRoundData();
    }

    function _eq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    // -------------------------------------------------------------- tests

    function test_liveFreshTightPrintIsAnsweredWithTheMultiplier() public {
        _post(228_87000000, 8, REGULAR, TRADED, T0 + 100);
        (int256 a, uint256 updatedAt, uint80 round) = _answer(strict);
        // 228.87 * 1.000775159164630595, truncated at 8 decimals.
        _eq(uint256(a), 229_04741067, "answer is share price times uiMultiplier");
        _eq(updatedAt, T0 + 100, "updatedAt is the quote's publishTime");
        _eq(round, T0 + 100, "roundId is the publishTime");
    }

    function test_aWeekendModelIsRefused() public {
        _post(219_00000000, 420, CLOSED, DERIVED, T0 + 100);
        vm.expectRevert(abi.encodeWithSelector(HoodOracleFeed.NotLivePrint.selector, DERIVED));
        strict.latestRoundData();
    }

    function test_aStaleSessionPrintIsRefused() public {
        _post(228_87000000, 405, 1, STALE, T0 + 100);
        vm.expectRevert(abi.encodeWithSelector(HoodOracleFeed.NotLivePrint.selector, STALE));
        strict.latestRoundData();
    }

    /// The failure that froze production: a TRADED quote nothing replaced.
    function test_aLivePrintNobodyReplacedExpires() public {
        _post(228_87000000, 8, REGULAR, TRADED, T0 + 100);
        vm.warp(T0 + 100 + 1800);
        _answer(strict); // exactly at the limit: still fine
        vm.warp(T0 + 100 + 1801);
        vm.expectRevert(
            abi.encodeWithSelector(HoodOracleFeed.StaleQuote.selector, T0 + 100, T0 + 100 + 1801)
        );
        strict.latestRoundData();
    }

    function test_aWideLivePrintIsRefused() public {
        _post(228_87000000, 150, REGULAR, TRADED, T0 + 100);
        vm.expectRevert(abi.encodeWithSelector(HoodOracleFeed.BandTooWide.selector, uint64(150), uint64(100)));
        strict.latestRoundData();
    }

    function test_theMultiplierIsReadLiveNotCached() public {
        _post(100_00000000, 8, REGULAR, TRADED, T0 + 100);
        (int256 before,,) = _answer(strict);
        nvda.setMultiplier(2e18); // a 2-for-1 split expressed as a multiplier
        (int256 afterSplit,,) = _answer(strict);
        _eq(uint256(before), 100_07751591, "before");
        _eq(uint256(afterSplit), 200_00000000, "the next read follows the multiplier");
    }

    function test_plainModeForwardsWhateverIsStored() public {
        _post(219_00000000, 420, CLOSED, DERIVED, T0 + 100);
        vm.warp(T0 + 100 + 30 days);
        (int256 a,,) = _answer(plain);
        _eq(uint256(a), 219_16975985, "a month-old model price, answered anyway");
    }

    function test_withoutATokenItPricesTheShare() public {
        HoodOracleFeed share = new HoodOracleFeed(address(oracle), "NVDA", address(0), 1800, 100, true);
        _post(228_87000000, 8, REGULAR, TRADED, T0 + 100);
        (int256 a,,) = _answer(share);
        _eq(uint256(a), 228_87000000, "no multiplier applied");
    }

    function test_aTickerNeverPostedReverts() public {
        HoodOracleFeed tlt = new HoodOracleFeed(address(oracle), "TLT", address(0), 1800, 100, true);
        vm.expectRevert(abi.encodeWithSelector(HoodOracle.NoQuote.selector, "TLT"));
        tlt.latestRoundData();
    }

    function test_chainlinkAccessorsAgree() public {
        _post(228_87000000, 8, REGULAR, TRADED, T0 + 100);
        (uint80 round, int256 a,,,) = strict.latestRoundData();
        (, int256 b,,,) = strict.getRoundData(round);
        _eq(uint256(b), uint256(a), "getRoundData(latest) matches");
        _eq(uint256(strict.latestAnswer()), uint256(a), "latestAnswer matches");
        _eq(strict.decimals(), 8, "8 decimals, like Chainlink USD feeds");
        vm.expectRevert(abi.encodeWithSelector(HoodOracleFeed.NoSuchRound.selector, uint80(1)));
        strict.getRoundData(1);
    }

    function test_descriptionSaysWhatItIs() public view {
        require(
            keccak256(bytes(strict.description())) ==
                keccak256(bytes("NVDA token / USD \xc2\xb7 hoodoracle, live prints only")),
            "strict description"
        );
        require(
            keccak256(bytes(plain.description())) ==
                keccak256(bytes("NVDA token / USD \xc2\xb7 hoodoracle, any provenance")),
            "plain description"
        );
    }
}
