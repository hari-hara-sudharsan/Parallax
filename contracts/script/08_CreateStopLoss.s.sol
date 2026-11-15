// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {TripwireExecutor} from "../src/TripwireExecutor.sol";
import {RuleType} from "../src/libraries/RuleTypes.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice Demo: "sell SL_AMOUNT mWETH if the WETH price drops by SL_DROP_BPS" (defaults: 1 mWETH, 3%).
///         Converts the % drop into a tick distance (1 tick ≈ 1 bp) and picks the right direction for
///         however the tokens happen to be sorted in the pool.
/// Run: ./tw.sh create-stop-loss
contract CreateStopLoss is DemoBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        (uint256 pk,) = _deployer();
        TripwireExecutor executor = TripwireExecutor(payable(_readAddress("tripwireExecutor")));
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        uint128 amount = uint128(vm.envOr("SL_AMOUNT", uint256(1)) * 1 ether);
        int24 dropTicks = int24(int256(vm.envOr("SL_DROP_BPS", uint256(300))));
        uint16 slippage = uint16(vm.envOr("SL_SLIPPAGE_BPS", uint256(300)));

        PoolKey memory key = _poolKey();
        (, int24 tick,,) = manager.getSlot0(key.toId());

        // WETH price (USDC per WETH) falls ⇔ tick falls if WETH is currency0, rises if it is currency1.
        bool wethIs0 = _wethIsCurrency0();
        bool below = wethIs0;
        int24 trigger = below ? tick - dropTicks : tick + dropTicks;

        vm.startBroadcast(pk);
        IERC20(_weth()).approve(address(executor), amount);
        uint256 ruleId = executor.createRule(key, RuleType.STOP_LOSS, wethIs0, trigger, below, amount, slippage);
        vm.stopBroadcast();

        console2.log("ruleId:", ruleId);
        console2.log("current tick:", tick);
        console2.log("trigger tick:", trigger);
        console2.log(below ? "fires when tick <= trigger" : "fires when tick >= trigger");
    }
}
