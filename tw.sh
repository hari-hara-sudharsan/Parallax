#!/usr/bin/env bash
# Parallax task runner. Works in Git Bash (Windows), macOS and Linux.
#   ./tw.sh help
# The Makefile just forwards to this script, so `make <task>` == `./tw.sh <task>`.
#
# Chain selection: CHAIN=unichain (default) or CHAIN=base, e.g.  CHAIN=base ./tw.sh push-down
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.foundry/bin"

# Load .env (gitignored) so every forge/cast call sees the same config.
if [[ -f "$ROOT/.env" ]]; then set -a; source "$ROOT/.env"; set +a; fi

need_env() { for v in "$@"; do [[ -n "${!v:-}" ]] || { echo "✗ $v is not set. Copy .env.example to .env and fill it in."; exit 1; }; done; }

# ── Chain config (official addresses: deployments/addresses.md, contracts/script/Chains.sol) ──
SYSTEM_CONTRACT=${SYSTEM_CONTRACT:-0x8888888888888888888888888888888888888888}
LASNA_ID=5318007
# Foundry's cast also reads a CHAIN env var (as a *mainnet* chain name), so take ours and unset it.
SEL="${CHAIN:-unichain}"; unset CHAIN
case "$SEL" in
  unichain) CID=1301;  RPC="${UNICHAIN_SEPOLIA_RPC:-https://sepolia.unichain.org}"; CHAIN_NAME="Unichain Sepolia"
            PROXY=0x775c9B990ADe401060B78D0e98684eEf8d2466C1; STATE_VIEW_ADDR=0xc199f1072a74d4e905aba1a84d9a45e2546b6222 ;;
  base)     CID=84532; RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}";       CHAIN_NAME="Base Sepolia"
            PROXY=0x476F44b11F5C942c58f4c8E3d0300E5710743585; STATE_VIEW_ADDR=0x571291b572ed32ce6751a2cb2486ebee8defb9b4 ;;
  *) echo "✗ CHAIN must be unichain or base"; exit 1 ;;
esac
LASNA_RPC=${LASNA_RPC:-https://lasna-rpc.rnk.dev/}

# forge script against the selected chain, broadcasting real transactions.
chain_script() {
  need_env PRIVATE_KEY
  (cd "$ROOT/contracts" && forge script "$1" --rpc-url "$RPC" --broadcast --slow -vv)
}

# forge script against Reactive Lasna. Set LASNA_FLAGS (e.g. "--legacy") if the node rejects EIP-1559 txs.
lasna_script() {
  need_env PRIVATE_KEY
  (cd "$ROOT/contracts" && forge script "$1" --rpc-url "$LASNA_RPC" --broadcast --slow -vv ${LASNA_FLAGS:-})
}

# Read a saved value from contracts/deployments/<chainId>.json
saved() { grep -o "\"$2\": *\"\?0x[0-9a-fA-F]*\"\?" "$ROOT/contracts/deployments/$1.json" 2>/dev/null | grep -o '0x[0-9a-fA-F]*' || true; }

ANVIL_PORT=8545
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil's public test key #0

cmd="${1:-help}"; shift || true
case "$cmd" in
  install)      (cd "$ROOT" && git submodule update --init --recursive --depth 1) ;;
  build)        (cd "$ROOT/contracts" && forge build) ;;
  test)         (cd "$ROOT/contracts" && forge test -vv "$@") ;;

  # ── Demo pool (per chain) ───────────────────────────────────────────────
  deploy-tokens) chain_script script/01_DeployTokens.s.sol:DeployTokens ;;
  create-pool)   chain_script script/02_CreatePool.s.sol:CreatePool ;;
  add-liquidity) chain_script script/03_AddLiquidity.s.sol:AddLiquidity ;;
  demo-pool)     "$0" deploy-tokens && "$0" create-pool && "$0" add-liquidity ;;
  push-down)     PUSH_DIRECTION=down chain_script script/04_PushPrice.s.sol:PushPrice ;;
  push-up)       PUSH_DIRECTION=up   chain_script script/04_PushPrice.s.sol:PushPrice ;;

  # ── Parallax deployment. Forced order: Reactive → Executor per chain → addChain per chain ──
  deploy-reactive)  lasna_script script/05_DeployReactive.s.sol:DeployReactive ;;
  deploy-executor)  chain_script script/06_DeployExecutor.s.sol:DeployExecutor ;;
  add-chain)        ADD_CHAIN_ID=$CID lasna_script script/07_AddChain.s.sol:AddChain ;;
  deploy-parallax)  # one reactive on Lasna guarding BOTH chains
    "$0" deploy-reactive
    CHAIN=unichain "$0" deploy-executor && CHAIN=unichain "$0" add-chain
    CHAIN=base     "$0" deploy-executor && CHAIN=base     "$0" add-chain
    CHAIN=unichain "$0" debts; CHAIN=base "$0" debts ;;
  deploy-tryout)     chain_script script/15_DeployTryout.s.sol:DeployTryout ;;   # zero-setup judge path
  # ── Parallax Vault (keeperless managed LP). Order: brain (Lasna) → vault (chain) → set-vault (Lasna) ──
  deploy-vault-reactive) VAULT_CHAIN_ID=$CID lasna_script script/11_DeployVaultReactive.s.sol:DeployVaultReactive ;;
  deploy-vault)          chain_script script/12_DeployVault.s.sol:DeployVault ;;
  set-vault)             lasna_script script/13_SetVault.s.sol:SetVault ;;
  vault-deposit)         chain_script script/14_VaultDeposit.s.sol:VaultDeposit ;;
  deploy-vault-all)      # CHAIN=base ./tw.sh deploy-vault-all
    CHAIN=$SEL "$0" deploy-vault-reactive && CHAIN=$SEL "$0" deploy-vault && CHAIN=$SEL "$0" set-vault ;;
  vault)                 # CHAIN=base ./tw.sh vault  → live vault state
    V=$(saved $CID parallaxVault)
    echo "ParallaxVault $V ($CHAIN_NAME)"
    for f in "mode()(uint8)" "tickLower()(int24)" "tickUpper()(int24)" "anchorTick()(int24)" "inRange()(bool)"              "rebalances()(uint32)" "evacuations()(uint32)" "reentries()(uint32)" "totalSupply()(uint256)" "totalValue0()(uint256)"; do
      printf '  %-18s %s
