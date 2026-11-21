# Claims and evidence

Every factual claim in the README, with the kind of proof behind it and where to check it. **tx** = a transaction you
can open in an explorer, **test** = a Foundry test, **cmd** = a command you can run, **doc** = our own write-up
(weakest: you are trusting our reading).

All linked transactions are checked automatically: `node bench/check-links.mjs` asks each chain's public RPC for
every transaction linked anywhere in the docs (198 of 198 found on 2026-11-21).

## Speed

| Claim | Proof | Where |
|---|---|---|
| Median **7 Base blocks ≈ 1.4 s** from the crossing swap to the executed sell (32 rounds) | tx, on-chain record | [`results/SUMMARY.md`](../results/SUMMARY.md): every round with its 3 hashes. Block counts are `executedBlock − originBlock` from the executor's own `Execution` storage. |
| p90 10 blocks ≈ 2.0 s, fastest 5 blocks ≈ 1.0 s | tx | same table |
| Unichain: median 2 blocks ≈ 2.0 s (12 rounds) | tx | same table |
| 44 / 44 benchmark rounds filled | tx | same table |
| A 250 ms-polling keeper bot on the same pool needs 10 blocks ≈ 2.0 s (20 rounds) | tx | `results/keeper-base-*.json`, summarised in `results/SUMMARY.md` |
| On legacy Reactive (~7 s blocks) the same loop would take ~4.4 s on average, ~7.4 s at worst | **derived** | `results/SUMMARY.md` ("Why it needs Omni"): our measured loop plus half / one legacy block. Nothing was run on legacy Reactive. |
| In the worst 30 minutes of the 10 Oct 2025 crash, a 1.4 s fill keeps 32.5 bps at the p95 (~$325 per $100k) vs the derived legacy average | cmd | `python analysis/what_a_second_buys.py` → [`results/what-a-second-buys.md`](../results/what-a-second-buys.md). Binance data, SHA-256 checked. |

## What the reactive contract does

| Claim | Proof | Where |
|---|---|---|
| It mirrors every rule on both chains from the executors' events | test, tx | `ParallaxReactive.t.sol`; `RuleMirrored` events on [Reactscan](https://lasna.reactscan.net/address/0xDf554201dec784F0541FA5fc884240c73113e334) |
| It subscribes to a pool's `Swap` events from inside `react()` when the first rule arrives, and unsubscribes when the last one goes | test, tx | `test_ruleCreated_mirrorsRule_andWatchesPool`, `test_cancel_removesRule_andUnwatchesEmptyPool`; `PoolWatched` / `PoolUnwatched` events |
| One reactive contract serves Base Sepolia and Unichain Sepolia | tx | `addChain` txs in [`deployments/addresses.md`](../deployments/addresses.md) |
| It fires each rule once while a callback is in flight | test, tx | `test_pendingRule_notRefiredOnNextSwap`; dedupe row in [`results/REFUSALS.md`](../results/REFUSALS.md) |
| It raises trailing stops, and the executor checks each raise against the live tick | tx | "Week 2, part 2" in [`deployments/tx-proofs.md`](../deployments/tx-proofs.md) |
| It re-arms a rule after a stale trigger | test, tx | `test_skipped_rearmsRule`, `test_pendingTimeout_rearmsByTimestamp`; stale row in `results/REFUSALS.md` |
| One crash swap fired a trailing stop and a re-centring LP guard from one reactive tx | tx | "Week 2 live run" in `deployments/tx-proofs.md` |
| The vault evacuates a crash and re-enters after calm | tx, test | vault runs in `deployments/tx-proofs.md`; `ParallaxVault.t.sol` |

## Safety

