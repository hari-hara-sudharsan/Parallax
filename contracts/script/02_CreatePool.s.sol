// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolInitializer_v4} from "@uniswap/v4-periphery/src/interfaces/IPoolInitializer_v4.sol";
import {PoolMath} from "../src/libraries/PoolMath.sol";

/// @notice Step 2: initialize the mWETH/mUSDC v4 pool at a starting price (default 3000 USDC per WETH).
/// Run: make create-pool            (override with START_PRICE=2500 make create-pool)
contract CreatePool is DemoBase {
    using PoolIdLibrary for PoolKey;

    function run() external {
        (uint256 pk,) = _deployer();
        uint256 startPrice = vm.envOr("START_PRICE", uint256(3000));
        address posm = vm.envAddress("POSITION_MANAGER");

        PoolKey memory key = _poolKey();
        (uint256 a1, uint256 a0) = _rawRatio(startPrice);
        uint160 sqrtP = PoolMath.sqrtPriceX96(a1, a0);

        vm.startBroadcast(pk);
        // Returns type(int24).max (no revert) if the pool already exists.
        int24 tick = IPoolInitializer_v4(posm).initializePool(key, sqrtP);
        vm.stopBroadcast();

        _logPool(key);
        console2.log("start price (USDC/WETH):", startPrice);
        console2.log("initial tick:", tick);

        // Persist the poolId next to the token addresses.
        _save("poolId", PoolId.unwrap(key.toId()));
        _save("startPrice", startPrice);
    }
}
