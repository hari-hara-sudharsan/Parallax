// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {ParallaxVault} from "../src/ParallaxVault.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Deposit demo tokens into ParallaxVault (mints mock tokens to the deployer first).
///         VAULT_DEPOSIT_WETH (wei, default 1 ether) + VAULT_DEPOSIT_USDC (default 3000e6).
/// Run: CHAIN=base ./tw.sh vault-deposit
contract VaultDeposit is DemoBase {
    function run() external {
        (uint256 pk, address me) = _deployer();
        ParallaxVault vault = ParallaxVault(payable(_readAddress("parallaxVault")));
        uint256 w = vm.envOr("VAULT_DEPOSIT_WETH", uint256(1 ether));
        uint256 u = vm.envOr("VAULT_DEPOSIT_USDC", uint256(3000e6));
        MockERC20 weth = MockERC20(_weth());
        MockERC20 usdc = MockERC20(_usdc());
        (uint256 a0, uint256 a1) = _wethIsCurrency0() ? (w, u) : (u, w);

        vm.startBroadcast(pk);
        if (weth.balanceOf(me) < w) weth.mint(me, w);
        if (usdc.balanceOf(me) < u) usdc.mint(me, u);
        weth.approve(address(vault), w);
        usdc.approve(address(vault), u);
        uint256 shares = vault.deposit(a0, a1);
        vm.stopBroadcast();

        console2.log("shares minted:", shares);
        console2.log("range:", vm.toString(vault.tickLower()), vm.toString(vault.tickUpper()));
    }
}
