# Static analysis: Slither triage

`slither . --filter-paths "lib/|test/|script/" --exclude-dependencies` on `contracts/` (Slither, 101 detectors,
65 contracts), run 2026-11-21. **73 results. None is exploitable.** One finding from our own review (not Slither) is
real and is listed at the end. Raw output: [`slither.json`](slither.json).

| Detector | Impact | n | Where | Assessment |
|---|---|---|---|---|
| uninitialized-state | High | 1 | `ParallaxReactive._poolRules` | False positive. It is a `mapping(bytes32 => uint256[])`; mappings need no initialisation and are filled in `_onRuleCreated`. |
| reentrancy-no-eth | Medium | 7 | executor `execute`, `recenterSelf`; vault `vaultStep`; `V4LiquidityOps`; reactive `_onRuleCreated` | Not exploitable. `execute` is `nonReentrant` **and** callable only by the Callback Proxy with our reactive contract as sender. `recenterSelf` and `vaultStep` revert unless `msg.sender == address(this)`. The external calls go to the canonical v4 PoolManager / PositionManager / Permit2. On Lasna the only external call is `SYSTEM.subscribe` on the fixed system contract, which cannot call back. |
| unused-return | Medium | 13 | `getSlot0` destructuring; `POOL_MANAGER.unlock` in `_swapHeld` | Intentional. We take only the fields we need (`sqrtPriceX96`, `tick`); fees and protocol fee are unused. The `unlock` result is checked inside `unlockCallback`, which enforces `minOut`. |
| incorrect-equality | Medium | 4 | vault `shares == 0`, `liquidity == 0`, `totalSupply == 0`; vault brain `o.at == 0` | Intentional zero checks on values we computed (they cannot be "almost zero" by manipulation in a way that matters): a zero-share deposit reverts, a zero-liquidity add is skipped, an empty vault resets, an empty history slot is reused. |
| divide-before-multiply | Medium | 2 | `PoolMath.floorToSpacing`, `_centredRange` | Intentional: flooring a tick to a multiple of the tick spacing. |
| uninitialized-local | Medium | 1 | `_onSwap` `fired` | Counter that relies on Solidity's zero default. |
| calls-loop | Low | 4 | reactive `_onSwap` callback requests | Bounded: ≤ 25 rules per pool, ≤ 3 callbacks per swap (asserted in tests). |
| reentrancy-benign / reentrancy-events | Low | 18 | same functions as above | Same reasoning as reentrancy-no-eth; event order only. |
| timestamp | Low | 8 | pending timeouts, vault windows | Required by the buildathon rules: Base Sepolia makes 200 ms blocks, so every timer uses `block.timestamp`. A few seconds of validator drift does not matter at 60–120 s windows. |
| naming-convention | Info | 14 | `SCREAMING_CASE` immutables, `_param_` names | Style. |
| immutable-states | Optimization | 1 | `ParallaxReactive.owner` | Correct (never reassigned). Kept as is so the deployed, Sourcify-verified bytecode matches `main`. Will be addressed in v5 together with an ownership-transfer function. |

## Found in our own review, not by Slither

| Issue | Where | Impact | Plan |
|---|---|---|---|
| Vault deposits are valued at the pool's **spot** price | `ParallaxVault.deposit` (`_toToken0(amount1, sqrtP)` with `sqrtP` from `getSlot0`) | Someone could move the pool price within one transaction, deposit, and move it back, minting more `pxLP` than the deposit is worth. Testnet only, mock tokens, but a real flaw. | v5: price deposits from a manipulation-resistant reference (time-weighted tick kept by the vault brain, or a max deviation check against the last recorded tick) and add a sandwich test. Until then it is listed under Known limitations. |
| No way to transfer ownership | `ParallaxReactive`, `ParallaxVaultReactive` | A leaked owner key cannot be rotated; the owner can `withdraw` lREACT and `addChain`. | v5: `transferOwnership` (two-step) and redeploy from a new key. |
