# Project brief for Claude Code — "Tripwire" (Reactive Omni Buildathon, Track 1)

> ## ⚠️ Phase 0 corrections (verified 2026-11-14, these override the brief below)
> Full details and sources: `docs/research.md`. Addresses: `deployments/addresses.md`.
> 1. **Callbacks are NOT emitted as `emit Callback(...)` events in Omni.** That event is deprecated.
>    Use `SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({chainId, recipient, gasLimit, payload}))`.
> 2. **Reactive base:** `AbstractReactive` (reactive-lib-omni). `SYSTEM = 0x8888…8888`. `react(LogRecord memory log_) external onlySystem`.
>    LogRecord fields are `topic0..topic3`, `contractAddress`, `chainId`, `opCode` (no underscores like legacy `topic_0`).
> 3. **Callback auth needs BOTH modifiers:** `onlyServiceProvider` (msg.sender == Callback Proxy) **and**
>    `onlyCallbackSender(firstArg)` (injected reactive-contract address). The library's `onlyCallbackSender` alone does NOT check msg.sender.
>    The payload's first argument must be an `address` placeholder `address(0)`; the network overwrites it.
> 4. **Callback gas is paid by the destination contract in the destination chain's native ETH**, not REACT.
>    The reactive contract pays for `react()` in lREACT on Lasna. Any debt > 0 stops service on either side.
> 5. **Deployment order is forced:** deploy Reactive → deploy Executor(callbackProxy, reactiveAddr) → owner-only setter on Reactive
>    to set the executor and subscribe to its Rule* events (runtime subscribe is supported) → fund both.
> 6. **Official demos repo is still LEGACY code** (`vm`, `vmOnly`, `emit Callback`), so don't copy from it. `reactive-test-lib` is legacy too
>    (it mocks `0x…fffFfF`). We write our own Foundry mocks of SYSTEM and the Callback Proxy.
> 7. Never revert as a filter inside `react()` (still billed). Reactive tx gas cap is 900,000. Minimum callback gasLimit is 100,000.
> 8. Lasna REACT faucet is funded from **Ethereum Sepolia or Base Sepolia** ETH (1 ETH → 100 lREACT, max 5 ETH/tx), not Unichain.

---

## 0. How I want you to work

- **Verify before you code.** Reactive Omni is new (CometBFT, launched 2026). Your training data may describe the OLD Reactive (RVM, `vm` modifier, ReactVM, precompiles). Those are REMOVED in Omni. Before you write contract code, read the current docs and library:
  - Docs: https://dev.reactive.network/ (start with "Reactive Legacy v Reactive Omni", "Reactive Contracts", "Events & Callbacks", "Reactive Mainnet & Lasna Testnet", "Reactive Library")
  - Library: `forge install Reactive-Network/reactive-lib-omni`
  - Demos: the Reactive-Network GitHub org (look for Omni-compatible examples)
  - Testnet chain list (origin/destination support and Callback Proxy addresses): from the docs
  - Uniswap v4 docs + deployments (PoolManager, PositionManager, Universal Router, StateView, Quoter) for Unichain Sepolia and Base Sepolia
- **Never invent addresses, chain IDs, function signatures or event topics.** Get them from the docs or on-chain, and record them in `deployments/addresses.md` with the source link.
- If a doc contradicts this brief, **the doc wins**. Tell me what changed.
- Work in small phases (section 8). After each phase: run the tests, tell me what works, then stop and wait for my "go".
- I'm a UI/UX designer, not an expert Solidity dev. Explain decisions in 1–2 lines, keep the code readable and well commented, and keep the setup steps copy-pasteable.
- Use Foundry for contracts, and Next.js + TypeScript + wagmi/viem + Tailwind for the frontend.
- Never commit private keys. Use `.env` (gitignored) and `.env.example`.

---

## 1. The hackathon

**Reactive Omni Buildathon**, Nov 5 – Dec 5, 2026. Prizes are paid in REACT.
**My track: Track 1, "Every Second Counts".** Time-sensitive DeFi on **Unichain Sepolia and/or Base Sepolia**. First prize $2,000, runner-up $250.

