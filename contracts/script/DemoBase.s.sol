// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

/// @title DemoBase
/// @notice Shared plumbing for the demo scripts: reads env, builds our PoolKey,
///         and persists deployed addresses to `contracts/deployments/<chainId>.json`
///         so each script can pick up where the previous one left off.
abstract contract DemoBase is Script {
    using PoolIdLibrary for PoolKey;

    // Demo pool parameters: a plain 0.30% pool, no hooks.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    uint8 internal constant WETH_DECIMALS = 18;
    uint8 internal constant USDC_DECIMALS = 6;

    function _deployer() internal view returns (uint256 pk, address addr) {
        pk = vm.envUint("PRIVATE_KEY");
        addr = vm.addr(pk);
    }

    // ── Deployment file ────────────────────────────────────────────────────

    function _deploymentsPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }

    function _readAddress(string memory key) internal view returns (address) {
        string memory json = vm.readFile(_deploymentsPath());
        return vm.parseJsonAddress(json, string.concat(".", key));
    }

    /// @notice Read an address saved by a script that ran on ANOTHER chain (e.g. Lasna ↔ Unichain).
    function _readAddressFrom(uint256 chainId, string memory key) internal view returns (address) {
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(chainId), ".json");
        return vm.parseJsonAddress(vm.readFile(path), string.concat(".", key));
    }

    uint256 internal constant UNICHAIN_SEPOLIA = 1301;
    uint256 internal constant LASNA = 5318007;

    function _hasDeployments() internal view returns (bool) {
        return vm.exists(_deploymentsPath());
    }

    /// @notice Merge `key: value` into the deployments file (creating it if needed).
    function _save(string memory key, address value) internal {
        string memory obj = _loadObj();
        vm.writeJson(vm.serializeAddress(obj, key, value), _deploymentsPath());
    }

    function _save(string memory key, bytes32 value) internal {
        string memory obj = _loadObj();
        vm.writeJson(vm.serializeBytes32(obj, key, value), _deploymentsPath());
    }

    function _save(string memory key, uint256 value) internal {
        string memory obj = _loadObj();
        vm.writeJson(vm.serializeUint(obj, key, value), _deploymentsPath());
    }

    /// @dev Seeds a serialization object with the current file contents so we never drop earlier keys.
    function _loadObj() private returns (string memory obj) {
        obj = "deployments";
        if (_hasDeployments()) vm.serializeJson(obj, vm.readFile(_deploymentsPath()));
    }

    // ── Pool key ───────────────────────────────────────────────────────────

    function _weth() internal view returns (address) {
        return _readAddress("mockWETH");
    }

    function _usdc() internal view returns (address) {
        return _readAddress("mockUSDC");
    }

    /// @notice Our demo pool key. v4 requires currency0 < currency1 (sorted by address).
    function _poolKey() internal view returns (PoolKey memory key) {
        address weth = _weth();
        address usdc = _usdc();
        (address c0, address c1) = weth < usdc ? (weth, usdc) : (usdc, weth);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
    }

    function _wethIsCurrency0() internal view returns (bool) {
        return _weth() < _usdc();
    }

    /// @notice Convert a human price "USDC per 1 WETH" into the raw (amount1, amount0) ratio v4 expects.
    function _rawRatio(uint256 usdcPerWeth) internal view returns (uint256 amount1, uint256 amount0) {
        uint256 oneWeth = 10 ** WETH_DECIMALS;
        uint256 usdcAmt = usdcPerWeth * 10 ** USDC_DECIMALS;
        if (_wethIsCurrency0()) {
            (amount1, amount0) = (usdcAmt, oneWeth); // price = USDC per WETH
        } else {
            (amount1, amount0) = (oneWeth, usdcAmt); // price = WETH per USDC (inverted)
        }
    }

    function _logPool(PoolKey memory key) internal pure {
        console2.log("currency0:", Currency.unwrap(key.currency0));
        console2.log("currency1:", Currency.unwrap(key.currency1));
        console2.log("poolId:");
        console2.logBytes32(PoolId.unwrap(key.toId()));
    }
}
