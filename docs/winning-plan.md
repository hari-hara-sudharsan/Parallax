# Parallax: plan to finish 1st in Track 1 (Nov 21 → Dec 5, 2026)

Goal: stop being "one of 15 stop-loss entries". Every claim gets a transaction, a test or a command next to it, and
Parallax offers things no other entry has at the same time. Submit **Dec 4** (one day of buffer). The video is the
user's job and is not part of this plan.

Rule from the brief: we borrow **ideas** from other entries, never their code. Everything gets written fresh, during
the event.

---

## What we take from the field

| Idea | Seen in | What it becomes in Parallax | Phase |
|---|---|---|---|
| Show failures on-chain ("refusal room") | Ripcord, Reflex | Real txs for: unauthorized `execute` reverts, stale trigger → `RuleSkipped` → re-armed, double fire → `NOT_ACTIVE`, in-band swap correctly ignored | B, E |
| Judges run a loop with zero setup | Ripcord tryout, Firebreak simulator | `ParallaxTryout` contract: `arm()` gives the caller a funded stop, `crash(id)` crosses it; rate-limited by timestamp; no server key | D, F |
| Translate seconds into money | Ripcord (10 Oct 2025 1-s candles) | `analysis/what-a-second-buys`: reproducible script, SHA-256-checked Binance data, bps saved at 1.4 s vs 2.0 s bot vs ~7 s legacy | B |
| Derived "old Reactive" latency | Lien, "measures itself" | Extra column built from our measured legs with Lasna's block swapped for 7 s, labelled derived | B |
| Honest statistics | "measures itself" | Nearest-rank percentiles, p99 only with ≥100 samples, failures listed not dropped, clock-skew note | B, E |
| Evidence matrix | Ripcord CLAIMS, Pursestrings | `docs/CLAIMS.md`: every public sentence → tx / test / command | B |
| "For judges" criterion map | Lien | README table: Execution / Integration / Usefulness / Craft → where to look | G |
| Random-order cross-chain fuzzing | Lien, Pursestrings | Invariant suite: rule events, swaps, callbacks, skips delivered in random order | C |
| Mutation testing of guards | Pursestrings (39 mutants), Silence Watch | `script/mutants.sh`: break each guard, a test must fail | C |
| Coverage, Slither, CI | Lien, Tripwire-CB | `forge test` + coverage on every push, Slither triage table | A |
| Sourcify verification | most top entries | Every deployed contract, exact match | A, D |
| One STOP for every chain | Tripwire-CB, Pursestrings | **Panic Exit**: one tx on either chain closes all of the owner's rules on **both** chains via one reactive tx | D |
| Watchdog / retry | Lien, Silence Watch | Cron tick re-arms rules stuck pending > `PENDING_TIMEOUT` even if no new swap arrives | D |
| Funding runway | Silence Watch `fundedUntil`, Pursestrings | Dashboard health: lREACT + callback ETH, debt, "covers ~N more loops", measured cost per loop | B, F |
| Live loop ledger | Reflex | Dashboard table of every loop, newest one re-checked against the executor live | F |
| "What if price moves" simulator | Lien | Drag a price: see which rules would fire, using the contract's own tick math locally | F |
| Read-only `cast` verify block | Ripcord, Proceeds | README section: 4 commands anyone can run, no keys | B |
| Partial / laddered exits *(optional)* | Sentinel #10, AegisDeleverage | Take-profit ladder: 50% at TP1, rest at TP2 | D (cut first) |
| Depeg exit *(optional)* | our own brief | Stop rule on a mUSDC/mUSDT pool, framed as a depeg exit | D (cut second) |

What makes us dominant after this, which no single other entry has all together: real Uniswap v4 on **both** chains ·
measured keeper baseline · 100+ live rounds · cross-chain Panic Exit · LP re-centring guard + managed vault · trailing
stops · zero-setup judge tryout · on-chain refusal proofs · Sourcify + CI + coverage + mutation tests.

---

## Phase A — Fix what's broken (Nov 21–22) · no redeploy

1. Push the 3 local commits (README rewrite, Vercel link, home page fix). Confirm GitHub shows them.
2. Rotate the leaked deployer key: new testnet wallet, move remaining test funds, update `.env`. Never reuse the old one.
3. Make the clone URL, git remote and repo name consistent (`Parallax`).
4. Verify on Sourcify (exact match) every live v4.1 contract: ParallaxReactive, both executors, VaultReactive, Vault, tokens.
   Add a `./tw.sh verify` task.
5. CI (`.github/workflows/test.yml`): build, `forge test` (fork tests via public RPC, with retries), `forge coverage`
   summary as a job artifact; badge in README.
6. Run Slither, then write a triage table (each finding: real / not exploitable / why).
7. Check funding (`./tw.sh debts`) and measure the cost per loop (lREACT and ETH).

**Gate:** CI green, Sourcify links work, GitHub is up to date. Stop and report.

## Phase B — Evidence layer (Nov 22–24) · current deployment

1. **Refusal room** on v4.1, each with a hash: direct `execute()` reverts (`NotAuthorized`); stale trigger →
   `RuleSkipped` → re-armed → filled; double fire → `NOT_ACTIVE`; swap inside the band → reactive tx with no callback.
   Script: `bench/refusals.mjs`.
2. **`docs/CLAIMS.md`**: every number in the README → tx / test / file. A script checks that each tx hash in the docs
   resolves on its explorer.
3. **Bps analysis**: `analysis/what-a-second-buys.py` downloads Binance ETHUSDT 1-s klines for the 10 Oct 2025 crash
   window, checks the SHA-256, computes median / mean / p95 move within 1.4 s, 2.0 s and 7 s. One table plus a
   "$ per $100k" line.
