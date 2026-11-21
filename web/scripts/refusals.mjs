// Copies the refusal-room proofs (results/refusals-<chain>-*.json, written by bench/refusals.mjs) into the dashboard:
// for each scenario, the latest proven run against the CURRENT executor. Run: node scripts/refusals.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const results = join(ROOT, "results");
const out = {};
for (const [chain, chainId] of [["base", 84532], ["unichain", 1301]]) {
  const executor = JSON.parse(readFileSync(join(ROOT, "contracts/deployments", `${chainId}.json`), "utf8")).parallaxExecutor.toLowerCase();
  const merged = {};
  for (const f of readdirSync(results).filter((f) => f.startsWith(`refusals-${chain}-`) && f.endsWith(".json")).sort()) {
    const run = JSON.parse(readFileSync(join(results, f), "utf8"));
    if (run.executor?.toLowerCase() !== executor) continue;
    for (const [k, v] of Object.entries(run.results ?? {})) if (v.proven || !merged[k]?.proven) merged[k] = { ...v, ranAt: run.ranAt };
  }
  if (Object.keys(merged).length) out[chain] = merged;
}
writeFileSync(join(ROOT, "web/src/lib/refusals.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote web/src/lib/refusals.json:", Object.fromEntries(Object.entries(out).map(([c, m]) => [c, Object.keys(m).length])));
