# Demo video and pitch: step by step (target 2:50, hard limit 3:00)
n> Beginner, click-by-click version: **`docs/demo-walkthrough.md`**.

Everything below uses the live dashboard (https://parallax-kappa-six.vercel.app) and the v5 contracts. Every number
quoted in the voice-over is in `results/` and on-chain, so say them exactly as written.

---

## 1. The day before

| # | Task | How | Done when |
|---|---|---|---|
| 1 | Fund the reactive contract | From the **new** wallet, send ~0.05 Base Sepolia ETH to the lREACT faucet `0x2afaFD298b23b62760711756088F75B7409f5967`, then ask Claude to deposit it | Dashboard **Is it awake?** says **live**, ≥ 100 loops |
| 2 | Gas in the recording wallet | Use the new wallet `0x5bb8…4208`. Needs ~0.005 Base Sepolia ETH and ~0.005 Unichain Sepolia ETH ([Superchain faucet](https://app.optimism.io/faucet)) | MetaMask shows both balances |
| 3 | Add both networks to MetaMask | Open the app; it offers a one-click switch to Base Sepolia and Unichain Sepolia | Both appear in MetaMask |
| 4 | Full rehearsal | Run sections 3 and 4 once end to end, without recording | Every hop turned green |
| 5 | Screen setup | 1920×1080, browser zoom 110%, bookmarks bar hidden, other tabs closed, notifications off (Windows: Focus assist) | Clean screen |
| 6 | Prepare 3 tabs | Tab 1: dashboard landing. Tab 2: `github.com/hari-hara-sudharsan/Parallax`. Tab 3: `results/SUMMARY.md` on GitHub | Tabs open in that order |
| 7 | Recorder | OBS or Xbox Game Bar (Win+G), microphone tested, record a 10-second test | Clear audio, no echo |

## 2. Ten minutes before recording

1. Open the dashboard → **Guards**. **Is it awake?** must say **live** with no debt. If it says "paused" or "low", stop and top up first.
2. Connect MetaMask (new wallet), switch to **Unichain Sepolia**, click **Run a loop yourself → 1 · Arm a stop**, confirm. Leave that rule armed (it is used for Panic Exit in shot 6). Do **not** crash it.
3. Switch back to **Base Sepolia**.
4. Wait at least 60 seconds after any earlier **Arm**: the tryout contract has a 60-second cooldown per wallet.
5. Scroll to the top of the landing page.

## 3. The video, shot by shot

| Time | What to click / show | What to say (read it word for word) |
|---|---|---|
| **0:00–0:15** | Landing page hero. Let the blue loop animate once ("1.4 s · 7 blocks · the median"). | "On a DEX there's no order book. Stop-losses and LP guards depend on keeper bots, and bots go offline, run out of gas or arrive late. About thirty percent of concentrated liquidity sits out of range, earning nothing." |
| **0:15–0:30** | Scroll slowly to **How it works**, then to the **Base / Unichain** tile and click both sides. | "Parallax removes the bot. One reactive contract on Reactive Omni watches every Uniswap v4 swap on Base and Unichain and acts within about a second and a half. Omni's one-second blocks with instant finality are what make that possible." |
| **0:30–0:40** | Click **Open the app**. Point at **Is it awake?** (live, lREACT, loops left). | "This panel shows it's live and funded. A reactive contract in debt stops, so we show the runway openly." |
| **0:40–1:20** | **Run a loop yourself → 1 · Arm a stop**, confirm in MetaMask. Wait for "mirrored on Lasna". Click **2 · Crash it**, confirm. Keep still while hops 1 → 2 → 3 turn green and the latency appears. | "With only gas, anyone can run a real loop. One click arms a funded stop, just under the price. Reactive mirrors it on its own chain. Now I crash the price through it. I don't press anything else. Reactive sees the swap, decides the rule crossed and calls back. The executor re-checks the price on-chain and sells. That was *[read the number]* blocks." |
| **1:20–1:35** | Click the three transaction links in the panel (origin and callback open Basescan, reactive opens Reactscan). Show each for ~3 s. | "Every hop is a real transaction: the swap, the reactive transaction on Lasna, and the callback. The latency is stored in the executor's own contract storage, so anyone can check it." |
| **1:35–1:55** | Scroll to **Panic Exit**. Show "Base 0/1 · Unichain 1" (the rule armed in section 2). Click **Panic: close all**, confirm. Wait for "Unichain: closed … s later". | "One more thing no bot gives you: Panic Exit. One transaction on Base closes everything I have, and Reactive closes my rules on Unichain too, a few seconds later." |
| **1:55–2:10** | Scroll to **What if the price moved?** and drag the slider to −10%, then +10%. | "Here I can drag the price and see which armed rules would fire, using the executor's own trigger test on live rules." |
| **2:10–2:30** | Click **Proof** at the top. Show **What a second is worth**, then scroll to **What it refuses to do**. | "We measured it. Across 174 live rounds the median on Base is 1.4 seconds, faster than a keeper bot on the same pool at 2 seconds. On the October 2025 ETH crash, that speed keeps about three hundred dollars per hundred thousand against old Reactive, in the worst seconds. And these five refusals are real transactions: outsiders can't trigger it, stale triggers are skipped, and nothing sells twice." |
| **2:30–2:45** | Switch to tab 2 (GitHub README), scroll to **For judges**. | "Everything is open source and verified on Sourcify: 119 tests, fuzzing in random order, every mutant caught, and a page mapping each judging criterion to its evidence." |
| **2:45–2:55** | Back to the landing hero. | "Parallax: stops, LP guards and a panic button that never sleep. Next: Aave liquidation shields and more pools." |

Stop recording at 2:55. Check the file length is **under 3:00** before uploading.

## 4. If something goes wrong while recording

| Problem | What to do |
|---|---|
| **Arm** fails with a cooldown error | You armed less than 60 s ago. Wait a minute, try again. |
| "waiting for Lasna to mirror it" for more than 20 s | Lasna is slow. Keep recording. If it passes 60 s, cut and retry; check **Is it awake?** for debt. |
| Hop 2 turns green but hop 3 takes long | Keep recording: the "waiting" state is real footage. Say "the callback is landing". |
| Rule is skipped (price bounced back) | That is the safety logic. Say "the executor saw the price was back and refused to sell; Reactive re-armed it", then crash again. |
| MetaMask on the wrong network | The app shows a switch button; click it. Cut that part in editing. |
| Whole loop slower than ~5 s | Fine to keep. Say the number honestly; the median (1.4 s) is on the Proof page. |

## 5. Live pitch (if presenting to judges in a call)

Same order as the video, with more time per section:
1. **Problem** (30 s): no stop-loss on DEXs, bots fail, ~30% of LP capital out of range.
2. **Live loop** (60 s): Run a loop yourself, read out the blocks.
3. **Panic Exit** (30 s): both chains, one click.
4. **Proof** (45 s): 174 rounds, keeper comparison, money per $100k, refusal room.
5. **Craft** (15 s): Sourcify, CI, 119 tests, mutants, CLAIMS.md.
6. Invite them to try it: "Open the dashboard, connect any wallet with Base Sepolia gas, two clicks."

## 6. Questions judges may ask, and the answers

| Question | Answer |
|---|---|
| "Other entries show lower latency." | "Ours is a median over 174 live rounds, counted in exact blocks from contract storage, failures included. Measured with whole-second timestamps like most entries, our median reads 1 second. Our fastest loops were 0.8 s." |
| "What if a callback fails and there's no new swap?" | "The rule waits 120 seconds, then is re-checked on the next swap. A pool's price only changes on a swap, so the next swap is exactly when acting matters. A timer retry was a planned extra; it's listed in known limitations." |
| "Do you support depeg protection?" | "A stop-loss on a stablecoin pool is a depeg exit: same contract, same loop. A dedicated depeg rule type is on the roadmap." |
| "Why is the reactive contract necessary?" | "It holds the order book for both chains, decides which rules crossed, de-duplicates, raises trailing stops, re-arms stale triggers and relays panics across chains. Without it nothing fires." |
| "What stops someone faking a trigger?" | "The executor accepts calls only from Reactive's callback proxy on behalf of our reactive contract, and re-reads the pool price itself before acting. There's a live transaction of an outsider's call reverting in the refusal room." |
| "What happens if it runs out of funds?" | "Reactive pauses it; events in the meantime are lost. We hit that in our benchmark, documented it, and added `resync` so anyone can repair the mirror. The dashboard shows the runway." |
| "Is it audited / mainnet?" | "Testnet, not audited. Uniswap v4 is real; tokens are mocks. Mainnet is on the roadmap after an audit." |
