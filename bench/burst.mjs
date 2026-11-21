// Burst: many rules crossed by ONE swap. Shows the per-swap callback cap working live.
//
//   CHAIN=base node burst.mjs [N=5]        (or: CHAIN=base ./tw.sh burst 5)
//
// Arms N stop-losses on the same line, then one swap crosses all of them. ParallaxReactive fires at most
// MAX_CALLBACKS_PER_EVENT (3) per swap, so react() always stays far below Lasna's gas cap; the remaining rules fire on
// the next swap. Records which rules each swap fired and when each was executed (results/burst-<chain>-<date>.json).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, defineChain, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, unichainSepolia } from "viem/chains";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LASNA_RPC = process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/";
const CHAINS = {
  base: { chain: baseSepolia, rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4", poolSwapTest: "0x8b5bcc363dde2614281ad875bad385e0a785d3b9",
    explorer: "https://sepolia.basescan.org/tx/" },
  unichain: { chain: unichainSepolia, rpc: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org",
    stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222", poolSwapTest: "0x9140a78c1a137c7ff1c151ec8231272af78a99a4",
    explorer: "https://sepolia.uniscan.xyz/tx/" },
};
const lasna = defineChain({ id: 5318007, name: "Reactive Lasna", nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: [LASNA_RPC] } } });
const NO_LOWER = -(2 ** 23);
const NO_UPPER = 2 ** 23 - 1;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const POLL_MS = 300;
const TIMEOUT_MS = 180_000;

const executorAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function createRule(PoolKey key, uint8 ruleType, bool zeroForOne, int24 lowerTick, int24 upperTick, uint128 amountIn, uint16 maxSlippageBps) returns (uint256)",
  "function executions(uint256 ruleId) view returns (uint256 originTxHash, uint64 originBlock, uint64 executedBlock, uint64 executedAt)",
  "event RuleCreated(uint256 indexed ruleId, address indexed owner, bytes32 indexed poolId, uint8 ruleType, int24 lowerTick, int24 upperTick, bool zeroForOne, uint128 amountIn, uint256 positionId, int24 trailTicks)",
]);
const reactiveAbi = parseAbi([
  "struct MirrorRule { bytes32 poolId; int24 lowerTick; int24 upperTick; bool exists; uint64 pendingSince; uint32 index; }",
  "function mirror(uint256 chainId, uint256 ruleId) view returns (MirrorRule)",
  "function MAX_CALLBACKS_PER_EVENT() view returns (uint256)",
  "event RuleTriggered(uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId, int24 tick, uint256 originTxHash)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address who) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);
const swapAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
  "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
  "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256)",
]);
const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)"]);

