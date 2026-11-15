# Setup (copy-paste)

All commands run from the repo root in **Git Bash** (Windows) or any terminal (macOS/Linux).
`./tw.sh <task>` and `make <task>` do the same thing.

## 1. Tools

```bash
# Foundry (forge, cast, anvil)
curl -L https://foundry.paradigm.xyz | bash
foundryup
# Node 20+ for the frontend
node --version
```

## 2. Get the code + dependencies

```bash
git clone <repo-url> parallax && cd parallax
./tw.sh install          # git submodules: forge-std, reactive-lib-omni, v4-periphery
./tw.sh build
./tw.sh test
cd web && npm install && cd ..
```

## 3. Free local rehearsal (no wallet, no gas)

Runs the whole demo-pool flow (deploy tokens → create v4 pool → add liquidity → crash the price)
against a **local fork** of Unichain Sepolia using the real Uniswap v4 contracts:

```bash
./tw.sh rehearse
```

## 4. Wallet + testnet funds

1. Create a **fresh, testnet-only** wallet (e.g. a new MetaMask account) and export its private key.
2. `cp .env.example .env` and set `PRIVATE_KEY=0x…`
3. Fund it:
   | Need | Amount | Where |
   |---|---|---|
   | Unichain Sepolia ETH | ~0.05 | [Superchain faucet](https://app.optimism.io/faucet) · [QuickNode](https://faucet.quicknode.com/unichain/sepolia) · [thirdweb](https://thirdweb.com/unichain-sepolia-testnet) |
   | Base Sepolia (or Sepolia) ETH | ~0.1 | Superchain faucet (used to buy lREACT) |
   | lREACT on Lasna | ~10 | send Base Sepolia ETH to `0x2afaFD298b23b62760711756088F75B7409f5967` (1 ETH → 100 lREACT, **max 5 ETH/tx**) |
4. Check: `./tw.sh wallet`

## 5. Deploy (Base Sepolia + Unichain Sepolia, one reactive contract)

Every chain task takes `CHAIN=base` or `CHAIN=unichain` (default). Official addresses for both chains are built in
(`contracts/script/Chains.sol`), so there is nothing to configure per chain.

```bash
CHAIN=base     ./tw.sh demo-pool      # mock tokens + v4 pool + liquidity on Base Sepolia
CHAIN=unichain ./tw.sh demo-pool      # …and on Unichain Sepolia
./tw.sh deploy-parallax               # ParallaxReactive (Lasna) → executor on each chain → addChain for each
CHAIN=base ./tw.sh debts              # balances / reserves / debt (any debt > 0 stops service)
```

Try it by hand:

```bash
CHAIN=base ./tw.sh create-stop-loss   # sell 1 mWETH if WETH drops 3%
CHAIN=base ./tw.sh push-down          # crash the price → the callback executes it
CHAIN=base ./tw.sh rule 1             # status + the on-chain execution record (origin/executed blocks)
```

Or measure it automatically:

```bash
CHAIN=base ./tw.sh bench 30           # 30 live rounds → results/SUMMARY.md (p50/p90 in blocks + seconds)
```

Addresses are saved to `contracts/deployments/<chainId>.json`.

## 6. Frontend

```bash
cd web
npm install
npm run dev        # http://localhost:3000. Works against the live testnet deployment out of the box.
npm run smoke      # optional: checks every live data path without a browser
```

In MetaMask, use the same wallet, switch to **Unichain Sepolia** (the app offers a one-click switch), then:
1. **Demo controls → Get test tokens** (50 mWETH + 150k mUSDC)
2. **Create a rule → Stop-loss** → *Arm stop-loss*
3. **Demo controls → ▼ Crash the price** → watch **Live activity** go ① → ② → ③ with the latency

To use your own deployment instead, copy `web/.env.local.example` to `web/.env.local` and fill it in from
`contracts/deployments/*.json`.

## Troubleshooting

- **`lasna-rpc.rnk.dev` TLS error / "untrusted root"**: a corporate or campus firewall (we saw Fortinet) is intercepting HTTPS. Use another network, a VPN, or ask IT to allowlist `*.rnk.dev`.
- **Public RPC rate limits**: put an Alchemy/QuickNode URL in `UNICHAIN_SEPOLIA_RPC` / `BASE_SEPOLIA_RPC`.
- **`cast` talks to the wrong chain**: Foundry reads its own `CHAIN` env var as a *mainnet* name. `tw.sh` unsets it
  after reading ours; if you call `cast` yourself, don't export `CHAIN`.
- **Unichain "block not found" right after a receipt**: its public RPC serves Flashblocks preconfirmations, so the
  block may not be sealed yet. Retry after ~1 s (the bench does this automatically).