' "${f%%(*}" "$(cast call "$V" "$f" --rpc-url "$RPC")"
    done ;;
  create-stop-loss)   RULE_KIND=stop-loss   chain_script script/08_CreatePriceRule.s.sol:CreatePriceRule ;;
  create-take-profit) RULE_KIND=take-profit chain_script script/08_CreatePriceRule.s.sol:CreatePriceRule ;;
  create-range-guard) chain_script script/09_CreateRangeGuard.s.sol:CreateRangeGuard ;;
  create-recenter-guard) RG_RECENTER=true chain_script script/09_CreateRangeGuard.s.sol:CreateRangeGuard ;;
  create-trailing-stop)  chain_script script/10_CreateTrailingStop.s.sol:CreateTrailingStop ;;

  # Top-ups, credited to reserves via depositTo (the docs' recommended route).
  fund-reactive)    # ./tw.sh fund-reactive 1ether
    need_env PRIVATE_KEY
    cast send "$SYSTEM_CONTRACT" "depositTo(address)" "$(saved $LASNA_ID parallaxReactive)" --value "${1:-1ether}" \
      --rpc-url "$LASNA_RPC" --private-key "$PRIVATE_KEY" ${LASNA_FLAGS:-} ;;
  fund-executor)    # CHAIN=base ./tw.sh fund-executor 0.001ether
    need_env PRIVATE_KEY
    cast send "$PROXY" "depositTo(address)" "$(saved $CID parallaxExecutor)" --value "${1:-0.001ether}" \
      --rpc-url "$RPC" --private-key "$PRIVATE_KEY" ;;

  debts)            # balances / reserves / debt (any debt > 0 stops service)
    R=$(saved $LASNA_ID parallaxReactive); E=$(saved $CID parallaxExecutor)
    if [[ -n "$R" ]]; then
      echo "ParallaxReactive $R (Lasna)"
      echo "  balance  $(cast balance "$R" --ether --rpc-url "$LASNA_RPC")"
      echo "  debt     $(cast call "$SYSTEM_CONTRACT" 'debt(address)(uint256)' "$R" --rpc-url "$LASNA_RPC")"
    fi
    if [[ -n "$E" ]]; then
      echo "ParallaxExecutor $E ($CHAIN_NAME)"
      echo "  balance  $(cast balance "$E" --ether --rpc-url "$RPC")"
      echo "  reserves $(cast call "$PROXY" 'reserves(address)(uint256)' "$E" --rpc-url "$RPC")"
      echo "  debt     $(cast call "$PROXY" 'debt(address)(uint256)' "$E" --rpc-url "$RPC")"
    fi ;;

  rule)             # CHAIN=base ./tw.sh rule 1   → on-chain status + execution record of a rule
    E=$(saved $CID parallaxExecutor)
    cast call "$E" "getRule(uint256)((address,uint8,uint8,bool,int24,int24,uint16,uint128,uint64,bytes32,uint256))" "${1:?ruleId}" --rpc-url "$RPC"
    echo "execution (originTx, originBlock, executedBlock, executedAt):"
    cast call "$E" "executions(uint256)(uint256,uint64,uint64,uint64)" "$1" --rpc-url "$RPC"
    echo "(status: 1=ACTIVE 2=EXECUTED 3=CANCELLED)" ;;

  bench)            # CHAIN=base ./tw.sh bench 30   → N automated live rounds, writes results/
    (cd "$ROOT/bench" && [[ -d node_modules ]] || npm install --no-fund --no-audit --silent)
    (cd "$ROOT/bench" && CHAIN="$SEL" node bench.mjs "${1:-10}") ;;

  keeper)           # CHAIN=base ./tw.sh keeper 20  → off-chain keeper-bot baseline on the same pool
    (cd "$ROOT/bench" && [[ -d node_modules ]] || npm install --no-fund --no-audit --silent)
    (cd "$ROOT/bench" && CHAIN="$SEL" node keeper.mjs "${1:-10}") ;;

  check-links)      # ./tw.sh check-links        → every tx linked in the docs exists on its chain
    (cd "$ROOT/bench" && node check-links.mjs) ;;

  refusals)         # CHAIN=base ./tw.sh refusals   → on-chain proof of every safety refusal, writes results/REFUSALS.md
    (cd "$ROOT/bench" && [[ -d node_modules ]] || npm install --no-fund --no-audit --silent)
    (cd "$ROOT/bench" && CHAIN="$SEL" node refusals.mjs) ;;

  abis)             # regenerate the frontend's typed ABIs from Foundry artifacts
    (cd "$ROOT/contracts" && forge build >/dev/null 2>&1) && python "$ROOT/web/scripts/gen-abis.py" "$ROOT" ;;

  callbacks)        # ./tw.sh callbacks <reactiveTxHash>  → destination tx hash(es) for a reactive tx
    cast call "$SYSTEM_CONTRACT" "getCallbacks(uint256)((uint256,address,uint256,uint256,uint256,bytes)[])" \
      "$(cast to-dec "${1:?reactive tx hash}")" --rpc-url "$LASNA_RPC" ;;

  wallet)
    need_env PRIVATE_KEY
    ADDR=$(cast wallet address --private-key "$PRIVATE_KEY")
    echo "deployer: $ADDR"
    bal() { printf "  %-18s %s\n" "$1" "$(cast balance "$ADDR" --ether --rpc-url "$2" 2>/dev/null || echo 'unreachable')"; }
    bal "Unichain Sepolia" "${UNICHAIN_SEPOLIA_RPC:-https://sepolia.unichain.org}"
    bal "Base Sepolia"     "${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
    bal "Ethereum Sepolia" "${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
    bal "Reactive Lasna"   "$LASNA_RPC"
    ;;

  get-react)        # ./tw.sh get-react sepolia 0.045ether   (or: base 0.1ether)
    # Official lREACT faucets (Reactive docs): 1 ETH → 100 lREACT. NEVER more than 5 ETH per tx (excess is lost).
    need_env PRIVATE_KEY
    case "${1:-sepolia}" in
      sepolia) FAUCET=0x9b9BB25f1A81078C544C829c5EB7822d747Cf434; FRPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}" ;;
      base)    FAUCET=0x2afaFD298b23b62760711756088F75B7409f5967; FRPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}" ;;
      *) echo "usage: ./tw.sh get-react <sepolia|base> <amount, e.g. 0.045ether>"; exit 1 ;;
    esac
    AMT="${2:-0.045ether}"
    WEI=$(cast to-wei "${AMT%ether}"); (( $(cast to-unit "$WEI" ether | cut -d. -f1) < 5 )) || { echo "✗ max 5 ETH per tx"; exit 1; }
    ADDR=$(cast wallet address --private-key "$PRIVATE_KEY")
    echo "Sending $AMT to the $1 lREACT faucet for $ADDR …"
    cast send "$FAUCET" "request(address)" "$ADDR" --value "$AMT" --rpc-url "$FRPC" --private-key "$PRIVATE_KEY"
    echo "✓ lREACT arrives on Lasna shortly. Check with ./tw.sh wallet" ;;

  pool-state)
    POOL_ID=$(saved $CID poolId)
    echo "$CHAIN_NAME poolId: $POOL_ID"
    cast call "$STATE_VIEW_ADDR" "getSlot0(bytes32)(uint160,int24,uint24,uint24)" "$POOL_ID" --rpc-url "$RPC"
    ;;

  # ── Rehearsal: run the whole demo-pool flow on a local fork. Free, no keys needed. ──
  rehearse)
    echo "▶ starting anvil fork of Unichain Sepolia (local chain id 31337)…"
    anvil --fork-url "${UNICHAIN_SEPOLIA_RPC:-https://sepolia.unichain.org}" --chain-id 31337 --port $ANVIL_PORT --silent &
    APID=$!; trap 'kill $APID 2>/dev/null || true' EXIT
    for i in $(seq 1 30); do cast block-number --rpc-url http://127.0.0.1:$ANVIL_PORT >/dev/null 2>&1 && break; sleep 1; done
    rm -f "$ROOT/contracts/deployments/31337.json"
    for s in 01_DeployTokens.s.sol:DeployTokens 02_CreatePool.s.sol:CreatePool 03_AddLiquidity.s.sol:AddLiquidity 04_PushPrice.s.sol:PushPrice; do
      echo "▶ $s"
      LOG="$(mktemp)"
      if ! (cd "$ROOT/contracts" && PRIVATE_KEY=$ANVIL_KEY forge script "script/$s" --rpc-url http://127.0.0.1:$ANVIL_PORT --broadcast -vv) >"$LOG" 2>&1; then
        tail -30 "$LOG"; echo "✗ $s failed"; exit 1
      fi
      grep -E "MockW|MockU|poolId|0x[0-9a-f]{64}|tick|liquidity|tokenId|Pushed|price" "$LOG" | grep -v "^ *\[" || true
    done
    echo "✓ rehearsal done. Local deployment file: contracts/deployments/31337.json"
    ;;

  help|*)
    cat <<'EOF'
