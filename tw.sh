#!/usr/bin/env bash
# Parallax task runner. Works in Git Bash (Windows), macOS and Linux.
#   ./tw.sh help
# The Makefile just forwards to this script, so `make <task>` == `./tw.sh <task>`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.foundry/bin"

# Load .env (gitignored) so every forge/cast call sees the same config.
if [[ -f "$ROOT/.env" ]]; then set -a; source "$ROOT/.env"; set +a; fi

need_env() { for v in "$@"; do [[ -n "${!v:-}" ]] || { echo "✗ $v is not set. Copy .env.example to .env and fill it in."; exit 1; }; done; }

# forge script against Unichain Sepolia, broadcasting real transactions.
uni_script() {
  need_env PRIVATE_KEY UNICHAIN_SEPOLIA_RPC
  (cd "$ROOT/contracts" && forge script "$1" --rpc-url "$UNICHAIN_SEPOLIA_RPC" --broadcast --slow -vv)
}

# forge script against Reactive Lasna. Set LASNA_FLAGS (e.g. "--legacy") if the node rejects EIP-1559 txs.
lasna_script() {
  need_env PRIVATE_KEY LASNA_RPC
  (cd "$ROOT/contracts" && forge script "$1" --rpc-url "$LASNA_RPC" --broadcast --slow -vv ${LASNA_FLAGS:-})
}

# Read a saved address from contracts/deployments/<chainId>.json
saved() { grep -o "\"$2\": *\"0x[0-9a-fA-F]*\"" "$ROOT/contracts/deployments/$1.json" | grep -o '0x[0-9a-fA-F]*'; }

ANVIL_PORT=8545
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil's public test key #0

