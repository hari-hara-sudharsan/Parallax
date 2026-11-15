// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title RuleTypes
/// @notice Shared types for Tripwire rules (used by the executor, the reactive contract, and tests).

/// @notice What the user wants protected. Phase 2 implements STOP_LOSS and TAKE_PROFIT (both are
///         "swap when the tick crosses a level"; they differ only in which way the crossing goes).
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
    NOT_ACTIVE, // already executed or cancelled (idempotency)
    CONDITION_NOT_MET, // price moved back before the callback landed
    SWAP_FAILED // slippage limit hit or the swap reverted
}

/// @notice A rule as stored by the executor.
/// @dev Trigger logic is expressed in *tick space* so it is exact and direction-agnostic:
///      triggerBelow ? (tick <= triggerTick) : (tick >= triggerTick).
///      The frontend/scripts translate "WETH price <= 2,400 USDC" into the right tick + direction,
///      which depends on which token sorts as currency0.
struct Rule {
    address owner; //            who gets the proceeds / refund
    RuleType ruleType;
    RuleStatus status;
    bool zeroForOne; //          true = sell currency0 for currency1
    bool triggerBelow; //        direction of the crossing
    int24 triggerTick;
    uint16 maxSlippageBps; //    max shortfall vs. spot price at execution, in basis points
    uint128 amountIn; //         tokens deposited at creation, sold on trigger
    bytes32 poolId;
    uint64 createdAt; //         block.timestamp
}
