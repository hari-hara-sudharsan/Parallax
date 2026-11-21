# Parallax

[![Contracts](https://github.com/hari-hara-sudharsan/Parallax/actions/workflows/test.yml/badge.svg)](https://github.com/hari-hara-sudharsan/Parallax/actions/workflows/test.yml)

### Your Uniswap v4 positions, guarded from a parallel chain. It exits, re-centres or panics for you within about 1.4 seconds.

Arm a rule once: stop-loss, take-profit, trailing stop, or an LP range guard that **re-centres your liquidity** when the
price leaves it. A reactive contract on **Reactive Omni** watches every swap on **Base Sepolia and Unichain Sepolia** and
acts on the official Uniswap v4 contracts. One **Panic Exit** transaction closes everything you hold, on **both** chains.
No bot, no server, no hot key, and nothing you run has to stay online.

> Reactive Omni Buildathon · Track 1 **Every Second Counts** · built Nov 2026 · MIT

<!-- VIDEO: add the demo video link here, e.g. | **Demo video (2:50)** | https://youtu.be/... | -->

| | |
|---|---|
| ⚡ **Speed** | **Median 7 Base blocks ≈ 1.4 s** from the price-crossing swap to the executed sell (p90 2.0 s, fastest 1.0 s) |
| 💰 **Why seconds matter** | Replaying the 10 Oct 2025 crash, a 1.4 s fill keeps **$325 per $100k** at the worst 5% of seconds vs the same loop on legacy Reactive ([method](results/what-a-second-buys.md)) |
| 🤖 **vs a keeper bot** | Same pool, same crossing swap: a 250 ms-polling bot with a warm RPC needs **10 blocks ≈ 2.0 s**. Parallax is **~30% faster** and needs no infrastructure |
| 🚨 **Panic Exit** | One transaction on either chain closes every rule you have, there, and Reactive closes the rest on the other chain |
| 🌀 **LP that heals itself** | A range guard re-opens your position around the new price instead of leaving it out of range; the `pxLP` vault steps out of crashes and back in |
| 🦄 **Real DeFi** | The official Uniswap v4 `PoolManager` and `PositionManager` on **both** chains, not a mock pool |
| 🧠 **Real reactive work** | The reactive contract holds the order book, decides what crossed, raises trailing stops, re-arms stale triggers and relays panics across chains |
| 🎮 **Try it with only gas** | `ParallaxTryout`: `arm()` gives you a funded stop, `crash(id)` crosses it. Reactive does the rest (first live run filled in **6 blocks ≈ 1.2 s**) |
| 🧪 **Tested to break** | **119 Foundry tests** (fork tests on live v4, invariant fuzzing with lost and reordered events), guards checked by [mutation testing](results/mutants.md), [CI](.github/workflows/test.yml), 93% line coverage, Slither triaged, every contract **Sourcify-verified** |
| 🖥️ **Dashboard** | **[parallax-kappa-six.vercel.app](https://parallax-kappa-six.vercel.app)**: open the app, connect MetaMask on Base Sepolia, arm a stop, press "Crash the price" |

---

## Verify it in 60 seconds

You don't have to trust this README. Pick any row of [`results/SUMMARY.md`](results/SUMMARY.md) and click its three links:

1. **Origin swap** on Basescan: the price crosses a user's line.
2. **Reactive tx** on Reactscan (Lasna): `react()` emits `RuleTriggered` and requests the callback. No one sent this transaction.
3. **Callback** on Basescan: `ParallaxExecutor` re-checks the live price, sells, and writes
   `executedBlock − originBlock` into its own storage.

The latency figures come from that on-chain record, not from our stopwatch.

Or check from a terminal, read-only, no wallet or key (needs Foundry's `cast`):

```bash
RPC=https://sepolia.base.org; EXEC=0x2f772766ec926359093FA2d478FBDdcd828304Ff   # v4.1 executor (rule 1 below)
# 1. The executor's own record of rule 1 (the live trailing stop): origin tx, origin block 59074364,
#    executed block 59074376 (12 blocks later), executed timestamp
cast call --rpc-url $RPC $EXEC "executions(uint256)(uint256,uint64,uint64,uint64)" 1
# 2. Nobody but Reactive can fire a rule: a direct call reverts with NotAuthorized(you, callbackProxy)
cast call --rpc-url $RPC --from 0x000000000000000000000000000000000000dEaD $EXEC \
  "execute(address,uint256,int24,uint256,uint256)" 0x000000000000000000000000000000000000dEaD 1 0 0 0
# 3. The reactive contract on Lasna is funded and has no debt (debt > 0 pauses it)
cast call --rpc-url https://lasna-rpc.rnk.dev/ 0x8888888888888888888888888888888888888888 \
  "debt(address)(uint256)" 0x2FCF8025bC42a2902dA7Ddc46A0F1d617B197cf3
# 4. Every transaction linked in these docs exists on its chain
node bench/check-links.mjs
```

**Run a loop yourself, with only gas.** Any Base Sepolia account can do this; `ParallaxTryout` mints the demo tokens:

```bash
T=0xb56bf536CB864a4A848F00C1b4ebF27c6f1cAe44; RPC=https://sepolia.base.org   # needs Foundry's cast and jq
TX=$(cast send $T "arm()" --rpc-url $RPC --private-key $YOUR_TESTNET_KEY --json | jq -r .transactionHash)
ID=$(cast receipt $TX --rpc-url $RPC --json | jq -r '.logs[] | select(.address == "0xb56bf536cb864a4a848f00c1b4ebf27c6f1cae44") | .topics[2]' | cast to-dec)
echo "your stop: rule $ID"   # wait ~5 s for Lasna to mirror it, then cross it:
cast send $T "crash(uint256)" $ID --rpc-url $RPC --private-key $YOUR_TESTNET_KEY
```

Or `CHAIN=base ./tw.sh tryout`, which does the same and prints the origin, reactive and callback hashes with the latency.

Every claim in this README is mapped to its proof (transaction, test or command) in [`docs/CLAIMS.md`](docs/CLAIMS.md).
What Parallax refuses to do, shown as real transactions: [`results/REFUSALS.md`](results/REFUSALS.md).

---

## 1. The problem

- **DEXs have no native stop-loss.** An AMM has no order book. A stop-loss on Uniswap is a transaction that *someone*
  has to send at the right moment.
- **That "someone" is a keeper bot,** which a person has to host, fund, secure and keep online. Bots go down, run out
  of gas, skip orders that don't pay them, or arrive late. A late stop in a falling market fills far below its trigger.
- **Concentrated liquidity drifts out of range.** When the price leaves an LP's range, the position stops earning fees
  and becomes a one-sided bag. Individual wallets, which have no managers or bots, are the worst affected.
- **Depegs and crashes punish slow exits.** In the March 2023 USDC depeg, stable pools drained within hours and every
  late exit got a worse price.

All four are **races against time**, and today the only way to win them is to run your own bot.

## 2. Why this needs Reactive Omni

On legacy Reactive, a **single block took ~7 s**. That is longer than Parallax's *entire* loop on Omni, and reorg risk
came on top of it. A reactive stop-loss was too slow to beat a bot.

**Omni runs on CometBFT with ~1 s blocks and instant finality.** In one second, a swap on Base is seen, decided on and
answered with a callback:

```
Swap on Base ──▶ react() on Lasna ──▶ callback executes on Base
   T0                ~1 s                 T0 + 1.4 s (median, measured over 32 rounds)
```

With this speed, keeperless protection beats a well-run bot instead of trailing it. And there is nothing for the user
to keep online: no machine, no RPC subscription and no hot key holding funds.

**What a second is worth.** We replayed the worst 30 minutes of the 10 October 2025 crash (ETH −13.9%, Binance
1-second candles, checksum-verified) and asked how far the price fell while a triggered stop waited to fill:

| Fill latency | Loss at the p95 second | vs Parallax, per $100k |
|---|---|---|
| **1.4 s: Parallax (measured)** | **25.4 bps** | — |
| 2.0 s: keeper bot (measured) | 33.5 bps | $81 more |
| 4.4 s: legacy Reactive (derived) | 58.0 bps | $325 more |
| 7.4 s: legacy Reactive, worst case (derived) | 77.2 bps | $517 more |

On an average second the differences are small, because falls and bounces cancel. A stop exists for the bad seconds,
and there Omni's speed is worth hundreds of dollars per $100k. Method and both populations:
[`results/what-a-second-buys.md`](results/what-a-second-buys.md) (`python analysis/what_a_second_buys.py`).
The derived legacy rows add half a block (+3 s) and one block (+6 s) of a ~7 s chain to our measured loop; nothing was
run on legacy Reactive.

## 3. What it does

| Rule | Fires when | Action |
|---|---|---|
| **Stop-loss** | the price falls to your level | sells your deposit |
| **Take-profit** | the price rises to your target | sells your deposit |
| **Bracket** | either of the above, whichever comes first | sells your deposit |
| **Trailing stop** | the price falls X% below its best level since you armed it | sells; the stop **only ever tightens** as the price rises |
| **Range guard** | your v4 LP position leaves its range | withdraws liquidity + fees to you, **or re-centres**: re-opens a same-width position around the new price and keeps guarding it |
| **Panic Exit** | you call `panic()` on either chain | closes all your rules there in the same tx (sells at market within each rule's slippage cap, or refunds); Reactive relays it and closes your rules on the other chain too |

Every rule reduces to one test, `tick <= lowerTick || tick >= upperTick`, so one engine covers all five.

### Parallax Vault: a keeperless managed LP

Deposit both pool tokens once and receive `pxLP` shares. A second reactive contract (the vault's "brain" on Lasna)
watches every swap and keeps a short price history, tracked by timestamp:

| Situation | What the vault does |
|---|---|
| The price drifts out of range | **re-centres** around the new price |
| The price moves ≥ 2% within 60 s (a crash in progress) | **evacuates** all liquidity, so it isn't sold into the move |
| Evacuated, and the market has been calm for 60 s | **re-enters** around the new price |

Honest trade-off: stepping out of a crash avoids being sold into it, but if the price snaps straight back, the vault
re-enters lower. What you gain is time in range and a circuit breaker, not guaranteed profit.

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

1. **Arm.** You deposit tokens (or an LP NFT) into `ParallaxExecutor`, which emits `RuleCreated`.
2. **Mirror.** `ParallaxReactive` stores the rule. If it is the pool's first rule, the contract **subscribes to that
   pool's v4 `Swap` events from inside `react()`**. When the pool's last rule is gone it unsubscribes, so idle pools
   cost nothing.
3. **Decide.** Every `Swap` reaches `react()` about a second later. The contract compares the new tick with the pool's
   rules, with fixed limits: at most 25 rules per pool and 3 callbacks per swap, well under the 900k reactive gas cap.
4. **Act.** `SYSTEM.requestCallbackV_1_0` sends the callback to the executor **on the chain that tripped**. The
   executor re-checks the price itself, acts, and records the latency on-chain.

### The reactive contract does the real work

Take Reactive away and you need a bot again, because these jobs all run on Lasna:

- **It holds the order book.** It mirrors every rule on both chains from the executors' events. Nothing off-chain
  tells it which rule to fire.
- **It decides.** On each swap it determines which rules crossed, and it fires each rule once by marking it pending.
  That matters during a burst of swaps on Base's 200 ms blocks.
- **It manages subscriptions.** It subscribes to a pool when the pool's first rule arrives and unsubscribes when the
  last one goes.
- **It runs trailing stops.** It watches for new highs and requests stop raises, which the executor checks against the
  live tick.
- **It recovers.** When the executor reports a stale trigger (`RuleSkipped`), it re-arms the rule.
- **One contract serves both chains.** A single reactive contract guards Base Sepolia and Unichain Sepolia.

Details: [`docs/architecture.md`](docs/architecture.md).

## 5. Proof: the full loop, measured

`bench/bench.mjs` runs real rounds end to end: create a rule 0.5% from spot → wait for Lasna to mirror it → make the
crossing swap → wait for the callback → read the executor's on-chain `Execution` record → find the reactive tx.

| Chain | Block time | Rounds | Filled | Median | p90 | Fastest |
|---|---|---|---|---|---|---|
| **Base Sepolia** | 200 ms | 32 | **32/32** | **7 blocks ≈ 1.4 s** | 10 blocks ≈ 2.0 s | 5 blocks ≈ 1.0 s |
| **Unichain Sepolia** | 1 s | 12 | **12/12** | 2 blocks ≈ 2.0 s | 3 blocks ≈ 3.0 s | 2 blocks |

Block counts are exact, because they are read from contract storage. Wall-clock figures in the full table are upper
bounds, since they come from polling public RPCs. Every round, with explorer links:
**[`results/SUMMARY.md`](results/SUMMARY.md)**. A first Unichain run broken by a benchmark-script bug is kept, with the
explanation, in [`results/invalid/`](results/invalid/README.md). We don't hide failures.

### Head to head: Parallax vs a keeper bot

`bench/keeper.mjs` is a *good* bot: it polls every 250 ms over a warm RPC connection and holds a funded hot key. It ran
the same stop on the same pool, triggered by the same crossing swap:

| Base Sepolia | Rounds | Filled | Blocks p50 / p90 / min | Seconds p50 |
|---|---|---|---|---|
| **Parallax (on-chain, no bot)** | 32 | 32/32 | **7 / 10 / 5** | **1.4 s** |
| Keeper bot (off-chain) | 20 | 20/20 | 10 / 11 / 8 | 2.0 s |

Parallax was faster **and** removed the server, the hot key and the uptime risk. The benchmark doesn't model the bot's
real-world failures (downtime, gas spikes, skipped orders), so the real gap is larger.

### One complete loop (a median round, Base Sepolia)

| ① Origin swap | ② Reactive tx (Lasna) | ③ Callback |
|---|---|---|
| [`0xff4b2163…`](https://sepolia.basescan.org/tx/0xff4b216379d1b7cfc068c32dde537ed30f75ce67909a3aa74614ed2e4ce1aa5a) · block 59015912 | [`0xcae7fcd8…`](https://lasna.reactscan.net/tx/0xcae7fcd8e035bb8940085940d42b55a8fb61b6890c7c5adc0e9afdfc1160b40e) | [`0xef98afe1…`](https://sepolia.basescan.org/tx/0xef98afe15fa08397a209e7c30f3dceac688536cc97bd0248c98bd4a451d440a0) · block 59015919 → **7 blocks ≈ 1.4 s** |

### Beyond a simple stop: also proven live

| Run | What happened | Latency |
|---|---|---|
| **Two rules, one crash** | One crash swap fired a trailing stop **and** a re-centring LP guard from a single reactive tx. The LP was withdrawn, re-opened around the new price, and guarded again. | 1.2 s / 1.8 s |
| **Trailing stop that follows the price** | The stop was raised twice as the price climbed, each raise requested by Reactive and checked against the live tick. It then fired at the raised level, ~8% tighter than where it started. | 2.4 s |
| **Vault evacuates a crash** | After 90 quiet seconds, a ~9% crash made the vault pull all liquidity; after 60 calm seconds it re-entered. | 1.8 s / 1.6 s |
| **Single-chain v1/v2** | Stop-loss, take-profit and range-guard withdrawals on Unichain | 2–3 s |

Every tx for each run: [`deployments/tx-proofs.md`](deployments/tx-proofs.md).

## 6. Safety: shown, not just claimed

| Guarantee | How | Evidence |
|---|---|---|
| Only Reactive can trigger execution | `execute` / `raiseTrail` require `msg.sender == Callback Proxy` (`onlyServiceProvider`) **and** that the proxy-injected sender is our reactive contract (`onlyCallbackSender`). The library's sender check alone doesn't verify `msg.sender`, so we use both. | Foundry auth tests |
| A stale trigger can't force a bad sale | The executor re-reads the pool tick and re-evaluates the rule. If the price bounced back, it emits `RuleSkipped` and Reactive re-arms the rule. | Tests + live re-arm path |
| Never executes twice | Rules are single-shot; a repeat emits `RuleSkipped(NOT_ACTIVE)` | Tests |
| Slippage-capped | Floors come from the live spot price (swaps) or from the exact out-of-range amounts (LP withdrawals) | Tests |
| Trailing stops can't be moved too far | A raise is computed from the **live** tick, so a stop never moves further than the price justifies | Live v4.1 run |
| Benign failures don't revert | A reverted callback is still billed and is invisible to the reactive side, so the executor reports misses as events instead | Design + tests |
| Re-centring is atomic | Self-call wrapped in `try`; balances measured against a baseline, so other users' deposits are never touched | Fork tests on real v4 |
| Bounded gas | ≤ 25 rules per pool, ≤ 3 callbacks per swap; the re-centre's gas is asserted to fit its callback budget | Tests |
| Timers use time, not blocks | `block.timestamp` for every window and timeout (Base produces a block every 200 ms) | Code |

**Tests and static analysis:** 93 Foundry tests, **93% line / 75% branch coverage**
([`results/coverage.md`](results/coverage.md)), run in CI on every push. Slither reports 73 results, none exploitable;
each is triaged in [`results/slither-triage.md`](results/slither-triage.md).

**Bugs we found live, and fixed:**
- On v4, a trailing-stop raise ran out of gas: its 200k limit left only 24,023 gas after the Callback Proxy's reserve.
  v4.1 raises the limit to 500k and adds a regression test that replays that exact budget. Verified live.
- The v1 vault brain re-centred *into* a crash on a quiet pool. It now always compares against the last price it saw
  (`test_crashAfterQuietSpell_stillEvacuates`), and v2 evacuated on the first try.

## 7. Deployed contracts (testnet)

All live contracts are **source-verified on Sourcify with an exact match**:
[verification table](deployments/addresses.md#source-verification-sourcify-exact-match).

| Contract | Chain | Address |
|---|---|---|
| **ParallaxReactive v5** (guards both chains, relays Panic Exit) | Reactive Lasna (5318007) | [`0x2FCF8025bC42a2902dA7Ddc46A0F1d617B197cf3`](https://lasna.reactscan.net/address/0x2FCF8025bC42a2902dA7Ddc46A0F1d617B197cf3) |
| **ParallaxExecutor v5** | Base Sepolia (84532) | [`0x98f96fd0b1cb9B723157D3686446004EcA066982`](https://sepolia.basescan.org/address/0x98f96fd0b1cb9B723157D3686446004EcA066982) |
| **ParallaxExecutor v5** | Unichain Sepolia (1301) | [`0x391eecF06CA701b891498040D1CEFed90d500030`](https://sepolia.uniscan.xyz/address/0x391eecF06CA701b891498040D1CEFed90d500030) |
| **ParallaxTryout** (try it with only gas) | Base Sepolia (84532) | [`0xb56bf536CB864a4A848F00C1b4ebF27c6f1cAe44`](https://sepolia.basescan.org/address/0xb56bf536CB864a4A848F00C1b4ebF27c6f1cAe44) |
| **ParallaxTryout** | Unichain Sepolia (1301) | [`0xacD95E9891d4C29871b643e3C5bF99a3D4d20AFA`](https://sepolia.uniscan.xyz/address/0xacD95E9891d4C29871b643e3C5bF99a3D4d20AFA) |
| **ParallaxVaultReactive v3** (vault brain) | Reactive Lasna (5318007) | [`0xca72ebe1E4BD79323EC0bBbc2dd1188999B39a2c`](https://lasna.reactscan.net/address/0xca72ebe1E4BD79323EC0bBbc2dd1188999B39a2c) |
| **ParallaxVault v3** (`pxLP`) | Base Sepolia (84532) | [`0x9c868A6e74a1D00cc0cD1524AED57c35515c4899`](https://sepolia.basescan.org/address/0x9c868A6e74a1D00cc0cD1524AED57c35515c4899) |
| Demo pool mUSDC / mWETH 0.3% (real Uniswap v4) | both | poolId `0xade8c1a3…6f89763c` |
| v4.1 (refusal room, trailing raises) | Lasna / Base / Unichain | `0xDf55…e334` / `0x2f77…04Ff` / `0x5F41…109D` |
| v4 (first live trailing + re-centre run) | Lasna / Base / Unichain | `0x7b8f…e042` / `0x058a…254e` / `0xD83D…Ec9F` |
| v3 (the 44-round benchmark) | Lasna / Base / Unichain | `0x52e2…eC89` / `0x4d4f…Cbf9` / `0x8633…1181` |

Full addresses, deploy transactions and every third-party address with its source:
[`deployments/addresses.md`](deployments/addresses.md).

## 8. Run it yourself

Full copy-paste guide: **[`docs/setup.md`](docs/setup.md)**. In short:

```bash
git clone --recursive https://github.com/hari-hara-sudharsan/Parallax && cd Parallax
./tw.sh test                       # 93 Foundry tests (unit + fork tests against real Uniswap v4)
./tw.sh rehearse                   # free local rehearsal on a fork, no wallet needed
cp .env.example .env               # add a testnet-only PRIVATE_KEY
CHAIN=base ./tw.sh demo-pool       # tokens + v4 pool + liquidity
./tw.sh deploy-parallax            # reactive on Lasna + executors on Base and Unichain
CHAIN=base ./tw.sh bench 30        # reproduce the benchmark
CHAIN=base ./tw.sh keeper 20       # reproduce the keeper-bot baseline
cd web && npm install && npm run dev   # dashboard on http://localhost:3000
```

`./tw.sh help` lists every task (`make <task>` works too).

## 9. Known limitations

- **Testnet only, not audited.** The tokens are mocks and the demo pool holds our own liquidity. The pool itself is
  real Uniswap v4.
- **Market sells.** A gap through the stop fills at the gapped price, or skips if that is worse than your slippage cap.
  It never fills at a price you didn't allow.
- **No pure cross-chain signal** (Base price → act on Unichain), by design: an executor can't re-validate a remote
  price, so each executor acts only on its own chain's pool. One reactive contract still serves both chains.
- **Funding is real.** The reactive contract pays lREACT per reactive tx and each executor pays ETH per callback. Any
  debt pauses service, which is how Reactive Network is designed. Measured: ≈ 0.020 lREACT per reactive tx, ≈ 0.06 lREACT
  per full loop, a negligible amount of ETH per callback ([`results/costs.md`](results/costs.md)).
- **Events sent during a debt pause are lost, not queued.** Our fuzzing found what that does to v4.1: a missed
  `RuleExecuted` makes a dead rule refire on every swap, and a missed `RuleCreated` means a rule never fires. The fix
  is in `main` and ships with v5: the reactive contract drops a rule when the executor answers `NOT_ACTIVE`, and
  anyone can call `executor.resync(ruleId)` after a pause to re-announce a rule's state.
- **Vault deposits use the spot price.** A deposit is valued at the pool's current price, so a deposit sandwiched by
  two swaps could mint extra shares. A time-weighted reference is planned (see the Slither triage).
- **Vault scope:** one pool, one range width and fixed tuning (±3%, a 2% breaker, 60 s). A fast round trip can leave it
  behind a passive LP.

## 10. Roadmap

Depeg exits for stable pools · liquidation shield for Aave positions · more pools and chains · gas-sponsored rules ·
mainnet.

---

**Repo map:** `contracts/` (Foundry: `src/ParallaxExecutor.sol`, `src/ParallaxReactive.sol`, the vault) · `web/`
(Next.js dashboard) · `bench/` (live benchmark + keeper baseline) · `results/` · `deployments/` · `docs/` · `tw.sh`
(task runner). MIT licensed.