Parallax tasks (./tw.sh <task>  or  make <task>). Pick the chain with CHAIN=unichain (default) or CHAIN=base.

Setup
  wallet              deployer address + balances on every chain
  get-react <sepolia|base> <amt>   buy lREACT from the official faucet (e.g. sepolia 0.045ether)
  install / build / test           submodules / compile / Foundry tests
  rehearse            demo-pool flow on a local Unichain fork (no keys, no gas)

Demo pool (per chain)
  demo-pool           deploy-tokens + create-pool + add-liquidity
  push-down / push-up crash / pump the price (PUSH_AMOUNT)
  pool-state          current sqrtPrice / tick

Parallax
  deploy-parallax     one ParallaxReactive (Lasna) + an executor on Unichain AND Base, linked with addChain
  deploy-reactive | deploy-executor | add-chain     the individual steps
  deploy-tryout       ParallaxTryout on CHAIN: anyone arms a funded stop and crashes it (no tokens needed)
  deploy-vault-all    Parallax Vault: brain on Lasna + vault on CHAIN + wiring; vault-deposit; vault (state)
  create-stop-loss | create-take-profit | create-range-guard
  create-trailing-stop (TRAIL_BPS)  |  create-recenter-guard (LP guard that re-centres instead of withdrawing)
  fund-reactive [amt] / fund-executor [amt]         top up lREACT / callback ETH
  debts               balances, reserves, debt
  rule <id>           a rule's status + its on-chain execution record
  keeper <N>          off-chain keeper-bot baseline on the same pool (for comparison)
  bench <N>           N automated live rounds → results/<chain>-<date>.json + results/SUMMARY.md
  check-links         verify every transaction linked in the docs exists on its chain
  refusals            on-chain proof of each safety refusal (unauthorized, in-band, stale, dedupe, cancel)
  abis                regenerate web/src/lib/generated/abis.ts
  callbacks <tx>      Lasna getCallbacks for a reactive tx
EOF
    ;;
esac
