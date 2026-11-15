// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";

/// @notice Phase 2, step A (on Reactive LASNA): deploy TripwireReactive, funded with lREACT.
///         It watches Unichain Sepolia (origin) and sends callbacks to Unichain Sepolia (destination).
/// Run: ./tw.sh deploy-reactive        (REACTIVE_FUNDING in wei, default 2 lREACT)
contract DeployReactive is DemoBase {
    function run() external {
        require(block.chainid == LASNA, "run this on Lasna (--rpc-url $LASNA_RPC)");
        (uint256 pk,) = _deployer();
        address poolManager = vm.envAddress("POOL_MANAGER");
        uint256 funding = vm.envOr("REACTIVE_FUNDING", uint256(2 ether));

        vm.startBroadcast(pk);
        TripwireReactive reactive =
            new TripwireReactive{value: funding}(UNICHAIN_SEPOLIA, poolManager, UNICHAIN_SEPOLIA);
        vm.stopBroadcast();

        console2.log("TripwireReactive (Lasna):", address(reactive));
        console2.log("funded with (wei):", funding);
        _save("tripwireReactive", address(reactive));
    }
}
