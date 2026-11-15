# Parallax architecture

## Components

| Contract | Chain | Role |
|---|---|---|
| `ParallaxExecutor` | each origin chain (Base Sepolia, Unichain Sepolia) | Holds deposits / LP NFTs and rules; the **only** place value moves. Callback target. |
| `ParallaxReactive` | Reactive Lasna (one instance) | The brain: mirrors every chain's rules, watches pools, decides, requests callbacks. Holds no user funds. |
| Uniswap v4 `PoolManager` / `PositionManager` | each chain | Official deployments; the price signal (`Swap`) and the execution venue. |
| Reactive `SYSTEM` (`0x8888…8888`) / Callback Proxy | Lasna / each chain | Delivers logs to `react()`; delivers callbacks with the reactive contract's address injected. |

## One execution, step by step

```
User           ParallaxExecutor (Base)      Reactive SYSTEM        ParallaxReactive (Lasna)      Callback Proxy (Base)
 │ createRule ──▶ store rule, take deposit
 │               emit RuleCreated ─────────────▶ react(log) ───────▶ mirror rule; first rule on
 │                                                                   this pool → SYSTEM.subscribe(Swap, poolId)
 │
 │  (anyone swaps on the v4 pool; PoolManager emits Swap(poolId, …, tick))
 │                                                   react(log) ───▶ tick crossed lower/upper?
 │                                                                   pendingSince = now (de-dupe)
 │                                                                   SYSTEM.requestCallbackV_1_0(
 │                                                                     chain, executor, 2M gas,
 │                                                                     execute(0x0, rule, tick, originTx, originBlock))
 │                                                                                    ──────────────▶ execute(reactive, …)
 │               onlyServiceProvider + onlyCallbackSender  ◀──────────────────────────────────────────┘
 │               re-read tick → still crossed? ── no ─▶ emit RuleSkipped ──▶ react → re-arm
 │                                              yes
 │               swap / withdraw / re-centre
 │               store Execution{originTx, originBlock, executedBlock, executedAt}
 │◀── proceeds ── emit RuleExecuted ─────────────▶ react(log) ───────▶ remove from mirror; last rule on
 │                                                                   pool → SYSTEM.unsubscribe
```

## Rule representation

Every rule is `(lowerTick, upperTick)` and fires when `tick <= lowerTick || tick >= upperTick`; either side can be
disabled (`type(int24).min` / `max`). Ticks, not prices, so the check is exact and independent of token order. The
frontend converts prices to ticks (when USDC sorts as currency0, a falling WETH price is a *rising* tick).

| Rule | lowerTick | upperTick |
|---|---|---|
| stop-loss / take-profit | trigger / disabled (or the reverse, depending on token order) | |
| bracket | stop | target |
| trailing stop | `tick − trail`, raised over time | disabled (or the mirror image) |
| range guard on `[tl, tu)` | `tl − 1` | `tu` |

## Trust model

- **The executor trusts nothing it can check.** It re-reads the pool tick on every callback, recomputes trailing-stop
  raises from the live tick, and enforces slippage floors. A compromised or buggy reactive contract could at worst
  *request* executions; it cannot make one fire while the price is inside the band.
- **Authentication** follows the Reactive docs: `msg.sender` must be the chain's Callback Proxy *and* the injected
  first argument must be our `ParallaxReactive`.
- **Why no pure cross-chain trigger** ("Base price → trade on Unichain"): the Unichain executor cannot read a Base
  pool, so it would have to trust the callback's price blindly. Parallax keeps the re-validation guarantee instead: one
  reactive contract serves every chain, and each callback returns to the chain whose pool moved.

## Failure handling

| Situation | What happens |
|---|---|
| Price bounced back before the callback | `RuleSkipped(CONDITION_NOT_MET)`; the reactive side re-arms |
| Slippage floor / swap / mint failed | `RuleSkipped(ACTION_FAILED)`; state restored, rule re-armed |
| Duplicate / late callback | `RuleSkipped(NOT_ACTIVE)`; nothing moves |
| Callback never arrives | the mirror's `pendingSince` times out after 120 s (timestamp) and the rule can fire again |
| Reactive contract out of lREACT | Reactive stops delivering (debt-blocking, by design); `coverDebt()` / `depositTo` revives it |

Benign failures deliberately **do not revert**: a reverted callback is still billed and is invisible to the reactive
contract, which would leave the rule stuck as "in flight".

## Gas budgets

| Path | Measured | Budget |
|---|---|---|
| `react()` on a swap, 25 rules, 3 callbacks (mock system, pessimistic) | ≈ 640k | 900k reactive-tx cap |
| `react()` on Lasna, one real trigger | ≈ 100k | |
| `execute` swap | ≈ 220k | 2M callback limit − ~130k proxy overhead |
| `execute` LP withdraw | ≈ 300k | |
| `execute` LP re-centre (withdraw + swap + mint) | ≈ 900k (asserted in tests) | |
| `raiseTrail` | small | 200k |

## Re-centring, in detail

`recenterSelf` (external, callable only by the executor itself, wrapped in `try`):
1. snapshot the executor's balances (baseline), `DECREASE_LIQUIDITY + TAKE_PAIR` everything to itself, return the
   empty NFT to the owner;
2. new range = same width, centred on `floorToSpacing(tick)`;
3. compute the swap that matches the new range's token ratio at the current price (values in currency0 terms), and
   swap with the rule's slippage floor;
4. mint the new position through Permit2 → PositionManager, held by the executor;
5. refund everything above the baseline to the owner; store a new `RANGE_GUARD` rule for the new position and emit
   `RuleCreated`, so the reactive contract mirrors it before the old rule's `RuleExecuted` removes the old one.

## Data for the dashboard

No indexer: `ParallaxExecutor.executions(ruleId)` gives origin tx + block and executed block + time. The latency in
blocks is one multicall for every rule; the callback tx is the `RuleExecuted` log in `executedBlock` (a one-block
query); the reactive tx is `RuleTriggered(chainId, ruleId)` on Lasna (indexed filter, located from the origin
timestamp because Lasna has no logs API).

## Lint notes

`forge lint src` is clean. Fixed for real: pools whose currencies have no code are rejected (Solmate's safe transfers
would otherwise "succeed" silently on such addresses), `settle()`'s credited amount is checked (a fee-on-transfer
token makes the swap fail cleanly and the rule re-arm), and `nonReentrant` runs first on both callbacks. The categories
excluded in `contracts/foundry.toml` are deliberate:

| Lint | Why it is intentional |
|---|---|
| `block-timestamp` | Every timeout is timestamp-based by requirement (Base makes 200 ms blocks). |
| `calls-loop` | The reactive loop is bounded: ≤ 25 rules per pool, ≤ 3 callback requests per swap. |
| `reentrancy-events`, `reentrancy-no-eth` | All state-changing executor entrypoints are `nonReentrant` and apply effects before interactions; the reactive contract only calls the trusted `SYSTEM`. |
| `unsafe-typecast` | Casts are bounded by construction (timestamps and block numbers to `uint64`, ticks and token amounts within range). |
| `divide-before-multiply` | Rounding a tick down to the tick spacing is the intended behaviour. |
| `uninitialized-local` | `for (uint256 i; …)` relies on the zero default. |
| `solmate-safe-transfer-lib` | Every token the executor transfers is a pool currency that was checked for code at rule creation. |
