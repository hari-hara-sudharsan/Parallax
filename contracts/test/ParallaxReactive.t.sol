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
    uint256 constant OTHER_CHAIN = 84532; // Base Sepolia
    address constant OTHER_POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    address constant OTHER_EXECUTOR = address(0xBA5E);
    bytes32 constant POOL = keccak256("pool");
    bytes32 constant OTHER_POOL = keccak256("other-pool");

    ParallaxReactive reactive;
    MockSystemContract sys;

    function setUp() public {
        vm.etch(SYSTEM, address(new MockSystemContract()).code);
        sys = MockSystemContract(payable(SYSTEM));
        vm.warp(1_800_000_000);
        reactive = new ParallaxReactive();
        reactive.addChain(CHAIN, POOL_MANAGER, EXECUTOR);
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
        r.blockNumber = 1234;
    }

    /// @dev Matches the executor's RuleCreated layout: data = (ruleType, lowerTick, upperTick, zeroForOne, amountIn, positionId).
    function _ruleCreated(uint256 ruleId, bytes32 poolId, int24 lowerTick, int24 upperTick)
        internal
        view
        returns (IReactive.LogRecord memory)
    {
        bytes memory data =
            abi.encode(RuleType.STOP_LOSS, lowerTick, upperTick, true, uint128(1 ether), uint256(0), int24(0));
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
        assertEq(reactive.RULE_UPDATED_TOPIC0(), uint256(IParallaxExecutor.RuleUpdated.selector));
        assertEq(reactive.SWAP_TOPIC0(), 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f);
    }

    function test_addChain_subscribesToAllRuleEvents() public view {
        uint256[5] memory topics = [
            reactive.RULE_CREATED_TOPIC0(),
            reactive.RULE_CANCELLED_TOPIC0(),
            reactive.RULE_EXECUTED_TOPIC0(),
            reactive.RULE_SKIPPED_TOPIC0(),
            reactive.RULE_UPDATED_TOPIC0()
        ];
        for (uint256 i; i < 5; ++i) {
            assertTrue(
                sys.subscribed(address(reactive), CHAIN, EXECUTOR, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE)
            );
        }
    }

    function test_addChain_oncePerChain_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(ParallaxReactive.ChainAlreadyAdded.selector, CHAIN));
        reactive.addChain(CHAIN, POOL_MANAGER, address(1));

        vm.prank(address(0xBAD));
        vm.expectRevert(ParallaxReactive.NotOwner.selector);
        reactive.addChain(OTHER_CHAIN, OTHER_POOL_MANAGER, OTHER_EXECUTOR);

        vm.expectRevert(ParallaxReactive.ZeroAddress.selector);
        reactive.addChain(OTHER_CHAIN, address(0), OTHER_EXECUTOR);
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

        ParallaxReactive.MirrorRule memory m = reactive.mirror(CHAIN, 1);
        assertEq(m.poolId, POOL);
        assertEq(m.lowerTick, -100);
        assertEq(m.upperTick, NO_UPPER);
        assertTrue(m.exists);
        assertEq(m.pendingSince, 0);
        assertTrue(_poolSubscribed(POOL), "pool should be subscribed on first rule");
        assertEq(reactive.rulesOf(CHAIN, POOL).length, 1);
    }

    function test_ruleCreated_duplicateDeliveryIgnored() public {
        _react(_stop(1, POOL, -100));
        uint256 subsBefore = sys.subCount();
        _react(_stop(1, POOL, -100));
        assertEq(reactive.rulesOf(CHAIN, POOL).length, 1);
        assertEq(sys.subCount(), subsBefore);
    }

    function test_secondRuleSamePool_noExtraSubscription() public {
        _react(_stop(1, POOL, -100));
        uint256 subsBefore = sys.subCount();
        _react(_stop(2, POOL, -200));
        assertEq(sys.subCount(), subsBefore);
        assertEq(reactive.rulesOf(CHAIN, POOL).length, 2);
    }

    function test_cancel_removesRule_andUnwatchesEmptyPool() public {
        _react(_stop(1, POOL, -100));
        _react(_stop(2, POOL, -200));

        _react(_executorEvent(reactive.RULE_CANCELLED_TOPIC0(), 1));
        uint256[] memory left = reactive.rulesOf(CHAIN, POOL);
        assertEq(left.length, 1);
        assertEq(left[0], 2);
        assertEq(reactive.mirror(CHAIN, 2).index, 0, "moved rule index updated");
        assertTrue(_poolSubscribed(POOL));

        _react(_executorEvent(reactive.RULE_CANCELLED_TOPIC0(), 2));
        assertEq(reactive.rulesOf(CHAIN, POOL).length, 0);
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
            cb.payload,
            abi.encodeCall(IParallaxExecutor.execute, (address(0), uint256(1), int24(-150), s.txHash, s.blockNumber))
        );
        uint64 pending = reactive.mirror(CHAIN, 1).pendingSince;
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
        uint64 pending = reactive.mirror(CHAIN, 1).pendingSince;
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
        assertEq(reactive.rulesOf(CHAIN, POOL).length, 0);
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

    // ── Multi-chain: one reactive contract guarding rules on two chains ──

    function _onOther(IReactive.LogRecord memory r) internal pure returns (IReactive.LogRecord memory) {
        r.chainId = OTHER_CHAIN;
        if (r.contractAddress == EXECUTOR) r.contractAddress = OTHER_EXECUTOR;
        if (r.contractAddress == POOL_MANAGER) r.contractAddress = OTHER_POOL_MANAGER;
        return r;
    }

    function test_multichain_sameRuleIdOnTwoChains_isIndependent() public {
        reactive.addChain(OTHER_CHAIN, OTHER_POOL_MANAGER, OTHER_EXECUTOR);
        _react(_stop(1, POOL, -100)); //            rule 1 on Unichain
        _react(_onOther(_stop(1, POOL, -500))); //  rule 1 on Base (same id and poolId, different chain)

        assertEq(reactive.mirror(CHAIN, 1).lowerTick, -100);
        assertEq(reactive.mirror(OTHER_CHAIN, 1).lowerTick, -500);
        assertEq(reactive.rulesOf(CHAIN, POOL).length, 1);
        assertEq(reactive.rulesOf(OTHER_CHAIN, POOL).length, 1);
        assertEq(reactive.chainCount(), 2);
    }

    function test_multichain_callbackGoesBackToTheChainThatTripped() public {
        reactive.addChain(OTHER_CHAIN, OTHER_POOL_MANAGER, OTHER_EXECUTOR);
        _react(_stop(1, POOL, -100));
        _react(_onOther(_stop(1, POOL, -100)));

        _react(_onOther(_swap(POOL, -150))); // only Base's pool moved
        assertEq(sys.callbackCount(), 1);
        MockSystemContract.CallbackReq memory cb = sys.callbackAt(0);
        assertEq(cb.chainId, OTHER_CHAIN);
        assertEq(cb.recipient, OTHER_EXECUTOR);
        assertEq(reactive.mirror(CHAIN, 1).pendingSince, 0, "Unichain rule untouched");
        assertGt(reactive.mirror(OTHER_CHAIN, 1).pendingSince, 0);
    }

    function test_multichain_eachChainWatchesItsOwnPoolManager() public {
        reactive.addChain(OTHER_CHAIN, OTHER_POOL_MANAGER, OTHER_EXECUTOR);
        _react(_onOther(_stop(1, POOL, -100)));
        assertTrue(
            sys.subscribed(
                address(reactive), OTHER_CHAIN, OTHER_POOL_MANAGER, reactive.SWAP_TOPIC0(), uint256(POOL), REACTIVE_IGNORE, REACTIVE_IGNORE
            )
        );
        assertFalse(_poolSubscribed(POOL), "Unichain pool not subscribed by a Base rule");
    }

    function test_multichain_unknownChainIgnored() public {
        IReactive.LogRecord memory r = _stop(1, POOL, -100);
        r.chainId = 999;
        _react(r);
        assertFalse(reactive.mirror(999, 1).exists);
    }

    function test_callbackCarriesOriginBlock() public {
        _react(_stop(1, POOL, -100));
        IReactive.LogRecord memory s = _swap(POOL, -150);
        s.blockNumber = 987_654;
        _react(s);
        (, uint256 ruleId,, uint256 originTx, uint256 originBlock) =
            abi.decode(_args(sys.callbackAt(0).payload), (address, uint256, int24, uint256, uint256));
        assertEq(ruleId, 1);
        assertEq(originTx, s.txHash);
        assertEq(originBlock, 987_654);
    }

    /// @dev Strip the 4-byte selector from a calldata payload.
    function _args(bytes memory payload) internal pure returns (bytes memory out) {
        out = new bytes(payload.length - 4);
        for (uint256 i; i < out.length; ++i) out[i] = payload[i + 4];
    }

    // ── Trailing stops ───────────────────────────────────────────────────────

    /// @dev Trailing rule as the executor emits it: one bound at (creation tick ∓ trail), trailTicks set.
    function _trailing(uint256 ruleId, int24 lowerTick, int24 upperTick, int24 trail)
        internal
        view
        returns (IReactive.LogRecord memory)
    {
        bytes memory data =
            abi.encode(RuleType.TRAILING_STOP, lowerTick, upperTick, true, uint128(1 ether), uint256(0), trail);
        return _log(EXECUTOR, 4, reactive.RULE_CREATED_TOPIC0(), ruleId, uint160(address(this)), uint256(POOL), data);
    }

    function _ruleUpdated(uint256 ruleId, int24 lowerTick, int24 upperTick) internal view returns (IReactive.LogRecord memory) {
        return _log(EXECUTOR, 2, reactive.RULE_UPDATED_TOPIC0(), ruleId, 0, 0, abi.encode(lowerTick, upperTick));
    }

    function test_trailing_raiseRequestedOnlyAfterAStep() public {
        _react(_trailing(1, -100, NO_UPPER, 100)); // created at tick 0, stop at -100
        _react(_swap(POOL, 10)); //  candidate -90: only 10 ticks tighter (< 20 step)
        assertEq(sys.callbackCount(), 0);
        _react(_swap(POOL, 25)); //  candidate -75: 25 ticks tighter → raise
        assertEq(sys.callbackCount(), 1);
        MockSystemContract.CallbackReq memory cb = sys.callbackAt(0);
        assertEq(cb.recipient, EXECUTOR);
        assertEq(cb.gasLimit, reactive.RAISE_GAS_LIMIT());
        assertEq(cb.payload, abi.encodeCall(IParallaxExecutor.raiseTrail, (address(0), uint256(1), int24(25))));
    }

    function test_trailing_oneRaiseInFlight_thenFollowsExecutorUpdate() public {
        _react(_trailing(1, -100, NO_UPPER, 100));
        _react(_swap(POOL, 30));
        _react(_swap(POOL, 60)); // raise still in flight → no second request
        assertEq(sys.callbackCount(), 1);

        _react(_ruleUpdated(1, -70, NO_UPPER)); // executor tightened to tick(30) − 100
        assertEq(reactive.mirror(CHAIN, 1).lowerTick, -70);
        assertEq(reactive.mirror(CHAIN, 1).raiseSince, 0);

        _react(_swap(POOL, 60)); // candidate -40 ≥ -70 + 20 → next raise
        assertEq(sys.callbackCount(), 2);
    }

    function test_trailing_invertedAxis_usesUpperBound() public {
        _react(_trailing(1, NO_LOWER, 100, 100)); // stop above the tick (token is currency1)
        _react(_swap(POOL, -10));
        assertEq(sys.callbackCount(), 0);
        _react(_swap(POOL, -25)); // candidate 75 ≤ 100 − 20 → raise
        assertEq(sys.callbackCount(), 1);
    }

    function test_trailing_firesAtTheRaisedStop() public {
        _react(_trailing(1, -100, NO_UPPER, 100));
        _react(_swap(POOL, 30));
        _react(_ruleUpdated(1, -70, NO_UPPER));
        _react(_swap(POOL, -75)); // below the raised stop (-70), above the original (-100)
        assertEq(sys.callbackCount(), 2);
        assertEq(_first4(sys.callbackAt(1).payload), IParallaxExecutor.execute.selector, "second callback executes");
    }

    function test_trailing_staleRaiseRetriesAfterTimeout() public {
        _react(_trailing(1, -100, NO_UPPER, 100));
        _react(_swap(POOL, 30));
        vm.warp(block.timestamp + reactive.PENDING_TIMEOUT());
        _react(_swap(POOL, 30)); // no RuleUpdated came back: retry after the timeout
        assertEq(sys.callbackCount(), 2);
    }

    function test_fixedRules_neverRequestRaises() public {
        _react(_stop(1, POOL, -100));
        _react(_swap(POOL, 500));
        assertEq(sys.callbackCount(), 0);
    }

    function _first4(bytes memory b) internal pure returns (bytes4 out) {
        assembly {
            out := mload(add(b, 32))
        }
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
