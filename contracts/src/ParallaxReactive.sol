// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "reactive-lib-omni/base/AbstractReactive.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {ISystemContract} from "reactive-lib-omni/interfaces/ISystemContract.sol";

import {IParallaxExecutor} from "./interfaces/IParallaxExecutor.sol";
import {RuleType} from "./libraries/RuleTypes.sol";

/// @title ParallaxReactive
/// @notice Reactive-Network half of Parallax (deployed on Lasna). It keeps a live mirror of every active
///         rule by listening to the executor's events, watches each rule's Uniswap v4 pool for `Swap`
///         events, and the moment a swap moves the tick across a rule it requests a callback to the
///         executor. Pools are subscribed to on demand (from inside `react()`) when their first rule
///         appears and unsubscribed when their last rule is gone.
/// @dev Omni model: no RVM, no `vm` flag. `react()` is a normal tx called by the system contract
///      (`onlySystem`), and callbacks are requested via `SYSTEM.requestCallbackV_1_0`.
///      Never revert in `react()` to filter: reverts are still billed. Unknown logs fall through.
contract ParallaxReactive is AbstractReactive {
    // ── Errors ──────────────────────────────────────────────────────────────
    error NotOwner();
    error ExecutorAlreadySet();
    error ZeroAddress();

    // ── Events (on Reactive Network: these make the reactive tx readable in Reactscan) ──
    event ExecutorSet(address indexed executor);
    event PoolWatched(bytes32 indexed poolId);
    event PoolUnwatched(bytes32 indexed poolId);
    event RuleMirrored(uint256 indexed ruleId, bytes32 indexed poolId, int24 lowerTick, int24 upperTick);
    event RuleRemoved(uint256 indexed ruleId, bytes32 indexed poolId);
    event RuleRearmed(uint256 indexed ruleId);
    event MirrorFull(uint256 indexed ruleId, bytes32 indexed poolId);
    /// @notice A swap crossed the rule; a callback to the executor was requested in this tx.
    event RuleTriggered(uint256 indexed ruleId, bytes32 indexed poolId, int24 tick, uint256 originTxHash);

    // ── Protocol constants ──────────────────────────────────────────────────
    /// @dev Uniswap v4 `Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
    ///      uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`.
    ///      = 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f (verified with `cast sig-event`).
    uint256 public constant SWAP_TOPIC0 =
        uint256(keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
    /// @dev Executor events (enums encode as uint8). A unit test asserts these equal the
    ///      `IParallaxExecutor.<Event>.selector` values so the two contracts can never drift apart.
    uint256 public constant RULE_CREATED_TOPIC0 =
        uint256(keccak256("RuleCreated(uint256,address,bytes32,uint8,int24,int24,bool,uint128,uint256)"));
    uint256 public constant RULE_CANCELLED_TOPIC0 = uint256(keccak256("RuleCancelled(uint256,address)"));
    uint256 public constant RULE_EXECUTED_TOPIC0 =
        uint256(keccak256("RuleExecuted(uint256,address,int24,uint256,uint256,uint256,uint256)"));
    uint256 public constant RULE_SKIPPED_TOPIC0 = uint256(keccak256("RuleSkipped(uint256,uint8,int24,uint256)"));

    /// @notice Gas forwarded to `execute` on the destination (≥ 100k network minimum; swap ≈ 200–300k).
    uint64 public constant CALLBACK_GAS_LIMIT = 1_000_000;
    /// @notice Must match ParallaxExecutor.MAX_ACTIVE_RULES_PER_POOL so the mirror never overflows.
    uint256 public constant MAX_RULES_PER_POOL = 25;
    /// @notice Bound on callbacks requested per Swap. Extra triggered rules fire on the next swap.
    /// @dev Sized against the 900k reactive-tx gas cap: scanning 25 rules ≈ 160k, and each request is
    ///      ≤ ~190k even with a mock system contract that stores the whole payload (pessimistic).
    uint256 public constant MAX_CALLBACKS_PER_EVENT = 3;
    /// @notice If neither RuleExecuted nor RuleSkipped arrives within this many seconds of a trigger
    ///         (e.g. the callback was dropped), the rule becomes eligible to fire again. Timestamp-based.
    uint256 public constant PENDING_TIMEOUT = 120;

    // ── Config ──────────────────────────────────────────────────────────────
    uint256 public immutable ORIGIN_CHAIN_ID; //      chain of the v4 pool + executor events
    address public immutable POOL_MANAGER; //         v4 PoolManager on the origin chain
    uint256 public immutable DESTINATION_CHAIN_ID; // chain of the executor
    address public owner;
    address public executor;

    // ── Rule mirror ─────────────────────────────────────────────────────────
    /// @dev Fires when tick <= lowerTick || tick >= upperTick (same rule as the executor; one side may be
    ///      disabled with type(int24).min / type(int24).max). One struct covers stop-loss, take-profit,
    ///      brackets and LP range guards.
    struct MirrorRule {
        bytes32 poolId;
        int24 lowerTick;
        int24 upperTick;
        bool exists;
        uint64 pendingSince; // 0 = armed; otherwise block.timestamp of the callback request
        uint32 index; //        position in poolRules[poolId] (for O(1) removal)
    }

    mapping(uint256 ruleId => MirrorRule) public mirror;
    mapping(bytes32 poolId => uint256[]) internal _poolRules;

    /// @param originChainId_ Chain whose pool + executor we watch (Unichain Sepolia = 1301).
    /// @param poolManager_ Uniswap v4 PoolManager on that chain.
    /// @param destinationChainId_ Chain of the executor (same as origin for the core demo).
    constructor(uint256 originChainId_, address poolManager_, uint256 destinationChainId_) payable {
        if (poolManager_ == address(0)) revert ZeroAddress();
        ORIGIN_CHAIN_ID = originChainId_;
        POOL_MANAGER = poolManager_;
        DESTINATION_CHAIN_ID = destinationChainId_;
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Setup (deployment order: Reactive → Executor(proxy, this) → setExecutor)
    // ════════════════════════════════════════════════════════════════════════

    /// @notice One-time: point at the executor and subscribe to its rule lifecycle events.
    /// @dev Must happen after the executor is deployed because the executor stores our address immutably.
    function setExecutor(address executor_) external onlyOwner {
        if (executor != address(0)) revert ExecutorAlreadySet();
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;

        _subscribeExecutor(RULE_CREATED_TOPIC0);
        _subscribeExecutor(RULE_CANCELLED_TOPIC0);
        _subscribeExecutor(RULE_EXECUTED_TOPIC0);
        _subscribeExecutor(RULE_SKIPPED_TOPIC0);
        emit ExecutorSet(executor_);
    }

    /// @notice Settle any debt with the system contract from this contract's balance (anyone may call).
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice Recover unused lREACT (testnet convenience).
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        _pay(to, amount);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  react(): the entry point for every subscribed log
    // ════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IReactive
    function react(LogRecord memory log_) external onlySystem {
        if (log_.chainId != ORIGIN_CHAIN_ID) return;

        if (log_.contractAddress == POOL_MANAGER) {
            if (log_.topic0 == SWAP_TOPIC0 && log_.opCode == 3) _onSwap(log_);
            return;
        }
        if (log_.contractAddress != executor) return;

        uint256 t0 = log_.topic0;
        if (t0 == RULE_CREATED_TOPIC0 && log_.opCode == 4) {
            _onRuleCreated(log_);
        } else if (t0 == RULE_EXECUTED_TOPIC0 || t0 == RULE_CANCELLED_TOPIC0) {
            _removeRule(log_.topic1);
        } else if (t0 == RULE_SKIPPED_TOPIC0) {
            _rearm(log_.topic1);
        }
    }

    // ── Handlers ────────────────────────────────────────────────────────────

    function _onRuleCreated(LogRecord memory log_) internal {
        uint256 ruleId = log_.topic1;
        bytes32 poolId = bytes32(log_.topic3);
        if (mirror[ruleId].exists) return; // duplicate delivery

        // data = (ruleType, lowerTick, upperTick, zeroForOne, amountIn, positionId)
        (, int24 lowerTick, int24 upperTick,,,) =
            abi.decode(log_.data, (RuleType, int24, int24, bool, uint128, uint256));

        uint256[] storage list = _poolRules[poolId];
        if (list.length >= MAX_RULES_PER_POOL) {
            emit MirrorFull(ruleId, poolId); // unreachable while the executor enforces the same cap
            return;
        }
        if (list.length == 0) _watchPool(poolId); // first rule on this pool → start listening to it

        mirror[ruleId] = MirrorRule({
            poolId: poolId,
            lowerTick: lowerTick,
            upperTick: upperTick,
            exists: true,
            pendingSince: 0,
            index: uint32(list.length)
        });
        list.push(ruleId);
        emit RuleMirrored(ruleId, poolId, lowerTick, upperTick);
    }

    /// @dev Hot path: a swap happened in a watched pool. Check its (≤25) rules against the new tick.
    function _onSwap(LogRecord memory log_) internal {
        bytes32 poolId = bytes32(log_.topic1);
        uint256[] storage list = _poolRules[poolId];
        uint256 n = list.length;
        if (n == 0) return;

        // data = (int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
        (,,,, int24 tick,) = abi.decode(log_.data, (int128, int128, uint160, uint128, int24, uint24));

        uint256 fired;
        for (uint256 i; i < n && fired < MAX_CALLBACKS_PER_EVENT; ++i) {
            uint256 ruleId = list[i];
            MirrorRule storage m = mirror[ruleId];

            bool armed = m.pendingSince == 0 || block.timestamp >= m.pendingSince + PENDING_TIMEOUT;
            if (!armed) continue;
            if (tick > m.lowerTick && tick < m.upperTick) continue; // still inside the safe band

            m.pendingSince = uint64(block.timestamp); // de-dupe: one in-flight callback per rule
            _requestExecute(ruleId, tick, log_.txHash);
            emit RuleTriggered(ruleId, poolId, tick, log_.txHash);
            ++fired;
        }
    }

    function _rearm(uint256 ruleId) internal {
        MirrorRule storage m = mirror[ruleId];
        if (!m.exists || m.pendingSince == 0) return; // unknown or already armed (e.g. NOT_ACTIVE skips)
        m.pendingSince = 0;
        emit RuleRearmed(ruleId);
    }

    function _removeRule(uint256 ruleId) internal {
        MirrorRule storage m = mirror[ruleId];
        if (!m.exists) return;
        bytes32 poolId = m.poolId;
        uint256[] storage list = _poolRules[poolId];

        // Swap-and-pop removal, keeping the moved rule's index in sync.
        uint256 last = list[list.length - 1];
        list[m.index] = last;
        mirror[last].index = m.index;
        list.pop();
        delete mirror[ruleId];

        emit RuleRemoved(ruleId, poolId);
        if (list.length == 0) _unwatchPool(poolId); // last rule gone → stop paying for this pool's swaps
    }

    // ── Reactive Network calls ──────────────────────────────────────────────

    /// @dev The first payload argument is a placeholder: Reactive Network overwrites it with this
    ///      contract's address so the executor can authenticate the callback.
    function _requestExecute(uint256 ruleId, int24 tick, uint256 originTxHash) internal {
        bytes memory payload =
            abi.encodeCall(IParallaxExecutor.execute, (address(0), ruleId, tick, originTxHash));
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: DESTINATION_CHAIN_ID,
                recipient: executor,
                gasLimit: CALLBACK_GAS_LIMIT,
                payload: payload
            })
        );
    }

    function _subscribeExecutor(uint256 topic0) internal {
        SYSTEM.subscribe(ORIGIN_CHAIN_ID, executor, topic0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    /// @dev `_watchPool` / `_unwatchPool` must pass identical criteria or unsubscribe silently no-ops.
    function _watchPool(bytes32 poolId) internal {
        SYSTEM.subscribe(ORIGIN_CHAIN_ID, POOL_MANAGER, SWAP_TOPIC0, uint256(poolId), REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit PoolWatched(poolId);
    }

    function _unwatchPool(bytes32 poolId) internal {
        SYSTEM.unsubscribe(
            ORIGIN_CHAIN_ID, POOL_MANAGER, SWAP_TOPIC0, uint256(poolId), REACTIVE_IGNORE, REACTIVE_IGNORE
        );
        emit PoolUnwatched(poolId);
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function rulesOf(bytes32 poolId) external view returns (uint256[] memory) {
        return _poolRules[poolId];
    }
}
