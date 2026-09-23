// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {HoodOracleFeed} from "../contracts/HoodOracleFeed.sol";

/**
 * One weekend, two Morpho markets, run against Robinhood Chain mainnet state.
 *
 *   forge test --fork-url https://rpc.mainnet.chain.robinhood.com \
 *     --match-contract MorphoForkDemo -vv
 *
 * Everything that exists on mainnet is used as it is: Morpho Blue, its
 * ChainlinkOracleV2 factory and AdaptiveCurveIrm, USDG, the NVDA Robinhood
 * Stock Token with its live uiMultiplier, and hoodoracle itself. The two
 * markets are identical except for the oracle: one reads a plain feed, the
 * other hoodoracle's live-prints-only feed.
 *
 * The prices after the first are a scenario, signed by a throwaway key the
 * fork allow-lists. The production signer never signs a made-up quote: a
 * signature over invented data would be just as valid on mainnet.
 *
 * Without --fork-url this file does nothing, so plain `forge test` still runs
 * offline.
 */

interface Vm {
    function warp(uint256 ts) external;
    function prank(address who) external;
    function startPrank(address who) external;
    function stopPrank() external;
    function sign(uint256 pk, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 pk) external pure returns (address);
    function record() external;
    function accesses(address target) external returns (bytes32[] memory reads, bytes32[] memory writes);
    function load(address target, bytes32 slot) external view returns (bytes32);
    function store(address target, bytes32 slot, bytes32 value) external;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IStockToken is IERC20 {
    function uiMultiplier() external view returns (uint256);
}

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorpho {
    function createMarket(MarketParams memory) external;
    function supply(MarketParams memory, uint256 assets, uint256 shares, address onBehalf, bytes memory)
        external
        returns (uint256, uint256);
    function supplyCollateral(MarketParams memory, uint256 assets, address onBehalf, bytes memory) external;
    function borrow(MarketParams memory, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256, uint256);
    function repay(MarketParams memory, uint256 assets, uint256 shares, address onBehalf, bytes memory)
        external
        returns (uint256, uint256);
    function liquidate(MarketParams memory, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes memory)
        external
        returns (uint256, uint256);
    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function market(bytes32 id)
        external
        view
        returns (uint128, uint128, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128, uint128);
}

interface IMorphoOracle {
    function price() external view returns (uint256);
}

interface IOracleFactory {
    function createMorphoChainlinkOracleV2(
        address baseVault,
        uint256 baseVaultConversionSample,
        address baseFeed1,
        address baseFeed2,
        uint256 baseTokenDecimals,
        address quoteVault,
        uint256 quoteVaultConversionSample,
        address quoteFeed1,
        address quoteFeed2,
        uint256 quoteTokenDecimals,
        bytes32 salt
    ) external returns (address);
}

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

    function owner() external view returns (address);
    function setSigner(address signer, bool allowed) external;
    function getQuote(string calldata ticker) external view returns (Quote memory);
    function postQuote(string calldata ticker, Quote calldata q, bytes calldata signature) external;
}

