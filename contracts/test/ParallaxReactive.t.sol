// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {AbstractPayer} from "reactive-lib-omni/base/AbstractPayer.sol";
import {ParallaxReactive} from "../src/ParallaxReactive.sol";
import {IParallaxExecutor} from "../src/interfaces/IParallaxExecutor.sol";
import {RuleType, SkipReason, NO_LOWER, NO_UPPER} from "../src/libraries/RuleTypes.sol";
import {MockSystemContract} from "./mocks/MockSystemContract.sol";

/// @notice Unit tests of ParallaxReactive's decision logic with hand-built LogRecords (no chain needed).
contract ParallaxReactiveTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint256 constant CHAIN = 1301;
    address constant POOL_MANAGER = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;
    address constant EXECUTOR = address(0xE0E0);
    bytes32 constant POOL = keccak256("pool");
    bytes32 constant OTHER_POOL = keccak256("other-pool");

    ParallaxReactive reactive;
    MockSystemContract sys;

    function setUp() public {
        vm.etch(SYSTEM, address(new MockSystemContract()).code);
        sys = MockSystemContract(payable(SYSTEM));
        vm.warp(1_800_000_000);
        reactive = new ParallaxReactive(CHAIN, POOL_MANAGER, CHAIN);
        reactive.setExecutor(EXECUTOR);
    }

    // ── Log builders ────────────────────────────────────────────────────────

    function _log(address emitter, uint256 opCode, uint256 t0, uint256 t1, uint256 t2, uint256 t3, bytes memory data)
        internal
        pure
        returns (IReactive.LogRecord memory r)
    {
        r.chainId = CHAIN;
        r.contractAddress = emitter;
        r.topic0 = t0;
        r.topic1 = t1;
        r.topic2 = t2;
        r.topic3 = t3;
        r.data = data;
        r.opCode = opCode;
        r.txHash = uint256(keccak256(abi.encode(t0, t1, data)));
    }

    /// @dev Matches the executor's RuleCreated layout: data = (ruleType, lowerTick, upperTick, zeroForOne, amountIn, positionId).
    function _ruleCreated(uint256 ruleId, bytes32 poolId, int24 lowerTick, int24 upperTick)
        internal
        view
        returns (IReactive.LogRecord memory)
    {
        bytes memory data =
            abi.encode(RuleType.STOP_LOSS, lowerTick, upperTick, true, uint128(1 ether), uint256(0));
        return _log(EXECUTOR, 4, reactive.RULE_CREATED_TOPIC0(), ruleId, uint160(address(this)), uint256(poolId), data);
    }

    /// @dev Stop-loss style: fire when tick <= trigger.
    function _stop(uint256 ruleId, bytes32 poolId, int24 trigger) internal view returns (IReactive.LogRecord memory) {
        return _ruleCreated(ruleId, poolId, trigger, NO_UPPER);
    }

    function _swap(bytes32 poolId, int24 tick) internal view returns (IReactive.LogRecord memory) {
        bytes memory data = abi.encode(int128(-1), int128(1), uint160(1 << 96), uint128(1e18), tick, uint24(3000));
        return _log(POOL_MANAGER, 3, reactive.SWAP_TOPIC0(), uint256(poolId), uint160(address(0xBEEF)), 0, data);
    }

    function _executorEvent(uint256 topic0, uint256 ruleId) internal pure returns (IReactive.LogRecord memory) {
        return _log(EXECUTOR, 2, topic0, ruleId, 0, 0, "");
    }

    function _react(IReactive.LogRecord memory r) internal {
        vm.prank(SYSTEM);
        reactive.react(r);
    }

    function _poolSubscribed(bytes32 poolId) internal view returns (bool) {
        return sys.subscribed(
            address(reactive), CHAIN, POOL_MANAGER, reactive.SWAP_TOPIC0(), uint256(poolId), REACTIVE_IGNORE, REACTIVE_IGNORE
        );
    }

    // ── Wiring ──────────────────────────────────────────────────────────────

    function test_topicConstantsMatchExecutorEvents() public view {
        assertEq(reactive.RULE_CREATED_TOPIC0(), uint256(IParallaxExecutor.RuleCreated.selector));
        assertEq(reactive.RULE_CANCELLED_TOPIC0(), uint256(IParallaxExecutor.RuleCancelled.selector));
        assertEq(reactive.RULE_EXECUTED_TOPIC0(), uint256(IParallaxExecutor.RuleExecuted.selector));
        assertEq(reactive.RULE_SKIPPED_TOPIC0(), uint256(IParallaxExecutor.RuleSkipped.selector));
        assertEq(reactive.SWAP_TOPIC0(), 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f);
    }

    function test_setExecutor_subscribesToAllRuleEvents() public view {
        uint256[4] memory topics = [
            reactive.RULE_CREATED_TOPIC0(),
            reactive.RULE_CANCELLED_TOPIC0(),
            reactive.RULE_EXECUTED_TOPIC0(),
            reactive.RULE_SKIPPED_TOPIC0()
        ];
        for (uint256 i; i < 4; ++i) {
            assertTrue(
                sys.subscribed(address(reactive), CHAIN, EXECUTOR, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE)
            );
        }
    }

    function test_setExecutor_onlyOnce_onlyOwner() public {
        vm.expectRevert(ParallaxReactive.ExecutorAlreadySet.selector);
        reactive.setExecutor(address(1));

        ParallaxReactive fresh = new ParallaxReactive(CHAIN, POOL_MANAGER, CHAIN);
        vm.prank(address(0xBAD));
        vm.expectRevert(ParallaxReactive.NotOwner.selector);
        fresh.setExecutor(address(1));
    }

    function test_react_onlySystem() public {
        IReactive.LogRecord memory r = _swap(POOL, 0);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM));
        reactive.react(r);
    }

    // ── Mirror ──────────────────────────────────────────────────────────────

    function test_ruleCreated_mirrorsRule_andWatchesPool() public {
        assertFalse(_poolSubscribed(POOL));
        _react(_stop(1, POOL, -100));

        (bytes32 poolId, int24 lower, int24 upper, bool exists, uint64 pending,) = reactive.mirror(1);
        assertEq(poolId, POOL);
        assertEq(lower, -100);
        assertEq(upper, NO_UPPER);
        assertTrue(exists);
        assertEq(pending, 0);
        assertTrue(_poolSubscribed(POOL), "pool should be subscribed on first rule");
        assertEq(reactive.rulesOf(POOL).length, 1);
    }

    function test_ruleCreated_duplicateDeliveryIgnored() public {
        _react(_stop(1, POOL, -100));
        uint256 subsBefore = sys.subCount();
        _react(_stop(1, POOL, -100));
        assertEq(reactive.rulesOf(POOL).length, 1);
        assertEq(sys.subCount(), subsBefore);
    }

    function test_secondRuleSamePool_noExtraSubscription() public {
        _react(_stop(1, POOL, -100));
        uint256 subsBefore = sys.subCount();
        _react(_stop(2, POOL, -200));
        assertEq(sys.subCount(), subsBefore);
        assertEq(reactive.rulesOf(POOL).length, 2);
    }

    function test_cancel_removesRule_andUnwatchesEmptyPool() public {
        _react(_stop(1, POOL, -100));
        _react(_stop(2, POOL, -200));

        _react(_executorEvent(reactive.RULE_CANCELLED_TOPIC0(), 1));
        uint256[] memory left = reactive.rulesOf(POOL);
        assertEq(left.length, 1);
        assertEq(left[0], 2);
        (,,,,, uint32 idx) = reactive.mirror(2);
        assertEq(idx, 0, "moved rule index updated");
        assertTrue(_poolSubscribed(POOL));

        _react(_executorEvent(reactive.RULE_CANCELLED_TOPIC0(), 2));
        assertEq(reactive.rulesOf(POOL).length, 0);
        assertFalse(_poolSubscribed(POOL), "pool unsubscribed when empty");
    }

    // ── Trigger logic ───────────────────────────────────────────────────────

    function test_swapAboveStop_noCallback() public {
        _react(_stop(1, POOL, -100));
        _react(_swap(POOL, -99));
        assertEq(sys.callbackCount(), 0);
    }

    function test_swapCrossingStop_requestsCallback() public {
        _react(_stop(1, POOL, -100));
        IReactive.LogRecord memory s = _swap(POOL, -150);
        _react(s);

        assertEq(sys.callbackCount(), 1);
        MockSystemContract.CallbackReq memory cb = sys.callbackAt(0);
        assertEq(cb.chainId, CHAIN);
        assertEq(cb.recipient, EXECUTOR);
        assertEq(cb.gasLimit, reactive.CALLBACK_GAS_LIMIT());
        // First arg MUST be the address(0) placeholder that Reactive Network overwrites.
        assertEq(
            cb.payload, abi.encodeCall(IParallaxExecutor.execute, (address(0), uint256(1), int24(-150), s.txHash))
        );
        (,,,, uint64 pending,) = reactive.mirror(1);
        assertEq(pending, block.timestamp);
    }

    function test_takeProfitDirection_triggersAbove() public {
        _react(_ruleCreated(1, POOL, NO_LOWER, 500));
        _react(_swap(POOL, 499));
        assertEq(sys.callbackCount(), 0);
        _react(_swap(POOL, 500)); // inclusive
        assertEq(sys.callbackCount(), 1);
    }

    function test_swapInOtherPool_ignored() public {
        _react(_stop(1, POOL, -100));
        _react(_swap(OTHER_POOL, -1000));
        assertEq(sys.callbackCount(), 0);
    }

    function test_pendingRule_notRefiredOnNextSwap() public {
        _react(_stop(1, POOL, -100));
        _react(_swap(POOL, -150));
        _react(_swap(POOL, -160));
        assertEq(sys.callbackCount(), 1, "one in-flight callback per rule");
    }

    function test_skipped_rearmsRule() public {
        _react(_stop(1, POOL, -100));
        _react(_swap(POOL, -150));
        _react(_executorEvent(reactive.RULE_SKIPPED_TOPIC0(), 1));
        (,,,, uint64 pending,) = reactive.mirror(1);
        assertEq(pending, 0);
        _react(_swap(POOL, -150));
        assertEq(sys.callbackCount(), 2);
    }

    function test_pendingTimeout_rearmsByTimestamp() public {
        _react(_stop(1, POOL, -100));
        _react(_swap(POOL, -150));
        vm.warp(block.timestamp + reactive.PENDING_TIMEOUT() - 1);
        _react(_swap(POOL, -150));
        assertEq(sys.callbackCount(), 1);
        vm.warp(block.timestamp + 1);
        _react(_swap(POOL, -150));
        assertEq(sys.callbackCount(), 2);
    }

    function test_executed_removesRule_noMoreCallbacks() public {
        _react(_stop(1, POOL, -100));
        _react(_swap(POOL, -150));
        _react(_executorEvent(reactive.RULE_EXECUTED_TOPIC0(), 1));
        assertEq(reactive.rulesOf(POOL).length, 0);
        vm.warp(block.timestamp + 1 days);
        _react(_swap(POOL, -150));
        assertEq(sys.callbackCount(), 1);
    }

    function test_callbacksPerEventAreCapped() public {
        for (uint256 i = 1; i <= 8; ++i) _react(_stop(i, POOL, -100));
        _react(_swap(POOL, -150));
        assertEq(sys.callbackCount(), reactive.MAX_CALLBACKS_PER_EVENT());
        assertEq(sys.callbackCount(), 3);
        _react(_swap(POOL, -150)); // next 3
        _react(_swap(POOL, -150)); // last 2
        assertEq(sys.callbackCount(), 8);
    }

    function test_gas_fullPoolSwapStaysFarBelowReactiveCap() public {
        for (uint256 i = 1; i <= 25; ++i) _react(_stop(i, POOL, -100));
        IReactive.LogRecord memory s = _swap(POOL, -150);
        vm.prank(SYSTEM);
        uint256 g = gasleft();
        reactive.react(s);
        uint256 used = g - gasleft();
        // Upper bound: the mock system contract stores every payload in storage, the real one is cheaper.
        emit log_named_uint("react() gas, 25 rules, 3 callbacks (pessimistic)", used);
        assertLt(used, 900_000, "Reactive tx gas cap is 900k");
    }

    // ── Two-sided rules: LP range guard [tickLower, tickUpper) and brackets ──

    /// @dev A position on [-600, 600) is mirrored as lower = -601, upper = 600.
    function test_rangeGuard_firesOnlyWhenLeavingRange() public {
        _react(_ruleCreated(1, POOL, -601, 600));
        _react(_swap(POOL, -600)); // still in range (tickLower is inclusive)
        _react(_swap(POOL, 0));
        _react(_swap(POOL, 599)); //  still in range
        assertEq(sys.callbackCount(), 0);
        _react(_swap(POOL, 600)); //  tickUpper is exclusive → out of range
        assertEq(sys.callbackCount(), 1);
    }

    function test_rangeGuard_firesBelowRange() public {
        _react(_ruleCreated(1, POOL, -601, 600));
        _react(_swap(POOL, -601));
        assertEq(sys.callbackCount(), 1);
    }

    function test_bracket_firesOnEitherSide() public {
        _react(_ruleCreated(1, POOL, -100, 100)); // stop-loss + take-profit in one rule
        _react(_ruleCreated(2, POOL, -100, 100));
        _react(_swap(POOL, 150)); // rule 1 and 2 both fire on the upside
        assertEq(sys.callbackCount(), 2);
    }

    // ── Robustness: never revert on unexpected input (reverts are billed) ──

    function test_unknownLogs_fallThroughWithoutRevert() public {
        _react(_log(address(0xDEAD), 1, 123, 0, 0, 0, ""));
        _react(_log(EXECUTOR, 1, 456, 0, 0, 0, ""));
        _react(_executorEvent(reactive.RULE_EXECUTED_TOPIC0(), 999)); // unknown rule
        _react(_executorEvent(reactive.RULE_SKIPPED_TOPIC0(), 999));
        _react(_swap(POOL, 0)); // no rules
        IReactive.LogRecord memory wrongChain = _swap(POOL, 0);
        wrongChain.chainId = 1;
        _react(wrongChain);
        assertEq(sys.callbackCount(), 0);
    }
}
