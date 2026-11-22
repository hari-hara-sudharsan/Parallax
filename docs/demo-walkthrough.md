# Demo walkthrough: every step, in order

> Start here. The shorter shot list and judge Q&A are in `docs/demo-script.md`.

This is the click-by-click version of `docs/demo-script.md`. Follow it top to bottom. Each step says what to do and
**what you should see**. If you don't see it, use the "If not" line before going on.

Wallet for everything: the new wallet **`0x5bb83E60a7a05A0e1b077B66412a26306e334208`**. Never use the old leaked one.

---

## Part A. Gas for the wallet (do this 1–2 days before)

The demo sends 3–4 small transactions on Base Sepolia and 2 on Unichain Sepolia. You need test ETH on both.

1. Open MetaMask and select the account ending **…4208**. Click the address at the top to copy it.
2. Open https://app.optimism.io/faucet in your browser.
3. Connect, or paste the address. Choose **Base Sepolia** and request ETH.
   - **You should see:** a success message. After about a minute, MetaMask shows ETH on Base Sepolia.
4. On the same faucet, choose **Unichain Sepolia** and request again.
   - **If the faucet asks for a GitHub or Coinbase login:** that's normal; sign in with your own account. If it refuses, try https://faucet.quicknode.com/unichain/sepolia for Unichain.
5. **Enough:** at least **0.005 ETH on each chain**. One demo uses well under 0.001.

## Part B. Fund Parallax so it stays awake (before Dec 4)

Reactive Network charges lREACT for every reaction. About 55 loops are paid for today. Topping up keeps it running
through judging.

1. In MetaMask, switch to **Base Sepolia**.
2. Click **Send**. Paste this address: **`0x2afaFD298b23b62760711756088F75B7409f5967`** (the official lREACT faucet).
3. Amount: **0.05** ETH. Click **Next**, then **Confirm**.
   - **You should see:** the transaction confirmed. The faucet sends **5 lREACT** to your wallet on Lasna (1 ETH buys 100 lREACT).
4. Tell Claude "faucet sent". Claude deposits it into the reactive contract and checks it.
   - **Done when:** the dashboard panel **Is it awake?** shows about **8 lREACT** and **≈ 130 more loops**.

## Part C. Recorder setup (once)

Using the Xbox Game Bar, which is built into Windows:

1. Press **Windows + G**. The Game Bar opens.
2. In the **Capture** widget, click the gear icon and turn on **Record mic** (or use the microphone button).
3. Press **Windows + Alt + R** to start recording and the same keys again to stop. Videos are saved in **Videos → Captures**.
4. **Test it:** record 10 seconds of yourself talking over the browser, then play it back. Check that the voice is clear and the screen sharp.

Screen settings:
- Display resolution **1920 × 1080** (Settings → System → Display).
- Browser zoom **110%** (Ctrl and +). Hide the bookmarks bar (**Ctrl + Shift + B**).
- Close other tabs. Turn on **Do not disturb** (Settings → System → Notifications) so no pop-ups appear.

## Part D. Open the right tabs (just before recording)

Open exactly these 3 tabs, in this order:
1. **Tab 1:** https://parallax-kappa-six.vercel.app (the landing page)
2. **Tab 2:** https://github.com/hari-hara-sudharsan/Parallax (the README)
3. **Tab 3:** https://github.com/hari-hara-sudharsan/Parallax/blob/main/results/SUMMARY.md (the benchmark table; a backup)

## Part E. Get the dashboard ready (10 minutes before recording)

1. In Tab 1, click **Open the app**.
   - **You should see:** a dark dashboard. On the left edge are three icons: **Guards**, **Vault**, **Proof**. You are on **Guards**.
2. Top right: click **Connect wallet**. MetaMask opens; pick the …4208 account and approve.
   - **You should see:** your short address top right.
3. Top of the page: the switch **Base | Unichain**. Click **Unichain**.
   - If a button **Switch to Unichain** appears top right, click it and approve in MetaMask.
4. Find the panel **Run a loop yourself**. Click **1 · Arm a stop**. MetaMask opens: click **Confirm**.
   - **You should see:** a list starting "0 · Stop armed (rule N)", then "mirrored on Lasna" within about 10 seconds.
   - **Don't** click "2 · Crash it" here. This rule on Unichain is used for the Panic Exit shot later.
5. Click **Base** in the **Base | Unichain** switch. If **Switch to Base** appears top right, click it and approve.
6. Look at **Is it awake?**
   - **You should see:** a green **live** chip, some lREACT, "≈ N more loops" and no debt.
   - **If not** ("paused: in debt" or "low on lREACT"): stop and do Part B first.
7. Wait **one full minute** after step 4. The tryout contract lets each wallet arm once per 60 seconds.
8. Go back to Tab 1 and scroll to the very top of the landing page.

You are ready. Start the recorder (**Windows + Alt + R**).

## Part F. Recording: what to click and say

Speak slowly. Pause one second between scenes; you can trim pauses later. The words in quotes are the voice-over.

### Scene 1 · The problem (0:00–0:15)
- **Do:** stay on the landing page. Let the blue loop animate once ("1.4 s · executed, 7 blocks · the median").
- **Say:** "On a DEX there's no order book. Stop-losses and LP guards depend on keeper bots, and bots go offline, run out of gas or arrive late. About thirty percent of concentrated liquidity sits out of range, earning nothing."

