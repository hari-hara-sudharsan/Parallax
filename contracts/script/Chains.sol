// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Chains
/// @notice Official third-party addresses per chain, so every script works on Unichain Sepolia AND
///         Base Sepolia with no per-chain env vars. Sources (also in deployments/addresses.md):
///         • Uniswap v4: Uniswap docs, content/protocols/v4/deployments.mdx
///         • Callback Proxy: Reactive docs, Omni testnet chain table
///         Code at every address was checked on-chain (eth_getCode) on 2026-11-15.
library Chains {
    uint256 internal constant UNICHAIN_SEPOLIA = 1301;
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant LASNA = 5318007;
    uint256 internal constant LOCAL_FORK = 31337; // ./tw.sh rehearse forks Unichain Sepolia

    struct Addrs {
        address poolManager;
        address positionManager;
        address stateView;
        address poolSwapTest;
        address permit2;
        address callbackProxy;
    }

    error UnsupportedChain(uint256 chainId);

    function get(uint256 chainId) internal pure returns (Addrs memory) {
        if (chainId == UNICHAIN_SEPOLIA || chainId == LOCAL_FORK) {
            return Addrs({
                poolManager: 0x00B036B58a818B1BC34d502D3fE730Db729e62AC,
                positionManager: 0xf969Aee60879C54bAAed9F3eD26147Db216Fd664,
                stateView: 0xc199F1072a74D4e905ABa1A84d9a45E2546B6222,
                poolSwapTest: 0x9140a78c1A137c7fF1c151EC8231272aF78a99A4,
                permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
                callbackProxy: 0x775c9B990ADe401060B78D0e98684eEf8d2466C1
            });
        }
        if (chainId == BASE_SEPOLIA) {
            return Addrs({
                poolManager: 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408,
                positionManager: 0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80,
                stateView: 0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4,
                poolSwapTest: 0x8B5bcC363ddE2614281aD875bad385E0A785D3B9,
                permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
                callbackProxy: 0x476F44b11F5C942c58f4c8E3d0300E5710743585
            });
        }
        revert UnsupportedChain(chainId);
    }
}
