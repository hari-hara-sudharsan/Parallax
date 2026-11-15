// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {ParallaxVaultReactive} from "../src/ParallaxVaultReactive.sol";

/// @notice Vault step C (on Reactive LASNA): wire the brain to the vault. Subscribes it to the vault's
///         events and to the pool's Swap events.
/// Run: ./tw.sh set-vault
contract SetVault is DemoBase {
    function run() external {
        require(block.chainid == LASNA, "run this on Lasna");
        (uint256 pk,) = _deployer();
        ParallaxVaultReactive brain = ParallaxVaultReactive(payable(_readAddress("parallaxVaultReactive")));
        address vault = _readAddressFrom(brain.ORIGIN_CHAIN_ID(), "parallaxVault");

        vm.startBroadcast(pk);
        brain.setVault(vault);
        vm.stopBroadcast();
        console2.log("brain", address(brain), "-> vault", vault);
    }
}