4. **Latency methodology**: nearest-rank percentiles; derived legacy column; Lasna-vs-Base clock-skew note;
   `bench/summary.mjs` updated.
5. **Costs table**: lREACT per reactive tx, ETH per callback, per rule type.
6. **Read-only verify block** for the README (4 `cast` commands).

**Gate:** CLAIMS has no unresolved row; analysis reproducible from a clean clone.

## Phase C — Hardening tests (Nov 24–26) · no redeploy

1. **Ordering invariant suite**: a handler delivers RuleCreated / Cancelled / Swap / callback / Skipped / Executed in
   random order and timing. Invariants: a rule executes at most once, never below its slippage floor, the mirror always
   converges with the executor, pending rules always re-arm.
2. **Debt-pause scenario**: events lost during a pause; behaviour after `coverDebt` is documented and tested.
3. **Callback gas budget tests** for every callback type, replaying the proxy's withheld gas.
4. **Mutation script**: ~25 mutants on the guards (auth, re-check, slippage, single-shot, pending, bounds). Every
   mutant must be caught; results published.
5. Gas table (`forge test --gas-report`) for the README.

**Gate:** all mutants caught, coverage published, CI green.

## Phase D — v5 contracts (Nov 26–29) · ONE redeploy

All contract changes land together, so we redeploy and re-benchmark once.

1. **Panic Exit.** `ParallaxExecutor.panic()` emits `PanicRequested(owner)`. The reactive contract sends one callback
   per chain to `panicExit(owner)`, which closes up to N of the owner's rules (bounded loop, gas-tested, report per
   rule, never reverts on one bad rule). Same chain: instant; other chain: one Reactive hop.
2. **Cron watchdog.** Subscribe to a Cron topic (Cron events come from the legacy system contract `0x…fffFfF`).
   On a tick, re-arm rules pending longer than `PENDING_TIMEOUT`. Unsubscribe while nothing is pending, because every
   tick is billed. No self-callbacks (another team found that Lasna doesn't deliver them).
3. **`ParallaxTryout`** (per chain): holds test-token stock; `arm()` creates a stop 1 tick spacing from spot for
   `msg.sender`; `crash(id)` swaps just past it; a timestamp cooldown and a daily cap; `reset()` re-centres the price.
4. *(optional)* take-profit ladder; *(optional)* depeg pool + rule.
5. **Two-step `transferOwnership`** on both reactive contracts, and the deploy runs from the **new** key (the old
   deployer key was leaked on 2026-11-21 and owns the v4.1 contracts).
6. **Vault deposit pricing:** stop valuing deposits at spot (found in the Phase A review); add a sandwich test.
7. Tests for every new path + fork tests on real v4; mutants extended.
6. Deploy v5 (reactive, both executors, tryouts), Sourcify-verify, fund for the whole judging window. Keep the v3/v4.1
   addresses and proofs as history.

**Cut order if late:** ladder → depeg → Cron watchdog. Panic Exit and Tryout are not cut.
**Gate:** all tests green, v5 verified and funded.

## Phase E — v5 live proof (Nov 29 – Dec 1)

1. Base bench ≥100 rounds (so p99 is honest), Unichain ≥30, keeper baseline ≥50 on the same pool.
2. Burst test: several rules crossed by one swap (shows the 3-callbacks-per-swap cap and the next swap catching up).
3. Panic Exit live: rules on both chains, one tx, both chains closed; per-chain timing.
4. Tryout run from a **fresh wallet** that has only gas.
5. Cron watchdog live: a pending rule re-armed with no swap.
6. Refusal room re-run on v5. Update `results/SUMMARY.md`, `tx-proofs.md`, CLAIMS.

**Gate:** every new claim has a hash.

## Phase F — Dashboard (Dec 1–3)

1. **Judge path ≤ 2 clicks:** connect → "Try it" (Tryout `arm` + `crash`) → watch the 3 hops with a timer.
2. **Live loop ledger:** every recorded loop; the newest one re-checked against the executor on load.
3. **Refusal room page** with explorer links.
4. **What-if slider:** pick a price, see which rules fire (contract tick math, no tx).
5. **Health panel:** balances, debt, measured cost per loop, "covers ~N loops".
6. **Panic button** for connected owners.
7. Latency chart (Parallax vs keeper vs derived legacy). Check every page in a real browser at laptop and phone widths.

**Gate:** a fresh wallet completes the tryout through the UI.

## Phase G — Docs, freeze, submit (Dec 3–4)

1. Restructure the README: lead with **LP guard + vault + Panic Exit** and the "why Omni" money table; stop-loss becomes
   one of the rules. Add the "For judges" table and the verify block.
2. Re-test `docs/setup.md` from a clean clone.
3. Final proof refresh, tag `v5-submission`, check the funding runway covers results day.
4. DoraHacks form: repo, addresses, loop hashes, video link (from the user). Submit **Dec 4**.

---

## Risks

| Risk | Mitigation |
|---|---|
| lREACT runs out during 100+ rounds | Measure cost in Phase A; fill the faucet early; the bench refuses to start without enough budget |
| Redeploy breaks the dashboard or old links | One redeploy only; keep old addresses as history; regenerate ABIs (`./tw.sh abis`) |
| Panic Exit callback runs out of gas | Bounded N, gas test replaying the proxy's withheld gas, limit ≥ 1M |
| Tryout gets abused | Cooldown by timestamp, daily cap, owner `reset()` |
| Public RPC limits slow the bench and CI | Chunked log queries, retries, backoff |
| Scope creep | Cut order above; every phase ends at a gate |
