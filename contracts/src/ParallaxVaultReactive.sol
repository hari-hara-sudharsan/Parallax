// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "reactive-lib-omni/base/AbstractReactive.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {ISystemContract} from "reactive-lib-omni/interfaces/ISystemContract.sol";

import {ParallaxVault} from "./ParallaxVault.sol";

/// @title ParallaxVaultReactive
/// @notice The brain of ParallaxVault, running on Reactive Network. It watches every Swap in the vault's
///         pool and keeps a short tick history (timestamp-based window). On each swap it decides:
///         • crash in progress (the tick moved ≥ BREAKER_TICKS inside WINDOW_SECONDS, and is that far from
///           where liquidity was deployed) → `evacuate` (pull liquidity out before it is all sold into);
///         • price left the vault's range                                        → `rebalance`;
///         • evacuated, CALM_SECONDS have passed and the window is calm again     → `reenter`.
///         It mirrors the vault's state from its events, so it never fires the same action twice while a
///         callback is in flight. The vault re-checks every condition on-chain.
/// @dev Never reverts inside `react()` to filter (reverts are billed). Gas is bounded: 8 observations.
contract ParallaxVaultReactive is AbstractReactive {
    error NotOwner();
    error AlreadyConfigured();
    error ZeroAddress();

    enum Mode {
        EMPTY,
        POSITIONED,
        EVACUATED
    }

    /// @notice Emitted on Reactive Network in the same tx as the callback request (readable in Reactscan).
    event VaultActionRequested(uint8 action, int24 tick, int24 windowMove, uint256 originTxHash);
    event VaultMirrored(uint8 mode, int24 tickLower, int24 tickUpper, int24 anchorTick);

    // ── Topics ──────────────────────────────────────────────────────────────
    /// @dev Uniswap v4 PoolManager Swap (verified: 0x40e9cecb…d7112f, same constant as ParallaxReactive).
    uint256 public constant SWAP_TOPIC0 =
        uint256(keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
    /// @dev Vault events (enums/uint8 encode as uint8). Unit tests assert these equal the event selectors.
    uint256 public constant POSITIONED_TOPIC0 = uint256(keccak256("VaultPositioned(uint256,int24,int24,int24,uint8)"));
    uint256 public constant EVACUATED_TOPIC0 = uint256(keccak256("VaultEvacuated(int24,uint256,uint256)"));
    uint256 public constant SKIPPED_TOPIC0 = uint256(keccak256("VaultSkipped(uint8,uint8,int24)"));

    // ── Tuning ──────────────────────────────────────────────────────────────
    /// @notice Callback gas limits. Billed on gas used, and the Callback Proxy keeps ~180k of any limit.
    uint64 public constant MOVE_GAS_LIMIT = 2_000_000; // rebalance / reenter: withdraw + swap + mint
    uint64 public constant EVACUATE_GAS_LIMIT = 1_000_000; // withdraw only
    /// @notice A request with no answer (VaultPositioned / Evacuated / Skipped) re-arms after this long.
    uint256 public constant PENDING_TIMEOUT = 120;
    uint256 internal constant OBS = 8;

    // ── Config ──────────────────────────────────────────────────────────────
    address public immutable owner;
    uint256 public immutable ORIGIN_CHAIN_ID;
    address public immutable POOL_MANAGER;
    bytes32 public immutable POOL_ID;
    int24 public immutable BREAKER_TICKS;
    uint32 public immutable WINDOW_SECONDS;
    uint32 public immutable CALM_SECONDS;
    address public vault;

    // ── Mirror of the vault ─────────────────────────────────────────────────
    Mode public mode;
    int24 public tickLower;
    int24 public tickUpper;
    int24 public anchorTick;
    uint64 public evacuatedAt; //  Reactive Network timestamp when VaultEvacuated arrived
    uint64 public pendingSince; // 0 = idle; else timestamp of the in-flight request

    // ── Tick history (ring buffer) ──────────────────────────────────────────
    struct Obs {
        uint64 at;
        int24 tick;
    }

    Obs[OBS] internal _obs;
    uint8 internal _head;

    constructor(
        uint256 originChainId_,
        address poolManager_,
        bytes32 poolId_,
        int24 breakerTicks_,
        uint32 windowSeconds_,
        uint32 calmSeconds_
    ) payable {
        if (poolManager_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        ORIGIN_CHAIN_ID = originChainId_;
        POOL_MANAGER = poolManager_;
        POOL_ID = poolId_;
        BREAKER_TICKS = breakerTicks_;
        WINDOW_SECONDS = windowSeconds_;
        CALM_SECONDS = calmSeconds_;
    }

    /// @notice One-time wiring after the vault is deployed (the vault stores this contract's address).
    ///         Subscribes to the vault's lifecycle events and to Swap events of its pool.
    function setVault(address vault_) external {
        if (msg.sender != owner) revert NotOwner();
        if (vault != address(0)) revert AlreadyConfigured();
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        uint256[3] memory topics = [POSITIONED_TOPIC0, EVACUATED_TOPIC0, SKIPPED_TOPIC0];
        for (uint256 i; i < 3; ++i) {
            SYSTEM.subscribe(ORIGIN_CHAIN_ID, vault_, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        SYSTEM.subscribe(
            ORIGIN_CHAIN_ID, POOL_MANAGER, SWAP_TOPIC0, uint256(POOL_ID), REACTIVE_IGNORE, REACTIVE_IGNORE
        );
    }

    function coverDebt() external {
        _coverDebt();
    }

    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        to.transfer(amount);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  react()
    // ════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IReactive
    function react(LogRecord memory log_) external onlySystem {
        if (log_.chainId != ORIGIN_CHAIN_ID) return;
        if (log_.contractAddress == POOL_MANAGER) {
            if (log_.topic0 == SWAP_TOPIC0 && bytes32(log_.topic1) == POOL_ID) _onSwap(log_);
            return;
        }
        if (log_.contractAddress != vault) return;

        if (log_.topic0 == POSITIONED_TOPIC0) {
            (, int24 tl, int24 tu, int24 anchor,) = abi.decode(log_.data, (uint256, int24, int24, int24, uint8));
            (mode, tickLower, tickUpper, anchorTick, pendingSince) = (Mode.POSITIONED, tl, tu, anchor, 0);
            emit VaultMirrored(uint8(Mode.POSITIONED), tl, tu, anchor);
        } else if (log_.topic0 == EVACUATED_TOPIC0) {
            (mode, evacuatedAt, pendingSince) = (Mode.EVACUATED, uint64(block.timestamp), 0);
            emit VaultMirrored(uint8(Mode.EVACUATED), tickLower, tickUpper, anchorTick);
        } else if (log_.topic0 == SKIPPED_TOPIC0) {
            pendingSince = 0;
        }
    }

    function _onSwap(LogRecord memory log_) internal {
        (,,,, int24 tick,) = abi.decode(log_.data, (int128, int128, uint160, uint128, int24, uint24));
        int24 move = _record(tick);

        if (pendingSince != 0 && block.timestamp < pendingSince + PENDING_TIMEOUT) return;
        (uint8 action, bool fire) = decide(tick, move, block.timestamp);
        if (!fire) return;

        pendingSince = uint64(block.timestamp);
        bytes4 sel = action == uint8(ParallaxVault.Action.EVACUATE)
            ? ParallaxVault.evacuate.selector
            : action == uint8(ParallaxVault.Action.REBALANCE) ? ParallaxVault.rebalance.selector : ParallaxVault.reenter.selector;
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: ORIGIN_CHAIN_ID,
                recipient: vault,
                gasLimit: action == uint8(ParallaxVault.Action.EVACUATE) ? EVACUATE_GAS_LIMIT : MOVE_GAS_LIMIT,
                // First argument is a placeholder the network overwrites with this contract's address.
                payload: abi.encodeWithSelector(sel, address(0), tick)
            })
        );
        emit VaultActionRequested(action, tick, move, log_.txHash);
    }

    /// @notice Pure decision logic (public so tests and the dashboard can explain what would happen).
    /// @param move the largest |tick − observed tick| inside the window, including this swap.
    function decide(int24 tick, int24 move, uint256 nowTs) public view returns (uint8 action, bool fire) {
        if (mode == Mode.POSITIONED) {
            int24 fromAnchor = tick > anchorTick ? tick - anchorTick : anchorTick - tick;
            if (move >= BREAKER_TICKS && fromAnchor >= BREAKER_TICKS) return (uint8(ParallaxVault.Action.EVACUATE), true);
            if (tick < tickLower || tick >= tickUpper) return (uint8(ParallaxVault.Action.REBALANCE), true);
            return (0, false);
        }
        if (mode == Mode.EVACUATED && nowTs >= evacuatedAt + CALM_SECONDS && move < BREAKER_TICKS) {
            return (uint8(ParallaxVault.Action.REENTER), true);
        }
        return (0, false);
    }

    /// @dev Push (now, tick) and return the largest move between `tick` and any observation in the window.
    function _record(int24 tick) internal returns (int24 maxMove) {
        uint256 cutoff = block.timestamp > WINDOW_SECONDS ? block.timestamp - WINDOW_SECONDS : 0;
        for (uint256 i; i < OBS; ++i) {
            Obs memory o = _obs[i];
            if (o.at == 0 || o.at < cutoff) continue;
            int24 d = tick > o.tick ? tick - o.tick : o.tick - tick;
            if (d > maxMove) maxMove = d;
        }
        _obs[_head] = Obs(uint64(block.timestamp), tick);
        _head = uint8((_head + 1) % OBS);
    }

    function observations() external view returns (Obs[OBS] memory) {
        return _obs;
    }
}