const chainName = process.env.CHAIN || "base";
const C = CHAINS[chainName];
const N = Number(process.argv[2] || 5);
const key = process.env.PRIVATE_KEY ?? readFileSync(join(ROOT, ".env"), "utf8").match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m)?.[1];
const account = privateKeyToAccount(key);
const dep = JSON.parse(readFileSync(join(ROOT, "contracts/deployments", `${C.chain.id}.json`), "utf8"));
const reactive = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/5318007.json"), "utf8")).parallaxReactive;
const { parallaxExecutor: executor, mockWETH: weth, mockUSDC: usdc, poolId } = dep;
const wethIs0 = weth.toLowerCase() < usdc.toLowerCase();
const poolKey = { currency0: wethIs0 ? weth : usdc, currency1: wethIs0 ? usdc : weth, fee: 3000, tickSpacing: 60,
  hooks: "0x0000000000000000000000000000000000000000" };
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
async function send(req) {
  const hash = await wallet.writeContract(req);
  const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS });
  if (rc.status !== "success") throw new Error(`reverted: ${hash}`);
  return rc;
}
const tick = async () => (await pub.readContract({ address: C.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }))[1];
const sellWeth = (amount) => {
  const zeroForOne = wethIs0;
  return { address: C.poolSwapTest, abi: swapAbi, functionName: "swap",
    args: [poolKey, { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x"] };
};

console.log(`Burst · ${C.chain.name} · ${N} rules on one line · executor ${executor} · reactive ${reactive}`);
const cap = Number(await lpub.readContract({ address: reactive, abi: reactiveAbi, functionName: "MAX_CALLBACKS_PER_EVENT" }));
const bal = (t) => pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
if ((await bal(weth)) < 20n * 10n ** 18n) await send({ address: weth, abi: erc20Abi, functionName: "mint", args: [account.address, 50n * 10n ** 18n] });
for (const s of [executor, C.poolSwapTest]) {
  if ((await pub.readContract({ address: weth, abi: erc20Abi, functionName: "allowance", args: [account.address, s] })) < 10n ** 30n)
    await send({ address: weth, abi: erc20Abi, functionName: "approve", args: [s, 2n ** 255n] });
}

// 1. N stops on the same line, 0.5% below spot.
const t = await tick();
const [lower, upper] = wethIs0 ? [t - 50, NO_UPPER] : [NO_LOWER, t + 50];
const ids = [];
for (let i = 0; i < N; ++i) {
  const rc = await send({ address: executor, abi: executorAbi, functionName: "createRule", args: [poolKey, 0, wethIs0, lower, upper, parseUnits("0.02", 18), 300] });
  ids.push(parseEventLogs({ abi: executorAbi, eventName: "RuleCreated", logs: rc.logs })[0].args.ruleId);
}
for (const id of ids) {
  await until(`mirror ${id}`, async () => (await lpub.readContract({ address: reactive, abi: reactiveAbi, functionName: "mirror", args: [BigInt(C.chain.id), id] })).exists);
}
console.log(`armed rules ${ids.join(", ")} on one line; all mirrored`);

// 2. One crossing swap.
const lasnaFrom = await lpub.getBlockNumber();
const s1 = await send(sellWeth(parseUnits("2", 18)));
console.log(`swap 1 crosses all ${N}: ${C.explorer}${s1.transactionHash}`);
const triggersFor = async (hash) =>
  (await lpub.getContractEvents({ address: reactive, abi: reactiveAbi, eventName: "RuleTriggered", args: { chainId: BigInt(C.chain.id) }, fromBlock: lasnaFrom }))
    .filter((l) => ("0x" + l.args.originTxHash.toString(16).padStart(64, "0")).toLowerCase() === hash.toLowerCase());
const firstBatch = await until("first batch", async () => {
  const l = await triggersFor(s1.transactionHash);
  return l.length ? l : null;
});
await sleep(6000); // let the rest of the same reactive tx be indexed
const batch1 = await triggersFor(s1.transactionHash);
console.log(`swap 1 → Lasna fired ${batch1.length} (cap ${cap}) in ${[...new Set(batch1.map((l) => l.transactionHash))].join(", ")}`);

// 3. The rest fire on the next Swap in the pool, whoever sends it. Usually that is the first stop's own sale.
const s2 = await send(sellWeth(parseUnits("0.05", 18))); // a nudge, in case nothing else trades
console.log(`swap 2 (a nudge, still below the line): ${C.explorer}${s2.transactionHash}`);
const fired1 = new Set(batch1.map((l) => Number(l.args.ruleId)));
const rest = ids.map(Number).filter((id) => !fired1.has(id));
const batch2 = await until("the remaining rules", async () => {
  const all = await lpub.getContractEvents({ address: reactive, abi: reactiveAbi, eventName: "RuleTriggered", args: { chainId: BigInt(C.chain.id) }, fromBlock: lasnaFrom });
  const later = all.filter((l) => rest.includes(Number(l.args.ruleId)));
  return later.length >= rest.length ? later : null;
});
const batch2Origins = [...new Set(batch2.map((l) => "0x" + l.args.originTxHash.toString(16).padStart(64, "0")))];
console.log(`the remaining ${batch2.length} fired from origin ${batch2Origins.join(", ")}`);

// 4. Every rule executed.
const execs = [];
for (const id of ids) {
  const e = await until(`execution ${id}`, async () => {
    const x = await pub.readContract({ address: executor, abi: executorAbi, functionName: "executions", args: [id] });
    return x[2] > 0n ? x : null;
  });
  execs.push({ ruleId: Number(id), originBlock: Number(e[1]), executedBlock: Number(e[2]), latencyBlocks: Number(e[2] - e[1]) });
}
const out = {
  chain: chainName, ranAt: new Date().toISOString(), executor, reactive, cap, rules: ids.map(Number),
  swap1: s1.transactionHash, batch1: { fired: batch1.length, rules: batch1.map((l) => Number(l.args.ruleId)), reactiveTx: batch1[0]?.transactionHash },
  swap2: s2.transactionHash, batch2: { fired: batch2.length, rules: batch2.map((l) => Number(l.args.ruleId)), reactiveTx: batch2[0]?.transactionHash, origins: batch2Origins },
  executions: execs,
};
out.ok = batch1.length === Math.min(cap, N) && batch1.length + batch2.length === N && execs.length === N;
for (const e of execs) console.log(`  rule ${e.ruleId}: executed ${e.latencyBlocks} blocks after its origin swap`);
writeFileSync(join(ROOT, "results", `burst-${chainName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`), JSON.stringify(out, null, 2));
console.log(out.ok ? `OK: ${batch1.length} on the crossing swap (the cap), ${batch2.length} on the next swap in the pool, all ${N} executed` : "NOT OK");
