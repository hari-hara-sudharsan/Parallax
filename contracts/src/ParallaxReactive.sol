// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "reactive-lib-omni/base/AbstractReactive.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {ISystemContract} from "reactive-lib-omni/interfaces/ISystemContract.sol";

import {IParallaxExecutor} from "./interfaces/IParallaxExecutor.sol";
import {RuleType} from "./libraries/RuleTypes.sol";

/// @title ParallaxReactive
/// @notice Reactive-Network half of Parallax (deployed on Lasna). ONE contract guards rules on SEVERAL
///         chains (Unichain Sepolia and Base Sepolia today): for each registered chain it mirrors every
///         active rule from that chain's executor events, watches each rule's Uniswap v4 pool for `Swap`
///         events, and the moment a swap moves the tick across a rule it requests a callback to the
///         executor on that same chain. Pools are subscribed to on demand (from inside `react()`) when
///         their first rule appears and unsubscribed when their last rule is gone.
/// @dev Omni model: no RVM, no `vm` flag. `react()` is a normal tx called by the system contract
///      (`onlySystem`), and callbacks are requested via `SYSTEM.requestCallbackV_1_0`.
///      Never revert in `react()` to filter: reverts are still billed. Unknown logs fall through.
///      Each executor re-validates the price on its own chain, which is why a rule's callback always
///      goes back to the chain whose pool tripped it.
contract ParallaxReactive is AbstractReactive {
    // ── Errors ──────────────────────────────────────────────────────────────
    error NotOwner();
    error ChainAlreadyAdded(uint256 chainId);
    error ZeroAddress();

    // ── Events (on Reactive Network: these make each reactive tx readable in Reactscan) ──
    event ChainAdded(uint256 indexed chainId, address poolManager, address executor);
    event PoolWatched(uint256 indexed chainId, bytes32 indexed poolId);
    event PoolUnwatched(uint256 indexed chainId, bytes32 indexed poolId);
    event RuleMirrored(
        uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId, int24 lowerTick, int24 upperTick
    );
    event RuleRemoved(uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId);
    event RuleRearmed(uint256 indexed chainId, uint256 indexed ruleId);
    event MirrorFull(uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId);
    /// @notice A trailing stop has room to tighten; a raiseTrail callback was requested in this tx.
    event TrailRaiseRequested(uint256 indexed chainId, uint256 indexed ruleId, int24 tick);
    /// @notice The executor moved a trailing stop (or confirmed it unchanged); the mirror follows.
    event MirrorUpdated(uint256 indexed chainId, uint256 indexed ruleId, int24 lowerTick, int24 upperTick);
    /// @notice A swap crossed the rule; a callback to that chain's executor was requested in this tx.
    event RuleTriggered(
        uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId, int24 tick, uint256 originTxHash
    );

    // ── Protocol constants ──────────────────────────────────────────────────
    /// @dev Uniswap v4 `Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
    ///      uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`.
    ///      = 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f (verified with `cast sig-event`).
    uint256 public constant SWAP_TOPIC0 =
        uint256(keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
    /// @dev Executor events (enums encode as uint8). A unit test asserts these equal the
    ///      `IParallaxExecutor.<Event>.selector` values so the two contracts can never drift apart.
    uint256 public constant RULE_CREATED_TOPIC0 =
        uint256(keccak256("RuleCreated(uint256,address,bytes32,uint8,int24,int24,bool,uint128,uint256,int24)"));
    uint256 public constant RULE_CANCELLED_TOPIC0 = uint256(keccak256("RuleCancelled(uint256,address)"));
    uint256 public constant RULE_EXECUTED_TOPIC0 =
        uint256(keccak256("RuleExecuted(uint256,address,int24,uint256,uint256,uint256,uint256,uint256)"));
    uint256 public constant RULE_SKIPPED_TOPIC0 = uint256(keccak256("RuleSkipped(uint256,uint8,int24,uint256)"));
    uint256 public constant RULE_UPDATED_TOPIC0 = uint256(keccak256("RuleUpdated(uint256,int24,int24)"));

    /// @notice Gas limit for `execute` callbacks. Measured: swap ≈ 220k, LP withdraw ≈ 300k, LP re-centre ≈ 900k.
    /// @dev The Callback Proxy keeps ~130k of the limit for its own accounting (`_extraGas` + `_maxChargeGas`),
    ///      and callbacks are billed on gas USED, not on the limit, so a generous limit costs nothing extra.
    uint64 public constant CALLBACK_GAS_LIMIT = 2_000_000;
    /// @notice Must match ParallaxExecutor.MAX_ACTIVE_RULES_PER_POOL so the mirror never overflows.
    uint256 public constant MAX_RULES_PER_POOL = 25;
    /// @notice Bound on callbacks requested per Swap. Extra triggered rules fire on the next swap.
    /// @dev Sized against the 900k reactive-tx gas cap: scanning 25 rules ≈ 160k, and each request is
    ///      ≤ ~190k even with a mock system contract that stores the whole payload (pessimistic). On Lasna
    ///      a real trigger with one callback measured ≈ 100k gas in total.
    uint256 public constant MAX_CALLBACKS_PER_EVENT = 3;
    /// @notice If neither RuleExecuted nor RuleSkipped arrives within this many seconds of a trigger
    ///         (e.g. the callback was dropped), the rule becomes eligible to fire again. Timestamp-based.
    uint256 public constant PENDING_TIMEOUT = 120;
    /// @notice A trailing stop is only raised when it can tighten by at least this many ticks (≈ bps),
    ///         so a slowly rising price costs a raise every 0.2% instead of one per swap.
    int24 public constant TRAIL_STEP_TICKS = 20;
    /// @notice Gas for a raiseTrail callback (one storage write + event; ≥ the 100k network minimum).
    uint64 public constant RAISE_GAS_LIMIT = 200_000;

    // ── Config ──────────────────────────────────────────────────────────────
    struct ChainConfig {
        address poolManager; // Uniswap v4 PoolManager on that chain (origin of Swap events)
        address executor; //    ParallaxExecutor on that chain (origin of rule events + callback target)
    }

    address public owner;
    mapping(uint256 chainId => ChainConfig) public chains;
    uint256[] public chainIds;

    // ── Rule mirror ─────────────────────────────────────────────────────────
    /// @dev Fires when tick <= lowerTick || tick >= upperTick (same rule as the executor; one side may be
    ///      disabled with type(int24).min / type(int24).max). One struct covers stop-loss, take-profit,
    ///      brackets and LP range guards. Rule ids are per executor, so the mirror is keyed by
    ///      (chainId, ruleId) and pools by (chainId, poolId).
    struct MirrorRule {
        bytes32 poolId;
        int24 lowerTick;
        int24 upperTick;
        bool exists;
        uint64 pendingSince; // 0 = armed; otherwise block.timestamp of the callback request
        uint32 index; //        position in the pool's rule list (for O(1) removal)
        int24 trailTicks; //    trailing stop distance (0 = fixed bound)
        uint64 raiseSince; //   0 = no raise in flight; otherwise block.timestamp of the request
    }

    mapping(uint256 key => MirrorRule) internal _mirror;
    mapping(bytes32 poolKey => uint256[] ruleIds) internal _poolRules;

    constructor() payable {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Setup (deployment order: Reactive → Executor(proxy, this) on each chain → addChain per chain)
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Register a chain: its v4 PoolManager and its ParallaxExecutor. Subscribes to the executor's
    ///         rule lifecycle events; pool Swap subscriptions are added on demand as rules appear.
    /// @dev Executors store this contract's address immutably, so they must be deployed first.
    function addChain(uint256 chainId, address poolManager, address executor) external onlyOwner {
        if (chains[chainId].executor != address(0)) revert ChainAlreadyAdded(chainId);
        if (poolManager == address(0) || executor == address(0)) revert ZeroAddress();
        chains[chainId] = ChainConfig(poolManager, executor);
        chainIds.push(chainId);

        uint256[5] memory topics = [
            RULE_CREATED_TOPIC0, RULE_CANCELLED_TOPIC0, RULE_EXECUTED_TOPIC0, RULE_SKIPPED_TOPIC0, RULE_UPDATED_TOPIC0
        ];
        for (uint256 i; i < 5; ++i) {
            SYSTEM.subscribe(chainId, executor, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        emit ChainAdded(chainId, poolManager, executor);
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
        ChainConfig memory cfg = chains[log_.chainId];
        if (cfg.executor == address(0)) return; // not a chain we serve

        if (log_.contractAddress == cfg.poolManager) {
            if (log_.topic0 == SWAP_TOPIC0 && log_.opCode == 3) _onSwap(log_, cfg.executor);
            return;
        }
        if (log_.contractAddress != cfg.executor) return;

        uint256 t0 = log_.topic0;
        if (t0 == RULE_CREATED_TOPIC0 && log_.opCode == 4) {
            _onRuleCreated(log_);
        } else if (t0 == RULE_EXECUTED_TOPIC0 || t0 == RULE_CANCELLED_TOPIC0) {
            _removeRule(log_.chainId, log_.topic1);
        } else if (t0 == RULE_SKIPPED_TOPIC0) {
            _rearm(log_.chainId, log_.topic1);
        } else if (t0 == RULE_UPDATED_TOPIC0) {
            _onRuleUpdated(log_);
        }
    }

    // ── Handlers ────────────────────────────────────────────────────────────

    function _onRuleCreated(LogRecord memory log_) internal {
        uint256 chainId = log_.chainId;
        uint256 ruleId = log_.topic1;
        bytes32 poolId = bytes32(log_.topic3);
        uint256 key = _key(chainId, ruleId);
        if (_mirror[key].exists) return; // duplicate delivery

        // data = (ruleType, lowerTick, upperTick, zeroForOne, amountIn, positionId, trailTicks)
        (, int24 lowerTick, int24 upperTick,,,, int24 trailTicks) =
            abi.decode(log_.data, (RuleType, int24, int24, bool, uint128, uint256, int24));

        uint256[] storage list = _poolRules[_poolKey(chainId, poolId)];
        if (list.length >= MAX_RULES_PER_POOL) {
            emit MirrorFull(chainId, ruleId, poolId); // unreachable while the executor enforces the same cap
            return;
        }
        if (list.length == 0) _watchPool(chainId, poolId); // first rule on this pool → start listening

        _mirror[key] = MirrorRule({
            poolId: poolId,
            lowerTick: lowerTick,
            upperTick: upperTick,
            exists: true,
            pendingSince: 0,
            index: uint32(list.length),
            trailTicks: trailTicks,
            raiseSince: 0
        });
        list.push(ruleId);
        emit RuleMirrored(chainId, ruleId, poolId, lowerTick, upperTick);
    }

    /// @dev Hot path: a swap happened in a watched pool. Check its (≤25) rules against the new tick.
    function _onSwap(LogRecord memory log_, address executor) internal {
        uint256[] storage list = _poolRules[_poolKey(log_.chainId, bytes32(log_.topic1))];
        uint256 n = list.length;
        if (n == 0) return;

        // data = (int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
        (,,,, int24 tick,) = abi.decode(log_.data, (int128, int128, uint160, uint128, int24, uint24));

        uint256 fired;
        for (uint256 i; i < n && fired < MAX_CALLBACKS_PER_EVENT; ++i) {
            if (_tryFire(list[i], tick, log_, executor)) ++fired;
        }
    }

    /// @dev Fires one rule if it is armed and the tick is outside its safe band. Returns true if fired.
    function _tryFire(uint256 ruleId, int24 tick, LogRecord memory log_, address executor) internal returns (bool) {
        MirrorRule storage m = _mirror[_key(log_.chainId, ruleId)];
        bool armed = m.pendingSince == 0 || block.timestamp >= m.pendingSince + PENDING_TIMEOUT;
        if (!armed) return false;
        if (tick > m.lowerTick && tick < m.upperTick) return m.trailTicks != 0 && _tryRaise(m, ruleId, tick, log_, executor);

        m.pendingSince = uint64(block.timestamp); // de-dupe: one in-flight callback per rule
        _requestExecute(log_.chainId, executor, ruleId, tick, log_);
        emit RuleTriggered(log_.chainId, ruleId, m.poolId, tick, log_.txHash);
        return true;
    }

    /// @dev Trailing stop: if the price has improved enough that the stop could tighten by at least
    ///      TRAIL_STEP_TICKS, ask the executor to raise it. One raise in flight per rule (timestamp timeout).
    function _tryRaise(MirrorRule storage m, uint256 ruleId, int24 tick, LogRecord memory log_, address executor)
        internal
        returns (bool)
    {
        if (m.raiseSince != 0 && block.timestamp < m.raiseSince + PENDING_TIMEOUT) return false;
        bool roomToTighten = m.lowerTick != type(int24).min
            ? tick - m.trailTicks >= m.lowerTick + TRAIL_STEP_TICKS
            : tick + m.trailTicks <= m.upperTick - TRAIL_STEP_TICKS;
        if (!roomToTighten) return false;

        m.raiseSince = uint64(block.timestamp);
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: log_.chainId,
                recipient: executor,
                gasLimit: RAISE_GAS_LIMIT,
                payload: abi.encodeCall(IParallaxExecutor.raiseTrail, (address(0), ruleId, tick))
            })
        );
        emit TrailRaiseRequested(log_.chainId, ruleId, tick);
        return true;
    }

    /// @dev RuleUpdated(ruleId, lowerTick, upperTick): the executor's authoritative bounds.
    function _onRuleUpdated(LogRecord memory log_) internal {
        MirrorRule storage m = _mirror[_key(log_.chainId, log_.topic1)];
        if (!m.exists) return;
        (int24 lowerTick, int24 upperTick) = abi.decode(log_.data, (int24, int24));
        m.lowerTick = lowerTick;
        m.upperTick = upperTick;
        m.raiseSince = 0;
        emit MirrorUpdated(log_.chainId, log_.topic1, lowerTick, upperTick);
    }

    function _rearm(uint256 chainId, uint256 ruleId) internal {
        MirrorRule storage m = _mirror[_key(chainId, ruleId)];
        if (!m.exists || m.pendingSince == 0) return; // unknown or already armed (e.g. NOT_ACTIVE skips)
        m.pendingSince = 0;
        emit RuleRearmed(chainId, ruleId);
    }

    function _removeRule(uint256 chainId, uint256 ruleId) internal {
        uint256 key = _key(chainId, ruleId);
        MirrorRule storage m = _mirror[key];
        if (!m.exists) return;
        bytes32 poolId = m.poolId;
        uint256[] storage list = _poolRules[_poolKey(chainId, poolId)];

        // Swap-and-pop removal, keeping the moved rule's index in sync.
        uint256 last = list[list.length - 1];
        list[m.index] = last;
        _mirror[_key(chainId, last)].index = m.index;
        list.pop();
        delete _mirror[key];

        emit RuleRemoved(chainId, ruleId, poolId);
        if (list.length == 0) _unwatchPool(chainId, poolId); // last rule gone → stop paying for its swaps
    }

    // ── Reactive Network calls ──────────────────────────────────────────────

    /// @dev The first payload argument is a placeholder: Reactive Network overwrites it with this
    ///      contract's address so the executor can authenticate the callback. The origin tx hash and
    ///      block travel along so the executor can record block-exact latency on-chain.
    function _requestExecute(uint256 chainId, address executor, uint256 ruleId, int24 tick, LogRecord memory log_)
        internal
    {
        bytes memory payload = abi.encodeCall(
            IParallaxExecutor.execute, (address(0), ruleId, tick, log_.txHash, log_.blockNumber)
        );
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: chainId,
                recipient: executor,
                gasLimit: CALLBACK_GAS_LIMIT,
                payload: payload
            })
        );
    }

    /// @dev `_watchPool` / `_unwatchPool` must pass identical criteria or unsubscribe silently no-ops.
    function _watchPool(uint256 chainId, bytes32 poolId) internal {
        SYSTEM.subscribe(
            chainId, chains[chainId].poolManager, SWAP_TOPIC0, uint256(poolId), REACTIVE_IGNORE, REACTIVE_IGNORE
        );
        emit PoolWatched(chainId, poolId);
    }

    function _unwatchPool(uint256 chainId, bytes32 poolId) internal {
        SYSTEM.unsubscribe(
            chainId, chains[chainId].poolManager, SWAP_TOPIC0, uint256(poolId), REACTIVE_IGNORE, REACTIVE_IGNORE
        );
        emit PoolUnwatched(chainId, poolId);
    }

    function _key(uint256 chainId, uint256 ruleId) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(chainId, ruleId)));
    }

    function _poolKey(uint256 chainId, bytes32 poolId) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, poolId));
    }

    // ── Views ───────────────────────────────────────────────────────────────

    /// @notice The mirrored copy of a rule (pendingSince > 0 ⇒ triggered, callback in flight).
    function mirror(uint256 chainId, uint256 ruleId) external view returns (MirrorRule memory) {
        return _mirror[_key(chainId, ruleId)];
    }

    function rulesOf(uint256 chainId, bytes32 poolId) external view returns (uint256[] memory) {
        return _poolRules[_poolKey(chainId, poolId)];
    }

    function chainCount() external view returns (uint256) {
        return chainIds.length;
    }
}
