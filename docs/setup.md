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
git clone --recursive https://github.com/hari-hara-sudharsan/Parallax parallax && cd parallax
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
export LASNA_FLAGS="--legacy --with-gas-price 110000000000"   # Lasna wants legacy gas pricing (base fee 100 gwei)
./tw.sh deploy-parallax               # ParallaxReactive (Lasna) → executor on each chain → addChain for each
CHAIN=base     ./tw.sh deploy-tryout  # the zero-setup judge path (also CHAIN=unichain)
CHAIN=base     ./tw.sh deploy-vault-all && CHAIN=base ./tw.sh vault-deposit   # optional: the pxLP vault
./tw.sh fund-reactive 2ether          # lREACT for reactions (≈ 0.06 per loop, results/costs.md)
CHAIN=base ./tw.sh debts              # balances / reserves / debt (any debt > 0 stops service)
```

Funding knobs: `REACTIVE_FUNDING`, `EXECUTOR_FUNDING`, `VAULT_FUNDING` (wei). The reactive contract owner can hand
ownership to another wallet with `transferOwnership(newOwner)`; the new wallet then calls `acceptOwnership()`.

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

## 6. Prove it (each writes its evidence to `results/`)

```bash
CHAIN=base ./tw.sh tryout             # one loop through ParallaxTryout: arm → crash → filled, with all 3 hashes
FROM=base  ./tw.sh panic              # cross-chain Panic Exit: one tx on Base closes your rules on both chains
CHAIN=base ./tw.sh refusals           # the five safety refusals as real txs → results/REFUSALS.md
CHAIN=base node bench/burst.mjs 5     # 5 rules crossed by one swap: the 3-callbacks-per-swap cap, then the rest
CHAIN=base ./tw.sh keeper 50          # the off-chain keeper-bot baseline on the same pool
./tw.sh check-links                   # every tx linked in the docs exists on its chain
python contracts/mutation/mutants.py  # break each guard, a test must fail → results/mutants.md (~30 min)
python analysis/what_a_second_buys.py # crash-data cost of latency → results/what-a-second-buys.md
```

## 7. Frontend

```bash
cd web
npm install
npm run dev        # http://localhost:3000. Works against the live testnet deployment out of the box.
npm run smoke      # optional: checks every live data path without a browser
```

In MetaMask, switch to **Base Sepolia** (the app offers a one-click switch). The fastest path needs only gas:
**Run a loop yourself → 1 · Arm a stop → 2 · Crash it**, then watch the origin, reactive and callback hops fill in
with the block-exact latency. Or do it by hand: **Get tokens → Create a rule → Crash −12%**. **Panic Exit** closes
everything you armed on both chains; **Is it awake?** shows the lREACT runway and any debt.

To use your own deployment instead, copy `web/.env.local.example` to `web/.env.local` and fill it in from
`contracts/deployments/*.json`.

## Troubleshooting

- **Windows: `Failed to recurse into submodule` / `unable to write file … .pack`**: v4-periphery nests submodules
  deeply and the paths pass Windows' 260-character limit. Clone to a short path (e.g. `C:\px`) and run
  `git config --global core.longpaths true` before `git submodule update --init --recursive`. Linux and macOS
  are unaffected; CI does a fresh recursive clone on every push.

- **A Lasna `cast send` / `forge script` silently does nothing or is rejected**: use legacy gas pricing,
  `--legacy --gas-price 110gwei` (`LASNA_FLAGS` for `tw.sh`).
- **Rules stop firing / "mirror timeout"**: the reactive contract is in debt (`./tw.sh debts`). Reactive does not call it
  and does not queue the events. Top up with `./tw.sh fund-reactive 1ether`, then repair anything missed with
  `cast send <executor> "resync(uint256)" <ruleId>` (anyone may call it).

- **`lasna-rpc.rnk.dev` TLS error / "untrusted root"**: a corporate or campus firewall (we saw Fortinet) is intercepting HTTPS. Use another network, a VPN, or ask IT to allowlist `*.rnk.dev`.
- **Public RPC rate limits**: put an Alchemy/QuickNode URL in `UNICHAIN_SEPOLIA_RPC` / `BASE_SEPOLIA_RPC`.
- **`cast` talks to the wrong chain**: Foundry reads its own `CHAIN` env var as a *mainnet* name. `tw.sh` unsets it
  after reading ours; if you call `cast` yourself, don't export `CHAIN`.
- **Unichain "block not found" right after a receipt**: its public RPC serves Flashblocks preconfirmations, so the
  block may not be sealed yet. Retry after ~1 s (the bench does this automatically).
