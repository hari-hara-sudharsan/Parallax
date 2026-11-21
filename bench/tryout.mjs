// Runs the zero-setup judge path once, live, and records every hop:
//   arm() → Lasna mirrors the rule → crash(id) → Lasna decides → callback sells the stop
//
//   CHAIN=base node tryout.mjs        (or: CHAIN=base ./tw.sh tryout)
//
// The wallet only needs gas: ParallaxTryout mints the demo tokens itself. Writes results/tryout-<chain>-<date>.json.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, defineChain, parseEventLogs, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, unichainSepolia } from "viem/chains";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAINS = {
  base: { chain: baseSepolia, rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org", explorer: "https://sepolia.basescan.org/tx/" },
  unichain: { chain: unichainSepolia, rpc: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org", explorer: "https://sepolia.uniscan.xyz/tx/" },
};
const LASNA_RPC = process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/";
const lasna = defineChain({ id: 5318007, name: "Reactive Lasna", nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: [LASNA_RPC] } } });
const POLL_MS = 300;
const TIMEOUT_MS = 120_000;

const tryoutAbi = parseAbi([
  "function arm() returns (uint256)",
  "function crash(uint256 ruleId)",
  "function restore()",
  "event Armed(address indexed user, uint256 indexed ruleId, int24 line, int24 tick)",
  "event Crashed(address indexed user, uint256 indexed ruleId, int24 tickBefore, int24 tickAfter)",
]);
const executorAbi = parseAbi([
  "function executions(uint256 ruleId) view returns (uint256 originTxHash, uint64 originBlock, uint64 executedBlock, uint64 executedAt)",
  "event RuleExecuted(uint256 indexed ruleId, address indexed owner, int24 tick, uint256 amount0Out, uint256 amount1Out, uint256 originTxHash, uint256 originBlock, uint256 executedAt)",
]);
const reactiveAbi = parseAbi([
  "struct MirrorRule { bytes32 poolId; int24 lowerTick; int24 upperTick; bool exists; uint64 pendingSince; uint32 index; }",
  "function mirror(uint256 chainId, uint256 ruleId) view returns (MirrorRule)",
  "event RuleTriggered(uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId, int24 tick, uint256 originTxHash)",
]);

const chainName = process.env.CHAIN || "base";
const C = CHAINS[chainName];
const key = process.env.PRIVATE_KEY ?? readFileSync(join(ROOT, ".env"), "utf8").match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m)?.[1];
if (!key) throw new Error("PRIVATE_KEY missing");
const account = privateKeyToAccount(key);
const dep = JSON.parse(readFileSync(join(ROOT, "contracts/deployments", `${C.chain.id}.json`), "utf8"));
const reactive = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/5318007.json"), "utf8")).parallaxReactive;
const { parallaxTryout: tryout, parallaxExecutor: executor } = dep;
const transport = (url) => http(url, { retryCount: 6, retryDelay: 800, timeout: 20_000 });
const pub = createPublicClient({ chain: C.chain, transport: transport(C.rpc) });
const wallet = createWalletClient({ account, chain: C.chain, transport: transport(C.rpc) });
const lpub = createPublicClient({ chain: lasna, transport: transport(LASNA_RPC) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`timeout waiting for ${what}`);
    await sleep(POLL_MS);
  }
}
async function send(functionName, args = []) {
  const hash = await wallet.writeContract({ address: tryout, abi: tryoutAbi, functionName, args });
  const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS });
  if (rc.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return rc;
}

console.log(`Tryout · ${C.chain.name} · tryout ${tryout} · executor ${executor} · reactive ${reactive}`);
const lasnaFrom = await lpub.getBlockNumber();
const armRc = await send("arm");
const [armed] = parseEventLogs({ abi: tryoutAbi, eventName: "Armed", logs: armRc.logs });
const ruleId = armed.args.ruleId;
console.log(`armed rule ${ruleId} (line ${armed.args.line}, tick ${armed.args.tick}) ${C.explorer}${armRc.transactionHash}`);

const tMirror = Date.now();
await until("mirror", async () => (await lpub.readContract({ address: reactive, abi: reactiveAbi, functionName: "mirror", args: [BigInt(C.chain.id), ruleId] })).exists);
console.log(`mirrored on Lasna after ${((Date.now() - tMirror) / 1000).toFixed(1)} s`);

const crashRc = await send("crash", [ruleId]);
const [crashed] = parseEventLogs({ abi: tryoutAbi, eventName: "Crashed", logs: crashRc.logs });
console.log(`crash tick ${crashed.args.tickBefore} → ${crashed.args.tickAfter} ${C.explorer}${crashRc.transactionHash}`);

const exec = await until("execution", async () => {
  const e = await pub.readContract({ address: executor, abi: executorAbi, functionName: "executions", args: [ruleId] });
  return e[2] > 0n ? e : null;
});
const [execLog] = await pub.getContractEvents({ address: executor, abi: executorAbi, eventName: "RuleExecuted", args: { ruleId }, fromBlock: exec[2], toBlock: exec[2] });
const trig = await lpub.getContractEvents({ address: reactive, abi: reactiveAbi, eventName: "RuleTriggered", args: { chainId: BigInt(C.chain.id), ruleId }, fromBlock: lasnaFrom });
const originBlock = await pub.getBlock({ blockNumber: crashRc.blockNumber });
const out = {
  chain: chainName, ranAt: new Date().toISOString(), visitor: account.address, tryout, executor, reactive, ruleId: Number(ruleId),
  armTx: armRc.transactionHash, originTx: crashRc.transactionHash, reactiveTx: trig[0]?.transactionHash, callbackTx: execLog?.transactionHash,
  recordedOrigin: toHex(exec[0], { size: 32 }), latencyBlocks: Number(exec[2] - crashRc.blockNumber),
  latencySeconds: Number(exec[3]) - Number(originBlock.timestamp),
};
out.ok = out.recordedOrigin.toLowerCase() === crashRc.transactionHash.toLowerCase();
console.log(`filled ${out.latencyBlocks} blocks (${out.latencySeconds} s by timestamp) after the crash`);
console.log(`  reactive https://lasna.reactscan.net/tx/${out.reactiveTx}\n  callback ${C.explorer}${out.callbackTx}`);
const rr = await send("restore").catch((e) => ({ error: String(e?.shortMessage ?? e) }));
out.restoreTx = rr.transactionHash;
writeFileSync(join(ROOT, "results", `tryout-${chainName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`), JSON.stringify(out, null, 2));
console.log(out.ok ? "OK: the execution record points at our crash" : "MISMATCH");