Omni context: reactive contracts watch events on other chains and act automatically. The old version had ~7s blocks; Omni has **~1s blocks with instant finality** (CometBFT, no reorgs). The track is about strategies that were too slow before.

### Judging (each scored 1–5, equal weight)
1. **Execution:** It must run. Judges want to see **reactive transactions and the callbacks they trigger, on-chain**. No callbacks means the entry isn't scored further. ← HARD GATE
2. **Integration:** The reactive contract must do real work, not be bolted on.
3. **Usefulness:** It solves a problem real users have.
4. **Craft:** Readable code, a working demo, and docs someone else could follow.

### Submission needs
- A public, open-source repo
- Deployed contract addresses
- Several tx hashes showing the **full loop: origin event → reactive tx → callback tx**
- A demo video **under 3 minutes**

### Ground rules
- Everything must be built during the event; prior work only as a dependency.
- **Base Sepolia produces blocks every 200ms, so use `block.timestamp`, never block counts, for any timer, cooldown or deadline.** Apply this everywhere, on every chain.

---

## 2. What we're building: Tripwire

**One line:** keeperless, ~1-second protection for Uniswap v4 traders and LPs. The user sets rules once, and Reactive executes them the moment the price crosses, with no bot or server.

### The real problems it solves (for README and pitch)
1. **DEXs have no native stop-loss.** AMMs have no order book, so stop-loss and take-profit depend on third-party keeper bots.
2. **Keeper bots are fragile.** They go offline, run out of gas, skip unprofitable orders or arrive late (for example, an audit finding on Avantis: bot latency let the price leave the valid range and the limit-close never executed).
3. **LP capital drifts out of range.** Dune's 2026 study of Uniswap v3/v4, PancakeSwap and Aerodrome found ~29–30% of concentrated liquidity out of range (~$542M per average week), costing LPs roughly $150–195M per year in fees. Individual wallets suffer most (on Base, ~30% of wallet capital is out of range vs 6.5% for managed contracts).
4. **Stablecoin depegs punish slow exits.** In the March 2023 USDC depeg, pools drained within hours and late exits got far worse prices.

Why Omni matters: all four are races against time. With ~7s blocks plus reorg risk, a reactive guard was too slow. With ~1s blocks and instant finality, it becomes viable.

### Rule types
| Rule | Trigger | Action |
|---|---|---|
| `STOP_LOSS` | pool price/tick crosses below the user's level | swap the user's token → stable |
| `TAKE_PROFIT` | price/tick crosses above the user's level | swap → stable |
| `RANGE_GUARD` | the pool tick leaves the user's LP range [tickLower, tickUpper] | remove liquidity and re-add centred on the current tick (or just withdraw for the MVP) |
| `DEPEG_EXIT` (stretch) | the stable pool price drops below the threshold (e.g. 0.98) | withdraw LP / swap to the other asset |

---

## 3. Architecture (verify every detail against the Omni docs)

```
 ORIGIN (Unichain Sepolia)            REACTIVE (Lasna testnet)              DESTINATION (Unichain Sepolia)
 ┌────────────────────────┐           ┌───────────────────────────┐         ┌───────────────────────────────┐
 │ Uniswap v4 PoolManager │──Swap────▶│ TripwireReactive.sol      │         │ TripwireExecutor.sol          │
 │  (our demo pool)       │  event    │  - subscribes to Swap     │──Callb.─▶│  - verifies callback sender  │
 │                        │           │    (filtered by poolId)   │         │  - re-checks price on-chain   │
 │ TripwireExecutor       │──Rule─────▶│  - subscribes to Rule*   │         │  - executes swap / LP change  │
 │  emits RuleCreated /   │  events   │    events (mirrors rules) │         │  - marks rule executed        │
 │  RuleCancelled         │           │  - on Swap: check rules   │         │  - emits RuleExecuted(ts)     │
 └────────────────────────┘           │    → request callback     │         └───────────────────────────────┘
                                      └───────────────────────────┘
                                                                     Frontend (Next.js): create rules, live feed,
                                                                     origin → reactive → callback tx + latency
```

