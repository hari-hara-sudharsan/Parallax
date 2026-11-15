# Invalid benchmark runs (kept for transparency)

## `unichain-2026-11-15-06-46.json`: harness bug, not a Parallax failure

The first Unichain Sepolia run reported 0/15 filled. The cause was the **benchmark script**, not the contracts:

- Unichain's public RPC serves **Flashblocks**: transaction receipts arrive at ~200 ms *preconfirmation*, before
  the block is sealed. The harness read `nextRuleId()` right after the `createRule` receipt; that read did not yet
  include the new rule, so every round watched the **previous** round's rule id (round 1 recorded rule id 0).
- Take-profit rounds therefore waited on a mirror entry that never appeared ("mirror timeout") and never sent their
  crossing swap; stop-loss rounds passed on the previous rule's mirror and then failed reading the not-yet-sealed
  origin block ("Block … could not be found").

What actually happened on-chain (read back from `ParallaxExecutor` storage on Unichain Sepolia,
`0x86338DDBD3E2E8546Ff48b3fd4cdb41D40A11181`): **every rule that received a crossing swap executed**: rules
2, 4, 6, 8, 10, 12, 14, each 2–3 blocks after its origin swap. The rules that never got a swap were cancelled or
left armed.

Fix (bench/bench.mjs): take the rule id from the `RuleCreated` event in the receipt, and retry block lookups until
the block is sealed. The re-run with the fixed harness is the one counted in `results/SUMMARY.md`.
