// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {ParallaxExecutor} from "./ParallaxExecutor.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {RuleType, RuleStatus, NO_LOWER, NO_UPPER} from "./libraries/RuleTypes.sol";

/// @title ParallaxTryout
/// @notice Lets anyone with a little gas run a real Parallax loop in two transactions, with no tokens and no setup:
///           1. `arm()`      a funded stop-loss is placed one tick spacing below the current WETH price;
///           2. `crash(id)`  a swap pushes the price just past that line.
///         Reactive Network then does the rest on its own: it sees the swap, decides, and calls the executor back,
///         which sells the stop. `restore()` moves the price back home so the next visitor starts from the same spot.
/// @dev Testnet only. It mints the demo pool's open-faucet mock tokens to itself, so it owns the rules it creates
///      and keeps their proceeds; `armedBy` records who armed each one. Rate limits use timestamps, not blocks.
contract ParallaxTryout {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error Cooldown(uint256 readyAt);
    error DailyCapReached();
    error NotYours(uint256 ruleId);
    error NotArmed(uint256 ruleId);

    event Armed(address indexed user, uint256 indexed ruleId, int24 line, int24 tick);
    event Crashed(address indexed user, uint256 indexed ruleId, int24 tickBefore, int24 tickAfter);
    event Restored(int24 tickBefore, int24 tickAfter);

    /// @notice Each stop sells this much mock WETH.
    uint128 public constant RULE_WETH = 0.05 ether;
    /// @notice One arm per address per minute, and a daily cap overall (every loop costs lREACT).
    uint256 public constant COOLDOWN = 60;
    uint256 public constant ARMS_PER_DAY = 200;
    /// @notice The crash stops this many ticks past the line, so the stop is clearly crossed but the move is small.
    int24 public constant OVERSHOOT_TICKS = 20;
    /// @notice `restore()` acts only once the price has drifted this far from home.
    int24 public constant RESTORE_BAND = 120;

    ParallaxExecutor public immutable EXECUTOR;
    IPoolManager public immutable POOL_MANAGER;
    PoolSwapTest public immutable SWAP_ROUTER;
    MockERC20 public immutable WETH;
    MockERC20 public immutable USDC;
    bool public immutable WETH_IS_0;
    int24 public immutable HOME_TICK;

    PoolKey internal _key;
    mapping(uint256 ruleId => address user) public armedBy;
    mapping(address user => uint256 at) public lastArmAt;
    mapping(uint256 day => uint256 count) public armsOnDay;

    constructor(ParallaxExecutor executor_, PoolSwapTest swapRouter_, PoolKey memory key_, MockERC20 weth_, MockERC20 usdc_) {
        EXECUTOR = executor_;
        POOL_MANAGER = executor_.POOL_MANAGER();
        SWAP_ROUTER = swapRouter_;
        WETH = weth_;
        USDC = usdc_;
        _key = key_;
        WETH_IS_0 = Currency.unwrap(key_.currency0) == address(weth_);
        (, HOME_TICK,,) = POOL_MANAGER.getSlot0(key_.toId());
        weth_.approve(address(executor_), type(uint256).max);
        weth_.approve(address(swapRouter_), type(uint256).max);
        usdc_.approve(address(swapRouter_), type(uint256).max);
    }

    /// @notice Step 1: arm a funded stop-loss one tick spacing below the current WETH price.
    function arm() external returns (uint256 ruleId) {
        uint256 readyAt = lastArmAt[msg.sender] + COOLDOWN;
        if (lastArmAt[msg.sender] != 0 && block.timestamp < readyAt) revert Cooldown(readyAt);
        uint256 day = block.timestamp / 1 days;
        if (armsOnDay[day] >= ARMS_PER_DAY) revert DailyCapReached();
        lastArmAt[msg.sender] = block.timestamp;
        armsOnDay[day]++;

        WETH.mint(address(this), RULE_WETH);
        int24 t = _tick();
        int24 spacing = _key.tickSpacing;
        // A falling WETH price lowers the tick when WETH is currency0, and raises it otherwise.
        (int24 lower, int24 upper, int24 line) = WETH_IS_0 ? (t - spacing, NO_UPPER, t - spacing) : (NO_LOWER, t + spacing, t + spacing);
        ruleId = EXECUTOR.createRule(_key, RuleType.STOP_LOSS, WETH_IS_0, lower, upper, RULE_WETH, 300);
        armedBy[ruleId] = msg.sender;
        emit Armed(msg.sender, ruleId, line, t);
    }

    /// @notice Step 2: sell WETH until the price is just past your stop's line. Reactive Network takes it from there.
    function crash(uint256 ruleId) external {
        if (armedBy[ruleId] != msg.sender) revert NotYours(ruleId);
        if (EXECUTOR.getRule(ruleId).status != RuleStatus.ACTIVE) revert NotArmed(ruleId);
        ParallaxExecutorRuleView memory r = _view(ruleId);
        int24 target = WETH_IS_0 ? r.lowerTick - OVERSHOOT_TICKS : r.upperTick + OVERSHOOT_TICKS;
        int24 before = _tick();
        WETH.mint(address(this), 300 ether);
        _swapTo(target, WETH_IS_0, address(WETH));
        emit Crashed(msg.sender, ruleId, before, _tick());
    }

    /// @notice Anyone: move the price back home after visitors have pushed it around.
    function restore() external {
        int24 t = _tick();
        if (t >= HOME_TICK - RESTORE_BAND && t <= HOME_TICK + RESTORE_BAND) return;
        bool zeroForOne = t > HOME_TICK; // lowering the tick means selling currency0
        address tokenIn = zeroForOne ? Currency.unwrap(_key.currency0) : Currency.unwrap(_key.currency1);
        MockERC20(tokenIn).mint(address(this), tokenIn == address(WETH) ? 300 ether : 1_000_000e6);
        _swapTo(HOME_TICK, zeroForOne, tokenIn);
        emit Restored(t, _tick());
    }

    function key() external view returns (PoolKey memory) {
        return _key;
    }

    // ── internals ──

    struct ParallaxExecutorRuleView {
        int24 lowerTick;
        int24 upperTick;
    }

    function _view(uint256 ruleId) internal view returns (ParallaxExecutorRuleView memory v) {
        v.lowerTick = EXECUTOR.getRule(ruleId).lowerTick;
        v.upperTick = EXECUTOR.getRule(ruleId).upperTick;
    }

    /// @dev Exact-input swap with a price limit: it stops at `targetTick`, so only what is needed is spent.
    function _swapTo(int24 targetTick, bool zeroForOne, address tokenIn) internal {
        uint256 budget = MockERC20(tokenIn).balanceOf(address(this));
        SWAP_ROUTER.swap(
            _key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(budget),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(targetTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = POOL_MANAGER.getSlot0(_key.toId());
    }
}
