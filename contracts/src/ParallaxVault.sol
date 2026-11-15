// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "reactive-lib-omni/base/AbstractCallback.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solmate/src/utils/ReentrancyGuard.sol";

import {V4LiquidityOps} from "./base/V4LiquidityOps.sol";

/// @title ParallaxVault
/// @notice A keeperless managed LP vault on one Uniswap v4 pool. Depositors receive `pxLP` shares; the vault
///         keeps a single concentrated position and ParallaxVaultReactive (on Reactive Network) manages it:
///         • rebalance: the price left the range → re-open the same width centred on the price;
///         • evacuate:  the price is moving fast (a crash in progress) → pull all liquidity out at once;
///         • reenter:   the market has been calm for a while → re-open centred on the new price.
///         Every callback is re-validated here against the live pool, exactly like ParallaxExecutor.
/// @dev Callback gas is billed to this contract in native ETH by the Callback Proxy, so keep it funded.
///      Uncollected position fees are not counted in share value until they are collected (on every
///      rebalance / evacuation / withdrawal), which is conservative for depositors.
contract ParallaxVault is AbstractCallback, V4LiquidityOps, ERC20, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeTransferLib for ERC20;

    enum Mode {
        EMPTY, //      no liquidity deployed yet
        POSITIONED, // liquidity in a range around the price
        EVACUATED //   liquidity pulled out after a fast move; waiting for calm
    }

    enum Action {
        REBALANCE,
        EVACUATE,
        REENTER
    }

    enum SkipReason {
        NOT_NEEDED, //   condition not true on-chain (in range / move too small / not evacuated)
        TOO_EARLY, //    re-entry before the calm period ended
        ACTION_FAILED // slippage floor hit or a step reverted; nothing changed
    }

    // ── Errors ──────────────────────────────────────────────────────────────
    error ZeroAmount();
    error ZeroShares();
    error NotSelf();
    error InvalidConfig();

    // ── Events ──────────────────────────────────────────────────────────────
    event Deposited(address indexed owner, uint256 amount0, uint256 amount1, uint256 shares);
    event Withdrawn(address indexed owner, uint256 shares, uint256 amount0, uint256 amount1);
    /// @dev Topic watched by ParallaxVaultReactive: data = (positionId, tickLower, tickUpper, anchorTick, reason).
    event VaultPositioned(uint256 positionId, int24 tickLower, int24 tickUpper, int24 anchorTick, uint8 reason);
    /// @dev data = (tick, amount0, amount1) pulled out of the position.
    event VaultEvacuated(int24 tick, uint256 amount0, uint256 amount1);
    /// @dev data = (action, reason, tick): the request did not qualify on-chain; the reactive side clears its flag.
    event VaultSkipped(uint8 action, uint8 reason, int24 tick);

    // ── Config ──────────────────────────────────────────────────────────────
    bytes32 public immutable POOL_ID;
    int24 public immutable HALF_WIDTH; //       ticks on each side of the price for every (re)opened range
    int24 public immutable BREAKER_TICKS; //    min move from the entry tick that justifies an evacuation
    uint32 public immutable MIN_CALM_SECONDS; // earliest re-entry after an evacuation (timestamp-based)
    uint16 public immutable SLIPPAGE_BPS;
    PoolKey internal _key;

    // ── State ───────────────────────────────────────────────────────────────
    Mode public mode;
    uint256 public positionId;
    int24 public tickLower;
    int24 public tickUpper;
    int24 public anchorTick; //  tick when liquidity was last (re)deployed
    uint64 public evacuatedAt;
    uint32 public rebalances;
    uint32 public evacuations;
    uint32 public reentries;

    constructor(
        IPayable callbackProxy_,
        address reactive_,
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        PoolKey memory key_,
        int24 halfWidth_,
        int24 breakerTicks_,
        uint32 minCalmSeconds_,
        uint16 slippageBps_
    )
        payable
        AbstractCallback(callbackProxy_, reactive_)
        V4LiquidityOps(poolManager_, positionManager_)
        ERC20("Parallax Vault LP", "pxLP", 18)
    {
        if (halfWidth_ < key_.tickSpacing || breakerTicks_ <= 0 || slippageBps_ > 2000) revert InvalidConfig();
        _key = key_;
        POOL_ID = PoolId.unwrap(key_.toId());
        HALF_WIDTH = halfWidth_;
        BREAKER_TICKS = breakerTicks_;
        MIN_CALM_SECONDS = minCalmSeconds_;
        SLIPPAGE_BPS = slippageBps_;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Depositors
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Deposit both pool tokens (approve first) and receive pxLP shares priced at the live pool price.
    ///         The first deposit opens the vault's position; later ones are added to it (or wait idle while
    ///         the vault is evacuated).
    function deposit(uint256 amount0, uint256 amount1) external nonReentrant returns (uint256 shares) {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmount();
        PoolKey memory key = _key;
        (uint160 sqrtP,,,) = POOL_MANAGER.getSlot0(key.toId());
        uint256 before = totalValue0();
        uint256 valueIn = amount0 + _toToken0(amount1, sqrtP);
        shares = totalSupply == 0 ? valueIn : FullMath.mulDiv(valueIn, totalSupply, before);
        if (shares == 0) revert ZeroShares();

        if (amount0 > 0) ERC20(Currency.unwrap(key.currency0)).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) ERC20(Currency.unwrap(key.currency1)).safeTransferFrom(msg.sender, address(this), amount1);
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, amount0, amount1, shares);

        if (mode == Mode.EMPTY) _openCentred(0);
        else if (mode == Mode.POSITIONED) _addHeldToPosition();
    }

    /// @notice Burn shares for your pro-rata slice of the position plus idle tokens.
    function withdraw(uint256 shares) external nonReentrant returns (uint256 out0, uint256 out1) {
        if (shares == 0) revert ZeroShares();
        PoolKey memory key = _key;
        uint256 supply = totalSupply;
        (uint256 b0, uint256 b1) = _balances(key, address(this));

        uint128 liquidity = mode == Mode.POSITIONED ? POSITION_MANAGER.getPositionLiquidity(positionId) : 0;
        if (liquidity > 0) _decrease(uint128(FullMath.mulDiv(liquidity, shares, supply)));
        (uint256 r0, uint256 r1) = _heldAbove(key, b0, b1); // what the partial decrease returned

        out0 = r0 + FullMath.mulDiv(b0, shares, supply);
        out1 = r1 + FullMath.mulDiv(b1, shares, supply);
        _burn(msg.sender, shares);
        if (totalSupply == 0) mode = Mode.EMPTY;

        if (out0 > 0) ERC20(Currency.unwrap(key.currency0)).safeTransfer(msg.sender, out0);
        if (out1 > 0) ERC20(Currency.unwrap(key.currency1)).safeTransfer(msg.sender, out1);
        emit Withdrawn(msg.sender, shares, out0, out1);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Reactive callbacks (Callback Proxy + our reactive contract only; re-validated on-chain)
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Price left the range → re-open the same width centred on the price.
    function rebalance(address reactiveSender, int24 /* observedTick */ )
        external
        nonReentrant
        onlyServiceProvider
        onlyCallbackSender(reactiveSender)
    {
        int24 tick = _tick(_key);
        if (mode != Mode.POSITIONED || (tick >= tickLower && tick < tickUpper)) {
            return _skip(Action.REBALANCE, SkipReason.NOT_NEEDED, tick);
        }
        _tryStep(Action.REBALANCE, tick);
    }

    /// @notice Fast move in progress → pull all liquidity out now. Verified: the price really moved at least
    ///         BREAKER_TICKS from where the liquidity was deployed.
    function evacuate(address reactiveSender, int24 /* observedTick */ )
        external
        nonReentrant
        onlyServiceProvider
        onlyCallbackSender(reactiveSender)
    {
        int24 tick = _tick(_key);
        int24 moved = tick > anchorTick ? tick - anchorTick : anchorTick - tick;
        if (mode != Mode.POSITIONED || moved < BREAKER_TICKS) return _skip(Action.EVACUATE, SkipReason.NOT_NEEDED, tick);
        _tryStep(Action.EVACUATE, tick);
    }

    /// @notice Calm again → re-open centred on the new price. Not before MIN_CALM_SECONDS after evacuating.
    function reenter(address reactiveSender, int24 /* observedTick */ )
        external
        nonReentrant
        onlyServiceProvider
        onlyCallbackSender(reactiveSender)
    {
        int24 tick = _tick(_key);
        if (mode != Mode.EVACUATED) return _skip(Action.REENTER, SkipReason.NOT_NEEDED, tick);
        if (block.timestamp < evacuatedAt + MIN_CALM_SECONDS) return _skip(Action.REENTER, SkipReason.TOO_EARLY, tick);
        _tryStep(Action.REENTER, tick);
    }

    /// @notice Internal step of a callback, run as an external self-call so it is atomic and try/caught.
    function vaultStep(Action action) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (action == Action.EVACUATE) {
            (uint256 b0, uint256 b1) = _balances(_key, address(this));
            _decrease(POSITION_MANAGER.getPositionLiquidity(positionId));
            (uint256 a0, uint256 a1) = _heldAbove(_key, b0, b1);
            mode = Mode.EVACUATED;
            evacuatedAt = uint64(block.timestamp);
            evacuations++;
            emit VaultEvacuated(_tick(_key), a0, a1);
            return;
        }
        if (action == Action.REBALANCE) {
            _decrease(POSITION_MANAGER.getPositionLiquidity(positionId));
            rebalances++;
            _openCentred(1);
            return;
        }
        reentries++;
        _openCentred(2);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Views
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Everything the vault holds, valued in currency0 at the live pool price (position + idle).
    function totalValue0() public view returns (uint256) {
        PoolKey memory key = _key;
        (uint160 sqrtP,,,) = POOL_MANAGER.getSlot0(key.toId());
        (uint256 p0, uint256 p1) = positionAmounts();
        (uint256 i0, uint256 i1) = _balances(key, address(this));
        return p0 + i0 + _toToken0(p1 + i1, sqrtP);
    }

    /// @notice Token amounts currently inside the position at the live price (excluding uncollected fees).
    function positionAmounts() public view returns (uint256 a0, uint256 a1) {
        if (mode != Mode.POSITIONED) return (0, 0);
        uint128 liquidity = POSITION_MANAGER.getPositionLiquidity(positionId);
        (uint160 sqrtP,,,) = POOL_MANAGER.getSlot0(_key.toId());
        uint160 sL = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sU = TickMath.getSqrtPriceAtTick(tickUpper);
        if (sqrtP <= sL) return (SqrtPriceMath.getAmount0Delta(sL, sU, liquidity, false), 0);
        if (sqrtP >= sU) return (0, SqrtPriceMath.getAmount1Delta(sL, sU, liquidity, false));
        return (
            SqrtPriceMath.getAmount0Delta(sqrtP, sU, liquidity, false),
            SqrtPriceMath.getAmount1Delta(sL, sqrtP, liquidity, false)
        );
    }

    /// @notice Is the vault's liquidity earning fees right now?
    function inRange() external view returns (bool) {
        int24 tick = _tick(_key);
        return mode == Mode.POSITIONED && tick >= tickLower && tick < tickUpper;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    /// @notice Settle callback debt from this contract's ETH balance (anyone may call).
    function coverDebt() external {
        _coverDebt();
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Internal
    // ════════════════════════════════════════════════════════════════════════

    function _tryStep(Action action, int24 tick) internal {
        try this.vaultStep(action) {}
        catch {
            _skip(action, SkipReason.ACTION_FAILED, tick);
        }
    }

    function _skip(Action action, SkipReason reason, int24 tick) internal {
        emit VaultSkipped(uint8(action), uint8(reason), tick);
    }

    /// @dev Swap held tokens to the ratio a range centred on the price needs, mint it, and record it.
    function _openCentred(uint8 reason) internal {
        PoolKey memory key = _key;
        (int24 tl, int24 tu) = _centredRange(0, 2 * HALF_WIDTH, _tick(key), key.tickSpacing);
        (bool zeroForOne, uint256 amountIn) = _rebalancePlan(key, tl, tu, 0, 0);
        if (amountIn > 0) _swapHeld(key, zeroForOne, amountIn, SLIPPAGE_BPS);
        positionId = _mintHeld(key, tl, tu, 0, 0);
        (tickLower, tickUpper, anchorTick, mode) = (tl, tu, _tick(key), Mode.POSITIONED);
        emit VaultPositioned(positionId, tl, tu, anchorTick, reason);
    }

    /// @dev New deposits while positioned: add what fits to the existing position; the rest stays idle.
    function _addHeldToPosition() internal {
        PoolKey memory key = _key;
        (uint256 h0, uint256 h1) = _balances(key, address(this));
        (uint160 sqrtP,,,) = POOL_MANAGER.getSlot0(key.toId());
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), h0, h1
        ) * 9_999 / 10_000;
        if (liquidity == 0) return;
        bytes memory actions = abi.encodePacked(uint8(Actions.INCREASE_LIQUIDITY), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(positionId, uint256(liquidity), uint128(h0), uint128(h1), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    /// @dev Remove `liquidity` from the position (plus all accrued fees) into this contract, with slippage
    ///      minimums from the live position amounts.
    function _decrease(uint128 liquidity) internal {
        if (liquidity == 0) return;
        uint128 total = POSITION_MANAGER.getPositionLiquidity(positionId);
        (uint256 p0, uint256 p1) = positionAmounts();
        uint256 keep = 10_000 - SLIPPAGE_BPS;
        uint128 min0 = uint128(FullMath.mulDiv(p0, uint256(liquidity) * keep, uint256(total) * 10_000));
        uint128 min1 = uint128(FullMath.mulDiv(p1, uint256(liquidity) * keep, uint256(total) * 10_000));
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(positionId, uint256(liquidity), min0, min1, bytes(""));
        params[1] = abi.encode(_key.currency0, _key.currency1, address(this));
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }
}