### Contracts
1. **`TripwireExecutor.sol`** (destination, Unichain Sepolia; extends `AbstractCallback` from reactive-lib-omni)
   - `createRule(...)`: the user deposits or approves tokens, or hands over an LP position, and the contract stores the rule and emits `RuleCreated(ruleId, owner, poolId, ruleType, triggerTick, params)`.
   - `cancelRule(ruleId)`: refund, emit `RuleCancelled`.
   - `execute(address reactiveSender, uint256 ruleId, ...)`: the **callback entrypoint**. It must:
     - accept calls only from the official Callback Proxy (`onlyServiceProvider`) and only for our reactive contract (`onlyCallbackSender`)
     - **re-validate on-chain** that the condition still holds (read the current price/tick from the v4 PoolManager/StateView). Never trust the callback blindly.
     - be idempotent: a rule can execute only once (status check)
     - enforce slippage protection (minAmountOut, from a user-set max slippage)
     - perform the action (swap via v4, or modify liquidity via PositionManager)
     - emit `RuleExecuted(ruleId, executedAt = block.timestamp, priceTick, amountOut)`
   - Funding: the callback contract pays callback gas in Unichain Sepolia ETH via the Callback Proxy (`depositTo` or `receive` + `coverDebt`). Add a helper script.
2. **`TripwireReactive.sol`** (Reactive Lasna testnet; `AbstractReactive`, **no `vm` modifier, no RVM**)
   - In the constructor or an owner-only init function, subscribe to:
     - PoolManager `Swap` events on Unichain Sepolia, filtered by our `poolId` topic (topic1)
     - TripwireExecutor `RuleCreated` / `RuleCancelled` / `RuleExecuted`, to keep a local mirror of active rules
   - `react(...)`: decode the log. For rule events, update the mirror. For `Swap`, read the new tick/sqrtPrice and check active rules for that pool. For each triggered rule, **request the callback via `SYSTEM.requestCallbackV_1_0`** to the executor, then mark it "pending" locally to avoid duplicate callbacks.
   - Keep the loop bounded (cap the active rules checked per event, e.g. 20) to keep gas predictable. Store rules sorted or bucketed by trigger tick if easy; a simple array is fine for the MVP.
   - Fund it with testnet lREACT per the docs.
3. **Demo helpers (scripts only):** our own test tokens (`MockUSDC`, `MockWETH`), pool creation on Uniswap v4, adding liquidity, and a "push price" script that swaps hard to move the tick across a rule.

### Stretch: cross-chain
Watch the pool on **Base Sepolia** (origin) and execute on **Unichain Sepolia** (destination). This proves real cross-chain reactivity. Build it only after the Must-have works.

---

## 4. Frontend (my strength, so make it polished)

Next.js (App Router) + TypeScript + wagmi/viem + Tailwind. Clean, minimal, dashboard style.

Pages and sections:
1. **Connect + network check** (Unichain Sepolia)
2. **Create rule:** pick the pool, the rule type, and a trigger price (show the price, convert to tick under the hood), amount and max slippage. Show plain-English preview text such as "Sell 1 WETH if price ≤ 2,400 USDC".
3. **My rules:** a list with status chips: Active / Triggered / Executed / Cancelled.
4. **Live activity feed (the hero of the demo):** for each execution show:
   - Origin swap tx (time T0)
   - Reactive tx (Lasna explorer link)
   - Callback / execution tx (time T1)
   - **Latency = T1 − T0 in seconds**, as a big number
5. **Demo panel (testnet only):** a "Crash the price" button that calls the push-price swap, so judges can see the loop live.
6. Explorer links for every tx (Unichain Sepolia explorer + Reactive Lasna explorer, with URLs taken from the docs).

Read events with viem `watchContractEvent` or polling. No backend unless truly needed.

---

## 5. Repo structure

