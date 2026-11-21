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
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC721} from "forge-std/interfaces/IERC721.sol";

import {ParallaxExecutor} from "../src/ParallaxExecutor.sol";
import {ParallaxTryout} from "../src/ParallaxTryout.sol";
import {ParallaxReactive} from "../src/ParallaxReactive.sol";
import {V4LiquidityOps} from "../src/base/V4LiquidityOps.sol";
import {IParallaxExecutor} from "../src/interfaces/IParallaxExecutor.sol";
import {Rule, RuleType, RuleStatus, SkipReason, NO_LOWER, NO_UPPER} from "../src/libraries/RuleTypes.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {PoolMath} from "../src/libraries/PoolMath.sol";
import {MockSystemContract} from "./mocks/MockSystemContract.sol";

/// @notice Executor + full-loop tests on a fork of Unichain Sepolia, using the REAL Uniswap v4
///         PoolManager and the REAL Reactive Callback Proxy address (we impersonate it, exactly as
///         Reactive Network's signer would call through it).
/// @dev Needs network access. RPC: $UNICHAIN_SEPOLIA_RPC (defaults to the public endpoint).
contract ParallaxForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Official addresses (deployments/addresses.md)
    IPoolManager constant PM = IPoolManager(0x00B036B58a818B1BC34d502D3fE730Db729e62AC);
    PoolSwapTest constant SWAP_ROUTER = PoolSwapTest(payable(0x9140a78c1A137c7fF1c151EC8231272aF78a99A4));
    PoolModifyLiquidityTest constant LP_ROUTER = PoolModifyLiquidityTest(payable(0x5fa728C0A5cfd51BEe4B060773f50554c0C8A7AB));
    IPositionManager constant POSM = IPositionManager(0xf969Aee60879C54bAAed9F3eD26147Db216Fd664);
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address constant CALLBACK_PROXY = 0x775c9B990ADe401060B78D0e98684eEf8d2466C1;
    /// @dev Gas the Callback Proxy keeps from every callback limit. Measured live on Base Sepolia: a 200k limit
    ///      forwarded 24,023 gas to the target (replay of tx 0x01fe80b9…), i.e. ~176k overhead. Rounded up.
    uint256 constant PROXY_OVERHEAD = 180_000;
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant CHAIN = 1301;

    MockERC20 weth;
    MockERC20 usdc;
    PoolKey key;
    bytes32 poolId;
    bool wethIs0;

    ParallaxReactive reactive;
    ParallaxExecutor executor;
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
        reactive = new ParallaxReactive();
        executor = new ParallaxExecutor(IPayable(payable(CALLBACK_PROXY)), address(reactive), PM, POSM);
        reactive.addChain(CHAIN, address(PM), address(executor));

        weth.mint(alice, 100 ether);
        vm.prank(alice);
        weth.approve(address(executor), type(uint256).max);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    function _tick() internal view returns (int24 t) {
        (, t,,) = PM.getSlot0(key.toId());
    }

    /// @dev Bounds for "WETH price falls by `bps`" (falling=true) or "rises by `bps`" (falling=false),
    ///      1 tick ≈ 1 bp. If WETH is currency0 the WETH price moves WITH the tick; otherwise against it.
    function _priceMoveBounds(bool falling, int24 bps) internal view returns (int24 lower, int24 upper) {
        bool tickDown = falling == wethIs0;
        (lower, upper) = tickDown ? (_tick() - bps, NO_UPPER) : (NO_LOWER, _tick() + bps);
    }

    /// @dev "Stop-loss: sell WETH if its USDC price falls ~3%".
    function _stopLossParams() internal view returns (bool zeroForOne, int24 lower, int24 upper) {
        zeroForOne = wethIs0; // selling WETH
        (lower, upper) = _priceMoveBounds(true, 300);
    }

    function _createStopLoss(uint128 amount, uint16 slippageBps) internal returns (uint256 id) {
        (bool z, int24 lower, int24 upper) = _stopLossParams();
        vm.prank(alice);
        id = executor.createRule(key, RuleType.STOP_LOSS, z, lower, upper, amount, slippageBps);
    }

    /// @dev Mint a v4 LP position for alice via the real PositionManager (ERC20 → Permit2 → POSM).
    function _mintPositionForAlice(int24 tickLower, int24 tickUpper, uint256 liquidity) internal returns (uint256 id) {
        weth.mint(alice, 1_000 ether);
        usdc.mint(alice, 3_000_000e6);
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, tickLower, tickUpper, liquidity, type(uint128).max, type(uint128).max, alice, bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        vm.startPrank(alice);
        weth.approve(address(PERMIT2), type(uint256).max);
        usdc.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(weth), address(POSM), type(uint160).max, uint48(block.timestamp + 1 days));
        PERMIT2.approve(address(usdc), address(POSM), type(uint160).max, uint48(block.timestamp + 1 days));
        id = POSM.nextTokenId();
        POSM.modifyLiquidities(abi.encode(actions, params), block.timestamp + 60);
        vm.stopPrank();
    }

    /// @dev Alice's LP position on [tick-600, tick+600) (rounded to spacing), guarded by Parallax.
    function _createRangeGuard() internal returns (uint256 ruleId, uint256 positionId, int24 tl, int24 tu) {
        tl = PoolMath.floorToSpacing(_tick(), 60) - 600;
        tu = PoolMath.floorToSpacing(_tick(), 60) + 600;
        positionId = _mintPositionForAlice(tl, tu, 1e15);
        vm.startPrank(alice);
        IERC721(address(POSM)).approve(address(executor), positionId);
        ruleId = executor.createRangeGuard(positionId, 100, false);
        vm.stopPrank();
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
        executor.execute(address(reactive), ruleId, observed, uint256(keccak256("origin")), block.number - 2);
    }

    function _toRecord(Vm.Log memory l, uint256 txHash) internal view returns (IReactive.LogRecord memory r) {
        r.chainId = CHAIN;
        r.contractAddress = l.emitter;
        r.opCode = l.topics.length;
        if (l.topics.length > 0) r.topic0 = uint256(l.topics[0]);
        if (l.topics.length > 1) r.topic1 = uint256(l.topics[1]);
        if (l.topics.length > 2) r.topic2 = uint256(l.topics[2]);
        if (l.topics.length > 3) r.topic3 = uint256(l.topics[3]);
        r.data = l.data;
        r.txHash = txHash;
        r.blockNumber = block.number;
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
        int24 t = _tick();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.TriggerAlreadyHit.selector, t));
        executor.createRule(key, RuleType.STOP_LOSS, wethIs0, t + 60, NO_UPPER, 1 ether, 100); // tick <= t+60 now
    }

    function test_createRule_validatesInputs() public {
        (bool z, int24 lower, int24 upper) = _stopLossParams();
        vm.startPrank(alice);
        vm.expectRevert(ParallaxExecutor.ZeroAmount.selector);
        executor.createRule(key, RuleType.STOP_LOSS, z, lower, upper, 0, 100);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.SlippageTooHigh.selector, 2001, 2000));
        executor.createRule(key, RuleType.STOP_LOSS, z, lower, upper, 1 ether, 2001);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.SlippageTooLow.selector, 10, 50));
        executor.createRule(key, RuleType.STOP_LOSS, z, lower, upper, 1 ether, 10);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.UnsupportedRuleType.selector, RuleType.RANGE_GUARD));
        executor.createRule(key, RuleType.RANGE_GUARD, z, lower, upper, 1 ether, 100);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.InvalidBounds.selector, NO_LOWER, NO_UPPER));
        executor.createRule(key, RuleType.STOP_LOSS, z, NO_LOWER, NO_UPPER, 1 ether, 100);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.InvalidBounds.selector, int24(100), int24(-100)));
        executor.createRule(key, RuleType.STOP_LOSS, z, 100, -100, 1 ether, 100);
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
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.NotRuleOwner.selector, id));
        executor.cancelRule(id);
        vm.startPrank(alice);
        executor.cancelRule(id);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.RuleNotActive.selector, id));
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
        executor.execute(address(reactive), id, 0, 0, 0);
    }

    function test_execute_rejectsOtherReactiveContract() public {
        uint256 id = _createStopLoss(1 ether, 100);
        _crash(30 ether);
        address impostor = makeAddr("impostor-reactive");
        vm.prank(CALLBACK_PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, impostor, address(reactive))
        );
        executor.execute(impostor, id, 0, 0, 0);
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
            if (logs[i].topics[0] == IParallaxExecutor.RuleExecuted.selector) sawExecuted = true;
        }
        assertTrue(sawExecuted);
    }

    function test_execute_skipsWhenPriceRecovered() public {
        uint256 id = _createStopLoss(1 ether, 100);
        _crash(30 ether);
        _pump(400_000e6); // price recovers before the callback lands
        assertFalse(executor.isTriggered(id));

        vm.expectEmit(true, false, false, false, address(executor));
        emit IParallaxExecutor.RuleSkipped(id, SkipReason.CONDITION_NOT_MET, 0, 0);
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
        emit IParallaxExecutor.RuleSkipped(id, SkipReason.NOT_ACTIVE, 0, 0);
        _callbackFromProxy(id);
        assertEq(usdc.balanceOf(alice), usdcAfterFirst);
    }

    function test_execute_slippageExceeded_skipsAndKeepsDeposit() public {
        // 60 WETH into a ~180 WETH pool moves the price far more than 0.5%.
        weth.mint(alice, 60 ether);
        uint256 id = _createStopLoss(60 ether, 50);
        _crash(30 ether);

        vm.expectEmit(true, false, false, false, address(executor));
        emit IParallaxExecutor.RuleSkipped(id, SkipReason.ACTION_FAILED, 0, 0);
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
        emit IParallaxExecutor.RuleSkipped(id, SkipReason.NOT_ACTIVE, 0, 0);
        _callbackFromProxy(id);
    }

    /// @dev A line is inclusive: a stop exactly at the current tick has already been hit. The executor must treat
    ///      `tick == bound` as triggered, both when arming (reject) and when re-checking (execute).
    function test_trigger_boundIsInclusive() public {
        int24 t = _tick();
        bool z = wethIs0;
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.TriggerAlreadyHit.selector, t));
        executor.createRule(key, RuleType.STOP_LOSS, z, t, NO_UPPER, 1 ether, 100);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.TriggerAlreadyHit.selector, t));
        executor.createRule(key, RuleType.TAKE_PROFIT, z, NO_LOWER, t, 1 ether, 100);
        // One tick away is not yet hit.
        uint256 id = executor.createRule(key, RuleType.STOP_LOSS, z, t - 1, NO_UPPER, 1 ether, 100);
        vm.stopPrank();
        assertFalse(executor.isTriggered(id));
    }

    /// @dev After a debt pause, anyone can re-announce a rule so the reactive mirror catches up.
    function test_resync_reannouncesActiveAndSettledRules() public {
        uint256 id = _createStopLoss(1 ether, 100);
        Rule memory r = executor.getRule(id);
        vm.expectEmit(true, true, true, true, address(executor));
        emit IParallaxExecutor.RuleCreated(
            id, alice, r.poolId, r.ruleType, r.lowerTick, r.upperTick, r.zeroForOne, r.amountIn, r.positionId, r.trailTicks
        );
        vm.prank(address(0xCAFE)); // permissionless
        executor.resync(id);

        vm.prank(alice);
        executor.cancelRule(id);
        vm.expectEmit(true, false, false, true, address(executor));
        emit IParallaxExecutor.RuleSettled(id, RuleStatus.CANCELLED);
        executor.resync(id);

        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.RuleNotActive.selector, 999));
        executor.resync(999);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Panic Exit
    // ════════════════════════════════════════════════════════════════════════

    /// @dev One call closes every kind of rule here: stop-losses are sold at market, an in-range LP guard is
    ///      withdrawn at the current price, and the owner ends up holding everything.
    function test_panic_closesEveryRuleHere() public {
        uint256 s1 = _createStopLoss(1 ether, 100);
        uint256 s2 = _createStopLoss(0.5 ether, 100); // small enough to sell within its 1% cap (see the refund test)
        (uint256 g, uint256 positionId,,) = _createRangeGuard();
        assertEq(executor.activeRulesOf(alice), 3);

        uint256 usdcBefore = usdc.balanceOf(alice);
        vm.expectEmit(true, false, false, true, address(executor));
        emit IParallaxExecutor.PanicRequested(alice, 3, 0);
        vm.prank(alice);
        (uint256 closed, uint256 remaining) = executor.panic();

        assertEq(closed, 3);
        assertEq(remaining, 0);
        assertEq(executor.activeRulesOf(alice), 0);
        assertEq(uint8(executor.getRule(s1).status), uint8(RuleStatus.EXECUTED));
        assertEq(uint8(executor.getRule(s2).status), uint8(RuleStatus.EXECUTED));
        assertEq(uint8(executor.getRule(g).status), uint8(RuleStatus.EXECUTED));
        assertGt(usdc.balanceOf(alice) - usdcBefore, 4_300e6, "1.5 WETH sold at ~3000");
        assertEq(IERC721(address(POSM)).ownerOf(positionId), alice, "LP NFT handed back");
        assertEq(POSM.getPositionLiquidity(positionId), 0, "and emptied");
        assertEq(weth.balanceOf(address(executor)), 0, "nothing left behind");
        assertEq(executor.activeRuleCount(poolId), 0);
    }

    /// @dev Bounded per call so it always fits its callback gas; a second call finishes the job.
    function test_panic_boundedPerCall_thenFinishes() public {
        uint256 n = executor.MAX_PANIC_PER_CALL() + 2;
        for (uint256 i; i < n; ++i) _createStopLoss(0.1 ether, 100);
        vm.startPrank(alice);
        (uint256 closed, uint256 remaining) = executor.panic();
        assertEq(closed, executor.MAX_PANIC_PER_CALL());
        assertEq(remaining, 2);
        (closed, remaining) = executor.panic();
        vm.stopPrank();
        assertEq(closed, 2);
        assertEq(remaining, 0);
    }

    /// @dev Settled and cancelled rules are skipped and cleaned from the index, so panic still makes progress.
    function test_panic_skipsSettledRules() public {
        uint256 a = _createStopLoss(1 ether, 100);
        _createStopLoss(1 ether, 100);
        vm.startPrank(alice);
        executor.cancelRule(a);
        (uint256 closed, uint256 remaining) = executor.panic();
        assertEq(closed, 1);
        assertEq(remaining, 0);
        (closed,) = executor.panic(); // index already empty
        vm.stopPrank();
        assertEq(closed, 0);
    }

    /// @dev If a sale can't meet the rule's slippage cap, the deposit is refunded instead: never stuck.
    function test_panic_saleFails_refundsDeposit() public {
        weth.mint(alice, 50 ether);
        uint256 id = _createStopLoss(50 ether, 50); // ~28% of the pool at a 0.5% cap: the sale must fail
        uint256 wethBefore = weth.balanceOf(alice);
        vm.prank(alice);
        executor.panic();
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.CANCELLED));
        assertEq(weth.balanceOf(alice) - wethBefore, 50 ether, "full deposit back");
        assertEq(executor.activeRulesOf(alice), 0);
    }

    function test_panic_onlyClosesYourOwnRules() public {
        uint256 mine = _createStopLoss(1 ether, 100);
        vm.prank(address(0xB0B));
        (uint256 closed,) = executor.panic();
        assertEq(closed, 0);
        assertEq(uint8(executor.getRule(mine).status), uint8(RuleStatus.ACTIVE));
    }

    /// @dev panicExit is a callback: only the Callback Proxy, carrying our reactive contract, may call it.
    function test_panicExit_auth_andCloses() public {
        uint256 id = _createStopLoss(1 ether, 100);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), CALLBACK_PROXY));
        executor.panicExit(address(reactive), alice);

        vm.prank(CALLBACK_PROXY);
        vm.expectRevert(abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, address(0xBAD), address(reactive)));
        executor.panicExit(address(0xBAD), alice);

        vm.expectEmit(true, false, false, true, address(executor));
        emit IParallaxExecutor.PanicExecuted(alice, 1, 0);
        vm.prank(CALLBACK_PROXY);
        executor.panicExit(address(reactive), alice);
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
    }

    /// @dev A full panicExit (MAX_PANIC_PER_CALL swap closes) must fit the callback gas the reactive side requests,
    ///      after the Callback Proxy keeps its own reserve (the v4 raiseTrail bug, applied up front).
    function test_panicExit_fitsItsCallbackGas() public {
        for (uint256 i; i < executor.MAX_PANIC_PER_CALL(); ++i) _createStopLoss(0.5 ether, 100);
        uint256 budget = reactive.PANIC_GAS_LIMIT() - 200_000; // proxy reserve, rounded up
        vm.prank(CALLBACK_PROXY);
        uint256 g = gasleft();
        executor.panicExit{gas: budget}(address(reactive), alice);
        uint256 used = g - gasleft();
        emit log_named_uint("panicExit gas for 6 closes", used);
        assertEq(executor.activeRulesOf(alice), 0, "all closed within the budget");
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Full loops for the v5 features (reactive decisions driven by the real recorded logs)
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Delivers a recorded callback request exactly as Reactive Network would (sender injected, proxy calls).
    function _deliverCallbackReq(MockSystemContract.CallbackReq memory cb) internal returns (bool ok) {
        bytes memory payload = cb.payload;
        address injected = address(reactive);
        assembly {
            mstore(add(payload, 36), injected)
        }
        vm.prank(CALLBACK_PROXY);
        (ok,) = cb.recipient.call{gas: cb.gasLimit - PROXY_OVERHEAD}(payload);
    }

    /// @dev Zero-setup judge path: a wallet with no tokens arms a stop, crashes the price, and Reactive does the rest.
    function test_fullLoop_tryout() public {
        ParallaxTryout tryout = new ParallaxTryout(executor, SWAP_ROUTER, key, weth, usdc);
        address visitor = makeAddr("visitor");
        int24 home = _tick();

        vm.recordLogs();
        vm.prank(visitor);
        uint256 id = tryout.arm();
        _deliverRecorded(uint256(keccak256("tx:arm")));
        assertTrue(reactive.mirror(CHAIN, id).exists, "Lasna mirrored the visitor's stop");
        assertEq(tryout.armedBy(id), visitor);

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(ParallaxTryout.NotYours.selector, id));
        tryout.crash(id);

        vm.recordLogs();
        vm.prank(visitor);
        tryout.crash(id);
        assertTrue(executor.isTriggered(id), "the crash crossed the line");
        _deliverRecorded(uint256(keccak256("tx:crash")));
        assertEq(sys.callbackCount(), 1, "Reactive requested the callback");
        assertTrue(_deliverCallbackReq(sys.callbackAt(0)));
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED), "stop sold");

        tryout.restore();
        int24 t = _tick();
        assertTrue(t >= home - tryout.RESTORE_BAND() && t <= home + tryout.RESTORE_BAND(), "price back home");

        uint256 readyAt = block.timestamp + tryout.COOLDOWN(); // read before the prank: a call would consume it
        vm.prank(visitor);
        vm.expectRevert(abi.encodeWithSelector(ParallaxTryout.Cooldown.selector, readyAt));
        tryout.arm();
        vm.warp(readyAt);
        vm.prank(visitor);
        tryout.arm();
    }

    /// @dev Panic on chain A: A's rules close in the same tx, Reactive relays panicExit to chain B, B's close too.
    ///      Chain B is a second executor on this fork, registered under Base Sepolia's chain id.
    function test_fullLoop_panicAcrossTwoChains() public {
        uint256 chainB = 84532;
        ParallaxExecutor execB = new ParallaxExecutor(IPayable(payable(CALLBACK_PROXY)), address(reactive), PM, POSM);
        reactive.addChain(chainB, address(PM), address(execB));
        vm.prank(alice);
        weth.approve(address(execB), type(uint256).max);

        uint256 a1 = _createStopLoss(0.5 ether, 100);
        (bool z, int24 lower, int24 upper) = _stopLossParams();
        vm.prank(alice);
        uint256 b1 = execB.createRule(key, RuleType.STOP_LOSS, z, lower, upper, 0.5 ether, 100);

        vm.recordLogs();
        vm.prank(alice);
        executor.panic();
        assertEq(uint8(executor.getRule(a1).status), uint8(RuleStatus.EXECUTED), "chain A closed in the same tx");
        _deliverRecorded(uint256(keccak256("tx:panic")));

        assertEq(sys.callbackCount(), 1, "one relay, to chain B");
        MockSystemContract.CallbackReq memory cb = sys.callbackAt(0);
        assertEq(cb.chainId, chainB);
        assertEq(cb.recipient, address(execB));
        uint256 usdcBefore = usdc.balanceOf(alice);
        assertTrue(_deliverCallbackReq(cb));
        assertEq(uint8(execB.getRule(b1).status), uint8(RuleStatus.EXECUTED), "chain B closed by Reactive");
        assertGt(usdc.balanceOf(alice), usdcBefore, "and alice was paid on chain B");
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(V4LiquidityOps.NotPoolManager.selector);
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
        assertEq(reactive.rulesOf(CHAIN, poolId).length, 1);

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
        (bool ok,) = address(executor).call{gas: cb.gasLimit - PROXY_OVERHEAD}(payload);
        assertTrue(ok, "callback succeeded");
        assertGt(usdc.balanceOf(alice), usdcBefore, "alice got USDC");
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));

        // 5. RuleExecuted flows back: rule removed from the mirror and the pool unsubscribed.
        _deliverRecorded(uint256(keccak256("tx:callback")));
        assertEq(reactive.rulesOf(CHAIN, poolId).length, 0);

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

        uint64 pending = reactive.mirror(CHAIN, id).pendingSince;
        assertEq(pending, 0, "re-armed");

        // Next crash fires it again and this time it executes.
        vm.recordLogs();
        _crash(30 ether);
        _deliverRecorded(4);
        assertEq(sys.callbackCount(), 2);
        _callbackFromProxy(id);
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Phase 3: TAKE_PROFIT and brackets
    // ════════════════════════════════════════════════════════════════════════

    function test_takeProfit_sellsAfterPump() public {
        (int24 lower, int24 upper) = _priceMoveBounds(false, 300); // WETH up ~3%
        vm.prank(alice);
        uint256 id = executor.createRule(key, RuleType.TAKE_PROFIT, wethIs0, lower, upper, 1 ether, 100);

        _pump(100_000e6);
        assertTrue(executor.isTriggered(id));
        uint256 usdcBefore = usdc.balanceOf(alice);
        _callbackFromProxy(id);

        assertGt(usdc.balanceOf(alice) - usdcBefore, 3000e6, "sold 1 WETH above the 3000 start price");
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
    }

    function test_bracket_stopSideFires() public {
        (int24 lowerSL, int24 upperSL) = _priceMoveBounds(true, 300);
        (int24 lowerTP, int24 upperTP) = _priceMoveBounds(false, 300);
        // Combine the active side of each: one rule with both a stop and a target.
        int24 lower = lowerSL != NO_LOWER ? lowerSL : lowerTP;
        int24 upper = upperSL != NO_UPPER ? upperSL : upperTP;
        vm.prank(alice);
        uint256 id = executor.createRule(key, RuleType.STOP_LOSS, wethIs0, lower, upper, 1 ether, 100);

        _crash(30 ether);
        uint256 usdcBefore = usdc.balanceOf(alice);
        _callbackFromProxy(id);
        assertGt(usdc.balanceOf(alice), usdcBefore);
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Phase 3: RANGE_GUARD (LP position withdrawn when it leaves its range)
    // ════════════════════════════════════════════════════════════════════════

    function test_rangeGuard_takesCustody_andMirrorsRangeBounds() public {
        (uint256 id, uint256 positionId, int24 tl, int24 tu) = _createRangeGuard();
        Rule memory r = executor.getRule(id);
        assertEq(uint8(r.ruleType), uint8(RuleType.RANGE_GUARD));
        assertEq(r.positionId, positionId);
        assertEq(r.lowerTick, tl - 1, "fires once tick < tickLower");
        assertEq(r.upperTick, tu, "fires once tick >= tickUpper");
        assertEq(IERC721(address(POSM)).ownerOf(positionId), address(executor));
    }

    function test_rangeGuard_rejectsSomeoneElsesPosition() public {
        int24 base = PoolMath.floorToSpacing(_tick(), 60);
        uint256 positionId = _mintPositionForAlice(base - 600, base + 600, 1e15);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.NotPositionOwner.selector, positionId));
        executor.createRangeGuard(positionId, 100, false);
    }

    function test_rangeGuard_rejectsPositionAlreadyOutOfRange() public {
        int24 base = PoolMath.floorToSpacing(_tick(), 60);
        uint256 positionId = _mintPositionForAlice(base + 600, base + 1200, 1e15);
        vm.startPrank(alice);
        IERC721(address(POSM)).approve(address(executor), positionId);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.TriggerAlreadyHit.selector, _tick()));
        executor.createRangeGuard(positionId, 100, false);
        vm.stopPrank();
    }

    function test_rangeGuard_cancel_returnsNft() public {
        (uint256 id, uint256 positionId,,) = _createRangeGuard();
        vm.prank(alice);
        executor.cancelRule(id);
        assertEq(IERC721(address(POSM)).ownerOf(positionId), alice);
        assertGt(POSM.getPositionLiquidity(positionId), 0, "liquidity untouched");
    }

    function test_rangeGuard_skipsWhileStillInRange() public {
        (uint256 id, uint256 positionId,,) = _createRangeGuard();
        _crash(0.5 ether); // small move, still inside [tl, tu)
        vm.expectEmit(true, false, false, false, address(executor));
        emit IParallaxExecutor.RuleSkipped(id, SkipReason.CONDITION_NOT_MET, 0, 0);
        _callbackFromProxy(id);
        assertEq(IERC721(address(POSM)).ownerOf(positionId), address(executor));
    }

    function test_rangeGuard_withdrawsWhenPriceLeavesRange() public {
        (uint256 id, uint256 positionId,,) = _createRangeGuard();
        uint128 liqBefore = POSM.getPositionLiquidity(positionId);
        assertGt(liqBefore, 0);

        _crash(30 ether); // ~ -3000 ticks: far outside a ±600-tick range
        assertTrue(executor.isTriggered(id));

        uint256 w0 = weth.balanceOf(alice);
        uint256 u0 = usdc.balanceOf(alice);
        uint256 g = gasleft();
        _callbackFromProxy(id);
        emit log_named_uint("range guard execute() gas", g - gasleft());

        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
        assertEq(POSM.getPositionLiquidity(positionId), 0, "all liquidity withdrawn");
        assertEq(IERC721(address(POSM)).ownerOf(positionId), alice, "empty NFT handed back");
        // Price of WETH fell, so the position ended up fully in WETH (LPs buy the falling asset).
        assertGt(weth.balanceOf(alice), w0, "received WETH");
        assertEq(usdc.balanceOf(alice), u0, "no USDC left in an out-of-range-below position");
    }

    function test_fullLoop_rangeGuard() public {
        vm.recordLogs();
        (uint256 id, uint256 positionId,,) = _createRangeGuard();
        _deliverRecorded(uint256(keccak256("tx:createRangeGuard")));
        assertEq(reactive.rulesOf(CHAIN, poolId).length, 1);

        // In-range churn: no callback.
        vm.recordLogs();
        _crash(0.5 ether);
        _deliverRecorded(uint256(keccak256("tx:small")));
        assertEq(sys.callbackCount(), 0);

        // Price leaves the range → reactive requests the callback.
        vm.recordLogs();
        _crash(30 ether);
        _deliverRecorded(uint256(keccak256("tx:out-of-range")));
        assertEq(sys.callbackCount(), 1);

        MockSystemContract.CallbackReq memory cb = sys.callbackAt(0);
        bytes memory payload = cb.payload;
        address injected = address(reactive);
        assembly {
            mstore(add(payload, 36), injected)
        }
        vm.recordLogs();
        vm.prank(CALLBACK_PROXY);
        (bool ok,) = address(executor).call{gas: cb.gasLimit - PROXY_OVERHEAD}(payload);
        assertTrue(ok);
        assertEq(POSM.getPositionLiquidity(positionId), 0);
        assertEq(IERC721(address(POSM)).ownerOf(positionId), alice);

        _deliverRecorded(uint256(keccak256("tx:callback")));
        assertEq(reactive.rulesOf(CHAIN, poolId).length, 0, "mirror cleared, pool unwatched");
        id;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Week 2: TRAILING_STOP
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Trailing stop that sells WETH: the stop follows the WETH price up (axis inverted when WETH is currency1).
    function _createTrailing(int24 trail) internal returns (uint256 id) {
        vm.prank(alice);
        id = executor.createTrailingStop(key, wethIs0, wethIs0, trail, 1 ether, 300);
    }

    function _raiseFromProxy(uint256 ruleId) internal {
        int24 observed = _tick();
        vm.prank(CALLBACK_PROXY);
        executor.raiseTrail(address(reactive), ruleId, observed);
    }

    /// @dev The trailing stop's active bound, whichever side it is on.
    function _stopTick(uint256 id) internal view returns (int24) {
        Rule memory r = executor.getRule(id);
        return r.lowerTick != NO_LOWER ? r.lowerTick : r.upperTick;
    }

    function test_trailing_createsStopTrailBehindSpot() public {
        int24 t = _tick();
        uint256 id = _createTrailing(200);
        Rule memory r = executor.getRule(id);
        assertEq(uint8(r.ruleType), uint8(RuleType.TRAILING_STOP));
        assertEq(r.trailTicks, 200);
        assertEq(_stopTick(id), wethIs0 ? t - 200 : t + 200);
    }

    function test_trailing_raiseFollowsPriceUp_neverLoosens() public {
        uint256 id = _createTrailing(200);
        int24 before = _stopTick(id);

        _pump(60_000e6); // WETH price up
        _raiseFromProxy(id);
        int24 raised = _stopTick(id);
        assertEq(raised, wethIs0 ? _tick() - 200 : _tick() + 200, "stop = live tick - trail");
        assertTrue(wethIs0 ? raised > before : raised < before, "tightened");

        _crash(2 ether); // a little down: raising now would LOOSEN the stop, so it must not move
        vm.expectEmit(true, false, false, true, address(executor));
        emit IParallaxExecutor.RuleUpdated(id, executor.getRule(id).lowerTick, executor.getRule(id).upperTick);
        _raiseFromProxy(id);
        assertEq(_stopTick(id), raised, "unchanged");
    }

    function test_trailing_firesAtRaisedLevel() public {
        uint256 id = _createTrailing(200);
        _pump(100_000e6);
        _raiseFromProxy(id);
        _crash(10 ether); // well past the raised stop
        assertTrue(executor.isTriggered(id));
        uint256 usdcBefore = usdc.balanceOf(alice);
        _callbackFromProxy(id);
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
        assertGt(usdc.balanceOf(alice), usdcBefore);
    }

    function test_trailing_raiseAuth() public {
        uint256 id = _createTrailing(200);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), CALLBACK_PROXY));
        executor.raiseTrail(address(reactive), id, 0);
        address impostor = makeAddr("impostor");
        vm.prank(CALLBACK_PROXY);
        vm.expectRevert(abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, impostor, address(reactive)));
        executor.raiseTrail(impostor, id, 0);
    }

    function test_trailing_validation() public {
        int24 t = _tick(); // read first: an external call would consume expectRevert
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.InvalidTrail.selector, int24(5)));
        executor.createTrailingStop(key, wethIs0, wethIs0, 5, 1 ether, 300);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.UnsupportedRuleType.selector, RuleType.TRAILING_STOP));
        executor.createRule(key, RuleType.TRAILING_STOP, wethIs0, t - 100, NO_UPPER, 1 ether, 300);
        vm.stopPrank();
    }

    function test_fullLoop_trailingStop() public {
        vm.recordLogs();
        uint256 id = _createTrailing(200);
        _deliverRecorded(1);
        assertEq(reactive.mirror(CHAIN, id).trailTicks, 200);

        // Price rises: Reactive requests a raise, the executor tightens, the mirror follows.
        vm.recordLogs();
        _pump(60_000e6);
        _deliverRecorded(2);
        assertEq(sys.callbackCount(), 1, "raise requested");
        _deliverCallback(0);
        int24 raised = _stopTick(id);
        assertEq(
            wethIs0 ? reactive.mirror(CHAIN, id).lowerTick : reactive.mirror(CHAIN, id).upperTick, raised, "mirror follows"
        );

        // Price falls through the raised stop: execute.
        vm.recordLogs();
        _crash(10 ether);
        _deliverRecorded(3);
        assertEq(sys.callbackCount(), 2, "execute requested");
        _deliverCallback(1);
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
    }

    /// @dev Deliver callback request `i` exactly as Reactive Network would, then feed resulting logs back.
    function _deliverCallback(uint256 i) internal {
        MockSystemContract.CallbackReq memory cb = sys.callbackAt(i);
        bytes memory payload = cb.payload;
        address injected = address(reactive);
        assembly {
            mstore(add(payload, 36), injected)
        }
        vm.recordLogs();
        vm.prank(CALLBACK_PROXY);
        // Forward what the real Callback Proxy would: the limit minus its own reserve (_extraGas 80k +
        // _maxChargeGas 50k on these chains) and ~30k of intrinsic/calldata/pre-call overhead.
        (bool ok,) = address(executor).call{gas: cb.gasLimit - PROXY_OVERHEAD}(payload);
        assertTrue(ok, "callback ok within a realistic proxy gas budget");
        _deliverRecorded(uint256(keccak256(abi.encode("cb", i))));
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Week 2: RANGE_GUARD with re-centring
    // ════════════════════════════════════════════════════════════════════════

    function _createRecenterGuard() internal returns (uint256 ruleId, uint256 positionId, int24 tl, int24 tu) {
        tl = PoolMath.floorToSpacing(_tick(), 60) - 600;
        tu = PoolMath.floorToSpacing(_tick(), 60) + 600;
        positionId = _mintPositionForAlice(tl, tu, 1e15);
        vm.startPrank(alice);
        IERC721(address(POSM)).approve(address(executor), positionId);
        ruleId = executor.createRangeGuard(positionId, 300, true);
        vm.stopPrank();
    }

    function test_recenter_reopensCentredPosition_andKeepsGuarding() public {
        (uint256 id, uint256 oldPos, int24 tl, int24 tu) = _createRecenterGuard();
        _crash(30 ether); // far outside the ±600 range

        uint256 g = gasleft();
        _callbackFromProxy(id);
        uint256 used = g - gasleft();
        emit log_named_uint("recenter execute() gas", used);
        // The Callback Proxy keeps ~130k of the limit for itself (_extraGas 80k + _maxChargeGas 50k on these chains).
        assertLt(used, reactive.CALLBACK_GAS_LIMIT() - 130_000, "re-centre fits the callback gas budget");

        // Old rule done, old NFT back to alice (empty).
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.EXECUTED));
        assertEq(IERC721(address(POSM)).ownerOf(oldPos), alice);
        assertEq(POSM.getPositionLiquidity(oldPos), 0);

        // New rule guards a new, centred position of the same width.
        uint256 newId = executor.nextRuleId() - 1;
        Rule memory n = executor.getRule(newId);
        assertEq(uint8(n.ruleType), uint8(RuleType.RANGE_GUARD));
        assertTrue(n.recenter);
        assertEq(n.owner, alice);
        assertEq(IERC721(address(POSM)).ownerOf(n.positionId), address(executor));
        assertGt(POSM.getPositionLiquidity(n.positionId), 0, "liquidity re-deployed");
        int24 newLower = n.lowerTick + 1;
        int24 newUpper = n.upperTick;
        assertEq(newUpper - newLower, tu - tl, "same width");
        assertTrue(_tick() >= newLower && _tick() < newUpper, "in range again");
        assertEq(executor.activeRuleCount(poolId), 1);
    }

    function test_recenter_cancelReturnsTheNewPosition() public {
        (uint256 id,,,) = _createRecenterGuard();
        _crash(30 ether);
        _callbackFromProxy(id);
        uint256 newId = executor.nextRuleId() - 1;
        uint256 newPos = executor.getRule(newId).positionId;
        vm.prank(alice);
        executor.cancelRule(newId);
        assertEq(IERC721(address(POSM)).ownerOf(newPos), alice);
    }

    function test_recenter_stepIsNotCallableFromOutside() public {
        (uint256 id,,,) = _createRecenterGuard();
        int24 t = _tick(); // read first: an external call would consume expectRevert
        vm.expectRevert(ParallaxExecutor.NotSelf.selector);
        executor.recenterSelf(id, key, t);
    }

    function test_recenter_inRangeCallbackChangesNothing() public {
        (uint256 id, uint256 oldPos,,) = _createRecenterGuard();
        _crash(0.5 ether); // small move, still in range
        vm.expectEmit(true, false, false, false, address(executor));
        emit IParallaxExecutor.RuleSkipped(id, SkipReason.CONDITION_NOT_MET, 0, 0);
        _callbackFromProxy(id);
        assertEq(uint8(executor.getRule(id).status), uint8(RuleStatus.ACTIVE));
        assertEq(IERC721(address(POSM)).ownerOf(oldPos), address(executor), "position untouched");
    }

    function test_fullLoop_recenterIsPerpetual() public {
        vm.recordLogs();
        (uint256 id,,,) = _createRecenterGuard();
        _deliverRecorded(1);

        vm.recordLogs();
        _crash(30 ether);
        _deliverRecorded(2);
        assertEq(sys.callbackCount(), 1);
        _deliverCallback(0); // recenter → new rule mirrored, old removed

        uint256 newId = executor.nextRuleId() - 1;
        assertTrue(reactive.mirror(CHAIN, newId).exists, "new position mirrored");
        assertFalse(reactive.mirror(CHAIN, id).exists, "old rule removed");
        assertEq(reactive.rulesOf(CHAIN, poolId).length, 1, "pool still watched");

        // The market moves again: the new position gets re-centred too.
        vm.recordLogs();
        _crash(40 ether);
        _deliverRecorded(3);
        assertEq(sys.callbackCount(), 2);
        _deliverCallback(1);
        assertEq(uint8(executor.getRule(newId).status), uint8(RuleStatus.EXECUTED));
        assertTrue(executor.getRule(executor.nextRuleId() - 1).recenter);
    }

    /// @dev Regression for a bug found live on Base: with a 200k limit the proxy forwarded only 24,023 gas and
    ///      raiseTrail ran out of gas (CallbackFailure, tx 0x01fe80b9…). Storage is cooled first so this matches a
    ///      fresh transaction on the real chain.
    function test_raiseTrail_fitsTheProxyGasBudget() public {
        uint256 id = _createTrailing(200);
        _pump(60_000e6);
        bytes memory payload = abi.encodeCall(IParallaxExecutor.raiseTrail, (address(reactive), id, _tick()));

        uint256 snap = vm.snapshotState();
        vm.cool(address(executor));
        vm.cool(address(PM));
        vm.prank(CALLBACK_PROXY);
        (bool oldBudgetOk,) = address(executor).call{gas: 24_023}(payload); // exactly what the live proxy forwarded
        assertFalse(oldBudgetOk, "reproduces the live out-of-gas");
        vm.revertToState(snap);

        uint256 budget = reactive.RAISE_GAS_LIMIT() - PROXY_OVERHEAD; // read BEFORE prank (an external call consumes it)
        vm.cool(address(executor));
        vm.cool(address(PM));
        vm.prank(CALLBACK_PROXY);
        (bool ok,) = address(executor).call{gas: budget}(payload);
        assertTrue(ok, "raiseTrail fits the current limit after the proxy reserve");
    }

    /// @dev A pool can be initialised with code-less currency addresses; Solmate's safe transfers would then
    ///      "succeed" without moving anything, so arming a rule there must be rejected.
    function test_createRule_rejectsPoolWithCodelessToken() public {
        address fake = address(uint160(address(weth)) - 1); // sorts before mWETH, has no code
        (address c0, address c1) = fake < address(usdc) ? (fake, address(usdc)) : (address(usdc), fake);
        PoolKey memory fakeKey = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
        PM.initialize(fakeKey, TickMath.getSqrtPriceAtTick(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParallaxExecutor.TokenHasNoCode.selector, fake));
        executor.createRule(fakeKey, RuleType.STOP_LOSS, true, -100, NO_UPPER, 1 ether, 300);
    }
}
