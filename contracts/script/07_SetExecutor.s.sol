// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";

/// @notice Phase 2, step C (on Reactive LASNA): tell TripwireReactive where the executor lives.
///         This also subscribes it to the executor's RuleCreated/Cancelled/Executed/Skipped events.
/// Run: ./tw.sh set-executor
contract SetExecutor is DemoBase {
    function run() external {
        require(block.chainid == LASNA, "run this on Lasna");
        (uint256 pk,) = _deployer();
        TripwireReactive reactive = TripwireReactive(payable(_readAddress("tripwireReactive")));
        address executor = _readAddressFrom(UNICHAIN_SEPOLIA, "tripwireExecutor");

        vm.startBroadcast(pk);
        reactive.setExecutor(executor);
        vm.stopBroadcast();

        console2.log("reactive.executor =", executor);
    }
}
