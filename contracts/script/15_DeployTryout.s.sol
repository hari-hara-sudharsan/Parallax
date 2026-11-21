// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {ParallaxExecutor} from "../src/ParallaxExecutor.sol";
import {ParallaxTryout} from "../src/ParallaxTryout.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

/// @notice Deploy the zero-setup judge path on this chain: ParallaxTryout, bound to this chain's executor,
///         the demo pool and Uniswap's PoolSwapTest router. Its "home" price is the pool price at deploy time.
/// Run: CHAIN=base ./tw.sh deploy-tryout   (after deploy-parallax)
contract DeployTryout is DemoBase {
    function run() external {
        require(block.chainid == UNICHAIN_SEPOLIA || block.chainid == BASE_SEPOLIA, "run on Unichain or Base Sepolia");
        (uint256 pk,) = _deployer();
        ParallaxExecutor executor = ParallaxExecutor(payable(_readAddress("parallaxExecutor")));

        vm.startBroadcast(pk);
        ParallaxTryout tryout = new ParallaxTryout(
            executor,
            PoolSwapTest(payable(_addrs().poolSwapTest)),
            _poolKey(),
            MockERC20(_weth()),
            MockERC20(_usdc())
        );
        vm.stopBroadcast();

        console2.log("ParallaxTryout:", address(tryout));
        console2.log("home tick:", int256(tryout.HOME_TICK()));
        _save("parallaxTryout", address(tryout));
    }
}