```
tripwire/
├── CLAUDE.md                  # this brief
├── README.md                  # judge-facing docs (see section 7)
├── contracts/                 # Foundry project
│   ├── src/
│   │   ├── TripwireExecutor.sol
│   │   ├── TripwireReactive.sol
│   │   ├── libraries/RuleTypes.sol
│   │   └── mocks/MockERC20.sol
│   ├── script/                # Deploy*.s.sol, CreatePool, AddLiquidity, PushPrice, FundCallback
│   ├── test/                  # unit + fork tests
│   └── foundry.toml
├── web/                       # Next.js frontend
├── deployments/
│   ├── addresses.md           # every address + chain ID + source link
│   └── tx-proofs.md           # full-loop tx hashes for submission
├── docs/
│   ├── research.md            # Phase 0 findings
│   ├── architecture.md        # diagram + flow
│   └── demo-script.md         # the 3-min video script
├── .env.example
└── Makefile                   # make deploy-origin, make deploy-reactive, make demo ...
```

---

## 6. Quality bar

- Solidity `^0.8.29` (matches reactive-lib-omni pragma), with custom errors, events for every state change, NatSpec on public functions, and checks-effects-interactions.
- Security: callback sender authorization (both modifiers), re-validation of conditions on the destination, idempotency, slippage limits, reentrancy guard on execute, no unbounded loops, owner-only rescue for the demo only.
- Tests (Foundry): rule creation and cancellation, execute only by the authorized proxy, execute reverts if the condition no longer holds, no double execution, slippage revert, and unit tests of the reactive `react()` decision logic with mocked log data.
- Time: use `block.timestamp` only, never block numbers.
- Gas: keep `react()` light (hard cap 900k gas per reactive tx).

---

## 7. README (judges read it, so write it for them)

1. One-line pitch + a 30-second GIF or screenshot
2. The problem, with the numbers from section 2 (cite sources)
3. **Why it needs Omni** (~1s blocks + instant finality vs ~7s legacy)
4. How it works: architecture diagram + the event → react → callback flow
5. **Deployed addresses** (table, all chains)
6. **Proof of the full loop:** a table of origin tx → reactive tx → callback tx, plus the measured latency
7. Run it yourself: prerequisites, `.env`, deploy commands, demo commands
8. Security considerations and known limitations
9. Roadmap: liquidation shield for Aave, more pools, mainnet

---

## 8. Build phases (stop after each one for my review)

- **Phase 0, Research (no code):** ✅ done 2026-11-14, see `docs/research.md`.
- **Phase 1, Scaffold:** Foundry + Next.js setup, `.env.example`, Makefile, mock tokens, pool creation + liquidity scripts. Deploy the demo pool on Unichain Sepolia.
- **Phase 2, Core loop (MUST HAVE):** `STOP_LOSS` end to end. Create a rule → push the price → reactive fires → callback executes the swap on-chain. Save the tx hashes to `deployments/tx-proofs.md`. **This phase is the hackathon's hard gate, so nothing else matters until it works.**
- **Phase 3:** `TAKE_PROFIT` + `RANGE_GUARD` (start with withdraw; re-centre if time allows).
- **Phase 4, Frontend:** create rule, my rules, live feed with latency, demo button.
- **Phase 5, Stretch:** `DEPEG_EXIT`, then cross-chain (Base Sepolia origin → Unichain Sepolia destination).
- **Phase 6, Polish:** README, architecture doc, tests passing, demo script, final proofs.

Deadline: submit by **Dec 5, 2026**. Target: Phase 2 done by Nov 20, Phase 4 by Nov 27, polish Nov 28 – Dec 4.

---

## 9. Demo video plan (< 3 min), for `docs/demo-script.md`

1. 0:00–0:20 The problem: "DEXs have no stop-loss; bots fail; ~30% of LP money sits out of range."
2. 0:20–0:40 Why Omni: 7s → 1s, instant finality.
3. 0:40–1:40 Live: create a stop-loss → click "Crash the price" → the feed shows the origin swap, reactive tx and callback, with **latency ≈ X s**.
4. 1:40–2:20 Range guard demo + rules list.
5. 2:20–2:50 Architecture in one slide + explorer proof links.
6. 2:50–3:00 Roadmap + repo link.
