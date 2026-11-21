// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title TwoStepOwnable
/// @notice Ownership that can be handed over, in two steps so a typo cannot lose it: the owner proposes a new owner,
///         and the new owner must accept from its own address.
/// @dev Why it exists: v4.1's owner key was exposed during the buildathon and could not be rotated, because the
///      contracts had no way to change owner. With this, a leaked key is retired with two transactions instead of a
///      full redeploy.
abstract contract TwoStepOwnable {
    address public owner;
    address public pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Step 1: propose `newOwner`. Proposing address(0) cancels a pending transfer.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2: the proposed owner accepts.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
