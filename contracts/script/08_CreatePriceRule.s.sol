// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {TripwireExecutor} from "../src/TripwireExecutor.sol";
import {RuleType, NO_LOWER, NO_UPPER} from "../src/libraries/RuleTypes.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice Demo: create a STOP_LOSS or TAKE_PROFIT rule that sells mWETH for mUSDC.
///   RULE_KIND=stop-loss    "sell RULE_AMOUNT mWETH if WETH drops RULE_MOVE_BPS"   [default]
///   RULE_KIND=take-profit  "sell RULE_AMOUNT mWETH if WETH rises RULE_MOVE_BPS"
///   Defaults: 1 mWETH, 300 bps (≈3%, 1 tick ≈ 1 bp), 300 bps max slippage.
/// The script converts the % move into tick bounds and picks the right side for however the
/// tokens happen to be sorted in the pool.
/// Run: ./tw.sh create-stop-loss   /   ./tw.sh create-take-profit
contract CreatePriceRule is DemoBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        (uint256 pk,) = _deployer();
        TripwireExecutor executor = TripwireExecutor(payable(_readAddress("tripwireExecutor")));
        bool takeProfit = keccak256(bytes(vm.envOr("RULE_KIND", string("stop-loss")))) == keccak256("take-profit");
        uint128 amount = uint128(vm.envOr("RULE_AMOUNT", uint256(1)) * 1 ether);
        (int24 lower, int24 upper) = _bounds(takeProfit);

        vm.startBroadcast(pk);
        IERC20(_weth()).approve(address(executor), amount);
        uint256 ruleId = executor.createRule(
            _poolKey(),
            takeProfit ? RuleType.TAKE_PROFIT : RuleType.STOP_LOSS,
            _wethIsCurrency0(), // selling WETH
            lower,
            upper,
            amount,
            uint16(vm.envOr("RULE_SLIPPAGE_BPS", uint256(300)))
        );
        vm.stopBroadcast();

        console2.log(takeProfit ? "TAKE_PROFIT ruleId:" : "STOP_LOSS ruleId:", ruleId);
        if (lower != NO_LOWER) console2.log("fires when tick <=", lower);
        if (upper != NO_UPPER) console2.log("fires when tick >=", upper);
    }

    /// @dev WETH price (USDC per WETH) moves WITH the tick if WETH is currency0, AGAINST it otherwise.
    function _bounds(bool takeProfit) internal view returns (int24 lower, int24 upper) {
        (, int24 tick,,) = IPoolManager(vm.envAddress("POOL_MANAGER")).getSlot0(_poolKey().toId());
        int24 moveTicks = int24(int256(vm.envOr("RULE_MOVE_BPS", uint256(300))));
        bool tickDown = (!takeProfit) == _wethIsCurrency0();
        (lower, upper) = tickDown ? (tick - moveTicks, NO_UPPER) : (NO_LOWER, tick + moveTicks);
        console2.log("current tick:", tick);
    }
}
