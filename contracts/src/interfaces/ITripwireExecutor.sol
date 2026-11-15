// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {RuleType, SkipReason} from "../libraries/RuleTypes.sol";

/// @title ITripwireExecutor
/// @notice Events + callback entrypoint of the destination contract.
/// @dev TripwireReactive subscribes to these events (topic0 = the event selectors below), so their
///      signatures and indexed layout are part of the cross-chain protocol. Change them in one place only.
interface ITripwireExecutor {
    /// @notice A rule was created and its tokens deposited.
    /// @dev Log layout (LOG4): topic1 = ruleId, topic2 = owner, topic3 = poolId,
    ///      data = abi.encode(ruleType, triggerTick, triggerBelow, zeroForOne, amountIn).
    event RuleCreated(
        uint256 indexed ruleId,
        address indexed owner,
        bytes32 indexed poolId,
        RuleType ruleType,
        int24 triggerTick,
        bool triggerBelow,
        bool zeroForOne,
        uint128 amountIn
    );

    /// @notice The owner cancelled the rule and was refunded.
    event RuleCancelled(uint256 indexed ruleId, address indexed owner);

    /// @notice The rule fired: tokens were swapped and the proceeds sent to the owner.
    /// @param tick Pool tick at execution time (re-read on-chain, not trusted from the callback).
    /// @param originTxHash Hash of the origin Swap tx that tripped the rule (for the latency proof).
    /// @param executedAt block.timestamp of execution (T1 in the latency measurement).
    event RuleExecuted(
        uint256 indexed ruleId,
        address indexed owner,
        int24 tick,
        uint256 amountIn,
        uint256 amountOut,
        uint256 originTxHash,
        uint256 executedAt
    );

    /// @notice A callback arrived but did not execute; the rule stays (or already is) final/active.
    event RuleSkipped(uint256 indexed ruleId, SkipReason reason, int24 tick, uint256 originTxHash);

    /// @notice Callback entrypoint, called by the Reactive Callback Proxy.
    /// @param reactiveSender Overwritten by Reactive Network with the requesting reactive contract's address.
    /// @param ruleId Rule to execute.
    /// @param observedTick Tick the reactive contract saw in the origin Swap (informational only).
    /// @param originTxHash Origin Swap tx hash (as uint256, straight from LogRecord.txHash).
    function execute(address reactiveSender, uint256 ruleId, int24 observedTick, uint256 originTxHash) external;
}
