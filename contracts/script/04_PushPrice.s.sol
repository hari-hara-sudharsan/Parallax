// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice Demo lever: swap hard to move the price, e.g. to cross a stop-loss.
///   PUSH_DIRECTION=down  → sell mWETH (price of WETH falls)   [default]
///   PUSH_DIRECTION=up    → sell mUSDC (price of WETH rises)
///   PUSH_AMOUNT          → whole tokens of the token being sold (default 20 WETH / 60000 USDC)
/// Uses Uniswap's deployed PoolSwapTest router. Each run emits a v4 `Swap` event, the ORIGIN event
/// that ParallaxReactive listens to.
/// Run: make push-down   /   make push-up
contract PushPrice is DemoBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        (uint256 pk,) = _deployer();
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        PoolSwapTest router = PoolSwapTest(vm.envAddress("POOL_SWAP_TEST"));

        bool down = keccak256(bytes(vm.envOr("PUSH_DIRECTION", string("down")))) == keccak256("down");
        PoolKey memory key = _poolKey();

        // Selling WETH pushes the WETH price down; selling USDC pushes it up.
        address tokenIn = down ? _weth() : _usdc();
        uint256 defaultAmt = down ? 20 : 60_000;
        uint256 amountIn = vm.envOr("PUSH_AMOUNT", defaultAmt) * 10 ** (down ? WETH_DECIMALS : USDC_DECIMALS);
        bool zeroForOne = tokenIn == Currency.unwrap(key.currency0);

        (, int24 tickBefore,,) = manager.getSlot0(key.toId());

        vm.startBroadcast(pk);
        IERC20(tokenIn).approve(address(router), amountIn);
        router.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn), // negative = exact input
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
        vm.stopBroadcast();

        // Note: in a broadcast script this "after" read is simulated locally, so it reflects the swap.
        (, int24 tickAfter,,) = manager.getSlot0(key.toId());
        console2.log(down ? "Pushed DOWN (sold mWETH)" : "Pushed UP (sold mUSDC)");
        console2.log("tick before:", tickBefore);
        console2.log("tick after: ", tickAfter);
    }
}
