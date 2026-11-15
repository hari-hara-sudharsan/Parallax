# Addresses & chain IDs

Every entry has a source. "On-chain ✅" means code was found at the address via `eth_getCode` on 2026-11-14.

## Networks

| Network | Chain ID | RPC | Explorer | Source |
|---|---|---|---|---|
| Reactive Lasna (testnet) | `5318007` | https://lasna-rpc.rnk.dev/ | https://lasna.reactscan.net/ | [Reactive docs: Mainnet / Lasna](https://github.com/Reactive-Network/documentation/blob/main/docs/docs/reactive-mainnet.mdx) |
| Unichain Sepolia | `1301` (on-chain ✅ `0x515`) | https://sepolia.unichain.org | https://sepolia.uniscan.xyz | [Reactive testnet chain table](https://github.com/Reactive-Network/documentation/blob/main/src/components/origins-destinations-testnet-omni.js), [Unichain network info](https://github.com/Uniswap/docs) |
| Base Sepolia | `84532` (on-chain ✅ `0x14a34`) | https://sepolia.base.org | https://sepolia.basescan.org | Reactive testnet chain table |

## Reactive Network

| Contract | Chain | Address | On-chain | Source |
|---|---|---|---|---|
| System contract (subscribe, requestCallback, depositTo, debt) | Lasna 5318007 | `0x8888888888888888888888888888888888888888` | ⚠️ not checked (Lasna RPC blocked by local firewall) | [reactive-lib-omni AbstractReactive.sol](https://github.com/Reactive-Network/reactive-lib-omni/blob/master/src/base/AbstractReactive.sol), Reactive docs |
| Callback Proxy | Unichain Sepolia 1301 | `0x775c9B990ADe401060B78D0e98684eEf8d2466C1` | ✅ | Reactive testnet chain table |
| Callback Proxy | Base Sepolia 84532 | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` | ✅ | Reactive testnet chain table |
| lREACT faucet (send SepETH) | Ethereum Sepolia | `0x9b9BB25f1A81078C544C829c5EB7822d747Cf434` | — | Reactive docs: Mainnet / Lasna |
| lREACT faucet (send SepETH) | Base Sepolia | `0x2afaFD298b23b62760711756088F75B7409f5967` | — | Reactive docs: Mainnet / Lasna |

## Uniswap v4: Unichain Sepolia (1301)

Source: [Uniswap docs `content/protocols/v4/deployments.mdx`](https://github.com/Uniswap/docs) (commit `1c7597d`).

| Contract | Address | On-chain |
|---|---|---|
| PoolManager | `0x00b036b58a818b1bc34d502d3fe730db729e62ac` | ✅ |
| PositionManager | `0xf969aee60879c54baaed9f3ed26147db216fd664` | — |
| Universal Router | `0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d` | — |
| StateView | `0xc199f1072a74d4e905aba1a84d9a45e2546b6222` | ✅ |
| Quoter | `0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472` | — |
| PoolSwapTest | `0x9140a78c1a137c7ff1c151ec8231272af78a99a4` | ✅ |
| PoolModifyLiquidityTest | `0x5fa728c0a5cfd51bee4b060773f50554c0c8a7ab` | — |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | — |

## Uniswap v4: Base Sepolia (84532)

| Contract | Address | On-chain |
|---|---|---|
| PoolManager | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` | ✅ |
| PositionManager | `0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80` | — |
| Universal Router | `0x492e6456d9528771018deb9e87ef7750ef184104` | — |
| StateView | `0x571291b572ed32ce6751a2cb2486ebee8defb9b4` | — |
| Quoter | `0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba` | — |
| PoolSwapTest | `0x8b5bcc363dde2614281ad875bad385e0a785d3b9` | — |
| PoolModifyLiquidityTest | `0x37429cd17cb1454c34e7f50b09725202fd533039` | — |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | — |

## Event topics (keccak256 computed locally from v4-core `IPoolManager.sol`)

| Event | topic0 |
|---|---|
| `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` | `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` |
| `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)` | `0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec` |
| `Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)` | `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438` |
| Reactive `CallbackRequest(uint256,address,address,uint8,bytes)` | `0xef94dbc611c4b95bf4b8ba34b413972180c2faf26fbb480befacedd83e07b133` |

Phase 1 TODO: re-confirm the Swap topic with `cast sig-event` and against a real PoolManager log once Foundry is installed.

## Our deployments

Scripts write these automatically to `contracts/deployments/<chainId>.json`; copy them here for the submission.

| Contract | Chain | Address | Tx |
|---|---|---|---|
| MockWETH (mWETH) | Unichain Sepolia | _pending_ | |
| MockUSDC (mUSDC) | Unichain Sepolia | _pending_ | |
| Demo pool (poolId) | Unichain Sepolia | _pending_ | |
| TripwireReactive | Lasna | _pending_ | |
| TripwireExecutor | Unichain Sepolia | _pending_ | |
