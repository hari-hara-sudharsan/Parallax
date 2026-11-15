// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {ParallaxExecutor} from "../src/ParallaxExecutor.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

/// @notice Step B (on Unichain Sepolia OR Base Sepolia): deploy ParallaxExecutor for this chain, bound to
///         this chain's Callback Proxy and to the ParallaxReactive from step A (stored immutably).
///         Funded with ETH because the Callback Proxy bills callback gas to this contract.
/// Run: CHAIN=unichain ./tw.sh deploy-executor   /   CHAIN=base ./tw.sh deploy-executor
///      (EXECUTOR_FUNDING in wei, default 0.002 ETH)
contract DeployExecutor is DemoBase {
    function run() external {
        require(block.chainid == UNICHAIN_SEPOLIA || block.chainid == BASE_SEPOLIA, "run on Unichain or Base Sepolia");
        (uint256 pk,) = _deployer();
        address reactive = _readAddressFrom(LASNA, "parallaxReactive");
        uint256 funding = vm.envOr("EXECUTOR_FUNDING", uint256(0.002 ether));

        vm.startBroadcast(pk);
        ParallaxExecutor executor = new ParallaxExecutor{value: funding}(
            IPayable(payable(_addrs().callbackProxy)),
            reactive,
            IPoolManager(_addrs().poolManager),
            IPositionManager(_addrs().positionManager)
        );
        vm.stopBroadcast();

        console2.log("ParallaxExecutor:", address(executor));
        console2.log("chain:", block.chainid);
        console2.log("authorized reactive sender:", reactive);
        _save("parallaxExecutor", address(executor));
        _save("parallaxExecutorBlock", block.number);
    }
}
