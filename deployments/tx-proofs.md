# Full-loop proofs: origin event → reactive tx → callback tx

Each row is one complete, unattended Tripwire execution on testnet. No keeper and no script triggered the callback:
Reactive Network saw the origin event and did the rest.

## Run 1: STOP_LOSS, 2026-11-15 ✅

Rule 1: *sell 1 mWETH if the WETH price drops ~3%* (trigger tick 196556, pool starts at tick 196256 ≈ 3000 USDC/WETH).
In this pool mUSDC sorts as currency0, so a falling WETH price means a **rising** tick.

| Step | Chain | Tx | Block · timestamp | What happened |
|---|---|---|---|---|
| Rule created | Unichain Sepolia | [`0x2d862bf9…6030316`](https://sepolia.uniscan.xyz/tx/0x2d862bf97ecab6a2baed74e009245309b19dc62ee01581f169c8d96e26030316) | | `RuleCreated(1, …)`, 1 mWETH deposited |
| Reactive: mirror | Lasna | [`0xb6844050…173c5fd1`](https://lasna.reactscan.net/tx/0xb68440509ab527f225b03f0c8899148842c84e79492248467ea25cc0173c5fd1) | 8382901 | `RuleMirrored` + subscribed to the pool's `Swap` events (from inside `react()`) |
| **① Origin swap** | Unichain Sepolia | [`0xec2c37a5…7e0ba05e`](https://sepolia.uniscan.xyz/tx/0xec2c37a57b49fb2e17210c391cb9b59e42853a38de8e5b90cd4fef7e7e0ba05e) | 67866435 · **T0 = 1794718863** | 20 mWETH sold, tick 196256 → 197394 (crosses 196556) |
| **② Reactive tx** | Lasna | [`0xb15dead1…bb3df3a9`](https://lasna.reactscan.net/tx/0xb15dead18f90deb0204e3a13cf67127acc9df34fa530e4fb3bdf7683bb3df3a9) | 8382948 · 1794718862¹ | `RuleTriggered(1, …)` + `requestCallbackV_1_0`, gas used 100,727 |
| **③ Callback tx** | Unichain Sepolia | [`0xabeb52f8…bb2e2bc0`](https://sepolia.uniscan.xyz/tx/0xabeb52f84745ad9c8af2ac13372b3216ab978346e03bef227c8ae6d5bb2e2bc0) | 67866437 · **T1 = 1794718865** | `RuleExecuted(1, tick 197450, in 1 mWETH, out 2,661.78 mUSDC, origin 0xec2c…, executedAt T1)` |
| Reactive: cleanup | Lasna | [`0xc1daaaa5…3aaa24899`](https://lasna.reactscan.net/tx/0xc1daaaa508cc7dd4b93a21a2f903504a06c942bb8dda6ae3ccb21543aaa24899) | 8382950 | `RuleRemoved` + unsubscribed from the now-empty pool |

**Latency T1 − T0 = 2 seconds** (2 Unichain blocks after the origin swap), measured on Unichain's own clock.

¹ Lasna and Unichain block clocks differ by about 1 s, so cross-chain timestamps aren't compared directly.

Costs: the reactive tx cost ≈ 0.02 lREACT. The callback cost the executor ≈ 0.00000032 ETH.

## Summary table (for the README / submission)

| # | Rule | Origin tx | Reactive tx | Callback tx | Latency |
|---|---|---|---|---|---|
| 1 | STOP_LOSS | [0xec2c…a05e](https://sepolia.uniscan.xyz/tx/0xec2c37a57b49fb2e17210c391cb9b59e42853a38de8e5b90cd4fef7e7e0ba05e) | [0xb15d…f3a9](https://lasna.reactscan.net/tx/0xb15dead18f90deb0204e3a13cf67127acc9df34fa530e4fb3bdf7683bb3df3a9) | [0xabeb…2bc0](https://sepolia.uniscan.xyz/tx/0xabeb52f84745ad9c8af2ac13372b3216ab978346e03bef227c8ae6d5bb2e2bc0) | **2 s** |

## How to add a row

1. `./tw.sh create-stop-loss`, then `./tw.sh push-down`. The swap tx is the **origin** (T0 = its block timestamp).
2. On Lasna, find the `RuleTriggered` log from `TripwireReactive`:
   `cast logs --address <reactive> $(cast keccak "RuleTriggered(uint256,bytes32,int24,uint256)") --from-block <recent> --rpc-url $LASNA_RPC`
3. On Unichain, find `RuleExecuted` from `TripwireExecutor`. Its data carries the origin tx hash and `executedAt` (T1).
4. Note: `SYSTEM.getCallbacks(reactiveTx)` returned an empty list on Lasna for this run, so we link via the origin hash in `RuleExecuted` instead.
