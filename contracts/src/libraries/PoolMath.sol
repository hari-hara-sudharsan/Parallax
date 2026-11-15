// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

/// @title PoolMath
/// @notice Small helpers to go between human prices and Uniswap v4 sqrtPriceX96 / ticks.
/// @dev In v4 the "price" is always currency1 per currency0, in raw (smallest-unit) amounts.
library PoolMath {
    /// @notice sqrtPriceX96 for a pool where `amount0` raw units of currency0 are worth `amount1` raw units of currency1.
    /// @dev sqrtPriceX96 = sqrt(amount1 / amount0) * 2^96 = sqrt(amount1 * 2^192 / amount0).
    ///      Example: 1 WETH (1e18) = 3000 USDC (3000e6), WETH is currency0 → sqrtPriceX96(3000e6, 1e18).
    function sqrtPriceX96(uint256 amount1, uint256 amount0) internal pure returns (uint160) {
        uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }

    /// @notice The tick for a given raw price ratio, rounded DOWN to a multiple of `tickSpacing`.
    function tickAt(uint256 amount1, uint256 amount0, int24 tickSpacing) internal pure returns (int24) {
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96(amount1, amount0));
        return floorToSpacing(tick, tickSpacing);
    }

    /// @notice Round a tick down (towards -infinity) to a multiple of `tickSpacing`.
    function floorToSpacing(int24 tick, int24 tickSpacing) internal pure returns (int24) {
        int24 compressed = tick / tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) compressed--;
        return compressed * tickSpacing;
    }
}
