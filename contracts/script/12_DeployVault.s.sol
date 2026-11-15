// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {ParallaxVault} from "../src/ParallaxVault.sol";
import {ParallaxVaultReactive} from "../src/ParallaxVaultReactive.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

/// @notice Vault step B (on the vault chain): deploy ParallaxVault on the demo pool, bound to this chain's
///         Callback Proxy and to the brain from step A. Breaker and calm period are read back from the brain
///         so both sides agree. VAULT_HALF_WIDTH (default 300 ticks ≈ ±3%), VAULT_FUNDING (0.002 ETH).
/// Run: CHAIN=base ./tw.sh deploy-vault
contract DeployVault is DemoBase {
    function run() external {
        (uint256 pk,) = _deployer();
        ParallaxVaultReactive brain = ParallaxVaultReactive(payable(_readAddressFrom(LASNA, "parallaxVaultReactive")));
        int24 halfWidth = int24(int256(vm.envOr("VAULT_HALF_WIDTH", uint256(300))));
        uint256 funding = vm.envOr("VAULT_FUNDING", uint256(0.002 ether));
        // Brain lives on Lasna; its tuning is passed in env (same defaults as step A) to avoid a cross-RPC read.
        int24 breaker = int24(int256(vm.envOr("VAULT_BREAKER_TICKS", uint256(200))));
        uint32 calm = uint32(vm.envOr("VAULT_CALM_SEC", uint256(60)));

        vm.startBroadcast(pk);
        ParallaxVault vault = new ParallaxVault{value: funding}(
            IPayable(payable(_addrs().callbackProxy)),
            address(brain),
            IPoolManager(_addrs().poolManager),
            IPositionManager(_addrs().positionManager),
            _poolKey(),
            halfWidth,
            breaker,
            calm,
            300
        );
        vm.stopBroadcast();

        console2.log("ParallaxVault:", address(vault));
        _save("parallaxVault", address(vault));
        _save("parallaxVaultBlock", block.number);
    }
}
