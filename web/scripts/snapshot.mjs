// Freeze every proven loop into src/lib/proofs.json:  npm run snapshot
//
// Lasna nodes prune old blocks, so a reactive tx that the dashboard can find today may be unreadable in a few
// weeks. This script reads each execution's full loop from chain while it is still available and stores it in
// the app's source: the dashboard shows the stored links whenever a live lookup comes back empty.
// Nothing here is invented: every field is read from Base, Unichain or Lasna, and re-running only adds rows.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, decodeEventLog, defineChain, http, parseAbi, toHex } from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";

const OUT = new URL("../src/lib/proofs.json", import.meta.url);
// Every deployment whose loops we keep. Rule ids restart at 1 per executor, so rows are keyed by version too.
const DEPLOYMENTS = [
  {
    version: "v4.1", reactive: "0xDf554201dec784F0541FA5fc884240c73113e334", reactiveBlock: 8399503n,
    executors: { base: "0x2f772766ec926359093FA2d478FBDdcd828304Ff", unichain: "0x5F4159fEF569FbDe44C069751A57e38e97b1109D" },
  },
  {
    version: "v5", reactive: "0x2FCF8025bC42a2902dA7Ddc46A0F1d617B197cf3", reactiveBlock: 8881285n,
    executors: { base: "0x98f96fd0b1cb9B723157D3686446004EcA066982", unichain: "0x391eecF06CA701b891498040D1CEFed90d500030" },
  },
];
const VAULT = { address: "0x9c868A6e74a1D00cc0cD1524AED57c35515c4899", block: 61652690n, brain: "0xca72ebe1E4BD79323EC0bBbc2dd1188999B39a2c", brainBlock: 8881631n };
const CHAINS = [
  { key: "base", chain: baseSepolia, rpc: "https://sepolia.base.org", span: 200n },
  { key: "unichain", chain: unichainSepolia, rpc: "https://sepolia.unichain.org", span: 1000n },
];
// v4.1 rows predate versioned keys; keep their old key so re-runs never duplicate them.
const rowKey = (version, chain, id) => (version === "v4.1" ? `${chain}:${id}` : `${version}:${chain}:${id}`);

const lasna = createPublicClient({
  chain: defineChain({ id: 5318007, name: "Lasna", nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 }, rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } } }),
  transport: http(),
});
const executorAbi = parseAbi([
  "function nextRuleId() view returns (uint256)",
  "function executions(uint256) view returns (uint256 originTxHash, uint64 originBlock, uint64 executedBlock, uint64 executedAt)",
  "event RuleExecuted(uint256 indexed ruleId, address indexed owner, int24 tick, uint256 amount0Out, uint256 amount1Out, uint256 originTxHash, uint256 originBlock, uint256 executedAt)",
]);
const reactiveAbi = parseAbi(["event RuleTriggered(uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId, int24 tick, uint256 originTxHash)"]);
const brainAbi = parseAbi(["event VaultActionRequested(uint8 action, int24 tick, int24 windowMove, uint256 originTxHash)"]);
const vaultEvents = parseAbi([
  "event VaultPositioned(uint256 positionId, int24 tickLower, int24 tickUpper, int24 anchorTick, uint8 reason)",
  "event VaultEvacuated(int24 tick, uint256 amount0, uint256 amount1)",
  "event VaultSkipped(uint8 action, uint8 reason, int24 tick)",
]);

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { executions: [], vault: [] };
const known = new Map(prev.executions.map((e) => [rowKey(e.version, e.chain, e.ruleId), e]));
const knownVault = new Map(prev.vault.map((v) => [v.callbackTx, v]));

// The benchmark rounds (bench/bench.mjs, v3 contracts) were read from chain when they ran; fold them in as-is.
const RESULTS = new URL("../../results/", import.meta.url);
const bench = [];
for (const f of readdirSync(RESULTS).filter((f) => /^(base|unichain)-.*\.json$/.test(f))) {
  const version = f.includes("2026-11-21") ? "v5" : "v3"; // the v5 rounds were all run on 21 Nov
  for (const r of JSON.parse(readFileSync(new URL(f, RESULTS), "utf8"))) {
    if (!r.callbackTx || !r.originTx) continue; // failed rounds stay in results/, not in the proof store
    bench.push({
      source: "bench", version, chain: r.chain, ruleId: r.ruleId, kind: r.kind, originTx: r.originTx, originBlock: r.originBlock,
      t0: r.originTimestamp, reactiveTx: r.reactiveTx ?? null, callbackTx: r.callbackTx, executedBlock: r.executedBlock, t1: r.executedAt,
      latencyBlocks: r.latencyBlocks,
    });
  }
}

const tsCache = new Map();
async function lasnaTs(n) {
  if (!tsCache.has(n)) tsCache.set(n, Number((await lasna.getBlock({ blockNumber: n })).timestamp));
  return tsCache.get(n);
}
async function lasnaBlockAt(ts, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await lasnaTs(mid)) < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

let lasnaOk = true;
const lasnaLatest = await lasna.getBlockNumber().catch((e) => {
  lasnaOk = false;
  console.log(`! Lasna unreachable (${String(e.shortMessage ?? e.message).split(String.fromCharCode(10))[0]}): keeping stored rows, adding bench rounds only`);
  return 0n;
});

