# Demo video script (target 2:50, hard limit 3:00)

**Setup before recording:** dashboard open on **Base**, wallet connected with test tokens, ParallaxReactive and the Base
executor funded (`CHAIN=base ./tw.sh debts`: debt 0), a range-guard LP position minted (`CHAIN=base ./tw.sh
create-range-guard` or `create-recenter-guard`), `results/SUMMARY.md` and one Basescan + one Reactscan tab ready.
Record at 1080p; keep the cursor slow; zoom into the latency number when it lands.

| Time | Screen | Voice-over |
|---|---|---|
| **0:00–0:20** | Hero section, then a static title card "DEXs have no stop-loss." | "On a DEX there's no order book, so stop-losses depend on keeper bots, and bots go offline, run out of gas, or arrive late. About a third of concentrated liquidity sits out of range, earning nothing." |
| **0:20–0:40** | Header chain switch (Base · 200 ms), the "How it works" strip | "Parallax removes the bot. One reactive contract on Reactive Omni watches every Uniswap v4 swap on Base and Unichain. Omni's one-second blocks with instant finality make that fast enough to matter." |
| **0:40–1:15** | **Create a rule → Stop-loss**, show the plain-English preview, click *Arm stop-loss*; My rules shows **Active** | "I arm a stop-loss: sell one WETH if the price falls half a percent. Tokens go into the executor; Reactive mirrors the rule within a second." |
| **1:15–1:45** | **Demo controls → ▼ Crash the price.** Live activity row turns amber "Reactive fired", then green with **≈1.4 s / 7 blocks** | "Anyone sells into the pool. Reactive sees the swap, decides the rule crossed and calls back. The executor re-checks the price on-chain and sells. About seven Base blocks: one and a half seconds, no server." |
| **1:45–2:05** | Click the three tx links (origin on Basescan, reactive on Reactscan, callback on Basescan) | "Every leg is on-chain: the origin swap, the reactive transaction on Lasna, and the callback, with the latency stored in contract storage." |
| **2:05–2:25** | **Trailing** tab (preview text), then **Range guard** with *Re-centre automatically* | "Trailing stops follow the price up and only ever tighten. Range guards can re-centre an LP position around the new price the moment it drifts out, so it keeps earning fees." |
| **2:25–2:45** | `results/SUMMARY.md` table (44/44, Base p50 7 blocks; keeper bot 10 blocks) | "We measured it: 44 out of 44 live rounds filled, median 1.4 seconds on Base, faster than a 250-millisecond keeper bot on the same pool, on real Uniswap v4." |
| **2:45–2:55** | README top + repo URL | "It's open source: contracts, benchmark and dashboard. Next up: Aave liquidation shields and depeg exits. This is Parallax." |

**Fallback if a live run is slow:** keep recording; the amber "Reactive fired · executing" state is itself good footage.
If a round skips (price bounced), show the `RuleSkipped` → re-arm and crash again; it demonstrates the safety logic.
