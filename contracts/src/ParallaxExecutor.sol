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
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC721} from "forge-std/interfaces/IERC721.sol";

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solmate/src/utils/ReentrancyGuard.sol";

import {IParallaxExecutor} from "./interfaces/IParallaxExecutor.sol";
import {PoolMath} from "./libraries/PoolMath.sol";
import {Rule, RuleType, RuleStatus, SkipReason, Origin, Execution, NO_LOWER, NO_UPPER} from "./libraries/RuleTypes.sol";

/// @title ParallaxExecutor
/// @notice Destination-chain half of Parallax. Users register protection rules here:
///         • STOP_LOSS / TAKE_PROFIT: deposit tokens; when the price crosses, they are swapped.
///         • RANGE_GUARD: hand over a Uniswap v4 LP position; when the price leaves its range (the position
///           stops earning fees), the liquidity + fees are withdrawn back to the owner.
///         ParallaxReactive (on Reactive Network) watches the pool and, the moment a swap crosses a rule,
///         requests a callback; the Reactive Callback Proxy then calls `execute`, which re-checks the price
///         on-chain before acting. No keeper, no server.
/// @dev Callback gas is billed to THIS contract in native ETH by the Callback Proxy, so keep it funded
///      (`receive()` + `coverDebt()`, or `CallbackProxy.depositTo(address(this))`).
contract ParallaxExecutor is AbstractCallback, IUnlockCallback, IParallaxExecutor, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using PositionInfoLibrary for PositionInfo;
    using SafeTransferLib for ERC20;

    // ── Errors ──────────────────────────────────────────────────────────────
    error ZeroAmount();
    error NativeCurrencyNotSupported();
    error DynamicFeeNotSupported();
    error PoolNotInitialized();
    error UnsupportedRuleType(RuleType ruleType);
    error SlippageTooHigh(uint16 bps, uint16 maxBps);
    error SlippageTooLow(uint16 bps, uint16 minBps);
    error InvalidBounds(int24 lowerTick, int24 upperTick);
    error TriggerAlreadyHit(int24 currentTick);
    error TooManyActiveRules(bytes32 poolId);
    error NotRuleOwner(uint256 ruleId);
    error RuleNotActive(uint256 ruleId);
    error NotPositionOwner(uint256 positionId);
    error EmptyPosition(uint256 positionId);
    error NotPoolManager();
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error InvalidTrail(int24 trailTicks);
    error NotSelf();

    // ── Constants ───────────────────────────────────────────────────────────
    /// @notice Hard cap so the reactive contract's per-event loop stays bounded (it mirrors this cap).
    uint256 public constant MAX_ACTIVE_RULES_PER_POOL = 25;
    /// @notice Slippage bounds. The floor must cover the pool fee + some price impact or every swap fails.
    uint16 public constant MIN_SLIPPAGE_BPS = 50; //   0.5%
    uint16 public constant MAX_SLIPPAGE_BPS = 2000; // 20%

    uint256 private constant Q96 = 1 << 96;

    /// @notice Trailing distance bounds (1 tick ≈ 1 bp): 0.1% … 50%.
    int24 public constant MIN_TRAIL_TICKS = 10;
    int24 public constant MAX_TRAIL_TICKS = 5000;
    /// @dev Canonical Permit2 (same address on every chain); PositionManager pulls tokens through it.
    IAllowanceTransfer internal constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    // ── State ───────────────────────────────────────────────────────────────
    IPoolManager public immutable POOL_MANAGER;
    IPositionManager public immutable POSITION_MANAGER;

    uint256 public nextRuleId = 1;
    mapping(uint256 ruleId => Rule) public rules;
    /// @notice Proof of each execution, readable without an indexer.
    mapping(uint256 ruleId => Execution) public executions;
    mapping(bytes32 poolId => PoolKey) internal _poolKeys;
    mapping(bytes32 poolId => uint256) public activeRuleCount;
    /// @dev Tokens already approved ERC20 → Permit2 → PositionManager (for re-centred mints).
    mapping(address token => bool) internal _permit2Ready;

    /// @param callbackProxy_ Reactive Callback Proxy on this chain (Unichain Sepolia: 0x775c…66C1).
    /// @param reactive_ The ParallaxReactive contract on Reactive Network allowed to drive callbacks.
    /// @param poolManager_ Uniswap v4 PoolManager on this chain.
    /// @param positionManager_ Uniswap v4 PositionManager on this chain (LP NFTs for RANGE_GUARD).
    constructor(IPayable callbackProxy_, address reactive_, IPoolManager poolManager_, IPositionManager positionManager_)
        payable
        AbstractCallback(callbackProxy_, reactive_)
    {
        POOL_MANAGER = poolManager_;
        POSITION_MANAGER = positionManager_;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  User actions
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Create a swap rule (stop-loss, take-profit, or both as a bracket). Pulls `amountIn` of the
    ///         input token from the caller (approve first).
    /// @param key Uniswap v4 pool to watch and trade in (ERC20/ERC20, static fee).
    /// @param ruleType STOP_LOSS or TAKE_PROFIT (UI label; when it fires is decided by the bounds).
    /// @param zeroForOne true = sell currency0 for currency1, false = sell currency1 for currency0.
    /// @param lowerTick Fire when tick <= lowerTick (NO_LOWER = no lower bound).
    /// @param upperTick Fire when tick >= upperTick (NO_UPPER = no upper bound).
    /// @param amountIn Amount of the input token to deposit and sell when triggered.
    /// @param maxSlippageBps Max shortfall vs. the spot price at execution (50–2000 bps).
    /// @return ruleId The new rule's id.
    function createRule(
        PoolKey calldata key,
        RuleType ruleType,
        bool zeroForOne,
        int24 lowerTick,
        int24 upperTick,
        uint128 amountIn,
        uint16 maxSlippageBps
    ) external nonReentrant returns (uint256 ruleId) {
        // ── Checks
        if (ruleType == RuleType.RANGE_GUARD || ruleType == RuleType.TRAILING_STOP) revert UnsupportedRuleType(ruleType);
        if (amountIn == 0) revert ZeroAmount();
        _checkBounds(lowerTick, upperTick);
        _checkSlippage(maxSlippageBps);
        bytes32 poolId = _checkPoolAndBounds(key, lowerTick, upperTick);

        // ── Effects
        ruleId = _storeRule(
            key,
            Rule({
                owner: msg.sender,
                ruleType: ruleType,
                status: RuleStatus.ACTIVE,
                zeroForOne: zeroForOne,
                lowerTick: lowerTick,
                upperTick: upperTick,
                maxSlippageBps: maxSlippageBps,
                amountIn: amountIn,
                createdAt: uint64(block.timestamp),
                trailTicks: 0,
                recenter: false,
                poolId: poolId,
                positionId: 0
            })
        );

        // ── Interactions
        ERC20(_inputToken(key, zeroForOne)).safeTransferFrom(msg.sender, address(this), amountIn);
        emit RuleCreated(ruleId, msg.sender, poolId, ruleType, lowerTick, upperTick, zeroForOne, amountIn, 0, 0);
    }

    /// @notice Create a trailing stop: sell when the price falls `trailTicks` (≈ bps) behind the best price
    ///         seen since creation. The stop starts at (current tick ∓ trailTicks) and only ever tightens:
    ///         ParallaxReactive asks for raises as the price improves and this contract verifies each one
    ///         against the live tick (see `raiseTrail`).
    /// @param stopBelow true = the stop sits below the tick (protects a position whose value rises with the
    ///        tick); false = above (the price axis is inverted when your token is currency1).
    function createTrailingStop(
        PoolKey calldata key,
        bool zeroForOne,
        bool stopBelow,
        int24 trailTicks,
        uint128 amountIn,
        uint16 maxSlippageBps
    ) external nonReentrant returns (uint256 ruleId) {
        if (amountIn == 0) revert ZeroAmount();
        if (trailTicks < MIN_TRAIL_TICKS || trailTicks > MAX_TRAIL_TICKS) revert InvalidTrail(trailTicks);
        _checkSlippage(maxSlippageBps);
        (, int24 tick,,) = POOL_MANAGER.getSlot0(key.toId());
        Rule memory r = Rule({
            owner: msg.sender,
            ruleType: RuleType.TRAILING_STOP,
            status: RuleStatus.ACTIVE,
            zeroForOne: zeroForOne,
            lowerTick: stopBelow ? tick - trailTicks : NO_LOWER,
            upperTick: stopBelow ? NO_UPPER : tick + trailTicks,
            maxSlippageBps: maxSlippageBps,
            amountIn: amountIn,
            createdAt: uint64(block.timestamp),
            trailTicks: trailTicks,
            recenter: false,
            poolId: bytes32(0),
            positionId: 0
        });
        r.poolId = _checkPoolAndBounds(key, r.lowerTick, r.upperTick);
        ruleId = _storeRule(key, r);

        ERC20(_inputToken(key, zeroForOne)).safeTransferFrom(msg.sender, address(this), amountIn);
        emit RuleCreated(
            ruleId, msg.sender, r.poolId, RuleType.TRAILING_STOP, r.lowerTick, r.upperTick, zeroForOne, amountIn, 0, trailTicks
        );
    }

    /// @notice Guard a Uniswap v4 LP position: when the pool price leaves the position's range, withdraw
    ///         all liquidity + fees to you. Approve this contract on the PositionManager NFT first.
    /// @param positionId PositionManager token id (must be yours and currently in range).
    /// @param maxSlippageBps Max shortfall vs. the exact out-of-range amounts (50–2000 bps).
    /// @return ruleId The new rule's id.
    /// @param recenter false = withdraw everything to you when out of range; true = re-open the liquidity as
    ///        a new position of the same width centred on the current price, and keep guarding it.
    function createRangeGuard(uint256 positionId, uint16 maxSlippageBps, bool recenter)
        external
        nonReentrant
        returns (uint256 ruleId)
    {
        // ── Checks
        if (_nft().ownerOf(positionId) != msg.sender) revert NotPositionOwner(positionId);
        if (POSITION_MANAGER.getPositionLiquidity(positionId) == 0) revert EmptyPosition(positionId);
        _checkSlippage(maxSlippageBps);
        (PoolKey memory key, PositionInfo info) = POSITION_MANAGER.getPoolAndPositionInfo(positionId);
        // In range ⇔ tickLower <= tick < tickUpper. So "left the range" ⇔ tick <= tickLower-1 || tick >= tickUpper.
        Rule memory r = Rule({
            owner: msg.sender,
            ruleType: RuleType.RANGE_GUARD,
            status: RuleStatus.ACTIVE,
            zeroForOne: false,
            lowerTick: info.tickLower() - 1,
            upperTick: info.tickUpper(),
            maxSlippageBps: maxSlippageBps,
            amountIn: 0,
            createdAt: uint64(block.timestamp),
            trailTicks: 0,
            recenter: recenter,
            poolId: bytes32(0),
            positionId: positionId
        });
        r.poolId = _checkPoolAndBounds(key, r.lowerTick, r.upperTick);

        // ── Effects
        ruleId = _storeRule(key, r);

        // ── Interactions: take custody of the position NFT.
        _nft().transferFrom(msg.sender, address(this), positionId);
        _emitCreated(ruleId, r);
    }

    /// @notice Cancel an active rule and get the deposit (or LP position) back.
    function cancelRule(uint256 ruleId) external nonReentrant {
        Rule storage r = rules[ruleId];
        if (r.owner != msg.sender) revert NotRuleOwner(ruleId);
        if (r.status != RuleStatus.ACTIVE) revert RuleNotActive(ruleId);

        r.status = RuleStatus.CANCELLED;
        activeRuleCount[r.poolId]--;

        if (r.ruleType == RuleType.RANGE_GUARD) {
            _nft().transferFrom(address(this), msg.sender, r.positionId);
        } else {
            ERC20(_inputToken(_poolKeys[r.poolId], r.zeroForOne)).safeTransfer(msg.sender, r.amountIn);
        }
        emit RuleCancelled(ruleId, msg.sender);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Reactive callback
    // ════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IParallaxExecutor
    /// @dev Guarded twice, as the Reactive docs require: `onlyServiceProvider` (msg.sender is the
    ///      Callback Proxy) AND `onlyCallbackSender` (the injected first argument is our reactive contract).
    ///      Benign failures do NOT revert; they emit RuleSkipped so the reactive contract can re-arm the
    ///      rule (a reverted callback is still billed and is invisible to the reactive side).
    function execute(
        address reactiveSender,
        uint256 ruleId,
        int24, /* observedTick: informational, we always re-read the tick ourselves */
        uint256 originTxHash,
        uint256 originBlock
    ) external override onlyServiceProvider onlyCallbackSender(reactiveSender) nonReentrant {
        Origin memory origin = Origin(originTxHash, originBlock);
        Rule storage r = rules[ruleId];
        PoolKey memory key = _poolKeys[r.poolId];
        (uint160 sqrtPriceX96, int24 tick,,) = POOL_MANAGER.getSlot0(key.toId());

        // 1. Idempotency: each rule executes at most once.
        if (r.status != RuleStatus.ACTIVE) {
            emit RuleSkipped(ruleId, SkipReason.NOT_ACTIVE, tick, originTxHash);
            return;
        }
        // 2. Re-validate on-chain. Never trust the callback blindly.
        if (!_isTriggered(r.lowerTick, r.upperTick, tick)) {
            emit RuleSkipped(ruleId, SkipReason.CONDITION_NOT_MET, tick, originTxHash);
            return;
        }

        // 3. Effects before the external calls (checks-effects-interactions), undone if the action fails.
        r.status = RuleStatus.EXECUTED;
        activeRuleCount[r.poolId]--;

        bool ok;
        if (r.ruleType != RuleType.RANGE_GUARD) ok = _swapAndReport(ruleId, r, key, sqrtPriceX96, origin);
        else if (r.recenter) ok = _recenterAndReport(ruleId, r, key, tick, origin);
        else ok = _withdrawAndReport(ruleId, r, key, tick, origin);

        if (!ok) {
            r.status = RuleStatus.ACTIVE;
            activeRuleCount[r.poolId]++;
            emit RuleSkipped(ruleId, SkipReason.ACTION_FAILED, tick, originTxHash);
        }
    }

    /// @inheritdoc IParallaxExecutor
    /// @dev Same double guard as `execute`. The new bound is computed from the LIVE tick read here, so a
    ///      raise request can only ever tighten the stop to what the current price justifies.
    function raiseTrail(address reactiveSender, uint256 ruleId, int24 /* observedTick */ )
        external
        override
        onlyServiceProvider
        onlyCallbackSender(reactiveSender)
        nonReentrant
    {
        Rule storage r = rules[ruleId];
        if (r.status != RuleStatus.ACTIVE || r.trailTicks == 0) return;
        int24 tick = _tick(_poolKeys[r.poolId]);
        if (r.lowerTick != NO_LOWER) {
            int24 candidate = tick - r.trailTicks;
            if (candidate > r.lowerTick) r.lowerTick = candidate;
        } else {
            int24 candidate = tick + r.trailTicks;
            if (candidate < r.upperTick) r.upperTick = candidate;
        }
        emit RuleUpdated(ruleId, r.lowerTick, r.upperTick);
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
        POOL_MANAGER.settle();
        // Collect the proceeds straight to the rule owner.
        POOL_MANAGER.take(currencyOut, recipient, amountOut);

        // If the pool ran out of liquidity before the full amount was sold, refund the remainder.
        uint256 refund = amountIn - amountInPaid;
        if (refund > 0) ERC20(Currency.unwrap(currencyIn)).safeTransfer(recipient, refund);
        return abi.encode(refund, amountOut);
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
        return r.status == RuleStatus.ACTIVE && _isTriggered(r.lowerTick, r.upperTick, tick);
    }

    /// @notice Lets PositionManager `safeTransferFrom` positions to us (we use plain transferFrom ourselves).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Internal: actions
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Swap rule: sells the deposit via unlock(). Returns false (instead of reverting) if the swap
    ///      fails, e.g. the slippage floor was not met.
    function _swapAndReport(uint256 ruleId, Rule storage r, PoolKey memory key, uint160 sqrtPriceX96, Origin memory origin)
        internal
        returns (bool)
    {
        // Slippage floor from the live spot price (incl. pool fee).
        uint256 minOut =
            _quoteAtSpot(r.amountIn, sqrtPriceX96, r.zeroForOne, key.fee) * (10_000 - r.maxSlippageBps) / 10_000;

        try POOL_MANAGER.unlock(abi.encode(key, r.zeroForOne, r.amountIn, minOut, r.owner)) returns (
            bytes memory result
        ) {
            (uint256 refund, uint256 amountOut) = abi.decode(result, (uint256, uint256));
            (uint256 out0, uint256 out1) = r.zeroForOne ? (refund, amountOut) : (amountOut, refund);
            _recordExecution(ruleId, r.owner, key, out0, out1, origin);
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Range guard: withdraw all liquidity + fees to the owner through the PositionManager, then hand
    ///      the (now empty) NFT back. Out of range the position holds a single token, so the expected
    ///      amount is exact and the slippage floor is tight.
    function _withdrawAndReport(uint256 ruleId, Rule storage r, PoolKey memory key, int24 tick, Origin memory origin)
        internal
        returns (bool)
    {
        address owner_ = r.owner;
        (uint256 bal0, uint256 bal1) = _balances(key, owner_);
        try POSITION_MANAGER.modifyLiquidities(_withdrawCalldata(r, key, tick, owner_), block.timestamp) {
            _nft().transferFrom(address(this), owner_, r.positionId); // hand back the now-empty NFT
            (uint256 now0, uint256 now1) = _balances(key, owner_);
            _recordExecution(ruleId, owner_, key, now0 - bal0, now1 - bal1, origin);
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Stores the proof of execution and emits RuleExecuted (T1 = block.timestamp).
    function _recordExecution(
        uint256 ruleId,
        address owner_,
        PoolKey memory key,
        uint256 amount0Out,
        uint256 amount1Out,
        Origin memory origin
    ) internal {
        executions[ruleId] = Execution({
            originTxHash: origin.txHash,
            originBlock: uint64(origin.blockNumber),
            executedBlock: uint64(block.number),
            executedAt: uint64(block.timestamp)
        });
        emit RuleExecuted(
            ruleId, owner_, _tick(key), amount0Out, amount1Out, origin.txHash, origin.blockNumber, block.timestamp
        );
    }

    /// @dev PositionManager action list: DECREASE_LIQUIDITY (all of it, with slippage minimums), then
    ///      TAKE_PAIR to send both tokens (principal + accrued fees) straight to the owner.
    function _withdrawCalldata(Rule storage r, PoolKey memory key, int24 tick, address recipient)
        internal
        view
        returns (bytes memory)
    {
        (uint128 min0, uint128 min1) = _withdrawMinimums(r, tick);
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            r.positionId, uint256(POSITION_MANAGER.getPositionLiquidity(r.positionId)), min0, min1, bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1, recipient);
        return abi.encode(actions, params);
    }

    function _balances(PoolKey memory key, address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = ERC20(Currency.unwrap(key.currency0)).balanceOf(who);
        b1 = ERC20(Currency.unwrap(key.currency1)).balanceOf(who);
    }

    /// @dev Below the range the position is 100% currency0, above it 100% currency1 (exact v4 math).
    function _withdrawMinimums(Rule storage r, int24 tick) internal view returns (uint128 min0, uint128 min1) {
        uint128 liquidity = POSITION_MANAGER.getPositionLiquidity(r.positionId);
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(r.lowerTick + 1); // = position tickLower
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(r.upperTick); //     = position tickUpper
        uint256 keep = 10_000 - r.maxSlippageBps;
        if (tick <= r.lowerTick) {
            min0 = uint128(SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, false) * keep / 10_000);
        } else {
            min1 = uint128(SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, liquidity, false) * keep / 10_000);
        }
    }


    // ════════════════════════════════════════════════════════════════════════
    //  Internal: range guard with re-centring
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Runs the whole re-centre atomically through an external self-call so any failure (slippage,
    ///      mint) reverts every step and the rule simply stays armed.
    function _recenterAndReport(uint256 ruleId, Rule storage r, PoolKey memory key, int24 tick, Origin memory origin)
        internal
        returns (bool)
    {
        try this.recenterSelf(ruleId, key, tick) returns (
            uint256 newRuleId, uint256 newPositionId, int24 tl, int24 tu, uint256 refund0, uint256 refund1
        ) {
            _recordExecution(ruleId, r.owner, key, refund0, refund1, origin);
            emit RuleRecentered(ruleId, newRuleId, newPositionId, tl, tu);
            return true;
        } catch {
            return false;
        }
    }

    /// @notice Internal step of a re-centring range guard. Only callable by this contract.
    /// @dev 1. pull all liquidity + fees here and hand the empty NFT back to the owner;
    ///      2. pick a new range of the same width centred on the current tick;
    ///      3. swap to the token ratio that range needs and mint it (held by this contract);
    ///      4. refund whatever did not fit; 5. guard the new position with a new rule.
    ///      Balances are measured against a baseline taken first, so other users' deposits are never touched.
    function recenterSelf(uint256 ruleId, PoolKey memory key, int24 tick)
        external
        returns (uint256 newRuleId, uint256 newPositionId, int24 tl, int24 tu, uint256 refund0, uint256 refund1)
    {
        if (msg.sender != address(this)) revert NotSelf();
        Rule storage r = rules[ruleId];
        (uint256 b0, uint256 b1) = _balances(key, address(this));

        POSITION_MANAGER.modifyLiquidities(_withdrawCalldata(r, key, tick, address(this)), block.timestamp);
        _nft().transferFrom(address(this), r.owner, r.positionId);

        (tl, tu) = _centredRange(r.lowerTick + 1, r.upperTick, tick, key.tickSpacing);
        (bool zeroForOne, uint256 amountIn) = _rebalancePlan(key, tl, tu, b0, b1);
        if (amountIn > 0) _swapHeld(key, zeroForOne, amountIn, r.maxSlippageBps);
        newPositionId = _mintHeld(key, tl, tu, b0, b1);
        (refund0, refund1) = _refundAbove(key, b0, b1, r.owner);

        Rule memory next = Rule({
            owner: r.owner,
            ruleType: RuleType.RANGE_GUARD,
            status: RuleStatus.ACTIVE,
            zeroForOne: false,
            lowerTick: tl - 1,
            upperTick: tu,
            maxSlippageBps: r.maxSlippageBps,
            amountIn: 0,
            createdAt: uint64(block.timestamp),
            trailTicks: 0,
            recenter: true,
            poolId: r.poolId,
            positionId: newPositionId
        });
        newRuleId = _storeRule(key, next);
        _emitCreated(newRuleId, next);
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

    function _refundAbove(PoolKey memory key, uint256 b0, uint256 b1, address to)
        internal
        returns (uint256 r0, uint256 r1)
    {
        (r0, r1) = _heldAbove(key, b0, b1);
        if (r0 > 0) ERC20(Currency.unwrap(key.currency0)).safeTransfer(to, r0);
        if (r1 > 0) ERC20(Currency.unwrap(key.currency1)).safeTransfer(to, r1);
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

    function _emitCreated(uint256 ruleId, Rule memory r) internal {
        emit RuleCreated(
            ruleId,
            r.owner,
            r.poolId,
            r.ruleType,
            r.lowerTick,
            r.upperTick,
            r.zeroForOne,
            r.amountIn,
            r.positionId,
            r.trailTicks
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Internal: validation + helpers
    // ════════════════════════════════════════════════════════════════════════

    function _storeRule(PoolKey memory key, Rule memory r) internal returns (uint256 ruleId) {
        if (activeRuleCount[r.poolId] >= MAX_ACTIVE_RULES_PER_POOL) revert TooManyActiveRules(r.poolId);
        ruleId = nextRuleId++;
        rules[ruleId] = r;
        if (Currency.unwrap(_poolKeys[r.poolId].currency1) == address(0)) _poolKeys[r.poolId] = key;
        activeRuleCount[r.poolId]++;
    }

    /// @dev Pool must be a live ERC20/ERC20 static-fee pool, and the rule must not fire immediately
    ///      (an instant trigger is almost always a UI / direction mistake).
    function _checkPoolAndBounds(PoolKey memory key, int24 lowerTick, int24 upperTick)
        internal
        view
        returns (bytes32 poolId)
    {
        if (key.currency0.isAddressZero()) revert NativeCurrencyNotSupported();
        if (LPFeeLibrary.isDynamicFee(key.fee)) revert DynamicFeeNotSupported();
        (uint160 sqrtPriceX96, int24 tick,,) = POOL_MANAGER.getSlot0(key.toId());
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        if (_isTriggered(lowerTick, upperTick, tick)) revert TriggerAlreadyHit(tick);
        poolId = PoolId.unwrap(key.toId());
    }

    function _checkBounds(int24 lowerTick, int24 upperTick) internal pure {
        bool hasLower = lowerTick != NO_LOWER;
        bool hasUpper = upperTick != NO_UPPER;
        if (!hasLower && !hasUpper) revert InvalidBounds(lowerTick, upperTick);
        if (hasLower && (lowerTick <= TickMath.MIN_TICK || lowerTick >= TickMath.MAX_TICK)) {
            revert InvalidBounds(lowerTick, upperTick);
        }
        if (hasUpper && (upperTick <= TickMath.MIN_TICK || upperTick >= TickMath.MAX_TICK)) {
            revert InvalidBounds(lowerTick, upperTick);
        }
        if (lowerTick >= upperTick) revert InvalidBounds(lowerTick, upperTick);
    }

    function _checkSlippage(uint16 bps) internal pure {
        if (bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(bps, MAX_SLIPPAGE_BPS);
        if (bps < MIN_SLIPPAGE_BPS) revert SlippageTooLow(bps, MIN_SLIPPAGE_BPS);
    }

    function _isTriggered(int24 lowerTick, int24 upperTick, int24 tick) internal pure returns (bool) {
        return tick <= lowerTick || tick >= upperTick;
    }

    /// @dev PositionManager is an ERC-721 (LP NFTs); IPositionManager itself doesn't declare those functions.
    function _nft() internal view returns (IERC721) {
        return IERC721(address(POSITION_MANAGER));
    }

    function _tick(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = POOL_MANAGER.getSlot0(key.toId());
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
