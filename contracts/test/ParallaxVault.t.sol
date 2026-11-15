// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";
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
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

import {ParallaxVault} from "../src/ParallaxVault.sol";
import {ParallaxVaultReactive} from "../src/ParallaxVaultReactive.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {PoolMath} from "../src/libraries/PoolMath.sol";
import {MockSystemContract} from "./mocks/MockSystemContract.sol";

/// @notice ParallaxVault + ParallaxVaultReactive on a fork of Unichain Sepolia (real PoolManager and
///         PositionManager; the Callback Proxy is impersonated and the Omni system contract is mocked).
///         Logs are delivered to `react()` the way Reactive Network would, and requested callbacks are
///         replayed through the proxy with the proxy's measured gas overhead removed.
contract ParallaxVaultTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x00B036B58a818B1BC34d502D3fE730Db729e62AC);
    PoolSwapTest constant SWAP_ROUTER = PoolSwapTest(payable(0x9140a78c1A137c7fF1c151EC8231272aF78a99A4));
    PoolModifyLiquidityTest constant LP_ROUTER = PoolModifyLiquidityTest(payable(0x5fa728C0A5cfd51BEe4B060773f50554c0C8A7AB));
    IPositionManager constant POSM = IPositionManager(0xf969Aee60879C54bAAed9F3eD26147Db216Fd664);
    address constant CALLBACK_PROXY = 0x775c9B990ADe401060B78D0e98684eEf8d2466C1;
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant PROXY_OVERHEAD = 180_000;
    uint256 constant CHAIN = 1301;
    uint256 constant IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;

    int24 constant HALF_WIDTH = 600;
    int24 constant BREAKER = 300;
    uint32 constant WINDOW = 60;
    uint32 constant CALM = 120;

    MockERC20 weth;
    MockERC20 usdc;
    PoolKey key;
    bytes32 poolId;
    bool wethIs0;

    ParallaxVaultReactive brain;
    ParallaxVault vault;
    MockSystemContract sys;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.createSelectFork(vm.envOr("UNICHAIN_SEPOLIA_RPC", string("https://sepolia.unichain.org")));
        weth = new MockERC20("mWETH", "mWETH", 18);
        usdc = new MockERC20("mUSDC", "mUSDC", 6);
        wethIs0 = address(weth) < address(usdc);
        (address c0, address c1) = wethIs0 ? (address(weth), address(usdc)) : (address(usdc), address(weth));
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
        poolId = PoolId.unwrap(key.toId());
        (uint256 a1, uint256 a0) = wethIs0 ? (uint256(3000e6), uint256(1e18)) : (uint256(1e18), uint256(3000e6));
        PM.initialize(key, PoolMath.sqrtPriceX96(a1, a0));

        weth.mint(address(this), 10_000 ether);
        usdc.mint(address(this), 5_000_000e6);
        weth.approve(address(LP_ROUTER), type(uint256).max);
        usdc.approve(address(LP_ROUTER), type(uint256).max);
        weth.approve(address(SWAP_ROUTER), type(uint256).max);
        usdc.approve(address(SWAP_ROUTER), type(uint256).max);
        LP_ROUTER.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1e16, salt: 0}), ""
        );

        // Deployment order: reactive → vault(proxy, reactive) → setVault (subscribes).
        vm.etch(SYSTEM, address(new MockSystemContract()).code);
        sys = MockSystemContract(payable(SYSTEM));
        brain = new ParallaxVaultReactive(CHAIN, address(PM), poolId, BREAKER, WINDOW, CALM);
        vault = new ParallaxVault(
            IPayable(payable(CALLBACK_PROXY)), address(brain), PM, POSM, key, HALF_WIDTH, BREAKER, CALM, 300
        );
        brain.setVault(address(vault));

        for (uint256 i; i < 2; ++i) {
            address u = i == 0 ? alice : bob;
            weth.mint(u, 100 ether);
            usdc.mint(u, 300_000e6);
            vm.startPrank(u);
            weth.approve(address(vault), type(uint256).max);
            usdc.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    function _tick() internal view returns (int24 t) {
        (, t,,) = PM.getSlot0(key.toId());
    }

    function _deposit(address who, uint256 wethAmt, uint256 usdcAmt) internal returns (uint256) {
        (uint256 a0, uint256 a1) = wethIs0 ? (wethAmt, usdcAmt) : (usdcAmt, wethAmt);
        vm.prank(who);
        return vault.deposit(a0, a1);
    }

    function _swap(bool sellWeth, uint256 amount) internal {
        bool z = sellWeth == wethIs0;
        SWAP_ROUTER.swap(
            key,
            SwapParams(z, -int256(amount), z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _record(Vm.Log memory l) internal pure returns (IReactive.LogRecord memory r) {
        r.chainId = CHAIN;
        r.contractAddress = l.emitter;
        r.opCode = l.topics.length;
        if (l.topics.length > 0) r.topic0 = uint256(l.topics[0]);
        if (l.topics.length > 1) r.topic1 = uint256(l.topics[1]);
        if (l.topics.length > 2) r.topic2 = uint256(l.topics[2]);
        if (l.topics.length > 3) r.topic3 = uint256(l.topics[3]);
        r.data = l.data;
        r.txHash = uint256(keccak256(abi.encode(l.data)));
    }

    /// @dev Feed every subscribed log (pool swaps + vault events) to react(), as Reactive Network does.
    function _deliver() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bool fromPool = logs[i].emitter == address(PM) && logs[i].topics[0] == bytes32(brain.SWAP_TOPIC0())
                && logs[i].topics[1] == poolId;
            if (!fromPool && logs[i].emitter != address(vault)) continue;
            vm.prank(SYSTEM);
            brain.react(_record(logs[i]));
        }
    }

    /// @dev Swap, deliver the Swap log, and replay any callbacks it requested; then deliver the vault's
    ///      own events back to the reactive mirror. Returns how many callbacks were requested.
    function _swapAndLoop(bool sellWeth, uint256 amount) internal returns (uint256 fired) {
        uint256 before = sys.callbackCount();
        vm.recordLogs();
        _swap(sellWeth, amount);
        _deliver();
        fired = sys.callbackCount() - before;
        for (uint256 i = before; i < sys.callbackCount(); ++i) {
            vm.recordLogs();
            _runCallback(i);
            _deliver();
        }
    }

    /// @dev Execute callback request `i` through the Callback Proxy, first argument overwritten with the
    ///      reactive contract's address and the proxy's gas overhead subtracted from the limit.
    function _runCallback(uint256 i) internal {
        MockSystemContract.CallbackReq memory c = sys.callbackAt(i);
        bytes memory payload = c.payload;
        address sender = address(brain);
        assembly {
            mstore(add(payload, 36), sender)
        }
        vm.prank(CALLBACK_PROXY);
        (bool ok,) = c.recipient.call{gas: c.gasLimit - PROXY_OVERHEAD}(payload);
        assertTrue(ok, "callback reverted");
    }

    function _inRangeOf(int24 t) internal view returns (bool) {
        return t >= vault.tickLower() && t < vault.tickUpper();
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Deposits / withdrawals
    // ════════════════════════════════════════════════════════════════════════

    function test_firstDeposit_opensCentredPosition() public {
        vm.recordLogs();
        uint256 shares = _deposit(alice, 1 ether, 3000e6);
        _deliver();
        assertGt(shares, 0);
        assertEq(uint8(vault.mode()), uint8(ParallaxVault.Mode.POSITIONED));
        assertTrue(vault.inRange());
        assertEq(vault.tickUpper() - vault.tickLower(), 2 * HALF_WIDTH);
        assertEq(uint8(brain.mode()), uint8(ParallaxVaultReactive.Mode.POSITIONED));
        assertEq(brain.tickLower(), vault.tickLower());
        // Nearly everything is deployed (only rounding dust idle).
        (uint256 p0, uint256 p1) = vault.positionAmounts();
        assertGt(p0 + p1, 0);
    }

    function test_deposit_sharesProRataAndWithdrawReturnsValue() public {
        _deposit(alice, 1 ether, 3000e6);
        uint256 bobShares = _deposit(bob, 2 ether, 6000e6);
        assertApproxEqRel(bobShares, 2 * vault.balanceOf(alice), 0.01e18);

        uint256 valueBefore = vault.totalValue0();
        uint256 w0 = weth.balanceOf(bob);
        uint256 u0 = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.withdraw(bobShares);
        assertEq(vault.balanceOf(bob), 0);
        // Bob got back ~2/3 of the vault's value (as some mix of both tokens).
        uint256 gotW = weth.balanceOf(bob) - w0;
        uint256 gotU = usdc.balanceOf(bob) - u0;
        assertGt(gotW + gotU, 0);
        assertApproxEqRel(vault.totalValue0(), valueBefore / 3, 0.02e18);
    }

    function test_withdrawAll_emptiesVault() public {
        uint256 s = _deposit(alice, 1 ether, 3000e6);
        vm.prank(alice);
        vault.withdraw(s);
        assertEq(vault.totalSupply(), 0);
        assertEq(uint8(vault.mode()), uint8(ParallaxVault.Mode.EMPTY));
        assertLt(vault.totalValue0(), 10); // dust only
    }

    function test_deposit_rejectsZero() public {
        vm.expectRevert(ParallaxVault.ZeroAmount.selector);
        vault.deposit(0, 0);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  The reactive loop
    // ════════════════════════════════════════════════════════════════════════

    function test_crash_evacuatesThenReentersAfterCalm() public {
        vm.recordLogs();
        _deposit(alice, 1 ether, 3000e6);
        _deliver();
        int24 entry = _tick();

        // Crash: ~10% in one swap → move ≥ breaker inside the window → evacuate (priority over rebalance).
        assertEq(_swapAndLoop(true, 10 ether), 1);
        assertGt(entry - _tick() > 0 ? entry - _tick() : _tick() - entry, BREAKER);
        assertEq(uint8(vault.mode()), uint8(ParallaxVault.Mode.EVACUATED));
        assertEq(uint8(brain.mode()), uint8(ParallaxVaultReactive.Mode.EVACUATED));
        assertEq(vault.evacuations(), 1);
        (uint256 p0, uint256 p1) = vault.positionAmounts();
        assertEq(p0 + p1, 0, "no liquidity left in the pool");

        // Still volatile / too early: a swap inside the calm period does nothing.
        vm.warp(block.timestamp + 30);
        assertEq(_swapAndLoop(true, 0.01 ether), 0);

        // Calm for CALM seconds and the window has rolled over: the next swap re-enters, centred.
        vm.warp(block.timestamp + CALM + WINDOW);
        assertEq(_swapAndLoop(false, 30e6), 1);
        assertEq(uint8(vault.mode()), uint8(ParallaxVault.Mode.POSITIONED));
        assertEq(vault.reentries(), 1);
        assertTrue(vault.inRange());
        assertEq(brain.pendingSince(), 0);
    }

    function test_slowDrift_rebalancesInsteadOfEvacuating() public {
        vm.recordLogs();
        _deposit(alice, 1 ether, 3000e6);
        _deliver();
        int24 lowerBefore = vault.tickLower();

        // Walk the price out of range in small steps spread over time (never ≥ breaker inside a window).
        uint256 fired;
        for (uint256 i; i < 12 && fired == 0; ++i) {
            vm.warp(block.timestamp + WINDOW + 1);
            fired = _swapAndLoop(true, 0.8 ether);
        }
        assertEq(fired, 1);
        assertEq(vault.rebalances(), 1);
        assertEq(vault.evacuations(), 0);
        assertTrue(vault.inRange());
        assertTrue(vault.tickLower() != lowerBefore);
    }

    function test_inRangeQuietSwap_doesNothing() public {
        vm.recordLogs();
        _deposit(alice, 1 ether, 3000e6);
        _deliver();
        assertEq(_swapAndLoop(true, 0.05 ether), 0);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Callback safety
    // ════════════════════════════════════════════════════════════════════════

    function test_callbacks_requireProxyAndOurReactive() public {
        _deposit(alice, 1 ether, 3000e6);
        vm.expectRevert(); // not the Callback Proxy
        vault.evacuate(address(brain), 0);

        vm.prank(CALLBACK_PROXY);
        vm.expectRevert(); // proxy, but on behalf of some other reactive contract
        vault.evacuate(makeAddr("impostor"), 0);
    }

    function test_evacuate_isRevalidatedOnChain() public {
        _deposit(alice, 1 ether, 3000e6);
        vm.recordLogs();
        vm.prank(CALLBACK_PROXY);
        vault.evacuate(address(brain), 0); // price has not moved: must be skipped, not executed
        assertEq(uint8(vault.mode()), uint8(ParallaxVault.Mode.POSITIONED));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[logs.length - 1].topics[0], ParallaxVault.VaultSkipped.selector);
    }

    function test_reenter_tooEarlyIsSkipped() public {
        _deposit(alice, 1 ether, 3000e6);
        _swap(true, 10 ether);
        vm.prank(CALLBACK_PROXY);
        vault.evacuate(address(brain), 0);
        assertEq(uint8(vault.mode()), uint8(ParallaxVault.Mode.EVACUATED));

        vm.prank(CALLBACK_PROXY);
        vault.reenter(address(brain), 0);
        assertEq(uint8(vault.mode()), uint8(ParallaxVault.Mode.EVACUATED), "calm period not over");

        vm.warp(block.timestamp + CALM);
        vm.prank(CALLBACK_PROXY);
        vault.reenter(address(brain), 0);
        assertEq(uint8(vault.mode()), uint8(ParallaxVault.Mode.POSITIONED));
    }

    function test_vaultStep_onlySelf() public {
        vm.expectRevert(ParallaxVault.NotSelf.selector);
        vault.vaultStep(ParallaxVault.Action.EVACUATE);
    }

    function test_withdrawWhileEvacuated_paysIdle() public {
        uint256 s = _deposit(alice, 1 ether, 3000e6);
        _swap(true, 10 ether);
        vm.prank(CALLBACK_PROXY);
        vault.evacuate(address(brain), 0);
        vm.prank(alice);
        (uint256 o0, uint256 o1) = vault.withdraw(s);
        assertGt(o0 + o1, 0);
        assertEq(vault.totalSupply(), 0);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Reactive side
    // ════════════════════════════════════════════════════════════════════════

    function test_topicsMatchVaultEvents() public view {
        assertEq(bytes32(brain.POSITIONED_TOPIC0()), ParallaxVault.VaultPositioned.selector);
        assertEq(bytes32(brain.EVACUATED_TOPIC0()), ParallaxVault.VaultEvacuated.selector);
        assertEq(bytes32(brain.SKIPPED_TOPIC0()), ParallaxVault.VaultSkipped.selector);
    }

    function test_setVault_subscribesAndIsOneShot() public {
        assertTrue(
            sys.subscribed(
                address(brain), CHAIN, address(PM), brain.SWAP_TOPIC0(), uint256(poolId), IGNORE, IGNORE
            )
        );
        vm.expectRevert(ParallaxVaultReactive.AlreadyConfigured.selector);
        brain.setVault(address(1));
    }

    function test_react_onlySystem() public {
        IReactive.LogRecord memory r;
        vm.expectRevert();
        brain.react(r);
    }

    function test_pendingRequest_isNotDuplicated() public {
        vm.recordLogs();
        _deposit(alice, 1 ether, 3000e6);
        _deliver();
        // Crash but do NOT run the callback: further swaps must not request another one.
        uint256 before = sys.callbackCount();
        vm.recordLogs();
        _swap(true, 10 ether);
        _swap(true, 1 ether);
        _deliver();
        assertEq(sys.callbackCount() - before, 1);
        // After the timeout it may retry.
        vm.warp(block.timestamp + brain.PENDING_TIMEOUT());
        vm.recordLogs();
        _swap(true, 0.5 ether);
        _deliver();
        assertEq(sys.callbackCount() - before, 2);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Simulation: the same deposit as a passive LP vs in ParallaxVault, over one scripted price path
    //  (drift up → chop → crash → calm → partial recovery). Writes results/vault-sim.json.
    // ════════════════════════════════════════════════════════════════════════

    address passive = makeAddr("passive");
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    uint256 constant SIM_STEPS = 30;
    uint256 constant STEP_SECONDS = 30;

    /// @dev Value of (weth, usdc) in USDC (6 dp) at the live pool price.
    function _usdcValue(uint256 w, uint256 u) internal view returns (uint256) {
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        uint256 p2 = FullMath.mulDiv(sqrtP, sqrtP, 1 << 64); // sqrtP^2 / 2^64
        uint256 wInUsdc = wethIs0 ? FullMath.mulDiv(w, p2, 1 << 128) : FullMath.mulDiv(w, 1 << 128, p2);
        return u + wInUsdc;
    }

    function _mintPassive(int24 tl, int24 tu, uint256 w, uint256 u) internal returns (uint256 id) {
        weth.mint(passive, w);
        usdc.mint(passive, u);
        (uint256 a0, uint256 a1) = wethIs0 ? (w, u) : (u, w);
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), a0, a1
        ) * 9_999 / 10_000;
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(key, tl, tu, uint256(liq), uint128(a0), uint128(a1), passive, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        vm.startPrank(passive);
        weth.approve(address(PERMIT2), type(uint256).max);
        usdc.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(weth), address(POSM), type(uint160).max, uint48(block.timestamp + 30 days));
        PERMIT2.approve(address(usdc), address(POSM), type(uint160).max, uint48(block.timestamp + 30 days));
        id = POSM.nextTokenId();
        POSM.modifyLiquidities(abi.encode(actions, params), block.timestamp + 60);
        vm.stopPrank();
    }

    /// @dev Close the passive position (liquidity + fees); its total value in USDC including leftovers.
    function _closePassive(uint256 id) internal returns (uint256) {
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, uint256(POSM.getPositionLiquidity(id)), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, passive);
        vm.prank(passive);
        POSM.modifyLiquidities(abi.encode(actions, params), block.timestamp + 60);
        return _usdcValue(weth.balanceOf(passive), usdc.balanceOf(passive));
    }

    /// @dev Step i of the scripted path: (sell WETH?, amount, phase name).
    function _pathStep(uint256 i) internal pure returns (bool sellWeth, uint256 amount, string memory phase) {
        if (i < 8) return (false, 1_400e6, "drift up");
        if (i < 14) return (i % 2 == 0, i % 2 == 0 ? 0.3 ether : 900e6, "chop");
        if (i == 14) return (true, 14 ether, "crash");
        if (i < 22) return (i % 2 == 0, i % 2 == 0 ? 0.1 ether : 300e6, "calm");
        return (false, 2_000e6, "recovery");
    }

    function _row(uint256 i, string memory phase, int24 t, bool v, bool p) internal view returns (string memory) {
        return string.concat(
            i == 0 ? "" : ",",
            '{"step":', vm.toString(i), ',"phase":"', phase, '","tick":', vm.toString(int256(t)),
            ',"vaultMode":', vm.toString(uint256(uint8(vault.mode()))),
            ',"vaultInRange":', v ? "true" : "false", ',"passiveInRange":', p ? "true" : "false", "}"
        );
    }

    uint256 internal simVaultIn;
    uint256 internal simPassiveIn;
    string internal simRows;

    function test_sim_vaultVsPassiveLP() public {
        (uint256 W, uint256 U) = (1 ether, 3000e6);
        vm.recordLogs();
        _deposit(alice, W, U);
        _deliver();
        (int24 pl, int24 pu) = (vault.tickLower(), vault.tickUpper());
        uint256 pid = _mintPassive(pl, pu, W, U); // same capital, same starting range, never managed

        simRows = "[";
        for (uint256 i; i < SIM_STEPS; ++i) {
            vm.warp(block.timestamp + STEP_SECONDS);
            (bool s, uint256 a, string memory phase) = _pathStep(i);
            _swapAndLoop(s, a);
            int24 t = _tick();
            bool v = vault.inRange();
            bool p = t >= pl && t < pu;
            if (v) ++simVaultIn;
            if (p) ++simPassiveIn;
            simRows = string.concat(simRows, _row(i, phase, t, v, p));
        }
        simRows = string.concat(simRows, "]");

        uint256 hodl = _usdcValue(W, U);
        uint256 aliceShares = vault.balanceOf(alice); // read BEFORE prank (an external call consumes it)
        vm.prank(alice);
        (uint256 o0, uint256 o1) = vault.withdraw(aliceShares);
        uint256 vaultValue = wethIs0 ? _usdcValue(o0, o1) : _usdcValue(o1, o0);
        uint256 passiveValue = _closePassive(pid);
        _writeSim(vaultValue, passiveValue, hodl);

        emit log_named_uint("vault time in range %", simVaultIn * 100 / SIM_STEPS);
        emit log_named_uint("passive time in range %", simPassiveIn * 100 / SIM_STEPS);
        emit log_named_uint("vault final (USDC 6dp)", vaultValue);
        emit log_named_uint("passive final (USDC 6dp)", passiveValue);
        emit log_named_uint("hodl final (USDC 6dp)", hodl);
        emit log_named_uint("rebalances", vault.rebalances());
        emit log_named_uint("evacuations", vault.evacuations());
        emit log_named_uint("reentries", vault.reentries());
        assertGt(simVaultIn, simPassiveIn, "vault should spend more time in range");
    }

    function _writeSim(uint256 vaultValue, uint256 passiveValue, uint256 hodl) internal {
        string memory head = string.concat(
            '{"steps":', vm.toString(SIM_STEPS), ',"stepSeconds":', vm.toString(STEP_SECONDS),
            ',"halfWidthTicks":', vm.toString(int256(HALF_WIDTH)), ',"breakerTicks":', vm.toString(int256(BREAKER)),
            ',"calmSeconds":', vm.toString(uint256(CALM)),
            ',"vaultTimeInRangePct":', vm.toString(simVaultIn * 100 / SIM_STEPS),
            ',"passiveTimeInRangePct":', vm.toString(simPassiveIn * 100 / SIM_STEPS)
        );
        string memory tail = string.concat(
            ',"rebalances":', vm.toString(uint256(vault.rebalances())),
            ',"evacuations":', vm.toString(uint256(vault.evacuations())),
            ',"reentries":', vm.toString(uint256(vault.reentries())),
            ',"finalValueUsdc6":{"vault":', vm.toString(vaultValue), ',"passive":', vm.toString(passiveValue),
            ',"hodl":', vm.toString(hodl), '},"path":', simRows, "}"
        );
        vm.writeFile(string.concat(vm.projectRoot(), "/../results/vault-sim.json"), string.concat(head, tail));
    }
}
