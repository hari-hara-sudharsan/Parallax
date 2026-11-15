// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {ParallaxExecutor} from "../src/ParallaxExecutor.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice Demo: trailing stop that sells TRAIL_AMOUNT mWETH (default 1) once the WETH price falls
///         TRAIL_BPS (default 300 ≈ 3%) behind the best price seen since creation. The stop only tightens:
///         ParallaxReactive requests raises as the price climbs and the executor verifies each one on-chain.
/// Run: CHAIN=base ./tw.sh create-trailing-stop
contract CreateTrailingStop is DemoBase {
    function run() external {
        (uint256 pk,) = _deployer();
        ParallaxExecutor executor = ParallaxExecutor(payable(_readAddress("parallaxExecutor")));
        uint128 amount = uint128(vm.envOr("TRAIL_AMOUNT", uint256(1)) * 1 ether);
        int24 trail = int24(int256(vm.envOr("TRAIL_BPS", uint256(300))));
        // Selling WETH. Its price moves WITH the tick if it is currency0, so the stop sits below the tick then.
        bool wethIs0 = _wethIsCurrency0();

        vm.startBroadcast(pk);
        IERC20(_weth()).approve(address(executor), amount);
        uint256 ruleId = executor.createTrailingStop(_poolKey(), wethIs0, wethIs0, trail, amount, 300);
        vm.stopBroadcast();

        console2.log("TRAILING_STOP ruleId:", ruleId);
        console2.log("trail (ticks):", trail);
    }
}
