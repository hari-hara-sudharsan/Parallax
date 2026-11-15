// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolMath} from "../src/libraries/PoolMath.sol";

contract PoolMathTest is Test {
    /// 1:1 price → sqrtPriceX96 == 2^96 exactly, tick 0.
    function test_sqrtPrice_parity() public pure {
        assertEq(PoolMath.sqrtPriceX96(1e18, 1e18), uint160(1 << 96));
        assertEq(TickMath.getTickAtSqrtPrice(PoolMath.sqrtPriceX96(1e18, 1e18)), 0);
    }

    /// 3000 USDC (6dp) per 1 WETH (18dp), WETH = currency0. Known reference: tick ≈ -196,256.
    /// (ln(3e-9) / ln(1.0001) = -19.6246 / 0.000099995 = -196,256.)
    function test_tick_wethUsdc_3000() public pure {
        int24 tick = TickMath.getTickAtSqrtPrice(PoolMath.sqrtPriceX96(3000e6, 1e18));
        assertApproxEqAbs(int256(tick), -196_256, 1);
    }

    /// Inverted ordering (USDC = currency0) gives the mirror-image tick.
    function test_tick_inverted() public pure {
        int24 tick = TickMath.getTickAtSqrtPrice(PoolMath.sqrtPriceX96(1e18, 3000e6));
        assertApproxEqAbs(int256(tick), 196_256, 1);
    }

    function test_floorToSpacing() public pure {
        assertEq(PoolMath.floorToSpacing(125, 60), 120);
        assertEq(PoolMath.floorToSpacing(120, 60), 120);
        assertEq(PoolMath.floorToSpacing(-1, 60), -60);
        assertEq(PoolMath.floorToSpacing(-120, 60), -120);
        assertEq(PoolMath.floorToSpacing(-121, 60), -180);
    }

    function testFuzz_floorToSpacing(int24 tick) public pure {
        tick = int24(bound(tick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        int24 f = PoolMath.floorToSpacing(tick, 60);
        assertEq(f % 60, 0);
        assertLe(f, tick);
        assertGt(int256(f) + 60, int256(tick));
    }
}