| Claim | Proof | Where |
|---|---|---|
| Only the Callback Proxy, carrying our reactive contract, can call `execute` / `raiseTrail` | test, tx | `test_execute_rejectsDirectCaller`, `test_execute_rejectsOtherReactiveContract`, `test_trailing_raiseAuth`; outsider call reverting with `NotAuthorized` in `results/REFUSALS.md` |
| The executor re-reads the live tick and skips a stale trigger | test, tx | `test_execute_skipsWhenPriceRecovered`, `test_fullLoop_staleCallbackRearms`; stale row in `results/REFUSALS.md` |
| A swap that stops short of the line requests no callback | tx | in-band row in `results/REFUSALS.md` (the Lasna reaction is found by its input, and its receipt has no `CallbackRequest`) |
| Never executes twice | test | `test_execute_noDoubleExecution`, `test_execute_cancelledRule_isSkipped` |
| Slippage-capped | test | `test_execute_slippageExceeded_skipsAndKeepsDeposit` |
| Bounded gas: ≤ 25 rules per pool, ≤ 3 callbacks per swap | test | `test_callbacksPerEventAreCapped`, `test_gas_fullPoolSwapStaysFarBelowReactiveCap`, `test_raiseTrail_fitsTheProxyGasBudget` |
| Timers use `block.timestamp`, not block numbers | code | `PENDING_TIMEOUT` in `ParallaxReactive.sol`; the vault brain's windows |
| 119 tests (93% line / 75% branch coverage at v4.1) | cmd | `./tw.sh test`; [`results/coverage.md`](../results/coverage.md); CI on every push |
| Slither: 73 results, none exploitable | cmd, doc | [`results/slither-triage.md`](../results/slither-triage.md) |
| Every live contract is source-verified | cmd | Sourcify table in `deployments/addresses.md` |

## v5 features

| Claim | Proof | Where |
|---|---|---|
| One `panic()` closes all of the caller's rules on that chain in the same tx | test | `test_panic_closesEveryRuleHere`, `test_panic_onlyClosesYourOwnRules`, `test_panic_skipsSettledRules` |
| Reactive relays the panic and the other chain's rules close too | test | `test_fullLoop_panicAcrossTwoChains` (second executor registered as a second chain, real recorded logs), `test_panic_relaysToEveryOtherChain` |
| A sale that can't meet its slippage cap refunds the deposit instead | test | `test_panic_saleFails_refundsDeposit` |
| A panic is bounded and always fits its callback gas (6 closes ≈ 645k of 3M) | test | `test_panic_boundedPerCall_thenFinishes`, `test_panicExit_fitsItsCallbackGas`, `test_panic_continuesWhileRulesRemain_thenStops` |
| `panicExit` is only callable by the Callback Proxy carrying our reactive contract | test | `test_panicExit_auth_andCloses` |
| A wallet with only gas can run a full loop through `ParallaxTryout` | tx, test | "v5 live" in [`deployments/tx-proofs.md`](../deployments/tx-proofs.md) (filled 6 blocks after the crash); `test_fullLoop_tryout` |
| Vault deposits can't be sandwiched | test | `test_deposit_sandwichGainsNothing`, `test_deposit_pullsOnlyProportionalAmounts` |
| A leaked owner key can be retired | test | `test_ownership_twoStepTransfer` |
| Events lost during a debt pause can't leave a rule firing forever or never | test | `test_debtPause_missedExecuted_staleRuleIsDroppedNotRefired`, `test_debtPause_missedCreated_recoveredByReannounce`, `test_debtPause_missedCancelled_recoveredByRuleSettled`, `test_resync_reannouncesActiveAndSettledRules`; invariant suite with lost logs |
| The reactive contract converges with the executor under random, late, duplicated and lost events | test | `ParallaxReactive.invariant.t.sol` |
| Every guard is actually tested | cmd | `python contracts/mutation/mutants.py` → [`results/mutants.md`](../results/mutants.md) |

## Costs

| Claim | Proof | Where |
|---|---|---|
| ≈ 0.020 lREACT per reactive tx, ≈ 0.06 lREACT per full loop | tx, cmd | [`results/costs.md`](../results/costs.md), from 10 round receipts and live fee parameters |

## Known gaps (stated, not hidden)

Vault deposits use the spot price; the reactive contracts cannot change owner; fills are market sells; testnet only,
not audited. Details: README "Known limitations" and `results/slither-triage.md`.
