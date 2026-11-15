// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {TripwireExecutor} from "../src/TripwireExecutor.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @notice Phase 2, step B (on UNICHAIN SEPOLIA): deploy TripwireExecutor bound to the Callback Proxy
///         and to the TripwireReactive address from step A (stored immutably, so get it right).
///         Funded with ETH because the Callback Proxy bills callback gas to this contract.
/// Run: ./tw.sh deploy-executor        (EXECUTOR_FUNDING in wei, default 0.01 ETH)
contract DeployExecutor is DemoBase {
    function run() external {
        require(block.chainid == UNICHAIN_SEPOLIA, "run this on Unichain Sepolia");
        (uint256 pk,) = _deployer();
        address proxy = vm.envAddress("UNICHAIN_CALLBACK_PROXY");
        address poolManager = vm.envAddress("POOL_MANAGER");
        address reactive = _readAddressFrom(LASNA, "tripwireReactive");
        uint256 funding = vm.envOr("EXECUTOR_FUNDING", uint256(0.01 ether));

        vm.startBroadcast(pk);
        TripwireExecutor executor =
            new TripwireExecutor{value: funding}(IPayable(payable(proxy)), reactive, IPoolManager(poolManager));
        vm.stopBroadcast();

        console2.log("TripwireExecutor (Unichain Sepolia):", address(executor));
        console2.log("authorized reactive sender:", reactive);
        _save("tripwireExecutor", address(executor));
    }
}