for (const D of lasnaOk ? DEPLOYMENTS : []) for (const C0 of CHAINS) {
  const C = { ...C0, executor: D.executors[C0.key] };
  const REACTIVE = D.reactive;
  const REACTIVE_BLOCK = D.reactiveBlock;
  const pub = createPublicClient({ chain: C.chain, transport: http(C.rpc) });
  const next = await pub.readContract({ address: C.executor, abi: executorAbi, functionName: "nextRuleId" });
  for (let id = 1n; id < next; id++) {
    const key = rowKey(D.version, C.key, id);
    if (known.get(key)?.reactiveTx) continue; // complete rows never change
    const ex = await pub.readContract({ address: C.executor, abi: executorAbi, functionName: "executions", args: [id] });
    if (ex[2] === 0n) continue; // not executed
    const [log] = await pub.getContractEvents({ address: C.executor, abi: executorAbi, eventName: "RuleExecuted", args: { ruleId: id }, fromBlock: ex[2], toBlock: ex[2] });
    const t0 = Number((await pub.getBlock({ blockNumber: ex[1] })).timestamp);
    const t1 = Number((await pub.getBlock({ blockNumber: ex[2] })).timestamp);
    const start = await lasnaBlockAt(t0, REACTIVE_BLOCK, lasnaLatest);
    const trig = await lasna.getContractEvents({
      address: REACTIVE, abi: reactiveAbi, eventName: "RuleTriggered", args: { chainId: BigInt(C.chain.id), ruleId: id },
      fromBlock: start - 60n, toBlock: start + 600n > lasnaLatest ? lasnaLatest : start + 600n,
    });
    const originTx = toHex(ex[0], { size: 32 });
    const hit = trig.find((t) => toHex(t.args.originTxHash, { size: 32 }) === originTx);
    known.set(key, {
      source: "live",
      version: D.version,
      chain: C.key,
      ruleId: Number(id),
      owner: log?.args.owner,
      originTx,
      originBlock: Number(ex[1]),
      t0,
      reactiveTx: hit?.transactionHash ?? null,
      callbackTx: log?.transactionHash ?? null,
      executedBlock: Number(ex[2]),
      t1,
      latencyBlocks: Number(ex[2] - ex[1]),
    });
    console.log(`${key}: ${Number(ex[2] - ex[1])} blocks, reactive ${hit?.transactionHash?.slice(0, 10) ?? "not found"}`);
  }
}

// Vault: each brain request (Lasna) names its origin swap; the vault's answer follows it on Base.
const base = createPublicClient({ chain: baseSepolia, transport: http(CHAINS[0].rpc) });
const reqs = [];
for (let from = VAULT.brainBlock; lasnaOk && from <= lasnaLatest; from += 10_000n) {
  const to = from + 9_999n > lasnaLatest ? lasnaLatest : from + 9_999n;
  reqs.push(...(await lasna.getContractEvents({ address: VAULT.brain, abi: brainAbi, eventName: "VaultActionRequested", fromBlock: from, toBlock: to })));
}
const ACTIONS = ["rebalance", "evacuate", "reenter"];
const scout = !lasnaOk ? {} : await (await fetch(`https://base-sepolia.blockscout.com/api?module=logs&action=getLogs&fromBlock=${VAULT.block}&toBlock=latest&address=${VAULT.address}`)).json();
const answers = [];
for (const l of Array.isArray(scout.result) ? scout.result : []) {
  let d;
  try {
    d = decodeEventLog({ abi: vaultEvents, data: l.data, topics: l.topics.filter(Boolean) });
  } catch {
    continue; // Deposited, Transfer, …
  }
  const name = d.eventName;
  const reason = name === "VaultPositioned" ? Number(d.args.reason) : name === "VaultSkipped" ? Number(d.args.action) : 1;
  if (name === "VaultPositioned" && reason === 0) continue; // the first deposit, not a reactive action
  answers.push({ name, action: name === "VaultPositioned" ? (reason === 2 ? "reenter" : "rebalance") : name === "VaultEvacuated" ? "evacuate" : ACTIONS[reason], tx: l.transactionHash, block: Number(BigInt(l.blockNumber)) });
}
answers.sort((a, b) => a.block - b.block);
for (let i = 0; i < answers.length; i++) {
  const a = answers[i];
  const r = reqs[i];
  if (!r || knownVault.get(a.tx)?.reactiveTx) continue;
  const originTx = toHex(r.args.originTxHash, { size: 32 });
  const rc = await base.getTransactionReceipt({ hash: originTx });
  knownVault.set(a.tx, {
    action: a.action,
    skipped: a.name === "VaultSkipped",
    originTx,
    originBlock: Number(rc.blockNumber),
    reactiveTx: r.transactionHash,
    callbackTx: a.tx,
    callbackBlock: a.block,
    latencyBlocks: a.block - Number(rc.blockNumber),
  });
  console.log(`vault ${a.action}: ${a.block - Number(rc.blockNumber)} blocks`);
}

const out = {
  note: "Frozen by web/scripts/snapshot.mjs from Base, Unichain and Lasna. Lasna prunes old blocks; these rows keep the proof.",
  updated: new Date().toISOString(),
  executions: [...known.values()].sort((a, b) => b.t0 - a.t0),
  bench: bench.sort((a, b) => b.t0 - a.t0),
  vault: [...knownVault.values()].sort((a, b) => b.callbackBlock - a.callbackBlock),
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.executions.length} live executions, ${out.bench.length} bench rounds and ${out.vault.length} vault actions`);
