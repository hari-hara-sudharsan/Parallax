// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {ParallaxReactive} from "../src/ParallaxReactive.sol";
import {RuleType, SkipReason, NO_LOWER, NO_UPPER} from "../src/libraries/RuleTypes.sol";
import {MockSystemContract} from "./mocks/MockSystemContract.sol";

/// @notice Drives ParallaxReactive with a random mix of rule events, swaps, time jumps and callbacks that arrive
///         late, out of order, twice, or never. A small model of ParallaxExecutor answers each callback the way the
///         real one does (re-check the live tick, execute once, otherwise emit RuleSkipped).
/// @dev Ordering model: logs from one origin chain (the executor's events and the pool's swaps) reach Lasna in
///      chain order, so they share one FIFO queue. Callbacks are separate destination transactions, so they are
///      delivered in random order, may be duplicated, and may be lost (as a callback that runs out of gas would be).
contract ReactiveHandler is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant CHAIN = 1301;
    address constant POOL_MANAGER = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;
    address constant EXECUTOR = address(0xE0E0);
    bytes32 constant POOL = keccak256("pool");
    uint8 constant ACTIVE = 1;
    uint8 constant EXECUTED = 2;
    uint8 constant CANCELLED = 3;

    ParallaxReactive public immutable reactive;
    MockSystemContract public immutable sys;

    // ── The executor's truth ──
    struct ModelRule {
        int24 lower;
        int24 upper;
        uint8 status;
    }

    mapping(uint256 => ModelRule) public rules;
    uint256 public ruleCount;
    int24 public tick;

    // ── Delivery queues ──
    bytes[] internal _outbox; // abi-encoded LogRecords, delivered FIFO
    uint256 internal _outboxHead;
    uint256[] internal _callbacks; // rule ids of requested, not yet delivered callbacks
    uint256 internal _seenCallbackRequests; // how many of sys's recorded requests we have harvested

    // ── Ghost variables checked by the invariants ──
    mapping(uint256 => uint256) public executions;
    mapping(uint256 => uint256) internal _lastRequestAt;
    mapping(uint256 => bool) internal _rearmedSinceRequest;
    uint256 public dedupeViolations;
    uint256 public maxCallbacksPerSwap;
    uint256 public executedWhileNotTriggered;
    uint256 public calls;

    constructor(ParallaxReactive reactive_, MockSystemContract sys_) {
        reactive = reactive_;
        sys = sys_;
    }

    // ════════════════════════════ fuzzed actions ════════════════════════════

    /// @notice A user arms a stop-loss, take-profit or bracket somewhere around the current price.
    function createRule(uint256 seed) external {
        if (ruleCount >= 20) return;
        int24 below = tick - int24(int256(bound(seed, 1, 200)));
        int24 above = tick + int24(int256(bound(seed >> 8, 1, 200)));
        uint256 kind = (seed >> 16) % 3;
        int24 lower = kind == 1 ? NO_LOWER : below;
        int24 upper = kind == 0 ? NO_UPPER : above;
        uint256 id = ++ruleCount;
        rules[id] = ModelRule(lower, upper, ACTIVE);
        bytes memory data = abi.encode(RuleType.STOP_LOSS, lower, upper, true, uint128(1 ether), uint256(0), int24(0));
        _emit(EXECUTOR, 4, reactive.RULE_CREATED_TOPIC0(), id, uint160(address(this)), uint256(POOL), data);
        calls++;
    }

    function cancelRule(uint256 seed) external {
        if (ruleCount == 0) return;
        uint256 id = bound(seed, 1, ruleCount);
        if (rules[id].status != ACTIVE) return;
        rules[id].status = CANCELLED;
        _emit(EXECUTOR, 2, reactive.RULE_CANCELLED_TOPIC0(), id, 0, 0, "");
        calls++;
    }

    function swap(int256 delta) external {
        tick += int24(bound(delta, -300, 300));
        bytes memory data = abi.encode(int128(-1), int128(1), uint160(1 << 96), uint128(1e18), tick, uint24(3000));
        _emit(POOL_MANAGER, 3, reactive.SWAP_TOPIC0(), uint256(POOL), uint160(address(0xBEEF)), 0, data);
        calls++;
    }

    /// @notice Lasna processes the next few origin logs, in order.
    function deliverLogs(uint256 n) external {
        n = bound(n, 1, 8);
        for (uint256 i; i < n && _outboxHead < _outbox.length; ++i) _deliverNextLog();
        calls++;
    }

    /// @notice One callback reaches the executor: maybe out of order, maybe twice, maybe lost.
    function deliverCallback(uint256 seed, uint8 mode) external {
        if (_callbacks.length == 0) return;
        uint256 i = seed % _callbacks.length;
        uint256 id = _callbacks[i];
        mode = mode % 6;
        if (mode != 5) {
            // 0–4: delivered (5 = lost before execution, like a callback that ran out of gas)
            _executorHandles(id);
        }
        if (mode != 4) {
            // 4 = delivered and kept in the queue, so it arrives a second time later
            _callbacks[i] = _callbacks[_callbacks.length - 1];
            _callbacks.pop();
        }
        calls++;
    }

    /// @notice The reactive contract was paused for debt while the next origin log arrived: it is lost, not queued.
    function loseNextLog() external {
        if (_outboxHead < _outbox.length) _outboxHead++;
        calls++;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 200));
        calls++;
    }

    // ════════════════════════════ draining (used after the run) ════════════════════════════

    /// @notice Lets every queue run dry, then keeps swapping at the current tick (and waiting out the pending
    ///         timeout) so that any rule that is still crossed gets its chance to fire.
    function settle() external {
        // After a debt pause, anyone calls executor.resync(id) for every rule: an active rule re-emits
        // RuleCreated, a settled one emits RuleSettled.
        _drain();
        for (uint256 id = 1; id <= ruleCount; ++id) {
            if (rules[id].status == ACTIVE) {
                ModelRule memory r = rules[id];
                bytes memory data =
                    abi.encode(RuleType.STOP_LOSS, r.lower, r.upper, true, uint128(1 ether), uint256(0), int24(0));
                _emit(EXECUTOR, 4, reactive.RULE_CREATED_TOPIC0(), id, uint160(address(this)), uint256(POOL), data);
            } else {
                _emit(EXECUTOR, 2, reactive.RULE_SETTLED_TOPIC0(), id, 0, 0, abi.encode(_statusOf(id)));
            }
        }
        for (uint256 round; round < 6; ++round) {
            _drain();
            vm.warp(block.timestamp + reactive.PENDING_TIMEOUT() + 1);
            bytes memory data = abi.encode(int128(-1), int128(1), uint160(1 << 96), uint128(1e18), tick, uint24(3000));
            _emit(POOL_MANAGER, 3, reactive.SWAP_TOPIC0(), uint256(POOL), uint160(address(0xBEEF)), 0, data);
        }
        _drain();
    }

    function _drain() internal {
        for (uint256 guard; guard < 400; ++guard) {
            if (_outboxHead < _outbox.length) {
                _deliverNextLog();
            } else if (_callbacks.length > 0) {
                uint256 id = _callbacks[_callbacks.length - 1];
                _callbacks.pop();
                _executorHandles(id);
            } else {
                return;
            }
        }
    }

    // ════════════════════════════ internals ════════════════════════════

    function _deliverNextLog() internal {
        IReactive.LogRecord memory r = abi.decode(_outbox[_outboxHead++], (IReactive.LogRecord));
        if (r.topic0 == reactive.RULE_SKIPPED_TOPIC0()) _rearmedSinceRequest[r.topic1] = true;
        uint256 before = sys.callbackCount();
        vm.prank(SYSTEM);
        reactive.react(r);
        uint256 fired = sys.callbackCount() - before;
        if (r.topic0 == reactive.SWAP_TOPIC0() && fired > maxCallbacksPerSwap) maxCallbacksPerSwap = fired;
        _harvestCallbackRequests();
    }

    /// @dev Moves newly requested callbacks from the mock system contract into our delivery queue, and checks
    ///      that the reactive contract never asks twice for a rule while a callback for it is still in flight.
    function _harvestCallbackRequests() internal {
        uint256 n = sys.callbackCount();
        for (; _seenCallbackRequests < n; ++_seenCallbackRequests) {
            bytes memory payload = sys.callbackAt(_seenCallbackRequests).payload;
            uint256 id = _ruleIdOf(payload);
            bool inFlight = _lastRequestAt[id] != 0 && !_rearmedSinceRequest[id]
                && block.timestamp < _lastRequestAt[id] + reactive.PENDING_TIMEOUT();
            if (inFlight) dedupeViolations++;
            _lastRequestAt[id] = block.timestamp;
            _rearmedSinceRequest[id] = false;
            _callbacks.push(id);
        }
    }

    /// @dev Mirrors ParallaxExecutor.execute: idempotent, re-checks the live tick, reports a miss as RuleSkipped.
    function _executorHandles(uint256 id) internal {
        ModelRule storage r = rules[id];
        if (r.status != ACTIVE) {
            _emit(EXECUTOR, 2, reactive.RULE_SKIPPED_TOPIC0(), id, 0, 0, abi.encode(SkipReason.NOT_ACTIVE, tick, uint256(0)));
            return;
        }
        if (!(tick <= r.lower || tick >= r.upper)) {
            _emit(EXECUTOR, 2, reactive.RULE_SKIPPED_TOPIC0(), id, 0, 0, abi.encode(SkipReason.CONDITION_NOT_MET, tick, uint256(0)));
            return;
        }
        r.status = EXECUTED;
        executions[id]++;
        _emit(EXECUTOR, 2, reactive.RULE_EXECUTED_TOPIC0(), id, 0, 0, "");
    }

    function _emit(address emitter, uint256 opCode, uint256 t0, uint256 t1, uint256 t2, uint256 t3, bytes memory data)
        internal
    {
        IReactive.LogRecord memory r;
        r.chainId = CHAIN;
        r.contractAddress = emitter;
        r.topic0 = t0;
        r.topic1 = t1;
        r.topic2 = t2;
        r.topic3 = t3;
        r.data = data;
        r.opCode = opCode;
        r.txHash = uint256(keccak256(abi.encode(_outbox.length, t0, t1)));
        r.blockNumber = _outbox.length + 1;
        _outbox.push(abi.encode(r));
    }

    /// @dev execute(address reactiveSender, uint256 ruleId, int24 tick, uint256 originTxHash, uint256 originBlock)
    function _ruleIdOf(bytes memory payload) internal pure returns (uint256 id) {
        assembly {
            id := mload(add(payload, 68)) // 32 (length) + 4 (selector) + 32 (address placeholder)
        }
    }

    function _statusOf(uint256 id) internal view returns (uint8) {
        return rules[id].status;
    }

    // ── views for the invariants ──
    function isTriggered(uint256 id) external view returns (bool) {
        ModelRule memory r = rules[id];
        return tick <= r.lower || tick >= r.upper;
    }
}

contract ParallaxReactiveInvariantTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint256 constant CHAIN = 1301;
    address constant POOL_MANAGER = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;
    address constant EXECUTOR = address(0xE0E0);
    bytes32 constant POOL = keccak256("pool");

    ParallaxReactive reactive;
    MockSystemContract sys;
    ReactiveHandler handler;

    function setUp() public {
        vm.etch(SYSTEM, address(new MockSystemContract()).code);
        sys = MockSystemContract(payable(SYSTEM));
        vm.warp(1_800_000_000);
        reactive = new ParallaxReactive();
        reactive.addChain(CHAIN, POOL_MANAGER, EXECUTOR);
        handler = new ReactiveHandler(reactive, sys);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = ReactiveHandler.createRule.selector;
        selectors[1] = ReactiveHandler.cancelRule.selector;
        selectors[2] = ReactiveHandler.swap.selector;
        selectors[3] = ReactiveHandler.deliverLogs.selector;
        selectors[4] = ReactiveHandler.deliverCallback.selector;
        selectors[5] = ReactiveHandler.warp.selector;
        selectors[6] = ReactiveHandler.loseNextLog.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ── Safety: must hold after every single step ──

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_eachRuleExecutesAtMostOnce() public view {
        for (uint256 id = 1; id <= handler.ruleCount(); ++id) assertLe(handler.executions(id), 1);
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_neverTwoCallbacksInFlightForOneRule() public view {
        assertEq(handler.dedupeViolations(), 0);
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 80
    function invariant_callbacksPerSwapAreCapped() public view {
        assertLe(handler.maxCallbacksPerSwap(), reactive.MAX_CALLBACKS_PER_EVENT());
        assertLe(reactive.rulesOf(CHAIN, POOL).length, reactive.MAX_RULES_PER_POOL());
    }

    // ── Convergence: once every queue has drained, Lasna agrees with the executor ──

    function afterInvariant() public {
        handler.settle();
        bool anyActive;
        for (uint256 id = 1; id <= handler.ruleCount(); ++id) {
            (,, uint8 status) = handler.rules(id);
            bool active = status == 1;
            anyActive = anyActive || active;
            // The mirror holds exactly the rules that are still active on the executor.
            assertEq(reactive.mirror(CHAIN, id).exists, active, "mirror disagrees with executor");
            // Liveness: no active rule is left sitting across its line, even after lost and duplicate callbacks.
            if (active) assertFalse(handler.isTriggered(id), "a crossed rule was never executed");
        }
        // Subscriptions follow the rules: a pool is watched iff it still has an active rule.
        bool watched = sys.subscribed(
            address(reactive), CHAIN, POOL_MANAGER, reactive.SWAP_TOPIC0(), uint256(POOL), REACTIVE_IGNORE, REACTIVE_IGNORE
        );
        assertEq(watched, anyActive, "pool subscription disagrees with rules");
        assertEq(reactive.rulesOf(CHAIN, POOL).length == 0, !anyActive);
    }
}
