// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @title MockERC20
/// @notice Testnet-only token with an open faucet `mint`. Used as MockWETH (18 dp) and MockUSDC (6 dp)
///         so the demo pool's liquidity and price are fully under our control.
/// @dev DO NOT deploy to mainnet: anyone can mint.
contract MockERC20 is ERC20 {
    /// @notice Max amount a single `mint` call can create (keeps the faucet from being silly).
    uint256 public immutable MAX_MINT;

    error MintTooLarge(uint256 requested, uint256 max);

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_, decimals_)
    {
        MAX_MINT = 10_000_000 * 10 ** decimals_;
    }

    /// @notice Faucet: mint `amount` tokens to `to`.
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge(amount, MAX_MINT);
        _mint(to, amount);
    }
}
