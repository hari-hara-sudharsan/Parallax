// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC721} from "forge-std/interfaces/IERC721.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

import {PoolMath} from "../libraries/PoolMath.sol";

/// @title V4LiquidityOps
/// @notice Shared Uniswap v4 plumbing for Parallax contracts that move liquidity: exact-input swaps through
///         `PoolManager.unlock`, rebalancing held tokens to a range's ratio, minting positions through
///         Permit2 → PositionManager, and the price/value math behind them. Used by ParallaxExecutor (rule
///         actions, LP re-centring) and ParallaxVault (keeperless managed LP).
abstract contract V4LiquidityOps is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeTransferLib for ERC20;

    error NotPoolManager();
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error SettleMismatch(uint256 paid, uint256 expected);

    uint256 internal constant Q96 = 1 << 96;
    /// @dev Canonical Permit2 (same address on every chain); PositionManager pulls tokens through it.
    IAllowanceTransfer internal constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    IPoolManager public immutable POOL_MANAGER;
    IPositionManager public immutable POSITION_MANAGER;

    /// @dev Tokens already approved ERC20 → Permit2 → PositionManager.
    mapping(address token => bool) internal _permit2Ready;

    constructor(IPoolManager poolManager_, IPositionManager positionManager_) {
        POOL_MANAGER = poolManager_;
        POSITION_MANAGER = positionManager_;
    }

    /// @notice Uniswap v4 flash-accounting callback: swap, pay the input, send the output to the rule owner.
    /// @dev Only reachable through our own `POOL_MANAGER.unlock` call inside `execute`
    ///      (PoolManager always calls back the contract that unlocked it).
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, uint128 amountIn, uint256 minOut, address recipient) =
            abi.decode(data, (PoolKey, bool, uint128, uint256, address));

        BalanceDelta delta = POOL_MANAGER.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(uint256(amountIn)), // negative = exact input
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // For an exact-input swap the input delta is negative (we owe) and the output delta positive.
        (int128 inDelta, int128 outDelta) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 amountInPaid = uint256(uint128(-inDelta));
        uint256 amountOut = uint256(uint128(outDelta));
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);

        (Currency currencyIn, Currency currencyOut) =
            zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);

        // Pay what we owe: sync → transfer → settle.
        POOL_MANAGER.sync(currencyIn);
        ERC20(Currency.unwrap(currencyIn)).safeTransfer(address(POOL_MANAGER), amountInPaid);
        uint256 paid = POOL_MANAGER.settle();
        if (paid != amountInPaid) revert SettleMismatch(paid, amountInPaid);
        // Collect the proceeds straight to the rule owner.
        POOL_MANAGER.take(currencyOut, recipient, amountOut);

        // If the pool ran out of liquidity before the full amount was sold, refund the remainder.
        uint256 refund = amountIn - amountInPaid;
        if (refund > 0) ERC20(Currency.unwrap(currencyIn)).safeTransfer(recipient, refund);
        return abi.encode(refund, amountOut);
    }

    /// @notice Lets PositionManager `safeTransferFrom` positions to us (we use plain transferFrom ourselves).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function _balances(PoolKey memory key, address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = ERC20(Currency.unwrap(key.currency0)).balanceOf(who);
        b1 = ERC20(Currency.unwrap(key.currency1)).balanceOf(who);
    }

    /// @dev Same width as the old position, centred on `tick`, aligned to the tick spacing.
    function _centredRange(int24 oldLower, int24 oldUpper, int24 tick, int24 spacing)
        internal
        pure
        returns (int24 tl, int24 tu)
    {
        int24 half = ((oldUpper - oldLower) / 2 / spacing) * spacing;
        int24 base = PoolMath.floorToSpacing(tick, spacing);
        if (half == 0) return (base, base + spacing);
        return (base - half, base + half);
    }

    /// @dev Plan the rebalancing swap from what we hold above the baseline (direction + exact input).
    function _rebalancePlan(PoolKey memory key, int24 tl, int24 tu, uint256 b0, uint256 b1)
        internal
        view
        returns (bool zeroForOne, uint256 amountIn)
    {
        (uint256 h0, uint256 h1) = _heldAbove(key, b0, b1);
        (uint160 sqrtP,,,) = POOL_MANAGER.getSlot0(key.toId());
        return _rebalanceAmount(tl, tu, h0, h1, sqrtP);
    }

    /// @dev Exact-input swap of tokens we hold, with the rule's slippage floor; proceeds stay here.
    function _swapHeld(PoolKey memory key, bool zeroForOne, uint256 amountIn, uint16 slippageBps) internal {
        (uint160 sqrtP,,,) = POOL_MANAGER.getSlot0(key.toId());
        uint256 minOut = _quoteAtSpot(amountIn, sqrtP, zeroForOne, key.fee) * (10_000 - slippageBps) / 10_000;
        // Proceeds stay in this contract and are measured against the baseline, so the result is not needed.
        // forge-lint: disable-next-line(unused-return)
        POOL_MANAGER.unlock(abi.encode(key, zeroForOne, uint128(amountIn), minOut, address(this)));
    }

    /// @dev How much to swap, and which way, so holdings (h0, h1) match the ratio the range needs.
    ///      Everything is valued in currency0 terms: price = (sqrtP / 2^96)^2 currency1 per currency0.
    function _rebalanceAmount(int24 tl, int24 tu, uint256 h0, uint256 h1, uint160 sqrtP)
        internal
        pure
        returns (bool zeroForOne, uint256 amountIn)
    {
        // Token amounts one unit of liquidity needs in the new range at the current price.
        uint256 u0 = SqrtPriceMath.getAmount0Delta(sqrtP, TickMath.getSqrtPriceAtTick(tu), 1e18, false);
        uint256 u1in0 =
            _toToken0(SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(tl), sqrtP, 1e18, false), sqrtP);
        uint256 h1in0 = _toToken0(h1, sqrtP);
        uint256 want1in0 = FullMath.mulDiv(h0 + h1in0, u1in0, u0 + u1in0);
        zeroForOne = h1in0 < want1in0;
        amountIn = zeroForOne ? want1in0 - h1in0 : _toToken1(h1in0 - want1in0, sqrtP);
    }

    /// @dev Mint [tl, tu) with everything held above the baseline; the NFT is held by this contract.
    function _mintHeld(PoolKey memory key, int24 tl, int24 tu, uint256 b0, uint256 b1) internal returns (uint256 id) {
        (uint256 h0, uint256 h1) = _heldAbove(key, b0, b1);
        _ensurePermit2(Currency.unwrap(key.currency0));
        _ensurePermit2(Currency.unwrap(key.currency1));
        (uint160 sqrtP,,,) = POOL_MANAGER.getSlot0(key.toId());
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), h0, h1
        );
        liquidity = liquidity * 9_999 / 10_000; // headroom for the PositionManager's round-up

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(key, tl, tu, uint256(liquidity), uint128(h0), uint128(h1), address(this), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        id = POSITION_MANAGER.nextTokenId();
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    function _heldAbove(PoolKey memory key, uint256 b0, uint256 b1) internal view returns (uint256 h0, uint256 h1) {
        (uint256 n0, uint256 n1) = _balances(key, address(this));
        (h0, h1) = (n0 - b0, n1 - b1);
    }

    /// @dev ERC20 → Permit2 → PositionManager, once per token.
    function _ensurePermit2(address token) internal {
        if (_permit2Ready[token]) return;
        ERC20(token).safeApprove(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(POSITION_MANAGER), type(uint160).max, type(uint48).max);
        _permit2Ready[token] = true;
    }

    function _toToken0(uint256 amount1, uint160 sqrtP) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(amount1, Q96, sqrtP), Q96, sqrtP);
    }

    function _toToken1(uint256 amount0, uint160 sqrtP) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(amount0, sqrtP, Q96), sqrtP, Q96);
    }

    /// @dev PositionManager is an ERC-721 (LP NFTs); IPositionManager itself doesn't declare those functions.
    function _nft() internal view returns (IERC721) {
        return IERC721(address(POSITION_MANAGER));
    }

    function _tick(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = POOL_MANAGER.getSlot0(key.toId());
    }

    /// @dev Output for `amountIn` at the spot price, after the LP fee, ignoring price impact.
    ///      price (currency1 per currency0) = (sqrtPriceX96 / 2^96)^2. Two mulDivs avoid overflow.
    function _quoteAtSpot(uint256 amountIn, uint160 sqrtPriceX96, bool zeroForOne, uint24 fee)
        internal
        pure
        returns (uint256 out)
    {
        out = zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(amountIn, sqrtPriceX96, Q96), sqrtPriceX96, Q96)
            : FullMath.mulDiv(FullMath.mulDiv(amountIn, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
        out = out * (1_000_000 - fee) / 1_000_000;
    }
}
