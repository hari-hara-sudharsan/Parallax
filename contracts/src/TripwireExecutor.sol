// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "reactive-lib-omni/base/AbstractCallback.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solmate/src/utils/ReentrancyGuard.sol";

import {ITripwireExecutor} from "./interfaces/ITripwireExecutor.sol";
import {Rule, RuleType, RuleStatus, SkipReason} from "./libraries/RuleTypes.sol";

/// @title TripwireExecutor
/// @notice Destination-chain half of Tripwire. Users deposit tokens and register a price rule here;
///         when TripwireReactive (on Reactive Network) sees the pool tick cross the rule, it requests a
///         callback, and the Reactive Callback Proxy calls `execute`, which re-checks the price on-chain
///         and swaps the deposit through the Uniswap v4 PoolManager. No keeper, no server.
/// @dev Callback gas is billed to THIS contract in native ETH by the Callback Proxy, so keep it funded
///      (`receive()` + `coverDebt()`, or `CallbackProxy.depositTo(address(this))`).
contract TripwireExecutor is AbstractCallback, IUnlockCallback, ITripwireExecutor, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeTransferLib for ERC20;

    // ── Errors ──────────────────────────────────────────────────────────────
    error ZeroAmount();
    error NativeCurrencyNotSupported();
    error DynamicFeeNotSupported();
    error PoolNotInitialized();
    error UnsupportedRuleType(RuleType ruleType);
    error SlippageTooHigh(uint16 bps, uint16 maxBps);
    error SlippageTooLow(uint16 bps, uint16 minBps);
    error InvalidTick(int24 tick);
    error TriggerAlreadyHit(int24 currentTick, int24 triggerTick);
    error TooManyActiveRules(bytes32 poolId);
    error NotRuleOwner(uint256 ruleId);
    error RuleNotActive(uint256 ruleId);
    error NotPoolManager();
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);

    // ── Constants ───────────────────────────────────────────────────────────
    /// @notice Hard cap so the reactive contract's per-event loop stays bounded (it mirrors this cap).
    uint256 public constant MAX_ACTIVE_RULES_PER_POOL = 25;
    /// @notice Slippage bounds. The floor must cover the pool fee + some price impact or every swap fails.
    uint16 public constant MIN_SLIPPAGE_BPS = 50; //   0.5%
    uint16 public constant MAX_SLIPPAGE_BPS = 2000; // 20%

    uint256 private constant Q96 = 1 << 96;

    // ── State ───────────────────────────────────────────────────────────────
    IPoolManager public immutable POOL_MANAGER;

    uint256 public nextRuleId = 1;
    mapping(uint256 ruleId => Rule) public rules;
    mapping(bytes32 poolId => PoolKey) internal _poolKeys;
    mapping(bytes32 poolId => uint256) public activeRuleCount;

    /// @param callbackProxy_ Reactive Callback Proxy on this chain (Unichain Sepolia: 0x775c…66C1).
    /// @param reactive_ The TripwireReactive contract on Reactive Network allowed to drive callbacks.
    /// @param poolManager_ Uniswap v4 PoolManager on this chain.
    constructor(IPayable callbackProxy_, address reactive_, IPoolManager poolManager_)
        payable
        AbstractCallback(callbackProxy_, reactive_)
    {
        POOL_MANAGER = poolManager_;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  User actions
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Create a price rule. Pulls `amountIn` of the input token from the caller (approve first).
    /// @param key Uniswap v4 pool to watch and trade in (ERC20/ERC20, static fee).
    /// @param ruleType STOP_LOSS or TAKE_PROFIT (labels for the UI; trigger semantics come from triggerBelow).
    /// @param zeroForOne true = sell currency0 for currency1, false = sell currency1 for currency0.
    /// @param triggerTick Tick level that trips the rule.
    /// @param triggerBelow true = fire when tick <= triggerTick, false = fire when tick >= triggerTick.
    /// @param amountIn Amount of the input token to deposit and sell when triggered.
    /// @param maxSlippageBps Max shortfall vs. the spot price at execution (50–2000 bps).
    /// @return ruleId The new rule's id.
    function createRule(
        PoolKey calldata key,
        RuleType ruleType,
        bool zeroForOne,
        int24 triggerTick,
        bool triggerBelow,
        uint128 amountIn,
        uint16 maxSlippageBps
    ) external nonReentrant returns (uint256 ruleId) {
        // ── Checks
        if (ruleType == RuleType.RANGE_GUARD) revert UnsupportedRuleType(ruleType);
        if (amountIn == 0) revert ZeroAmount();
        if (key.currency0.isAddressZero()) revert NativeCurrencyNotSupported();
        if (LPFeeLibrary.isDynamicFee(key.fee)) revert DynamicFeeNotSupported();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(maxSlippageBps, MAX_SLIPPAGE_BPS);
        if (maxSlippageBps < MIN_SLIPPAGE_BPS) revert SlippageTooLow(maxSlippageBps, MIN_SLIPPAGE_BPS);
        if (triggerTick <= TickMath.MIN_TICK || triggerTick >= TickMath.MAX_TICK) revert InvalidTick(triggerTick);

        bytes32 poolId = PoolId.unwrap(key.toId());
        (uint160 sqrtPriceX96, int24 tick,,) = POOL_MANAGER.getSlot0(key.toId());
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        // Safety: a rule that would fire immediately is almost always a UI/direction mistake.
        if (_isTriggered(triggerBelow, triggerTick, tick)) revert TriggerAlreadyHit(tick, triggerTick);
        if (activeRuleCount[poolId] >= MAX_ACTIVE_RULES_PER_POOL) revert TooManyActiveRules(poolId);

        // ── Effects
        ruleId = nextRuleId++;
        rules[ruleId] = Rule({
            owner: msg.sender,
            ruleType: ruleType,
            status: RuleStatus.ACTIVE,
            zeroForOne: zeroForOne,
            triggerBelow: triggerBelow,
            triggerTick: triggerTick,
            maxSlippageBps: maxSlippageBps,
            amountIn: amountIn,
            poolId: poolId,
            createdAt: uint64(block.timestamp)
        });
        if (Currency.unwrap(_poolKeys[poolId].currency1) == address(0)) _poolKeys[poolId] = key;
        activeRuleCount[poolId]++;

        // ── Interactions
        ERC20(_inputToken(key, zeroForOne)).safeTransferFrom(msg.sender, address(this), amountIn);

        emit RuleCreated(ruleId, msg.sender, poolId, ruleType, triggerTick, triggerBelow, zeroForOne, amountIn);
    }

    /// @notice Cancel an active rule and get the deposit back.
    function cancelRule(uint256 ruleId) external nonReentrant {
        Rule storage r = rules[ruleId];
        if (r.owner != msg.sender) revert NotRuleOwner(ruleId);
        if (r.status != RuleStatus.ACTIVE) revert RuleNotActive(ruleId);

        r.status = RuleStatus.CANCELLED;
        activeRuleCount[r.poolId]--;

        ERC20(_inputToken(_poolKeys[r.poolId], r.zeroForOne)).safeTransfer(msg.sender, r.amountIn);
        emit RuleCancelled(ruleId, msg.sender);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Reactive callback
    // ════════════════════════════════════════════════════════════════════════

    /// @inheritdoc ITripwireExecutor
    /// @dev Guarded twice, as the Reactive docs require: `onlyServiceProvider` (msg.sender is the
    ///      Callback Proxy) AND `onlyCallbackSender` (the injected first argument is our reactive contract).
    ///      Benign failures do NOT revert; they emit RuleSkipped so the reactive contract can re-arm the
    ///      rule (a reverted callback is still billed and is invisible to the reactive side).
    function execute(address reactiveSender, uint256 ruleId, int24, /* observedTick: informational, we re-read */ uint256 originTxHash)
        external
        override
        onlyServiceProvider
        onlyCallbackSender(reactiveSender)
        nonReentrant
    {
        Rule storage r = rules[ruleId];
        PoolKey memory key = _poolKeys[r.poolId];
        (uint160 sqrtPriceX96, int24 tick,,) = POOL_MANAGER.getSlot0(key.toId());

        // 1. Idempotency: each rule executes at most once.
        if (r.status != RuleStatus.ACTIVE) {
            emit RuleSkipped(ruleId, SkipReason.NOT_ACTIVE, tick, originTxHash);
            return;
        }
        // 2. Re-validate on-chain. Never trust the callback blindly.
        if (!_isTriggered(r.triggerBelow, r.triggerTick, tick)) {
            emit RuleSkipped(ruleId, SkipReason.CONDITION_NOT_MET, tick, originTxHash);
            return;
        }

        // 3. Slippage floor from the live spot price (incl. pool fee).
        uint256 minOut = _quoteAtSpot(r.amountIn, sqrtPriceX96, r.zeroForOne, key.fee) * (10_000 - r.maxSlippageBps)
            / 10_000;

        // 4. Effects before the external call (checks-effects-interactions), undone if the swap fails.
        r.status = RuleStatus.EXECUTED;
        activeRuleCount[r.poolId]--;

        if (!_swapAndReport(ruleId, r, key, minOut, originTxHash)) {
            r.status = RuleStatus.ACTIVE;
            activeRuleCount[r.poolId]++;
            emit RuleSkipped(ruleId, SkipReason.SWAP_FAILED, tick, originTxHash);
        }
    }

    /// @dev Runs the v4 swap via unlock(). Returns false (instead of reverting) if the swap fails,
    ///      e.g. the slippage floor was not met.
    function _swapAndReport(uint256 ruleId, Rule storage r, PoolKey memory key, uint256 minOut, uint256 originTxHash)
        internal
        returns (bool ok)
    {
        try POOL_MANAGER.unlock(abi.encode(key, r.zeroForOne, r.amountIn, minOut, r.owner)) returns (
            bytes memory result
        ) {
            (uint256 amountInPaid, uint256 amountOut) = abi.decode(result, (uint256, uint256));
            (, int24 tickAfter,,) = POOL_MANAGER.getSlot0(key.toId());
            emit RuleExecuted(ruleId, r.owner, tickAfter, amountInPaid, amountOut, originTxHash, block.timestamp);
            return true;
        } catch {
            return false;
        }
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
        (int128 inDelta, int128 outDelta) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 amountInPaid = uint256(uint128(-inDelta));
        uint256 amountOut = uint256(uint128(outDelta));
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);

        (Currency currencyIn, Currency currencyOut) =
            zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);

        // Pay what we owe: sync → transfer → settle.
        POOL_MANAGER.sync(currencyIn);
        ERC20(Currency.unwrap(currencyIn)).safeTransfer(address(POOL_MANAGER), amountInPaid);
        POOL_MANAGER.settle();
        // Collect the proceeds straight to the rule owner.
        POOL_MANAGER.take(currencyOut, recipient, amountOut);

        // If the pool ran out of liquidity before the full amount was sold, refund the remainder.
        if (amountInPaid < amountIn) {
            ERC20(Currency.unwrap(currencyIn)).safeTransfer(recipient, amountIn - amountInPaid);
        }
        return abi.encode(amountInPaid, amountOut);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Funding (callback gas)
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Settle any callback debt with the Callback Proxy from this contract's ETH balance.
    /// @dev Open to anyone: funding + restarting the service should never need an admin.
    function coverDebt() external {
        _coverDebt();
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Views
    // ════════════════════════════════════════════════════════════════════════

    function getRule(uint256 ruleId) external view returns (Rule memory) {
        return rules[ruleId];
    }

    function poolKeyOf(bytes32 poolId) external view returns (PoolKey memory) {
        return _poolKeys[poolId];
    }

    /// @notice Would this rule fire at the pool's current tick?
    function isTriggered(uint256 ruleId) external view returns (bool) {
        Rule storage r = rules[ruleId];
        (, int24 tick,,) = POOL_MANAGER.getSlot0(_poolKeys[r.poolId].toId());
        return r.status == RuleStatus.ACTIVE && _isTriggered(r.triggerBelow, r.triggerTick, tick);
    }

    // ── Internal ────────────────────────────────────────────────────────────

    function _isTriggered(bool triggerBelow, int24 triggerTick, int24 tick) internal pure returns (bool) {
        return triggerBelow ? tick <= triggerTick : tick >= triggerTick;
    }

    function _inputToken(PoolKey memory key, bool zeroForOne) internal pure returns (address) {
        return Currency.unwrap(zeroForOne ? key.currency0 : key.currency1);
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
