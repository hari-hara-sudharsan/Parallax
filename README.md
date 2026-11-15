# Parallax

**Keeperless, ~1-second protection for Uniswap v4 traders and LPs.** Set a stop-loss, take-profit, trailing stop or LP
range guard once; a reactive contract on Reactive Omni watches every swap and, the moment the price crosses your line,
calls back and executes, with no bot and no server. One reactive contract guards **Base Sepolia and Unichain Sepolia**.

> Reactive Omni Buildathon · Track 1 *Every Second Counts* · built Nov 2026

| | |
|---|---|
| **Live result** | **44 / 44** live rounds filled · **Base median 7 blocks ≈ 1.4 s** origin swap → execution (p90 2.0 s, fastest 1.0 s) |
| **vs a keeper bot** | Same pool, same crossing swap: a 250 ms-polling bot fills at a median of **10 blocks ≈ 2.0 s** |
| **Real DeFi, not a mock** | Official Uniswap v4 `PoolManager` / `PositionManager` on both chains |
| **Live dashboard** | **[hari-hara-sudharsan.github.io/Parallax](https://hari-hara-sudharsan.github.io/Parallax/)** (static site; connect MetaMask on Base Sepolia) |
| **Proof** | Every origin, reactive and callback tx: [`results/SUMMARY.md`](results/SUMMARY.md) · addresses: [`deployments/addresses.md`](deployments/addresses.md) |

---

## 1. The problem

- **DEXs have no native stop-loss.** AMMs have no order book, so stop-loss and take-profit orders depend on third-party
  keeper bots that someone has to host, fund and trust.
- **Keeper bots fail exactly when it matters.** They go offline, run out of gas, skip unprofitable orders or simply
  arrive late, and a late stop in a fast market fills far below its trigger.
- **Concentrated liquidity drifts out of range.** When the price leaves an LP's range the position stops earning fees.
  Industry analyses of Uniswap-style pools put roughly 30% of concentrated liquidity out of range at a given time, and
  individual wallets fare worst. *(Figures from the project brief; the source link is to be added before submission.)*
- **Depegs punish slow exits.** In the March 2023 USDC depeg, stable pools drained within hours and late exits got far
  worse prices.

All four are races against time.

## 2. Why it needs Omni

Reactive's legacy network had ~7 s blocks plus reorg risk: a reactive guard simply arrived too late. **Omni runs on
CometBFT with ~1 s blocks and instant finality**, so a swap on Base can be seen, decided on and answered with a callback
in a couple of seconds. Parallax measures this on-chain, round after round.

## 3. What it does

| Rule | Fires when | Action |
|---|---|---|
| **Stop-loss** | price falls to your level | sell your deposit |
| **Take-profit** | price rises to your target | sell your deposit |
| **Bracket** | either of the above, whichever comes first | sell your deposit |
| **Trailing stop** | price falls X% below its best level since you armed it | sell your deposit; the stop only ever tightens |
| **Range guard** | your v4 LP position leaves its range | withdraw liquidity + fees to you, **or re-centre it**: re-open a same-width position around the new price and keep guarding it |

Every rule fires on `tick <= lowerTick || tick >= upperTick`; one representation covers all of them.

## 4. How it works

```
 Base Sepolia / Unichain Sepolia               Reactive Lasna                        same chain as the origin
 ┌──────────────────────────────┐   Swap   ┌──────────────────────────────┐ callback ┌────────────────────────────────┐
 │ Uniswap v4 PoolManager       │─────────▶│ ParallaxReactive (one, for   │────────▶│ ParallaxExecutor               │
 │                              │  event   │ every chain)                 │         │  • only the Callback Proxy,    │
 │ ParallaxExecutor             │─────────▶│  • mirrors rules per chain   │         │    only our reactive contract  │
 │  RuleCreated / Cancelled /   │  rule    │  • subscribes to a pool's    │         │  • re-reads the live tick      │
 │  Executed / Skipped / Updated│  events  │    Swap events on demand     │         │  • swaps / withdraws /         │
 └──────────────────────────────┘          │  • on each Swap: decide,     │         │    re-centres                  │
                                           │    request the callback      │         │  • stores the Execution record │
                                           └──────────────────────────────┘         └────────────────────────────────┘
```

1. **Arm**: you deposit tokens (or an LP NFT) into `ParallaxExecutor`; it emits `RuleCreated`.
2. **Mirror**: `ParallaxReactive` receives the event, stores the rule and, if it's the pool's first rule, subscribes
   to that pool's v4 `Swap` events from inside `react()`. When the pool's last rule is gone it unsubscribes, so idle
   pools cost nothing.
3. **Decide**: every `Swap` reaches `react()` about a second later; the contract compares the new tick with the pool's
   rules (bounded: ≤25 rules, ≤3 callbacks per swap, well under the 900k reactive gas cap).
4. **Act**: `SYSTEM.requestCallbackV_1_0` sends the callback to the executor **on the chain that tripped**. The
   executor re-checks the price itself, acts, and writes `executedBlock − originBlock` into storage.

The reactive contract does real work: it holds the order book, decides which rules crossed, schedules trailing-stop
raises, rate-limits itself, and re-arms rules when the executor reports a stale trigger.

Details: [`docs/architecture.md`](docs/architecture.md).

## 5. Deployed contracts (testnet)

| Contract | Chain | Address |
|---|---|---|
| ParallaxReactive v4 (guards both chains; trailing stops + re-centring) | Reactive Lasna (5318007) | [`0x7b8f381783F33Fd75cdF9Dc3AFC1E02fB020e042`](https://lasna.reactscan.net/address/0x7b8f381783F33Fd75cdF9Dc3AFC1E02fB020e042) |
| ParallaxExecutor v4 | Base Sepolia (84532) | [`0x058a746A2719CD0F0d4e29D4EcCC9900B6cF254e`](https://sepolia.basescan.org/address/0x058a746A2719CD0F0d4e29D4EcCC9900B6cF254e) |
| ParallaxExecutor v4 | Unichain Sepolia (1301) | [`0xD83DE781AF09aCC1a2587f9e3A86426FfD36Ec9F`](https://sepolia.uniscan.xyz/address/0xD83DE781AF09aCC1a2587f9e3A86426FfD36Ec9F) |
| ParallaxReactive / Executors v3 (the 44-round benchmark) | Lasna / Base / Unichain | `0x52e2…eC89` / `0x4d4f…Cbf9` / `0x8633…1181` |
| Demo pool mUSDC / mWETH 0.3% (real Uniswap v4) | both | poolId `0xade8c1a3…6f89763c` |

Earlier versions, deploy transactions and every third-party address with its source: [`deployments/addresses.md`](deployments/addresses.md).

## 6. Proof: the full loop, measured

`bench/bench.mjs` runs real rounds end to end: create a rule 0.5% from spot → wait for Lasna to mirror it → make the
crossing swap → wait for the callback → read the executor's on-chain `Execution` record → find the reactive tx.

| Chain | Block time | Rounds | Filled | Median | p90 | Fastest |
|---|---|---|---|---|---|---|
| **Base Sepolia** | 200 ms | 32 | **32/32** | **7 blocks ≈ 1.4 s** | 10 blocks ≈ 2.0 s | 5 blocks ≈ 1.0 s |
| Unichain Sepolia | 1 s | 12 | **12/12** | 2 blocks ≈ 2.0 s | 3 blocks ≈ 3.0 s | 2 blocks |
| *Keeper bot, Base (`bench/keeper.mjs`)* | 200 ms | 20 | 20/20 | *10 blocks ≈ 2.0 s* | *11 blocks* | *8 blocks* |

Block counts are exact (read from contract storage). Wall-clock numbers in the full table are upper bounds (public-RPC
polling). Every round, with explorer links: **[`results/SUMMARY.md`](results/SUMMARY.md)**. A first Unichain run broken by a
benchmark-script bug is kept, with the explanation, in [`results/invalid/`](results/invalid/README.md).

One complete loop on Base Sepolia (a median round):

| ① Origin swap | ② Reactive tx (Lasna) | ③ Callback |
|---|---|---|
| [`0xff4b2163…`](https://sepolia.basescan.org/tx/0xff4b216379d1b7cfc068c32dde537ed30f75ce67909a3aa74614ed2e4ce1aa5a) · block 59015912 | [`0xcae7fcd8…`](https://lasna.reactscan.net/tx/0xcae7fcd8e035bb8940085940d42b55a8fb61b6890c7c5adc0e9afdfc1160b40e) | [`0xef98afe1…`](https://sepolia.basescan.org/tx/0xef98afe15fa08397a209e7c30f3dceac688536cc97bd0248c98bd4a451d440a0) · block 59015919 → **7 blocks ≈ 1.4 s** (take-profit, rule 25) |

**Week 2 live run (v4):** one crash swap fired a **trailing stop (6 blocks ≈ 1.2 s)** and a **self-re-centring LP guard (9 blocks ≈ 1.8 s)** from a single reactive transaction: the LP position was withdrawn, re-opened as a same-width position around the new price, and is guarded again. Details and every tx: [`deployments/tx-proofs.md`](deployments/tx-proofs.md#week-2-live-run-trailing-stop--self-re-centring-lp-guard-v4-base-sepolia-2026-11-15). Earlier single-chain proofs (v1/v2) are in the same file.

## 7. Run it yourself

Full copy-paste guide: **[`docs/setup.md`](docs/setup.md)**. In short:

```bash
git clone --recursive https://github.com/hari-hara-sudharsan/Parallax && cd Parallax
./tw.sh test                       # 75 Foundry tests (unit + fork tests against real Uniswap v4)
./tw.sh rehearse                   # free local rehearsal on a fork, no wallet needed
cp .env.example .env               # add a testnet-only PRIVATE_KEY
CHAIN=base ./tw.sh demo-pool       # tokens + v4 pool + liquidity
./tw.sh deploy-parallax            # reactive on Lasna + executors on Base and Unichain
CHAIN=base ./tw.sh bench 30        # reproduce the benchmark
cd web && npm install && npm run dev   # dashboard on http://localhost:3000
```

`./tw.sh help` lists every task (`make <task>` works too).

## 8. Security considerations

- **Callback auth, both checks**: `execute` / `raiseTrail` require `msg.sender == Callback Proxy`
  (`onlyServiceProvider`) **and** the proxy-injected sender == our reactive contract (`onlyCallbackSender`). The
  library's sender check alone would not verify `msg.sender`.
- **Never trust the callback**: the executor re-reads the pool tick and re-evaluates the rule; a trailing-stop raise
  is computed from the live tick, so a stop can never move further than the price justifies.
- **Idempotent**: a rule executes once; repeats emit `RuleSkipped(NOT_ACTIVE)`.
- **Benign failures don't revert**: a reverted callback is still billed and invisible to the reactive side, so stale
  triggers and slippage misses emit `RuleSkipped` and the reactive contract re-arms the rule.
- **Slippage floors** from the live spot price (swaps) or the exact out-of-range amounts (LP withdrawals).
- **Atomic re-centring** via a self-call wrapped in `try`; balances are measured against a baseline so other users'
  deposits are never touched.
- **Bounded gas**: ≤25 rules per pool, ≤3 callbacks per swap; the re-centre's gas is asserted to fit the callback budget.
- `react()` never reverts as a filter; `block.timestamp` (never block counts) for every timeout.

## 9. Known limitations

- **Testnet only, not audited.** Mock tokens; our own liquidity in the demo pool.
- **Market sells**: a gap through the stop fills at the gapped price, or skips if worse than your slippage cap.
- **No pure cross-chain signal** ("Base price → act on Unichain"): the executor could not re-validate a remote price,
  so each chain's executor acts only on its own pool. One reactive contract still serves both chains.
- **Funding is real**: the reactive contract pays lREACT per reactive tx and each executor pays ETH per callback; any
  debt pauses service (by design of Reactive Network).
- **Trailing-stop raises failed live on v4** (found during the Week 2 run): the raise callback's gas limit (200k) left
  only 24,023 gas after the Callback Proxy's reserve, so `raiseTrail` ran out of gas (`CallbackFailure`, tx
  `0x01fe80b9…`). The stop stayed at its original level, which is safe, and the rule still executed at that level.
  Fixed in code (500k limit + a regression test that replays the exact live budget with cold storage); the
  live re-run needs the next deployment.

## 10. Roadmap

Liquidation shield for Aave positions · depeg exits for stable pools · more pools and chains · gas-sponsored rules ·
mainnet.

---

Repo map: `contracts/` (Foundry: `src/ParallaxExecutor.sol`, `src/ParallaxReactive.sol`) · `web/` (Next.js dashboard) ·
`bench/` (live benchmark + keeper baseline) · `results/` · `deployments/` · `docs/` · `tw.sh` (task runner).
MIT licensed.
