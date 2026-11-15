# Phase 0: Research report

_Date: 2026-11-14. All findings come from primary sources, which were cloned and read directly:_

| Source | Version read |
|---|---|
| [Reactive-Network/reactive-lib-omni](https://github.com/Reactive-Network/reactive-lib-omni) | `3ade0dc` (2026-05-21) |
| [Reactive-Network/documentation](https://github.com/Reactive-Network/documentation) (`docs/docs/*`, the Omni docs behind dev.reactive.network) | `0ac3064` (2026-11-10) |
| [Reactive-Network/reactive-smart-contract-demos](https://github.com/Reactive-Network/reactive-smart-contract-demos) | main (2026-10-07) |
| [Uniswap/docs](https://github.com/Uniswap/docs) `content/protocols/v4/deployments.mdx` | `1c7597d` |
| [Uniswap/v4-core](https://github.com/Uniswap/v4-core) `src/interfaces/IPoolManager.sol` | main |
| On-chain `eth_getCode` / `eth_chainId` | Unichain Sepolia, Base Sepolia public RPCs |

Addresses are collected in [`deployments/addresses.md`](../deployments/addresses.md).

---

## 1. Reactive base contract

```solidity
pragma solidity ^0.8.29;
import { ISystemContract } from "reactive-lib-omni/src/interfaces/ISystemContract.sol";
import { AbstractReactive } from "reactive-lib-omni/src/base/AbstractReactive.sol";

contract ParallaxReactive is AbstractReactive {
    constructor(...) payable { SYSTEM.subscribe(...); }
    function react(LogRecord memory log_) external onlySystem { ... }
}
```

- `AbstractReactive` is `AbstractPayer` + `IReactive`. It provides:
  - `SYSTEM = ISystemContract(0x8888888888888888888888888888888888888888)`, the system contract on both Lasna and mainnet
  - `REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad`, the wildcard topic
  - the `onlySystem` modifier, which checks `msg.sender == SYSTEM`
- **There is no RVM, no `vm` flag and no `vmOnly`.** A reactive contract is an ordinary contract with a single state. `react()` is a normal transaction, so it can subscribe, unsubscribe, request callbacks and write storage.
- The `LogRecord` field names differ from legacy:

```solidity
struct LogRecord {
    uint256 chainId; address contractAddress;
    uint256 topic0; uint256 topic1; uint256 topic2; uint256 topic3;
    bytes data; uint256 blockNumber; uint256 opCode;   // opCode = number of topics (LOG3 → 3)
    uint256 blockHash; uint256 txHash; uint256 logIndex;
}
```

## 2. Subscribe API

`SYSTEM.subscribe(chainId, contract, topic0, topic1, topic2, topic3)` and a matching `unsubscribe` with the same six arguments.
- Matching is exact-equality only: no ranges and no OR. Use one `subscribe()` per combination.
- At least one criterion must be specific.
- You can subscribe **at any time**, including from an owner-only setter or from inside `react()`. We need this: the executor address is only known after the reactive contract is deployed.
- Subscriptions live in the node, not in storage, so we track them ourselves.

**Our subscriptions:**

| # | chainId | contract | topic0 | topic1 | Purpose |
|---|---|---|---|---|---|
| 1 | 1301 | PoolManager `0x00b0…62ac` | Swap `0x40e9…112f` | our `poolId` | price feed for the demo pool only |
| 2 | 1301 | ParallaxExecutor | `RuleCreated` | IGNORE | mirror rules |
| 3 | 1301 | ParallaxExecutor | `RuleCancelled` | IGNORE | mirror rules |
| 4 | 1301 | ParallaxExecutor | `RuleExecuted` / `RuleSkipped` | IGNORE | clear or re-arm the pending state |

## 3. Callback emission format (⚠️ changed from the brief)

The `Callback` event is **deprecated**. Use:

```solidity
SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({
    chainId:   1301,               // destination
    recipient: executor,           // ParallaxExecutor
    gasLimit:  1_000_000,          // ≥ 100,000 minimum; proxy withholds _extraGas + _maxChargeGas
    payload:   abi.encodeWithSignature("execute(address,uint256,...)", address(0), ruleId, ...)
}));
```

- **The first payload argument must be an `address` placeholder (`address(0)`).** The network overwrites the first 160 bits with the requesting reactive contract's address. The docs call forgetting this "the most common way to break a callback".
- The system contract emits `CallbackRequest(uint256 indexed chainId, address indexed sender, address indexed recipient, CallbackVersion version, bytes configuration)`, which is useful for the frontend feed.
- `SYSTEM.getCallbacks(uint256 reactiveTxHash)` returns `(blockNumber, sender, index, chainId, destTxHash, err)[]`. It maps a reactive tx to its destination tx hash, which is exactly what `tx-proofs.md` needs.

## 4. Callback authorization pattern

```solidity
contract ParallaxExecutor is AbstractCallback {
    constructor(IPayable callbackProxy_, address reactive_) payable AbstractCallback(callbackProxy_, reactive_) {}

    function execute(address reactive_, uint256 ruleId_ /*...*/)
        external onlyServiceProvider onlyCallbackSender(reactive_) { ... }
}
```

**Both modifiers are required.** `onlyServiceProvider` checks that `msg.sender` is the Callback Proxy. `onlyCallbackSender(x)` checks that the injected address is our reactive contract. I read the library source: `onlyCallbackSender` on its own does **not** check `msg.sender`, so using it alone would let anyone forge a call. `_CALLBACK_SENDER` is immutable, so a wrong address means redeploying the executor.

A contract cannot be both reactive and callback. They are two separate contracts, which matches our design.

## 5. Funding and debt model

| Side | Who pays | Currency | How to fund |
|---|---|---|---|
| Reactive (Lasna) | ParallaxReactive, per `react()` | **lREACT** | `SYSTEM.depositTo(reactive)` with value (preferred), or a payable constructor / plain transfer + `coverDebt()` |
| Destination (Unichain) | **ParallaxExecutor**, per callback | **Unichain Sepolia ETH** (not REACT) | `CallbackProxy.depositTo(executor)` with value, or a transfer + `coverDebt()` |

- Fee = `max(gasprice, basefee) × coeff/1000 × (gasUsed + extraGas)`. On Lasna the defaults are coeff 1000 and extraGas 100k, but proxy values are per chain, so read them with `cast call <proxy> "_extraGas()"`.
- **Any debt > 0 stops service** (no `react()` calls, no callback delivery). `AbstractPayer.pay()` settles automatically from the contract's own balance when reserves run out, so we keep a balance in both contracts.
- **Failed executions are still billed.** A reverting `react()` emits `ReactiveContractReverted`; a reverting callback emits `CallbackFailure`. → Never revert as a filter in `react()`.
- Limits: reactive tx gas cap is **900,000**; callback gasLimit minimum is **100,000**.
- We'll expose `coverDebt()` on both contracts and add `make fund-reactive` / `make fund-executor` helpers.

## 6. Supported testnet chains (confirmed)

From the Omni testnet chain table:

| Chain | ID | Origin | Destination | Callback Proxy |
|---|---|---|---|---|
| Unichain Sepolia | 1301 | ✅ | ✅ | `0x775c9B990ADe401060B78D0e98684eEf8d2466C1` (code ✅) |
| Base Sepolia | 84532 | ✅ | ✅ | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` (code ✅) |
| Ethereum Sepolia | 11155111 | ✅ | ✅ | `0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4` |
| Reactive Lasna | 5318007 | ✅ | ✅ | `0x8888…8888` |

Both Track 1 chains work as origin and as destination, so the cross-chain stretch (Base origin → Unichain destination) is supported.

## 7. Uniswap v4 addresses

Unichain Sepolia: PoolManager `0x00b036b58a818b1bc34d502d3fe730db729e62ac`, PositionManager `0xf969aee60879c54baaed9f3ed26147db216fd664`, StateView `0xc199f1072a74d4e905aba1a84d9a45e2546b6222`, PoolSwapTest `0x9140a78c1a137c7ff1c151ec8231272af78a99a4`. The Base Sepolia list and the rest are in `deployments/addresses.md`.

## 8. v4 `Swap` event and topic layout

```solidity
event Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
           uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee);
```

- Canonical signature: `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` (`PoolId` is `bytes32`)
- **topic0** = `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f`
- topic1 = `poolId`, which means **we can filter the subscription to our pool only**, so other pools on the singleton PoolManager cost us nothing
- topic2 = sender (the router)
- `opCode = 3`; `data = abi.encode(int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`
- In `react()`: `(, , uint160 sqrtP, , int24 tick, ) = abi.decode(log_.data, (int128,int128,uint160,uint128,int24,uint24));`
- Note: the PoolManager is a singleton that emits Swap for every pool. Filtering on topic1 is essential.

## 9. Faucets

| What | Where |
|---|---|
| Unichain Sepolia ETH | [Superchain Faucet](https://app.optimism.io/faucet), [QuickNode](https://faucet.quicknode.com/unichain/sepolia), [thirdweb](https://thirdweb.com/unichain-sepolia-testnet) (source: Uniswap docs `unichain/tools/faucets`) |
| Unichain Sepolia USDC | [Circle faucet](https://faucet.circle.com/) (we'll use our own MockUSDC anyway) |
| **lREACT (Lasna)** | Send **Ethereum Sepolia or Base Sepolia ETH** to a faucet contract (1 ETH → 100 lREACT, **max 5 ETH per tx; any excess is lost**). Sepolia: `0x9b9BB25f1A81078C544C829c5EB7822d747Cf434`. Base Sepolia: `0x2afaFD298b23b62760711756088F75B7409f5967`. Or call `request(address)` with value. |
| Base Sepolia ETH | Superchain Faucet (also feeds the lREACT faucet) |

You need ETH on **three** testnets: Unichain Sepolia (deploys + callback gas), and Base Sepolia or Sepolia (to buy lREACT).

---

## 10. Changes this brief needs (now applied to `CLAUDE.md`)

1. **`emit Callback` → `SYSTEM.requestCallbackV_1_0(...)`.** The event is deprecated.
2. **Callback gas is paid in Unichain Sepolia ETH by the executor**, not in REACT. REACT only pays for `react()` on Lasna.
3. **Deployment order is forced:** Reactive → Executor(proxy, reactiveAddr) → `reactive.setExecutor(executor)`, which also subscribes to the Rule* events → fund both.
4. **Callback auth uses two modifiers** (`onlyServiceProvider` + `onlyCallbackSender`), not just a sender check.
5. **There are no Omni demos.** The official demos repo is still legacy, and so is `reactive-test-lib` (it mocks `0x…fffFfF`). We write our own small Foundry mocks of `SYSTEM` and the Callback Proxy and test with `vm.prank`.
6. "Events & Callbacks" and "Reactive Library" pages no longer exist in the Omni docs. That content now lives in "Reactive Contracts", "Callback Contracts" and "Economy".

## 11. Design decisions I'd like you to approve before Phase 2

1. **Don't revert on stale callbacks; emit `RuleSkipped` instead.** The brief says `execute` should revert if the price moved back. But a reverted callback is still billed and is invisible to the reactive contract, so the rule would be stuck in "pending" forever. Proposal: if the re-check or the slippage check fails, `execute` emits `RuleSkipped(ruleId, reason)` and returns, leaving the rule Active. The reactive contract subscribes to `RuleSkipped` and re-arms the rule. Auth failures, double execution and other real errors still revert. Tests will cover "condition no longer holds → skipped, funds untouched".
2. **The executor swaps directly through `PoolManager.unlock()` + `IUnlockCallback`**, not through the Universal Router. That's fewer moving parts (no Permit2 or command encoding), cheaper gas, and easier to read.
3. **Custody: the user deposits the sell token into the executor at `createRule`**, so execution needs no approvals or user signature at trigger time. `cancelRule` refunds. For RANGE_GUARD, the user transfers the v4 position NFT to the executor.
4. **Latency proof:** the callback payload carries the origin `log_.txHash`, and `RuleExecuted` emits it. That gives the frontend a direct origin → callback link, plus `T1 − T0` from the two block timestamps. The reactive tx comes from the Lasna explorer, or from `CallbackRequest` logs filtered by our contract. Resolution is 1 s because Unichain blocks are ~1 s (with 200 ms flashblock preconfirmations).
5. **Price direction:** v4 ticks express token1 per token0, and the currency order is set by address sorting. The executor will store `zeroForOne` per rule, and the frontend handles price ↔ tick conversion, so "price ≤ 2,400" always means the right thing.
6. **One shared reactive contract for all users** (not one per user). It's more useful, and it shows the reactive contract doing real work (rule mirror + matching), which scores on Integration.

## 12. ⚠️ Blockers on this machine

1. **The Lasna RPC is blocked by your network.** `https://lasna-rpc.rnk.dev` fails TLS because a **Fortinet firewall** re-signs its certificate (`issuer=…O=Fortinet…`). Unichain and Base RPCs work normally. So I could not read the Lasna system contract on-chain, and **deploying to Lasna from this network will fail**. Fixes: use another network (phone hotspot or home), a VPN, or, if this is a managed work device, ask IT to allowlist `*.rnk.dev`. I won't bypass certificate checks.
2. **Foundry isn't installed.** Phase 1 starts with `curl -L https://foundry.paradigm.xyz | bash` then `foundryup`, run in Git Bash. Node 22 is already present for the frontend.
