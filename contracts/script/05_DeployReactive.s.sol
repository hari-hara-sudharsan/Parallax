// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {ParallaxReactive} from "../src/ParallaxReactive.sol";

/// @notice Step A (on Reactive LASNA): deploy the ONE ParallaxReactive that guards every chain,
///         funded with lREACT. Chains are registered afterwards with 07_AddChain.
/// Run: ./tw.sh deploy-reactive        (REACTIVE_FUNDING in wei, default 2 lREACT)
contract DeployReactive is DemoBase {
    function run() external {
        require(block.chainid == LASNA, "run this on Lasna (--rpc-url $LASNA_RPC)");
        (uint256 pk,) = _deployer();
        uint256 funding = vm.envOr("REACTIVE_FUNDING", uint256(2 ether));

        vm.startBroadcast(pk);
        ParallaxReactive reactive = new ParallaxReactive{value: funding}();
        vm.stopBroadcast();

        console2.log("ParallaxReactive (Lasna):", address(reactive));
        console2.log("funded with (wei):", funding);
        _save("parallaxReactive", address(reactive));
        _save("parallaxReactiveBlock", block.number);
    }
}
