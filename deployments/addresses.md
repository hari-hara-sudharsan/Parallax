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

> **Naming note:** the project was renamed from its working name *Tripwire* to **Parallax** on 2026-11-15 (another buildathon entry uses that name). Deployments v1/v2 and Runs 1–3 below were made before the rename: same code, same events; only identifiers changed.

## Our deployments

Scripts write these automatically to `contracts/deployments/<chainId>.json`; copy them here for the submission.

| Contract | Chain | Address | Tx |
|---|---|---|---|
| MockWETH (mWETH) | Unichain Sepolia | [`0x6D489Fa6F5c837B79A7FF8Dcc2B488CbD14309A5`](https://sepolia.uniscan.xyz/address/0x6D489Fa6F5c837B79A7FF8Dcc2B488CbD14309A5) | |
| MockUSDC (mUSDC) | Unichain Sepolia | [`0x0bE64D69008Afbef624B2ea7A5062a53E844Dc6c`](https://sepolia.uniscan.xyz/address/0x0bE64D69008Afbef624B2ea7A5062a53E844Dc6c) | |
| Demo pool mUSDC/mWETH 0.3% (poolId) | Unichain Sepolia | `0xade8c1a33dc66fd63e7f08b4af96a01c31ab4c5346a374a5d82d4d3a6f89763c` | |
| **ParallaxReactive v2** (current) | Lasna | [`0xC3C04592057E816EB706eF0E9A9438267537B2A2`](https://lasna.reactscan.net/address/0xC3C04592057E816EB706eF0E9A9438267537B2A2) | [`0x6fa7530f…6196f459`](https://lasna.reactscan.net/tx/0x6fa7530f219136a3f9cbfa5d2d22f113b7f0b32473f96863558b6e658196f459) |
| **ParallaxExecutor v2** (current) | Unichain Sepolia | [`0x87Ce29239B4F63a2C00DDa8F6e058ACDeB9181af`](https://sepolia.uniscan.xyz/address/0x87Ce29239B4F63a2C00DDa8F6e058ACDeB9181af) | [`0xc1fa91d5…3df87d9b1`](https://sepolia.uniscan.xyz/tx/0xc1fa91d53d01974f63e487a5c9ab136ab1be53333b55900e11db66f3df87d9b1) |
| ParallaxReactive v1 (Phase 2, stop-loss only) | Lasna | [`0x6D489Fa6F5c837B79A7FF8Dcc2B488CbD14309A5`](https://lasna.reactscan.net/address/0x6D489Fa6F5c837B79A7FF8Dcc2B488CbD14309A5) | |
| ParallaxExecutor v1 (Phase 2, stop-loss only) | Unichain Sepolia | [`0x4d4f9688CA21f7acD88031BeDAA52579925BCbf9`](https://sepolia.uniscan.xyz/address/0x4d4f9688CA21f7acD88031BeDAA52579925BCbf9) | |

Deployer: `0xACf40822E48ddb5f5220d37beb7d6830dD2DEEb3`. v2 (Phase 3) adds two-sided bounds + RANGE_GUARD; the event
layout changed, so both contracts were redeployed and linked with `setExecutor` ([`0x011d29eb…a191821a`](https://lasna.reactscan.net/tx/0x011d29eb8f7a17bc17fc74065d1196d7cd43f9c4aa75d5e882bb8620a191821a)). (ParallaxReactive and MockWETH share an address because each was the
deployer's first contract (nonce 0) on its own chain.)