contract MorphoForkDemo {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    // Robinhood Chain mainnet, all verified on-chain on 23 Sep 2026.
    IHoodOracle constant HOOD = IHoodOracle(0x65cF45524407a5e700188A8A8178D5D5c0C38d30);
    IMorpho constant MORPHO = IMorpho(0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010);
    address constant IRM = 0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1;
    IOracleFactory constant FACTORY = IOracleFactory(0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    IStockToken constant NVDA = IStockToken(0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC);

    uint256 constant LLTV = 0.77e18;
    uint256 constant SCENARIO_PK = 0x5CE7A410;

    // Real calendar instants, so the log reads as a real weekend.
    uint256 constant FRI_1500_ET = 1790362800;
    uint256 constant SAT_1200_ET = 1790438400;
    uint256 constant MON_0930_ET = 1790602200;
    uint256 constant MON_1015_ET = 1790604900;

    address lender = address(0x1E1D);
    address borrower = address(0xB0B);
    address liquidator = address(0x1D1D);

    MarketParams plainMkt;
    MarketParams hoodMkt;
    HoodOracleFeed hoodFeed;
    HoodOracleFeed plainFeed;
    uint128 close;

    // ---------------------------------------------------------------- run

    function test_theWeekendThatWouldHaveLiquidatedYou() public {
        if (block.chainid != 4663) return;

        _h("0 / What mainnet says right now");
        IHoodOracle.Quote memory real = HOOD.getQuote("NVDA");
        close = real.price;
        _log(string.concat("  hoodoracle NVDA   $", _fmt(real.price, 8, 2), "  provenance ", _prov(real.provenance)));
        _log(string.concat("  NVDA uiMultiplier ", _fmt(NVDA.uiMultiplier(), 18, 6), "  (dividends, per ERC-8056)"));

        _h("1 / Deploy the adapter, twice, and a Morpho oracle for each");
        hoodFeed = new HoodOracleFeed(address(HOOD), "NVDA", address(NVDA), 1800, 100, true);
        plainFeed = new HoodOracleFeed(address(HOOD), "NVDA", address(NVDA), 0, 0, false);
        _log(string.concat("  ", hoodFeed.description()));
        _log(string.concat("  ", plainFeed.description()));
        address hoodOracle = _morphoOracle(address(hoodFeed), "hoodoracle");
        address plainOracle = _morphoOracle(address(plainFeed), "plain");
        _log("  both through Morpho's own ChainlinkOracleV2 factory: no Morpho code changed");

        plainMkt = MarketParams(USDG, address(NVDA), plainOracle, IRM, LLTV);
        hoodMkt = MarketParams(USDG, address(NVDA), hoodOracle, IRM, LLTV);
        MORPHO.createMarket(plainMkt);
        MORPHO.createMarket(hoodMkt);
        _log("  two USDG / NVDA markets at 77% LLTV, identical except the oracle");

        vm.prank(HOOD.owner());
        HOOD.setSigner(vm.addr(SCENARIO_PK), true);

        _h("2 / Friday 15:00 ET: the tape is open");
        vm.warp(FRI_1500_ET);
        _post(close, 8, 0, 0);
        (, int256 feedAnswer,,,) = hoodFeed.latestRoundData();
        _log(string.concat("  share $", _fmt(close, 8, 2), "  x multiplier = token $", _fmt(uint256(feedAnswer), 8, 4)));
        _seed(plainMkt);
        _seed(hoodMkt);
        _log(string.concat("  borrower: 10 NVDA collateral, borrows 1,720 USDG in each market, LTV ", _ltv(hoodMkt)));

        _h("3 / Saturday 12:00 ET: stock market shut, BTC falls, the model marks NVDA -4%");
        vm.warp(SAT_1200_ET);
        _post(uint128((uint256(close) * 96) / 100), 420, 3, 1);
        _log(string.concat("  quote: DERIVED $", _fmt((uint256(close) * 96) / 100, 8, 2), " +/- 4.20%. A model, not a trade."));
        _log(string.concat("  plain market LTV ", _ltv(plainMkt), "  > 77%: liquidatable"));
        uint256 seized = _liquidateAll(plainMkt);
        _log(string.concat("  plain market: liquidated. borrower loses ", _fmt(seized, 18, 3), " NVDA of 10"));
        _tryLiquidate(hoodMkt, "  hoodoracle market: liquidate()");
        _tryBorrow(hoodMkt);
        vm.startPrank(borrower);
        MORPHO.repay(hoodMkt, 20e6, 0, borrower, "");
        vm.stopPrank();
        _log("  hoodoracle market: repay() still works, the borrower can de-risk all weekend");

        _h("4 / Monday 09:30 ET: the first real print. NVDA opens -1%, not -4%");
        vm.warp(MON_0930_ET);
        _post(uint128((uint256(close) * 99) / 100), 8, 0, 0);
        _log(string.concat("  quote: TRADED $", _fmt((uint256(close) * 99) / 100, 8, 2)));
        _log(string.concat("  hoodoracle market LTV ", _ltv(hoodMkt), "  < 77%: healthy"));
        _tryLiquidate(hoodMkt, "  hoodoracle market: liquidate()");
        _log(string.concat("  the model was 3% too pessimistic. the plain market's borrower paid for it with ", _fmt(seized, 18, 3), " NVDA"));

        _h("5 / Monday 10:15 ET: the print confirms a real fall, NVDA -6%");
        vm.warp(MON_1015_ET);
        _post(uint128((uint256(close) * 94) / 100), 8, 0, 0);
        _log(string.concat("  hoodoracle market LTV ", _ltv(hoodMkt), "  > 77%"));
        uint256 seizedLive = _liquidateAll(hoodMkt);
        _log(string.concat("  hoodoracle market: liquidated at a traded price, ", _fmt(seizedLive, 18, 3), " NVDA seized"));
        _log("  no liquidation on a guess. liquidation on a fact.");
    }

    // ------------------------------------------------------------ actions

    function _morphoOracle(address feed, bytes32 salt) internal returns (address) {
        // NVDA token: 18 decimals. USDG: 6 decimals, taken as $1 (no quote feed).
        return FACTORY.createMorphoChainlinkOracleV2(address(0), 1, feed, address(0), 18, address(0), 1, address(0), address(0), 6, salt);
    }

    function _seed(MarketParams memory m) internal {
        _deal(USDG, lender, 50_000e6);
        vm.startPrank(lender);
        IERC20(USDG).approve(address(MORPHO), type(uint256).max);
        MORPHO.supply(m, 50_000e6, 0, lender, "");
        vm.stopPrank();

        _deal(address(NVDA), borrower, NVDA.balanceOf(borrower) + 10e18);
        vm.startPrank(borrower);
        NVDA.approve(address(MORPHO), type(uint256).max);
        IERC20(USDG).approve(address(MORPHO), type(uint256).max);
        MORPHO.supplyCollateral(m, 10e18, borrower, "");
        MORPHO.borrow(m, 1_720e6, 0, borrower, borrower);
        vm.stopPrank();
    }

    function _liquidateAll(MarketParams memory m) internal returns (uint256 seized) {
        (,, uint128 before) = MORPHO.position(_id(m), borrower);
        (, uint128 borrowShares,) = MORPHO.position(_id(m), borrower);
        _deal(USDG, liquidator, 10_000e6);
        vm.startPrank(liquidator);
        IERC20(USDG).approve(address(MORPHO), type(uint256).max);
        MORPHO.liquidate(m, borrower, 0, borrowShares, "");
        vm.stopPrank();
        (,, uint128 afterCollateral) = MORPHO.position(_id(m), borrower);
        seized = before - afterCollateral;
    }

    function _tryLiquidate(MarketParams memory m, string memory label) internal {
        (, uint128 borrowShares,) = MORPHO.position(_id(m), borrower);
        _deal(USDG, liquidator, 10_000e6);
        vm.startPrank(liquidator);
        IERC20(USDG).approve(address(MORPHO), type(uint256).max);
        try MORPHO.liquidate(m, borrower, 0, borrowShares, "") {
            _log(string.concat(label, " went through"));
        } catch (bytes memory err) {
            _log(string.concat(label, " reverted: ", _reason(err)));
        }
        vm.stopPrank();
    }

    function _tryBorrow(MarketParams memory m) internal {
        vm.startPrank(borrower);
        try MORPHO.borrow(m, 100e6, 0, borrower, borrower) {
            _log("  hoodoracle market: borrow() went through");
        } catch (bytes memory err) {
            _log(string.concat("  hoodoracle market: borrow() reverted: ", _reason(err)));
        }
        vm.stopPrank();
    }

    function _post(uint128 price, uint64 bps, uint8 session, uint8 provenance) internal {
        IHoodOracle.Quote memory q = IHoodOracle.Quote({
            price: price,
            confidenceBps: bps,
            session: session,
            provenance: provenance,
            sourceCount: 2,
            maxDeviationBps: 0,
            lastTradeTime: uint64(block.timestamp),
            publishTime: uint64(block.timestamp)
        });
        bytes32 digest = keccak256(
            abi.encode("NVDA", q.price, q.confidenceBps, q.session, q.provenance, q.sourceCount, q.maxDeviationBps, q.lastTradeTime, q.publishTime)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SCENARIO_PK, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        HOOD.postQuote("NVDA", q, abi.encodePacked(r, s, v));
    }

    /// forge-std's deal(), without forge-std: find the slot balanceOf reads.
    function _deal(address token, address to, uint256 amount) internal {
        vm.record();
        IERC20(token).balanceOf(to);
        (bytes32[] memory reads,) = vm.accesses(token);
        for (uint256 i = reads.length; i > 0; i--) {
            bytes32 prev = vm.load(token, reads[i - 1]);
            vm.store(token, reads[i - 1], bytes32(amount));
            if (IERC20(token).balanceOf(to) == amount) return;
            vm.store(token, reads[i - 1], prev);
        }
        revert("deal: no balance slot");
    }

    // ------------------------------------------------------------ reading

    function _id(MarketParams memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    function _ltv(MarketParams memory m) internal view returns (string memory) {
        bytes32 id = _id(m);
        (, uint128 shares, uint128 collateral) = MORPHO.position(id, borrower);
        (,, uint128 totalAssets, uint128 totalShares,,) = MORPHO.market(id);
        uint256 debt = (uint256(shares) * (uint256(totalAssets) + 1)) / (uint256(totalShares) + 1e6);
        // Read the plain feed for display so this works while the strict one refuses.
        (, int256 px,,,) = plainFeed.latestRoundData();
        uint256 value = (uint256(collateral) * uint256(px)) / 1e20; // 18 + 8 decimals -> 6
        return string.concat(_fmt((debt * 1e4) / value, 2, 1), "%");
    }

    function _reason(bytes memory err) internal pure returns (string memory) {
        bytes4 sel = bytes4(err);
        if (sel == HoodOracleFeed.NotLivePrint.selector) {
            uint8 p;
            assembly {
                p := mload(add(err, 36))
            }
            return string.concat("NotLivePrint(", _prov(p), ") from the hoodoracle feed");
        }
        if (sel == bytes4(keccak256("Error(string)"))) {
            bytes memory s = new bytes(err.length - 4);
            for (uint256 i = 4; i < err.length; i++) s[i - 4] = err[i];
            return string.concat('"', abi.decode(s, (string)), '" from Morpho');
        }
        return "unrecognised revert";
    }

    function _prov(uint8 p) internal pure returns (string memory) {
        return p == 0 ? "TRADED" : p == 1 ? "DERIVED" : "STALE";
    }

    // ------------------------------------------------------------ output

    function _h(string memory s) internal view {
        _log("");
        _log(s);
    }

    function _log(string memory s) internal view {
        (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string)", s));
        ok;
    }

    /// Fixed-point to decimal string: `v` has `d` decimals, show `shown`.
    function _fmt(uint256 v, uint8 d, uint8 shown) internal pure returns (string memory) {
        uint256 whole = v / 10 ** d;
        uint256 frac = (v % 10 ** d) / 10 ** (d - shown);
        bytes memory f = bytes(_str(frac));
        bytes memory padded = new bytes(shown);
        for (uint256 i = 0; i < shown; i++) {
            padded[i] = i < shown - f.length ? bytes1("0") : f[i - (shown - f.length)];
        }
        return string.concat(_str(whole), ".", string(padded));
    }

    function _str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        for (; v != 0; v /= 10) b[--len] = bytes1(uint8(48 + (v % 10)));
        return string(b);
    }
}
