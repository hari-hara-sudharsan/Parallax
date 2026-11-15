# Full-loop proofs: origin event → reactive tx → callback tx

Each row is one complete Tripwire execution on testnet.

| # | Rule | Origin Swap tx (Unichain Sepolia) · T0 | Reactive tx (Lasna) | Callback / execution tx (Unichain Sepolia) · T1 | Latency T1 − T0 |
|---|---|---|---|---|---|
| _pending first testnet run_ | | | | | |

## How to fill a row

1. `./tw.sh create-stop-loss`, then `./tw.sh push-down`. The push-down tx is the **origin** tx (T0 = its block timestamp).
2. On [Lasna Reactscan](https://lasna.reactscan.net), open the `TripwireReactive` address and find the tx that emitted
   `RuleTriggered(ruleId, …, originTxHash)`. That's the **reactive** tx.
3. `./tw.sh callbacks <reactiveTxHash>` returns the destination tx hash (5th field). That's the **callback** tx, which
   emits `RuleExecuted(ruleId, …, originTxHash, executedAt = T1)`.
4. Latency = `executedAt` − origin block timestamp:
   ```bash
   cast block <originBlock> --field timestamp --rpc-url $UNICHAIN_SEPOLIA_RPC
   ```
