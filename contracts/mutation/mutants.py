#!/usr/bin/env python3
"""Mutation testing for Parallax's guards: break one check at a time, the test suite must fail.

    python contracts/mutation/mutants.py            # all mutants  (or: ./tw.sh mutants)
    python contracts/mutation/mutants.py 3 7        # only mutants #3 and #7

Each mutant replaces one exact piece of source text (it must occur exactly once) and runs `forge test --fail-fast`.
A mutant is KILLED when at least one test fails; it SURVIVES when every test still passes, which means that guard
is not actually tested. The original file is always restored, even on Ctrl-C. Writes results/mutants.md.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

CONTRACTS = Path(__file__).resolve().parent.parent
ROOT = CONTRACTS.parent
EXEC = "src/ParallaxExecutor.sol"
REACT = "src/ParallaxReactive.sol"
OPS = "src/base/V4LiquidityOps.sol"
VAULT = "src/ParallaxVault.sol"
BRAIN = "src/ParallaxVaultReactive.sol"

# (file, original text, mutated text, what the mutant breaks)
MUTANTS = [
    # ── ParallaxExecutor: who may call, and what it re-checks ──
    (EXEC, "external override nonReentrant onlyServiceProvider onlyCallbackSender(reactiveSender) {",
     "external override nonReentrant onlyCallbackSender(reactiveSender) {", "execute: drop the Callback Proxy check"),
    (EXEC, "external override nonReentrant onlyServiceProvider onlyCallbackSender(reactiveSender) {",
     "external override nonReentrant onlyServiceProvider {", "execute: drop the reactive-sender check"),
    (EXEC, "int24 /* observedTick */ )\n        external\n        override\n        nonReentrant\n        onlyServiceProvider\n",
     "int24 /* observedTick */ )\n        external\n        override\n        nonReentrant\n", "raiseTrail: drop the Callback Proxy check"),
    (EXEC, "        if (r.status != RuleStatus.ACTIVE) {", "        if (false) {", "execute: drop idempotency (execute twice)"),
    (EXEC, "        if (!_isTriggered(r.lowerTick, r.upperTick, tick)) {", "        if (false) {",
     "execute: trust the callback, skip the live-tick re-check"),
    (EXEC, "return tick <= lowerTick || tick >= upperTick;", "return tick < lowerTick || tick > upperTick;",
     "trigger test: exclusive instead of inclusive bounds"),
    (EXEC, "            r.status = RuleStatus.ACTIVE;\n", "\n", "failed action: rule is not restored (deposit lost)"),
    (EXEC, "        if (msg.sender != address(this)) revert NotSelf();", "",
     "recenterSelf: callable by anyone"),
    (EXEC, "        _checkBounds(lowerTick, upperTick);\n", "\n", "createRule: no bounds validation"),
    (EXEC, "        if (bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(bps, MAX_SLIPPAGE_BPS);", "",
     "rule creation: no slippage cap"),
    (OPS, "        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);", "",
     "swap: no minimum-output check"),
    # ── ParallaxReactive: what it decides on Lasna ──
    (REACT, "function react(LogRecord memory log_) external onlySystem {", "function react(LogRecord memory log_) external {",
     "react: callable by anyone, not only the system contract"),
    (REACT, "        if (log_.contractAddress != cfg.executor) return;", "",
     "react: accepts rule events from any contract"),
    (REACT, "        if (_mirror[key].exists) return; // duplicate delivery", "",
     "mirror: duplicate RuleCreated is mirrored twice"),
    (REACT, "        bool armed = m.pendingSince == 0 || block.timestamp >= m.pendingSince + PENDING_TIMEOUT;",
     "        bool armed = true;", "dedupe: a pending rule fires again on every swap"),
    (REACT, "        bool armed = m.pendingSince == 0 || block.timestamp >= m.pendingSince + PENDING_TIMEOUT;",
     "        bool armed = m.pendingSince == 0;", "timeout: a lost callback leaves the rule stuck forever"),
    (REACT, "        m.pendingSince = uint64(block.timestamp); // de-dupe: one in-flight callback per rule", "",
     "dedupe: rule is never marked pending"),
    (REACT, "if (tick > m.lowerTick && tick < m.upperTick) return", "if (tick >= m.lowerTick && tick < m.upperTick) return",
     "decision: stop at exactly its line does not fire"),
    (REACT, "fired < MAX_CALLBACKS_PER_EVENT;", "fired <= MAX_CALLBACKS_PER_EVENT;", "gas: one callback over the per-swap cap"),
    (REACT, "        m.pendingSince = 0;\n        emit RuleRearmed(chainId, ruleId);", "        emit RuleRearmed(chainId, ruleId);",
     "re-arm: a skipped rule is never re-armed (waits for the timeout)"),
    (REACT, "        if (list.length == 0) _unwatchPool(chainId, poolId);", "        if (false) _unwatchPool(chainId, poolId);",
     "subscriptions: an empty pool keeps costing lREACT"),
    (REACT, "        if (list.length >= MAX_RULES_PER_POOL) {", "        if (false) {", "gas: no rule cap per pool"),
    (REACT, "uint64 public constant RAISE_GAS_LIMIT = 500_000;", "uint64 public constant RAISE_GAS_LIMIT = 200_000;",
     "the live v4 bug: raise callback gas back to 200k"),
    # ── Debt-pause recovery (v5) ──
    (REACT, "if (reason == uint256(SkipReason.NOT_ACTIVE)) _removeRule(log_.chainId, log_.topic1);",
     "if (false) _removeRule(log_.chainId, log_.topic1);", "debt pause: a dead rule is re-armed and refires forever"),
    (REACT, "t0 == RULE_CANCELLED_TOPIC0 || t0 == RULE_SETTLED_TOPIC0", "t0 == RULE_CANCELLED_TOPIC0",
     "resync: RuleSettled is ignored, stale mirror stays"),
    (EXEC, "        if (r.status == RuleStatus.ACTIVE) _emitCreated(ruleId, r);", "        if (r.status == RuleStatus.ACTIVE) {}",
     "resync: an active rule is not re-announced"),
    (EXEC, "        else emit RuleSettled(ruleId, r.status);", "", "resync: a settled rule is not re-announced"),
    # ── Panic Exit / Tryout / vault deposits (v5) ──
    (EXEC, "        onlyServiceProvider\n        onlyCallbackSender(reactiveSender)\n    {\n        (uint256 closed, uint256 remaining) = _panicClose(owner_);",
     "        onlyCallbackSender(reactiveSender)\n    {\n        (uint256 closed, uint256 remaining) = _panicClose(owner_);",
     "panicExit: callable without the Callback Proxy"),
    (EXEC, "scanned < PANIC_SCAN && closed < MAX_PANIC_PER_CALL;", "scanned < PANIC_SCAN;",
     "panic: no per-call bound (gas could exceed the callback limit)"),
    (EXEC, "            if (!ok) ERC20(_inputToken(key, r.zeroForOne)).safeTransfer(r.owner, r.amountIn);", "",
     "panic: a failed sale keeps the deposit instead of refunding it"),
    ("src/ParallaxTryout.sol", "        if (armedBy[ruleId] != msg.sender) revert NotYours(ruleId);", "",
     "tryout: anyone can crash someone else's stop"),
    (VAULT, "            if (s1 < shares) shares = s1;", "            if (s1 > shares) shares = s1;",
     "vault: shares from the plentiful side (sandwich / over-mint)"),
    # ── Vault ──
    (VAULT, "        if (msg.sender != address(this)) revert NotSelf();", "", "vaultStep: callable by anyone"),
    (BRAIN, "if (move >= BREAKER_TICKS && fromAnchor >= BREAKER_TICKS)", "if (move > BREAKER_TICKS * 50 && fromAnchor >= BREAKER_TICKS)",
     "vault brain: crash breaker never trips"),
]


def run_tests() -> tuple[bool, str]:
    p = subprocess.run(["forge", "test", "--fail-fast"], cwd=CONTRACTS, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    out = p.stdout + p.stderr
    if "Compiler run failed" in out or "Error: Compiler" in out:
        return None, "does not compile"
    failing = [line.strip() for line in out.splitlines() if line.strip().startswith("[FAIL")]
    return p.returncode != 0, failing[0][:110] if failing else ""


def main() -> None:
    picks = {int(a) for a in sys.argv[1:]}
    rows = []
    for n, (rel, old, new, what) in enumerate(MUTANTS, 1):
        if picks and n not in picks:
            continue
        path = CONTRACTS / rel
        src = path.read_bytes().decode("utf-8")  # bytes in, bytes out: keep line endings exactly
        count = src.count(old)
        if count != 1:
            rows.append((n, rel, what, f"SKIPPED (pattern found {count}×)", ""))
            print(f"#{n:2} skipped: pattern found {count}x in {rel}")
            continue
        t0 = time.time()
        try:
            path.write_bytes(src.replace(old, new).encode("utf-8"))
            killed, by = run_tests()
        finally:
            path.write_bytes(src.encode("utf-8"))
        verdict = "INVALID" if killed is None else ("killed" if killed else "SURVIVED")
        rows.append((n, rel, what, verdict, by))
        print(f"#{n:2} {verdict:8} {time.time() - t0:5.0f}s  {what}  {by}", flush=True)

    killed = sum(r[3] == "killed" for r in rows)
    tested = sum(r[3] in ("killed", "SURVIVED") for r in rows)
    md = ["# Mutation testing", "",
          "Generated by [`contracts/mutation/mutants.py`](../contracts/mutation/mutants.py). Each mutant breaks one guard "
          "in the source and runs the full Foundry suite; a guard is only really tested if breaking it makes a test fail.",
          "", f"**{killed} of {tested} mutants killed.**", "",
          "| # | File | Mutant | Result | First failing test |", "|---|---|---|---|---|"]
    md += [f"| {n} | `{rel}` | {what} | {'✅ killed' if v == 'killed' else '❌ ' + v} | {by.replace('|', '/')} |"
           for n, rel, what, v, by in rows]
    if not picks:
        (ROOT / "results" / "mutants.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print(f"\n{killed}/{tested} killed")
    sys.exit(0 if killed == tested else 1)


if __name__ == "__main__":
    main()
