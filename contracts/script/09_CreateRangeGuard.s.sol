// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {ParallaxExecutor} from "../src/ParallaxExecutor.sol";
import {PoolMath} from "../src/libraries/PoolMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IERC721} from "forge-std/interfaces/IERC721.sol";

/// @notice Demo: mint a NARROW LP position around the current price (±RG_WIDTH_TICKS, default 600 ≈ ±6%)
///         and hand it to Parallax as a RANGE_GUARD. When the price leaves the range, the position's
///         liquidity + fees are withdrawn back to you automatically.
///         To guard an existing position instead, set RG_POSITION_ID.
///      RG_RECENTER=true re-opens the liquidity centred on the new price instead of withdrawing it.
/// Run: ./tw.sh create-range-guard   /   ./tw.sh create-recenter-guard
contract CreateRangeGuard is DemoBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        (uint256 pk, address me) = _deployer();
        ParallaxExecutor executor = ParallaxExecutor(payable(_readAddress("parallaxExecutor")));
        IPositionManager posm = IPositionManager(_addrs().positionManager);
        uint256 positionId = vm.envOr("RG_POSITION_ID", uint256(0));

        vm.startBroadcast(pk);
        if (positionId == 0) positionId = _mintNarrowPosition(posm, me);
        IERC721(address(posm)).approve(address(executor), positionId);
        uint256 ruleId = executor.createRangeGuard(
            positionId, uint16(vm.envOr("RG_SLIPPAGE_BPS", uint256(300))), vm.envOr("RG_RECENTER", false)
        );
        vm.stopBroadcast();

        console2.log("RANGE_GUARD ruleId:", ruleId);
        console2.log("guarding position:", positionId);
        _save("rangeGuardPositionId", positionId);
    }

    /// @dev Same Permit2 → PositionManager flow as 03_AddLiquidity, but a narrow, small position.
    function _mintNarrowPosition(IPositionManager posm, address owner) internal returns (uint256 id) {
        _approveViaPermit2(address(posm));
        (int24 tickLower, int24 tickUpper) = _narrowRange();
        id = posm.nextTokenId();
        posm.modifyLiquidities(_mintCalldata(tickLower, tickUpper, owner), block.timestamp + 600);
        console2.log("minted position", id);
        console2.log("  tickLower:", tickLower);
        console2.log("  tickUpper:", tickUpper);
    }

    function _narrowRange() internal view returns (int24 tickLower, int24 tickUpper) {
        (, int24 tick,,) = IPoolManager(_addrs().poolManager).getSlot0(_poolKey().toId());
        int24 width = int24(int256(vm.envOr("RG_WIDTH_TICKS", uint256(600))));
        int24 base = PoolMath.floorToSpacing(tick, TICK_SPACING);
        (tickLower, tickUpper) = (base - width, base + width);
        console2.log("  current tick:", tick);
    }

    function _mintCalldata(int24 tickLower, int24 tickUpper, address owner) internal view returns (bytes memory) {
        PoolKey memory key = _poolKey();
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            vm.envOr("RG_LIQUIDITY", uint256(1e14)),
            type(uint128).max,
            type(uint128).max,
            owner,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        return abi.encode(actions, params);
    }

    function _approveViaPermit2(address posm) internal {
        IAllowanceTransfer permit2 = IAllowanceTransfer(_addrs().permit2);
        address[2] memory tokens = [_weth(), _usdc()];
        for (uint256 i; i < 2; ++i) {
            IERC20(tokens[i]).approve(address(permit2), type(uint256).max);
            permit2.approve(tokens[i], posm, type(uint160).max, uint48(block.timestamp + 30 days));
        }
    }
}
