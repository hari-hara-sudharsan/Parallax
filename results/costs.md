# What a loop costs

Measured 2026-11-21 from 10 filled Base Sepolia benchmark rounds (`results/base-*.json`), using the receipts of each
round's reactive transaction (Lasna) and callback (Base Sepolia). Fee parameters were read live from the chains.

## Fee formula

Reactive bills the contract, not the transaction sender (reactive transactions show a gas price of 0 in receipts):

```
fee = max(gasPrice, baseFee) × coeff / 1000 × (gasUsed + extraGas)
```

| Parameter | Lasna (system contract `0x8888…8888`) | Base Sepolia (callback proxy `0x476F…3585`) |
|---|---|---|
| base fee | 100 gwei | ~0.006 gwei (effective gas price of our callbacks) |
| `coeff` | 1000 | n/a |
| `extraGas` | 100,000 | 80,000 |

## Per transaction

| Leg | Gas used (10 rounds) | Paid by | Cost |
|---|---|---|---|
| Reactive tx for a crossing swap (`react()` decides + requests the callback) | 96,250 – 106,413 | ParallaxReactive, in lREACT | **≈ 0.020 lREACT** |
| Callback that sells the deposit (`execute`) | 213,553 – 229,716 | ParallaxExecutor, in Base Sepolia ETH | **≈ 0.0000000018 ETH** |

## Per full benchmark loop

A loop produces about three reactive transactions: the `RuleCreated` mirror, the crossing swap, and the
`RuleExecuted` confirmation. So a loop costs **about 0.06 lREACT** on Lasna and a negligible amount of ETH on Base.
Swaps in a pool with no armed rules cost nothing, because the reactive contract unsubscribes from a pool when its last
rule is gone.

Budget for a 100-round benchmark: about 6 lREACT, which the official faucet sells for about 0.06 Sepolia ETH
(1 ETH → 100 lREACT).

## Why funding matters

When a reactive contract's reserves cannot cover a bill, it accrues **debt** and Reactive stops delivering events to
it until the debt is paid (`SYSTEM.depositTo` settles debt first). Events that arrive while it is paused are not
replayed. On 2026-11-21 the live v4.1 contract was found in debt (0.0107 lREACT) and revived with
[`0x4e8d90b6…`](https://lasna.reactscan.net/tx/0x4e8d90b6c4d8844857a118f6c2d7086fdb02186be4ab8b7ecd12065ddb0dc81c).
`./tw.sh debts` shows balance, reserves and debt for every contract.
