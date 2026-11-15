// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {Chains} from "./Chains.sol";
import {ParallaxVaultReactive} from "../src/ParallaxVaultReactive.sol";

/// @notice Vault step A (on Reactive LASNA): deploy the vault's reactive "brain" for the demo pool on
///         VAULT_CHAIN_ID (default Base Sepolia). Tuning (env, all optional):
///         VAULT_BREAKER_TICKS (default 200 ≈ 2%), VAULT_WINDOW_SEC (60), VAULT_CALM_SEC (60).
/// Run: ./tw.sh deploy-vault-reactive
contract DeployVaultReactive is DemoBase {
    function run() external {
        require(block.chainid == LASNA, "run this on Lasna");
        (uint256 pk,) = _deployer();
        uint256 chainId = vm.envOr("VAULT_CHAIN_ID", BASE_SEPOLIA);
        bytes32 poolId = vm.parseJsonBytes32(vm.readFile(_pathFor(chainId)), ".poolId");
        int24 breaker = int24(int256(vm.envOr("VAULT_BREAKER_TICKS", uint256(200))));
        uint32 window = uint32(vm.envOr("VAULT_WINDOW_SEC", uint256(60)));
        uint32 calm = uint32(vm.envOr("VAULT_CALM_SEC", uint256(60)));

        vm.startBroadcast(pk);
        ParallaxVaultReactive brain =
            new ParallaxVaultReactive(chainId, Chains.get(chainId).poolManager, poolId, breaker, window, calm);
        vm.stopBroadcast();

        console2.log("ParallaxVaultReactive (Lasna):", address(brain));
        _save("parallaxVaultReactive", address(brain));
        _save("parallaxVaultReactiveBlock", block.number);
    }

    function _pathFor(uint256 chainId) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(chainId), ".json");
    }
}