cmd="${1:-help}"; shift || true
case "$cmd" in
  install)      (cd "$ROOT" && git submodule update --init --recursive --depth 1) ;;
  build)        (cd "$ROOT/contracts" && forge build) ;;
  test)         (cd "$ROOT/contracts" && forge test -vv "$@") ;;

  # ── Demo pool on Unichain Sepolia (Phase 1) ─────────────────────────────
  deploy-tokens) uni_script script/01_DeployTokens.s.sol:DeployTokens ;;
  create-pool)   uni_script script/02_CreatePool.s.sol:CreatePool ;;
  add-liquidity) uni_script script/03_AddLiquidity.s.sol:AddLiquidity ;;
  demo-pool)     "$0" deploy-tokens && "$0" create-pool && "$0" add-liquidity ;;
  push-down)     PUSH_DIRECTION=down uni_script script/04_PushPrice.s.sol:PushPrice ;;
  push-up)       PUSH_DIRECTION=up   uni_script script/04_PushPrice.s.sol:PushPrice ;;

  # ── Parallax core loop (Phase 2). Order is forced by the docs: Reactive → Executor → setExecutor ──
  deploy-reactive)  lasna_script script/05_DeployReactive.s.sol:DeployReactive ;;
  deploy-executor)  uni_script   script/06_DeployExecutor.s.sol:DeployExecutor ;;
  set-executor)     lasna_script script/07_SetExecutor.s.sol:SetExecutor ;;
  deploy-parallax)  "$0" deploy-reactive && "$0" deploy-executor && "$0" set-executor && "$0" debts ;;
  create-stop-loss)   RULE_KIND=stop-loss   uni_script script/08_CreatePriceRule.s.sol:CreatePriceRule ;;
  create-take-profit) RULE_KIND=take-profit uni_script script/08_CreatePriceRule.s.sol:CreatePriceRule ;;
  create-range-guard) uni_script script/09_CreateRangeGuard.s.sol:CreateRangeGuard ;;

  # Top-ups, credited to reserves via depositTo (the docs' recommended route).
  fund-reactive)    # ./tw.sh fund-reactive 1ether
    need_env PRIVATE_KEY LASNA_RPC SYSTEM_CONTRACT
    cast send "$SYSTEM_CONTRACT" "depositTo(address)" "$(saved 5318007 parallaxReactive)" --value "${1:-1ether}" \
      --rpc-url "$LASNA_RPC" --private-key "$PRIVATE_KEY" ${LASNA_FLAGS:-} ;;
  fund-executor)    # ./tw.sh fund-executor 0.01ether
    need_env PRIVATE_KEY UNICHAIN_SEPOLIA_RPC UNICHAIN_CALLBACK_PROXY
    cast send "$UNICHAIN_CALLBACK_PROXY" "depositTo(address)" "$(saved 1301 parallaxExecutor)" --value "${1:-0.01ether}" \
      --rpc-url "$UNICHAIN_SEPOLIA_RPC" --private-key "$PRIVATE_KEY" ;;

  debts)            # balances / reserves / debt on both sides (any debt > 0 stops service)
    R=$(saved 5318007 parallaxReactive || true); E=$(saved 1301 parallaxExecutor || true)
    if [[ -n "$R" ]]; then
      echo "ParallaxReactive $R (Lasna)"
      echo "  balance  $(cast balance "$R" --ether --rpc-url "$LASNA_RPC")"
      echo "  reserves $(cast call "$SYSTEM_CONTRACT" 'reserves(address)(uint256)' "$R" --rpc-url "$LASNA_RPC")"
      echo "  debt     $(cast call "$SYSTEM_CONTRACT" 'debt(address)(uint256)' "$R" --rpc-url "$LASNA_RPC")"
    fi
    if [[ -n "$E" ]]; then
      echo "ParallaxExecutor $E (Unichain Sepolia)"
      echo "  balance  $(cast balance "$E" --ether --rpc-url "$UNICHAIN_SEPOLIA_RPC")"
      echo "  reserves $(cast call "$UNICHAIN_CALLBACK_PROXY" 'reserves(address)(uint256)' "$E" --rpc-url "$UNICHAIN_SEPOLIA_RPC")"
      echo "  debt     $(cast call "$UNICHAIN_CALLBACK_PROXY" 'debt(address)(uint256)' "$E" --rpc-url "$UNICHAIN_SEPOLIA_RPC")"
    fi ;;

  rule)             # ./tw.sh rule 1   → on-chain status of a rule
    E=$(saved 1301 parallaxExecutor)
    cast call "$E" "getRule(uint256)((address,uint8,uint8,bool,int24,int24,uint16,uint128,uint64,bytes32,uint256))" "${1:?ruleId}" \
      --rpc-url "$UNICHAIN_SEPOLIA_RPC"
    echo "(status: 1=ACTIVE 2=EXECUTED 3=CANCELLED)" ;;

  proof)            # ./tw.sh proof <originSwapTx>  → finds the reactive tx + callback tx, prints a proof row
    O="${1:?origin swap tx hash}"; O=$(echo "$O" | tr 'A-F' 'a-f'); OH=${O#0x}
    R=$(saved 5318007 parallaxReactive); E=$(saved 1301 parallaxExecutor)
    OB=$(cast receipt "$O" blockNumber --rpc-url "$UNICHAIN_SEPOLIA_RPC")
    T0=$(cast block "$OB" --field timestamp --rpc-url "$UNICHAIN_SEPOLIA_RPC")
    # Reactive side: RuleTriggered(ruleId, poolId, tick, originTxHash) logs that carry this origin hash.
    LB=$(cast block-number --rpc-url "$LASNA_RPC")
    RT=$(cast logs --address "$R" "$(cast keccak 'RuleTriggered(uint256,bytes32,int24,uint256)')" \
          --from-block $((LB-900)) --to-block latest --rpc-url "$LASNA_RPC" --json \
        | python -c "import json,sys; print(' '.join(l['transactionHash'] for l in json.load(sys.stdin) if '$OH' in l['data']))")
    # Destination side: RuleExecuted logs whose data carries this origin hash.
    EX=$(cast logs --address "$E" "$(cast keccak 'RuleExecuted(uint256,address,int24,uint256,uint256,uint256,uint256)')" \
          --from-block "$OB" --to-block latest --rpc-url "$UNICHAIN_SEPOLIA_RPC" --json \
        | python -c "
import json,sys
for l in json.load(sys.stdin):
    d=l['data'][2:]
    if '$OH' in d:
        w=[d[i:i+64] for i in range(0,len(d),64)]
        print(l['transactionHash'], int(l['topics'][1],16), int(w[1],16), int(w[2],16), int(w[4],16))")
    echo "origin   $O  block $OB  T0=$T0"
    for t in $RT; do echo "reactive $t  (Lasna)"; done
    while read -r tx rule a0 a1 t1; do
      [[ -z "$tx" ]] && continue
      echo "callback $tx  rule $rule  amount0Out=$a0 amount1Out=$a1  T1=$t1"
      echo "latency  $((t1 - T0)) s"
    done <<< "$EX"
    if [[ -z "$EX" ]]; then echo "callback (not found yet: try again in a few seconds)"; fi ;;

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
    bal "Unichain Sepolia" "${UNICHAIN_SEPOLIA_RPC}"
    bal "Base Sepolia"     "${BASE_SEPOLIA_RPC}"
    bal "Ethereum Sepolia" "${SEPOLIA_RPC}"
    bal "Reactive Lasna"   "${LASNA_RPC}"
    ;;

  get-react)        # ./tw.sh get-react sepolia 0.045ether   (or: base 0.1ether)
    # Official lREACT faucets (Reactive docs): 1 ETH → 100 lREACT. NEVER more than 5 ETH per tx (excess is lost).
    need_env PRIVATE_KEY
    case "${1:-sepolia}" in
      sepolia) FAUCET=0x9b9BB25f1A81078C544C829c5EB7822d747Cf434; RPC="$SEPOLIA_RPC" ;;
      base)    FAUCET=0x2afaFD298b23b62760711756088F75B7409f5967; RPC="$BASE_SEPOLIA_RPC" ;;
      *) echo "usage: ./tw.sh get-react <sepolia|base> <amount, e.g. 0.045ether>"; exit 1 ;;
    esac
    AMT="${2:-0.045ether}"
    WEI=$(cast to-wei "${AMT%ether}"); (( $(cast to-unit "$WEI" ether | cut -d. -f1) < 5 )) || { echo "✗ max 5 ETH per tx"; exit 1; }
    ADDR=$(cast wallet address --private-key "$PRIVATE_KEY")
    echo "Sending $AMT to the $1 lREACT faucet for $ADDR …"
    cast send "$FAUCET" "request(address)" "$ADDR" --value "$AMT" --rpc-url "$RPC" --private-key "$PRIVATE_KEY"
    echo "✓ lREACT arrives on Lasna shortly. Check with ./tw.sh wallet" ;;

  pool-state)
    need_env UNICHAIN_SEPOLIA_RPC STATE_VIEW
    POOL_ID=$(grep -o '"poolId": *"0x[0-9a-fA-F]*"' "$ROOT/contracts/deployments/1301.json" | grep -o '0x[0-9a-fA-F]*')
    echo "poolId: $POOL_ID"
    cast call "$STATE_VIEW" "getSlot0(bytes32)(uint160,int24,uint24,uint24)" "$POOL_ID" --rpc-url "$UNICHAIN_SEPOLIA_RPC"
    ;;

  # ── Rehearsal: run the whole Phase 1 flow on a local fork. Free, no keys needed. ──
  rehearse)
    need_env UNICHAIN_SEPOLIA_RPC
    echo "▶ starting anvil fork of Unichain Sepolia (local chain id 31337)…"
    anvil --fork-url "$UNICHAIN_SEPOLIA_RPC" --chain-id 31337 --port $ANVIL_PORT --silent &
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
Parallax tasks (./tw.sh <task>  or  make <task>)
  wallet         show deployer address + balances on every chain
  get-react <sepolia|base> <amt>  buy lREACT from the official faucet (e.g. sepolia 0.045ether)
  install        fetch git submodules (forge-std, reactive-lib-omni, v4-periphery)
  build / test   compile / run Foundry tests
  rehearse       run the full demo-pool flow on a local Unichain Sepolia fork (no keys, no gas)
  demo-pool      deploy-tokens + create-pool + add-liquidity on Unichain Sepolia
  deploy-tokens  deploy MockWETH + MockUSDC, mint to your wallet
  create-pool    initialize the v4 pool at START_PRICE (default 3000 USDC/WETH)
  add-liquidity  mint an LP position (LP_WETH, LP_USDC, LP_PRICE_LOW, LP_PRICE_HIGH)
  push-down      sell mWETH to crash the price (PUSH_AMOUNT, default 20)
  push-up        sell mUSDC to pump the price (PUSH_AMOUNT, default 60000)
  pool-state     print the pool's current sqrtPrice / tick

Core loop (Phase 2):
  deploy-parallax   deploy-reactive (Lasna) + deploy-executor (Unichain) + set-executor (Lasna) + debts
  create-stop-loss    sell RULE_AMOUNT mWETH (default 1) if WETH drops RULE_MOVE_BPS (default 300 = 3%)
  create-take-profit  sell RULE_AMOUNT mWETH if WETH rises RULE_MOVE_BPS
  create-range-guard  mint a narrow LP position (±RG_WIDTH_TICKS, default 600) and guard it
  fund-reactive [amt]   top up ParallaxReactive reserves (lREACT)
  fund-executor [amt]   top up ParallaxExecutor callback reserves (ETH)
  debts             balances / reserves / debt on both sides
  rule <id>         on-chain status of a rule
  abis              regenerate web/src/lib/generated/abis.ts from contracts
  proof <originTx>  origin → reactive → callback tx + latency for one run (proof table row)
  callbacks <tx>    destination tx hash for a Lasna reactive tx
EOF
    ;;
esac