### Scene 2 · The idea (0:15–0:30)
- **Do:** scroll down slowly past **How it works**. Keep going to the tiles under "Everything it guards". On the **Base | Unichain** tile, click **Unichain**, then **Base**.
- **Say:** "Parallax removes the bot. One reactive contract on Reactive Omni watches every Uniswap v4 swap on Base and Unichain and acts in about a second and a half. Omni's one-second blocks with instant finality make that possible."

### Scene 3 · It's live (0:30–0:40)
- **Do:** scroll back up and click **Open the app**. Move the mouse over the **Is it awake?** panel.
- **Say:** "This panel shows Parallax is live and funded. A reactive contract that runs out of funds stops, so we show the runway openly."

### Scene 4 · Run a real loop (0:40–1:20), the most important scene
1. **Do:** in **Run a loop yourself**, click **1 · Arm a stop**, then **Confirm** in MetaMask.
   - **Say while it confirms:** "With only gas, anyone can run a real loop. One click arms a funded stop just under the current price."
2. **Wait** until "mirrored on Lasna" appears (about 5–10 s).
   - **Say:** "Reactive has mirrored the rule on its own chain."
3. **Do:** click **2 · Crash it**, then **Confirm**.
   - **Say:** "Now I push the price through it. From here I don't press anything."
4. **Wait, hands off the mouse,** while hops 1, 2 and 3 turn green and the number appears in the grey box.
   - **Say:** "Reactive sees the swap, decides the rule crossed and calls back. The executor re-checks the price on-chain and sells. That took *[read the number in the box]* blocks."

### Scene 5 · Every hop is on-chain (1:20–1:35)
- **Do:** in the same panel, click the link next to hop **1** (opens Basescan), show it for 3 seconds, and go back. Do the same for hop **2** (opens Reactscan) and hop **3** (Basescan).
- **Say:** "Every hop is a real transaction: the swap on Base, the reactive transaction on Lasna, and the callback back on Base. The latency is stored in the executor's own storage, so anyone can check it."

### Scene 6 · Panic Exit (1:35–1:55)
- **Do:** scroll to **Panic Exit**. It should show **Unichain: 1** active rule (from Part E). Click **Panic: close all … on both chains**, then **Confirm**.
- **Wait** for the line "Unichain: closed 1 in … · N s later".
- **Say:** "One more thing a bot can't give you: Panic Exit. One transaction on Base closes everything I have, and Reactive closes my rules on Unichain too, a few seconds later."
- **If Panic shows 0 active:** the Unichain rule from Part E is missing. Skip this scene; it is also proven in `deployments/tx-proofs.md`.

### Scene 7 · What if the price moved (1:55–2:10)
- **Do:** scroll to **What if the price moved?** Drag the slider slowly to **−10%**, then to **+10%**.
- **Say:** "Here I can drag the price and see which armed rules would fire, using the executor's own trigger test on live rules."

### Scene 8 · The proof (2:10–2:30)
- **Do:** click the **Proof** icon on the left. Show **What a second is worth**. Then scroll down to **What it refuses to do**.
- **Say:** "We measured it. Across 174 live rounds the median on Base is 1.4 seconds, faster than a keeper bot on the same pool at 2 seconds. On the October 2025 ETH crash, that speed keeps about three hundred dollars per hundred thousand against old Reactive in the worst seconds. And these five refusals are real transactions: outsiders can't trigger it, stale triggers are skipped, and nothing sells twice."

### Scene 9 · Open source (2:30–2:45)
- **Do:** switch to Tab 2 (GitHub). Scroll to **For judges: where each criterion is answered**.
- **Say:** "Everything is open source and verified on Sourcify: 119 tests, fuzzing in random order, every mutant caught, and a table mapping each judging criterion to its evidence."

### Scene 10 · Close (2:45–2:55)
- **Do:** switch back to Tab 1 (landing page) and scroll to the top.
- **Say:** "Parallax: stops, LP guards and a panic button that never sleep. Next: Aave liquidation shields and more pools."

Stop the recorder (**Windows + Alt + R**).

## Part G. After recording

1. Open the video from **Videos → Captures** and watch it once.
2. Check the length is **under 3:00**. If it's over, trim the pauses or the waiting time in Scene 4 (Clipchamp, built into Windows, can trim: open it, drag the video in, cut, export at 1080p).
3. Upload to YouTube as **Unlisted** (or Loom). Copy the link.
4. Give Claude the link. Claude adds it to the README and moves the `v5-submission` tag to the final commit.

## If something goes wrong while recording

| What you see | What it means | What to do |
|---|---|---|
| Error mentioning **cooldown** after Arm | You armed less than 60 s ago | Wait a minute and click again; trim it out later |
| "waiting for Lasna to mirror it…" for over 20 s | Lasna is slow right now | Keep recording. After 60 s, stop, check **Is it awake?**, and retry |
| Hops 1 and 2 green, hop 3 slow | The callback is landing | Keep recording and say "the callback is landing" |
| The rule is skipped, not filled | The price bounced back before the callback | Say "the executor saw the price was back and refused to sell, and Reactive re-armed it". Click **Arm another** and repeat |
| MetaMask shows the wrong network | The app is on one chain and MetaMask on another | Click **Switch to Base** (top right); trim it later |
| The number is higher than usual (e.g. 3 s) | Normal spread | Keep it and read it honestly; the median is on the Proof page |
