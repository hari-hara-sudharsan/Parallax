// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Step 1: deploy MockWETH + MockUSDC and mint a demo bankroll to the deployer.
/// Run: make deploy-tokens
contract DeployTokens is DemoBase {
    function run() external {
        (uint256 pk, address me) = _deployer();

        vm.startBroadcast(pk);
        MockERC20 weth = new MockERC20("Tripwire Mock WETH", "mWETH", WETH_DECIMALS);
        MockERC20 usdc = new MockERC20("Tripwire Mock USDC", "mUSDC", USDC_DECIMALS);
        weth.mint(me, 1_000 * 10 ** WETH_DECIMALS);
        usdc.mint(me, 5_000_000 * 10 ** USDC_DECIMALS);
        vm.stopBroadcast();

        // Persist for the next scripts (and the frontend).
        _save("chainId", block.chainid);
        _save("mockWETH", address(weth));
        _save("mockUSDC", address(usdc));

        console2.log("MockWETH:", address(weth));
        console2.log("MockUSDC:", address(usdc));
        console2.log("Saved to", _deploymentsPath());
    }
}
