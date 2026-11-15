# Tripwire dashboard

Next.js 15 (App Router) · TypeScript · wagmi 2 / viem 2 · Tailwind. No backend: everything is read straight from
Unichain Sepolia, Reactive Lasna and Blockscout in the browser.

```bash
npm install
npm run dev        # http://localhost:3000
npm run smoke      # checks every live data path the UI uses, no browser needed
```

It works out of the box against the live testnet deployment (addresses in `src/lib/deployment.ts`). To point it at
your own deployment, copy `.env.local.example` to `.env.local` and fill in the `NEXT_PUBLIC_*` values from
`contracts/deployments/*.json`.

## What's on the page

| Section | What it does | Data source |
|---|---|---|
| Hero | Live mWETH/mUSDC price + the last trigger→execution latency (big number) | StateView `getSlot0` every 2 s; activity feed |
| Create a rule | Stop-loss / take-profit by **price** (converted to ticks), or guard an LP NFT; plain-English preview; auto-adds approvals | `TripwireExecutor.createRule` / `createRangeGuard` |
| Live activity | Each execution followed across chains: ① origin swap → ② reactive tx → ③ callback, latency T1−T0 | Lasna `RuleTriggered` + Unichain `RuleExecuted` (RPC tail) + Blockscout history |
| My rules | Your rules with status chips: Active / **Triggered** (callback in flight) / Executed / Cancelled | `getRule(1..n)` + the Lasna mirror's `pendingSince` |
| Demo controls | Free test tokens, **Crash** / **Pump** the price with a real v4 swap | `MockERC20.mint`, `PoolSwapTest.swap` |

## How the feed joins the two chains

The origin swap's tx hash travels through the whole loop: `TripwireReactive` emits it in `RuleTriggered` on Lasna, and
`TripwireExecutor` emits it in `RuleExecuted` on Unichain. The feed joins on it. Lasna has no public logs API, so for
older executions the reactive tx is found by estimating the Lasna block from the origin timestamp (Lasna makes about
1 block per second) and scanning ±300 blocks around it.

## Design tokens

Dark, one colour per state, used consistently: **blue** active · **amber** triggered / in flight · **green**
executed · **grey** cancelled · **red** danger. Numbers are tabular mono so ticking values don't jitter. Tokens live in
`src/app/globals.css` (RGB triplets) and `tailwind.config.ts`.

## Keeping ABIs in sync

`src/lib/generated/abis.ts` is generated from the Foundry build:

```bash
./tw.sh abis   # from the repo root
```
