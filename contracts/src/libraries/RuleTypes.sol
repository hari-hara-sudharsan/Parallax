// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title RuleTypes
/// @notice Shared types for Tripwire rules (used by the executor, the reactive contract, and tests).

/// @notice What the rule protects. The type is a label for the UI and decides the ACTION:
///         STOP_LOSS / TAKE_PROFIT swap the deposited tokens; RANGE_GUARD withdraws an LP position.
///         WHEN a rule fires is decided only by its tick bounds (see `Rule`).
enum RuleType {
    STOP_LOSS,
    TAKE_PROFIT,
    RANGE_GUARD
}

enum RuleStatus {
    NONE,
    ACTIVE,
    EXECUTED,
    CANCELLED
}

/// @notice Why a callback did not execute. The rule stays ACTIVE and the reactive contract re-arms it.
enum SkipReason {
    NOT_ACTIVE, //        already executed or cancelled (idempotency)
    CONDITION_NOT_MET, // price moved back before the callback landed
    ACTION_FAILED //      slippage limit hit, or the swap / withdrawal reverted
}

/// @dev "No bound on this side." Real pool ticks are within ±887,272, so these can never be crossed.
int24 constant NO_LOWER = type(int24).min;
int24 constant NO_UPPER = type(int24).max;

/// @notice A rule as stored by the executor.
/// @dev A rule fires when the pool tick reaches EITHER bound (both inclusive):
///          tick <= lowerTick  ||  tick >= upperTick
///      • Stop-loss / take-profit: one bound set, the other NO_LOWER / NO_UPPER.
///      • Both bounds on a swap rule: a bracket ("OCO") order, whichever price is hit first.
///      • Range guard on a v4 position [tickLower, tickUpper): lowerTick = tickLower - 1, upperTick = tickUpper,
///        i.e. it fires exactly when the position stops earning fees.
///      Ticks, not prices, so the check is exact and independent of which token sorts as currency0.
struct Rule {
    address owner; //            receives proceeds / withdrawn liquidity / refunds
    RuleType ruleType;
    RuleStatus status;
    bool zeroForOne; //          swap rules: true = sell currency0 for currency1
    int24 lowerTick;
    int24 upperTick;
    uint16 maxSlippageBps;
    uint128 amountIn; //         swap rules: tokens deposited and sold on trigger
    uint64 createdAt; //         block.timestamp
    bytes32 poolId;
    uint256 positionId; //       range guard: v4 PositionManager NFT id held by the executor
}
