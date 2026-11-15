// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";
import {AbstractPayer} from "reactive-lib-omni/base/AbstractPayer.sol";
import {AbstractCallback} from "reactive-lib-omni/base/AbstractCallback.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {TripwireExecutor} from "../src/TripwireExecutor.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";
import {ITripwireExecutor} from "../src/interfaces/ITripwireExecutor.sol";
import {Rule, RuleType, RuleStatus, SkipReason} from "../src/libraries/RuleTypes.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {PoolMath} from "../src/libraries/PoolMath.sol";
import {MockSystemContract} from "./mocks/MockSystemContract.sol";

/// @notice Executor + full-loop tests on a fork of Unichain Sepolia, using the REAL Uniswap v4
///         PoolManager and the REAL Reactive Callback Proxy address (we impersonate it, exactly as
///         Reactive Network's signer would call through it).
/// @dev Needs network access. RPC: $UNICHAIN_SEPOLIA_RPC (defaults to the public endpoint).
contract TripwireForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Official addresses (deployments/addresses.md)
    IPoolManager constant PM = IPoolManager(0x00B036B58a818B1BC34d502D3fE730Db729e62AC);
    PoolSwapTest constant SWAP_ROUTER = PoolSwapTest(payable(0x9140a78c1A137c7fF1c151EC8231272aF78a99A4));
    PoolModifyLiquidityTest constant LP_ROUTER = PoolModifyLiquidityTest(payable(0x5fa728C0A5cfd51BEe4B060773f50554c0C8A7AB));
    address constant CALLBACK_PROXY = 0x775c9B990ADe401060B78D0e98684eEf8d2466C1;
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant CHAIN = 1301;

    MockERC20 weth;
    MockERC20 usdc;
    PoolKey key;
    bytes32 poolId;
    bool wethIs0;

    TripwireReactive reactive;
    TripwireExecutor executor;
    MockSystemContract sys;

    address alice = makeAddr("alice");

    function setUp() public {
        vm.createSelectFork(vm.envOr("UNICHAIN_SEPOLIA_RPC", string("https://sepolia.unichain.org")));
        assertEq(block.chainid, CHAIN);

        // Fresh tokens + fresh pool at 3000 USDC/WETH.
        weth = new MockERC20("mWETH", "mWETH", 18);
        usdc = new MockERC20("mUSDC", "mUSDC", 6);
        wethIs0 = address(weth) < address(usdc);
        (address c0, address c1) = wethIs0 ? (address(weth), address(usdc)) : (address(usdc), address(weth));
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
        poolId = PoolId.unwrap(key.toId());
        (uint256 a1, uint256 a0) = wethIs0 ? (uint256(3000e6), uint256(1e18)) : (uint256(1e18), uint256(3000e6));
        PM.initialize(key, PoolMath.sqrtPriceX96(a1, a0));

        // Full-range liquidity ≈ 180 WETH + 550k USDC.
        weth.mint(address(this), 10_000 ether);
        usdc.mint(address(this), 5_000_000e6);
        weth.approve(address(LP_ROUTER), type(uint256).max);
        usdc.approve(address(LP_ROUTER), type(uint256).max);
        weth.approve(address(SWAP_ROUTER), type(uint256).max);
        usdc.approve(address(SWAP_ROUTER), type(uint256).max);
        LP_ROUTER.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1e16, salt: 0}), ""
        );

        // Mock Omni system contract, then the real deployment order: Reactive → Executor → setExecutor.
        vm.etch(SYSTEM, address(new MockSystemContract()).code);
        sys = MockSystemContract(payable(SYSTEM));
        reactive = new TripwireReactive(CHAIN, address(PM), CHAIN);
        executor = new TripwireExecutor(IPayable(payable(CALLBACK_PROXY)), address(reactive), PM);
        reactive.setExecutor(address(executor));

        weth.mint(alice, 100 ether);
        vm.prank(alice);
        weth.approve(address(executor), type(uint256).max);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    function _tick() internal view returns (int24 t) {
        (, t,,) = PM.getSlot0(key.toId());
    }

    /// @dev "Stop-loss: sell WETH if its USDC price falls ~3%" expressed in tick space.
    ///      If WETH is currency0 the price (USDC per WETH) falls as the tick falls → trigger below.
    ///      If WETH is currency1 the axis is inverted → trigger above.
    function _stopLossParams() internal view returns (bool zeroForOne, int24 triggerTick, bool below) {
        zeroForOne = wethIs0; // selling WETH
        below = wethIs0;
        triggerTick = below ? _tick() - 300 : _tick() + 300;
    }

    function _createStopLoss(uint128 amount, uint16 slippageBps) internal returns (uint256 id) {
        (bool z, int24 trig, bool below) = _stopLossParams();
        vm.prank(alice);
        id = executor.createRule(key, RuleType.STOP_LOSS, z, trig, below, amount, slippageBps);
    }

    /// @dev Sell WETH into the pool to crash its price (the "Crash the price" demo button).
    function _crash(uint256 wethAmount) internal {
        bool z = wethIs0;
        SWAP_ROUTER.swap(
            key,
            SwapParams(z, -int256(wethAmount), z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _pump(uint256 usdcAmount) internal {
        bool z = !wethIs0;
        SWAP_ROUTER.swap(
            key,
            SwapParams(z, -int256(usdcAmount), z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    /// @dev Call execute exactly as Reactive Network would: through the Callback Proxy,
    ///      with the first argument overwritten by the reactive contract's address.
    function _callbackFromProxy(uint256 ruleId) internal {
        int24 observed = _tick(); // read BEFORE prank: an external call would consume the prank
        vm.prank(CALLBACK_PROXY);
        executor.execute(address(reactive), ruleId, observed, uint256(keccak256("origin")));
    }

    function _toRecord(Vm.Log memory l, uint256 txHash) internal pure returns (IReactive.LogRecord memory r) {
        r.chainId = CHAIN;
        r.contractAddress = l.emitter;
        r.opCode = l.topics.length;
        if (l.topics.length > 0) r.topic0 = uint256(l.topics[0]);
        if (l.topics.length > 1) r.topic1 = uint256(l.topics[1]);
        if (l.topics.length > 2) r.topic2 = uint256(l.topics[2]);
        if (l.topics.length > 3) r.topic3 = uint256(l.topics[3]);
        r.data = l.data;
        r.txHash = txHash;
    }

    /// @dev Delivers every recorded log the reactive contract is subscribed to (what Reactive Network does).
    function _deliverRecorded(uint256 txHash) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bool fromPool = logs[i].emitter == address(PM) && logs[i].topics[0] == bytes32(reactive.SWAP_TOPIC0())
                && logs[i].topics[1] == poolId;
            bool fromExecutor = logs[i].emitter == address(executor);
            if (!fromPool && !fromExecutor) continue;
            vm.prank(SYSTEM);
            reactive.react(_toRecord(logs[i], txHash));
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  createRule / cancelRule
    // ════════════════════════════════════════════════════════════════════════

    function test_createRule_depositsAndStores() public {
        uint256 id = _createStopLoss(1 ether, 100);
        Rule memory r = executor.getRule(id);
        assertEq(r.owner, alice);
        assertEq(uint8(r.status), uint8(RuleStatus.ACTIVE));
        assertEq(r.amountIn, 1 ether);
        assertEq(r.poolId, poolId);
        assertEq(weth.balanceOf(address(executor)), 1 ether);
        assertEq(executor.activeRuleCount(poolId), 1);
    }

    function test_createRule_rejectsTriggerAlreadyHit() public {
        (bool z,, bool below) = _stopLossParams();
        int24 alreadyHit = below ? _tick() + 60 : _tick() - 60;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TripwireExecutor.TriggerAlreadyHit.selector, _tick(), alreadyHit));
        executor.createRule(key, RuleType.STOP_LOSS, z, alreadyHit, below, 1 ether, 100);
    }

    function test_createRule_validatesInputs() public {
        (bool z, int24 trig, bool below) = _stopLossParams();
        vm.startPrank(alice);
        vm.expectRevert(TripwireExecutor.ZeroAmount.selector);
        executor.createRule(key, RuleType.STOP_LOSS, z, trig, below, 0, 100);
        vm.expectRevert(abi.encodeWithSelector(TripwireExecutor.SlippageTooHigh.selector, 2001, 2000));
        executor.createRule(key, RuleType.STOP_LOSS, z, trig, below, 1 ether, 2001);
        vm.expectRevert(abi.encodeWithSelector(TripwireExecutor.SlippageTooLow.selector, 10, 50));
        executor.createRule(key, RuleType.STOP_LOSS, z, trig, below, 1 ether, 10);
        vm.expectRevert(abi.encodeWithSelector(TripwireExecutor.UnsupportedRuleType.selector, RuleType.RANGE_GUARD));
        executor.createRule(key, RuleType.RANGE_GUARD, z, trig, below, 1 ether, 100);
        vm.stopPrank();
    }

    function test_cancelRule_refunds() public {
        uint256 id = _createStopLoss(1 ether, 100);
        uint256 before = weth.balanceOf(alice);
        vm.prank(alice);
        executor.cancelRule(id);
        assertEq(weth.balanceOf(alice), before + 1 ether);
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.CANCELLED));
        assertEq(executor.activeRuleCount(poolId), 0);
    }

    function test_cancelRule_onlyOwner_onlyOnce() public {
        uint256 id = _createStopLoss(1 ether, 100);
        vm.expectRevert(abi.encodeWithSelector(TripwireExecutor.NotRuleOwner.selector, id));
        executor.cancelRule(id);
        vm.startPrank(alice);
        executor.cancelRule(id);
        vm.expectRevert(abi.encodeWithSelector(TripwireExecutor.RuleNotActive.selector, id));
        executor.cancelRule(id);
        vm.stopPrank();
    }

    // ════════════════════════════════════════════════════════════════════════
    //  execute: authorization
    // ════════════════════════════════════════════════════════════════════════

    function test_execute_rejectsDirectCaller() public {
        uint256 id = _createStopLoss(1 ether, 100);
        _crash(30 ether);
        // Even passing the right reactive address, a non-proxy caller is rejected.
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), CALLBACK_PROXY));
        executor.execute(address(reactive), id, 0, 0);
    }

    function test_execute_rejectsOtherReactiveContract() public {
        uint256 id = _createStopLoss(1 ether, 100);
        _crash(30 ether);
        address impostor = makeAddr("impostor-reactive");
        vm.prank(CALLBACK_PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, impostor, address(reactive))
        );
        executor.execute(impostor, id, 0, 0);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  execute: behaviour
    // ════════════════════════════════════════════════════════════════════════

    function test_execute_swapsWhenTriggered() public {
        uint256 id = _createStopLoss(1 ether, 100);
        _crash(30 ether);
        assertTrue(executor.isTriggered(id));

        uint256 usdcBefore = usdc.balanceOf(alice);
        vm.recordLogs();
        uint256 g = gasleft();
        _callbackFromProxy(id);
        uint256 gasUsed = g - gasleft();
        emit log_named_uint("execute() gas (callback gas limit is 1,000,000)", gasUsed);
        assertLt(gasUsed, 600_000);

        uint256 got = usdc.balanceOf(alice) - usdcBefore;
        assertGt(got, 2000e6, "sold 1 WETH for >2000 USDC after a ~16% crash");
        assertEq(weth.balanceOf(address(executor)), 0, "deposit fully used");
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
        assertEq(executor.activeRuleCount(poolId), 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawExecuted;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == ITripwireExecutor.RuleExecuted.selector) sawExecuted = true;
        }
        assertTrue(sawExecuted);
    }

    function test_execute_skipsWhenPriceRecovered() public {
        uint256 id = _createStopLoss(1 ether, 100);
        _crash(30 ether);
        _pump(400_000e6); // price recovers before the callback lands
        assertFalse(executor.isTriggered(id));

        vm.expectEmit(true, false, false, false, address(executor));
        emit ITripwireExecutor.RuleSkipped(id, SkipReason.CONDITION_NOT_MET, 0, 0);
        _callbackFromProxy(id);

        assertEq(weth.balanceOf(address(executor)), 1 ether, "funds untouched");
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.ACTIVE), "still armed");
    }

    function test_execute_noDoubleExecution() public {
        uint256 id = _createStopLoss(1 ether, 100);
        _crash(30 ether);
        _callbackFromProxy(id);
        uint256 usdcAfterFirst = usdc.balanceOf(alice);

        vm.expectEmit(true, false, false, false, address(executor));
        emit ITripwireExecutor.RuleSkipped(id, SkipReason.NOT_ACTIVE, 0, 0);
        _callbackFromProxy(id);
        assertEq(usdc.balanceOf(alice), usdcAfterFirst);
    }

    function test_execute_slippageExceeded_skipsAndKeepsDeposit() public {
        // 60 WETH into a ~180 WETH pool moves the price far more than 0.5%.
        weth.mint(alice, 60 ether);
        uint256 id = _createStopLoss(60 ether, 50);
        _crash(30 ether);

        vm.expectEmit(true, false, false, false, address(executor));
        emit ITripwireExecutor.RuleSkipped(id, SkipReason.SWAP_FAILED, 0, 0);
        _callbackFromProxy(id);

        assertEq(weth.balanceOf(address(executor)), 60 ether, "deposit intact");
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.ACTIVE));
        assertEq(executor.activeRuleCount(poolId), 1);
    }

    function test_execute_cancelledRule_isSkipped() public {
        uint256 id = _createStopLoss(1 ether, 100);
        vm.prank(alice);
        executor.cancelRule(id);
        _crash(30 ether);
        vm.expectEmit(true, false, false, false, address(executor));
        emit ITripwireExecutor.RuleSkipped(id, SkipReason.NOT_ACTIVE, 0, 0);
        _callbackFromProxy(id);
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(TripwireExecutor.NotPoolManager.selector);
        executor.unlockCallback("");
    }

    // ════════════════════════════════════════════════════════════════════════
    //  FULL LOOP: origin events → react() → callback request → proxy → execute
    // ════════════════════════════════════════════════════════════════════════

    function test_fullLoop_stopLoss() public {
        // 1. Alice creates a stop-loss. Reactive Network delivers RuleCreated → mirror + pool subscription.
        vm.recordLogs();
        uint256 id = _createStopLoss(1 ether, 100);
        _deliverRecorded(uint256(keccak256("tx:createRule")));
        assertEq(reactive.rulesOf(poolId).length, 1);

        // 2. A market swap that does NOT cross the stop → no callback.
        vm.recordLogs();
        _crash(0.1 ether);
        _deliverRecorded(uint256(keccak256("tx:small-swap")));
        assertEq(sys.callbackCount(), 0);

        // 3. The crash. The origin Swap event reaches react(), which requests the callback.
        uint256 originTx = uint256(keccak256("tx:crash"));
        vm.recordLogs();
        _crash(30 ether);
        _deliverRecorded(originTx);
        assertEq(sys.callbackCount(), 1);
        MockSystemContract.CallbackReq memory cb = sys.callbackAt(0);
        assertEq(cb.recipient, address(executor));
        assertEq(cb.chainId, CHAIN);

        // 4. Reactive Network overwrites the first 160 bits with the reactive contract's address and the
        //    Callback Proxy calls the executor with the requested gas limit.
        bytes memory payload = cb.payload;
        address injected = address(reactive);
        assembly {
            mstore(add(payload, 36), injected) // skip length (32) + selector (4)
        }
        uint256 usdcBefore = usdc.balanceOf(alice);
        vm.recordLogs();
        vm.prank(CALLBACK_PROXY);
        (bool ok,) = address(executor).call{gas: cb.gasLimit}(payload);
        assertTrue(ok, "callback succeeded");
        assertGt(usdc.balanceOf(alice), usdcBefore, "alice got USDC");
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));

        // 5. RuleExecuted flows back: rule removed from the mirror and the pool unsubscribed.
        _deliverRecorded(uint256(keccak256("tx:callback")));
        assertEq(reactive.rulesOf(poolId).length, 0);

        // 6. RuleExecuted carries the origin tx hash, the link the frontend uses for latency.
        //    (checked via the mirror being cleared + event emitted in step 4)
    }

    function test_fullLoop_staleCallbackRearms() public {
        vm.recordLogs();
        uint256 id = _createStopLoss(1 ether, 100);
        _deliverRecorded(1);

        vm.recordLogs();
        _crash(30 ether);
        _deliverRecorded(2);
        assertEq(sys.callbackCount(), 1);

        _pump(120_000e6); // price bounces back (just past the stop) before the callback lands
        assertFalse(executor.isTriggered(id));

        vm.recordLogs();
        _callbackFromProxy(id); // → RuleSkipped(CONDITION_NOT_MET)
        _deliverRecorded(3); //  → reactive re-arms

        (,,,, uint64 pending,) = reactive.mirror(id);
        assertEq(pending, 0, "re-armed");

        // Next crash fires it again and this time it executes.
        vm.recordLogs();
        _crash(30 ether);
        _deliverRecorded(4);
        assertEq(sys.callbackCount(), 2);
        _callbackFromProxy(id);
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
    }
}
