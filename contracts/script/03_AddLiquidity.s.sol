// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console2} from "forge-std/Script.sol";
import {DemoBase} from "./DemoBase.s.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {PoolMath} from "../src/libraries/PoolMath.sol";

/// @notice Step 3: mint a concentrated LP position (default 100 mWETH + 300k mUSDC, range 1500–6000 USDC/WETH)
///         through the official v4 PositionManager. The position is an NFT owned by the deployer.
/// Run: make add-liquidity
contract AddLiquidity is DemoBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        (uint256 pk, address me) = _deployer();
        IPositionManager posm = IPositionManager(vm.envAddress("POSITION_MANAGER"));
        IAllowanceTransfer permit2 = IAllowanceTransfer(vm.envAddress("PERMIT2"));
        PoolKey memory key = _poolKey();

        bytes memory unlockData = _plan(key, me);

        vm.startBroadcast(pk);
        _approveViaPermit2(Currency.unwrap(key.currency0), permit2, address(posm));
        _approveViaPermit2(Currency.unwrap(key.currency1), permit2, address(posm));
        uint256 tokenId = posm.nextTokenId();
        posm.modifyLiquidities(unlockData, block.timestamp + 600);
        vm.stopBroadcast();

        console2.log("position tokenId:", tokenId);
        _save("lpTokenId", tokenId);
    }

    /// @dev Works out the tick range + liquidity and returns the encoded PositionManager call.
    function _plan(PoolKey memory key, address owner) internal view returns (bytes memory) {
        (int24 tickLower, int24 tickUpper) = _range();
        (uint128 liquidity, uint256 amount0, uint256 amount1) = _liquidity(key, tickLower, tickUpper);
        console2.log("tickLower:", tickLower);
        console2.log("tickUpper:", tickUpper);
        console2.log("liquidity:", liquidity);
        return _mintCalldata(key, tickLower, tickUpper, liquidity, amount0, amount1, owner);
    }

    /// @dev Human price range → tick range. If WETH is currency1 the axis is inverted, so sort the ticks.
    function _range() internal view returns (int24 tickLower, int24 tickUpper) {
        (uint256 l1, uint256 l0) = _rawRatio(vm.envOr("LP_PRICE_LOW", uint256(1500)));
        (uint256 h1, uint256 h0) = _rawRatio(vm.envOr("LP_PRICE_HIGH", uint256(6000)));
        int24 tA = PoolMath.tickAt(l1, l0, TICK_SPACING);
        int24 tB = PoolMath.tickAt(h1, h0, TICK_SPACING);
        (tickLower, tickUpper) = tA < tB ? (tA, tB) : (tB, tA);
    }

    /// @dev Max liquidity we can mint with the requested token amounts at the current pool price.
    function _liquidity(PoolKey memory key, int24 tickLower, int24 tickUpper)
        internal
        view
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        (uint160 sqrtP, int24 tickNow,,) = IPoolManager(vm.envAddress("POOL_MANAGER")).getSlot0(key.toId());
        require(sqrtP != 0, "pool not initialized: run make create-pool");
        console2.log("current tick:", tickNow);

        uint256 wethAmt = vm.envOr("LP_WETH", uint256(100)) * 10 ** WETH_DECIMALS;
        uint256 usdcAmt = vm.envOr("LP_USDC", uint256(300_000)) * 10 ** USDC_DECIMALS;
        (amount0, amount1) = _wethIsCurrency0() ? (wethAmt, usdcAmt) : (usdcAmt, wethAmt);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount0, amount1
        );
    }

    /// @dev PositionManager action list: MINT_POSITION, then SETTLE_PAIR (pay both tokens in).
    function _mintCalldata(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1,
        address owner
    ) internal pure returns (bytes memory) {
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, tickLower, tickUpper, liquidity, uint128(amount0) + 1, uint128(amount1) + 1, owner, bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        return abi.encode(actions, params);
    }

    /// @dev v4 PositionManager pulls tokens through Permit2: ERC20 → Permit2 → PositionManager.
    function _approveViaPermit2(address token, IAllowanceTransfer permit2, address spender) internal {
        IERC20(token).approve(address(permit2), type(uint256).max);
        permit2.approve(token, spender, type(uint160).max, uint48(block.timestamp + 30 days));
    }
}
