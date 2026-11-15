// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {Chains} from "./Chains.sol";
import {ParallaxReactive} from "../src/ParallaxReactive.sol";

/// @notice Step C (on Reactive LASNA): register a chain with ParallaxReactive: its Uniswap v4
///         PoolManager and its ParallaxExecutor. This subscribes the reactive contract to that
///         executor's RuleCreated / Cancelled / Executed / Skipped events.
/// Run: ADD_CHAIN_ID=1301 ./tw.sh add-chain   /   ADD_CHAIN_ID=84532 ./tw.sh add-chain
contract AddChain is DemoBase {
    function run() external {
        require(block.chainid == LASNA, "run this on Lasna");
        (uint256 pk,) = _deployer();
        uint256 chainId = vm.envUint("ADD_CHAIN_ID");
        ParallaxReactive reactive = ParallaxReactive(payable(_readAddress("parallaxReactive")));
        address executor = _readAddressFrom(chainId, "parallaxExecutor");
        address poolManager = Chains.get(chainId).poolManager;

        vm.startBroadcast(pk);
        reactive.addChain(chainId, poolManager, executor);
        vm.stopBroadcast();

        console2.log("registered chain", chainId);
        console2.log("  poolManager:", poolManager);
        console2.log("  executor:   ", executor);
    }
}
