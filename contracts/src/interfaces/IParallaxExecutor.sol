// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {RuleType, RuleStatus, SkipReason} from "../libraries/RuleTypes.sol";

/// @title IParallaxExecutor
/// @notice Events + callback entrypoint of the destination contract.
/// @dev ParallaxReactive subscribes to these events (topic0 = the event selectors below), so their
///      signatures and indexed layout are part of the cross-chain protocol. Change them in one place only.
interface IParallaxExecutor {
    /// @notice A rule was created (tokens deposited, or LP position NFT handed over).
    /// @dev Log layout (LOG4): topic1 = ruleId, topic2 = owner, topic3 = poolId,
    ///      data = abi.encode(ruleType, lowerTick, upperTick, zeroForOne, amountIn, positionId, trailTicks).
    ///      Fires when tick <= lowerTick || tick >= upperTick (NO_LOWER / NO_UPPER disable a side).
    event RuleCreated(
        uint256 indexed ruleId,
        address indexed owner,
        bytes32 indexed poolId,
        RuleType ruleType,
        int24 lowerTick,
        int24 upperTick,
        bool zeroForOne,
        uint128 amountIn,
        uint256 positionId,
        int24 trailTicks
    );

    /// @notice A trailing stop's bound moved (it only ever tightens). Also emitted unchanged when a raise
    ///         request didn't qualify, so the reactive side can clear its in-flight flag.
    event RuleUpdated(uint256 indexed ruleId, int24 lowerTick, int24 upperTick);

    /// @notice A range guard re-opened its liquidity as a new position centred on the price, guarded by a new rule.
    event RuleRecentered(
        uint256 indexed oldRuleId, uint256 indexed newRuleId, uint256 newPositionId, int24 tickLower, int24 tickUpper
    );

    /// @notice The owner cancelled the rule and got the deposit / position back.
    event RuleCancelled(uint256 indexed ruleId, address indexed owner);

    /// @notice Re-announces that a rule is settled (executed or cancelled), so a reactive mirror that missed the
    ///         original event can drop it. Emitted only by `resync`.
    event RuleSettled(uint256 indexed ruleId, RuleStatus status);

    /// @notice The rule fired and its action completed.
    /// @param tick Pool tick after execution (re-read on-chain, never trusted from the callback).
    /// @param amount0Out currency0 sent to the owner (swap proceeds or refund, or withdrawn liquidity).
    /// @param amount1Out currency1 sent to the owner.
    /// @param originTxHash Hash of the origin Swap tx that tripped the rule (the latency proof link).
    /// @param originBlock Block of that origin Swap on the origin chain (from Reactive's LogRecord).
    /// @param executedAt block.timestamp of execution (T1 in the latency measurement).
    /// @dev When origin and destination are the same chain, `block.number - originBlock` of the tx that
    ///      emitted this event is the exact latency in blocks.
    event RuleExecuted(
        uint256 indexed ruleId,
        address indexed owner,
        int24 tick,
        uint256 amount0Out,
        uint256 amount1Out,
        uint256 originTxHash,
        uint256 originBlock,
        uint256 executedAt
    );

    /// @notice A callback arrived but did not execute (see SkipReason). The reactive side re-arms the rule, except
    ///         for NOT_ACTIVE, which means the rule is already settled, so the reactive side drops its mirror.
    event RuleSkipped(uint256 indexed ruleId, SkipReason reason, int24 tick, uint256 originTxHash);

    /// @notice Callback entrypoint, called by the Reactive Callback Proxy.
    /// @param reactiveSender Overwritten by Reactive Network with the requesting reactive contract's address.
    /// @param ruleId Rule to execute.
    /// @param observedTick Tick the reactive contract saw in the origin Swap (informational only).
    /// @param originTxHash Origin Swap tx hash (as uint256, straight from LogRecord.txHash).
    /// @param originBlock Origin Swap block number (LogRecord.blockNumber), recorded for block-exact latency.
    function execute(
        address reactiveSender,
        uint256 ruleId,
        int24 observedTick,
        uint256 originTxHash,
        uint256 originBlock
    ) external;

    /// @notice Callback: tighten a trailing stop to (current tick ∓ trailTicks). Verified on-chain: the
    ///         executor reads the live tick itself, so a stop can never be moved past what the price justifies.
    function raiseTrail(address reactiveSender, uint256 ruleId, int24 observedTick) external;

    /// @notice The owner pressed Panic on this chain: their rules here were closed in the same transaction, and
    ///         the reactive contract relays the panic to every other chain.
    /// @param closed Rules closed by this call.
    /// @param remaining Active rules the owner still has on this chain.
    event PanicRequested(address indexed owner, uint256 closed, uint256 remaining);

    /// @notice A relayed panic ran on this chain. If `remaining > 0` the reactive contract asks again.
    event PanicExecuted(address indexed owner, uint256 closed, uint256 remaining);

    /// @notice Callback: close all of `owner`'s rules on this chain (relayed from a panic on another chain).
    function panicExit(address reactiveSender, address owner) external;
}
