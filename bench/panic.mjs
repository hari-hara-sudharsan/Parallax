// Live cross-chain Panic Exit: one transaction on one chain closes your rules on BOTH chains.
//
//   FROM=base node panic.mjs          (or: FROM=base ./tw.sh panic)
//
//  1. arm a stop-loss on Base Sepolia and one on Unichain Sepolia (each 0.5% away, so neither fires on its own)
//  2. wait until Lasna mirrors both
//  3. call panic() on FROM: its rule closes in that same transaction
//  4. Lasna sees PanicRequested and relays panicExit to the other chain, where the rule closes too
// Records every hash and the latency of the cross-chain leg in results/panic-<date>.json.

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
    stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4", explorer: "https://sepolia.basescan.org/tx/" },
  unichain: { chain: unichainSepolia, rpc: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org",
    stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222", explorer: "https://sepolia.uniscan.xyz/tx/" },
};
const lasna = defineChain({ id: 5318007, name: "Reactive Lasna", nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: [LASNA_RPC] } } });
const NO_LOWER = -(2 ** 23);
const NO_UPPER = 2 ** 23 - 1;
const RULE_WETH = parseUnits("0.05", 18);
const POLL_MS = 300;
const TIMEOUT_MS = 180_000;

const executorAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Rule { address owner; uint8 ruleType; uint8 status; bool zeroForOne; int24 lowerTick; int24 upperTick; uint16 maxSlippageBps; uint128 amountIn; uint64 createdAt; int24 trailTicks; bool recenter; bytes32 poolId; uint256 positionId; }",
  "function createRule(PoolKey key, uint8 ruleType, bool zeroForOne, int24 lowerTick, int24 upperTick, uint128 amountIn, uint16 maxSlippageBps) returns (uint256)",
  "function getRule(uint256 ruleId) view returns (Rule)",
  "function panic() returns (uint256 closed, uint256 remaining)",
  "function activeRulesOf(address owner) view returns (uint256)",
  "event RuleCreated(uint256 indexed ruleId, address indexed owner, bytes32 indexed poolId, uint8 ruleType, int24 lowerTick, int24 upperTick, bool zeroForOne, uint128 amountIn, uint256 positionId, int24 trailTicks)",
  "event PanicRequested(address indexed owner, uint256 closed, uint256 remaining)",
  "event PanicExecuted(address indexed owner, uint256 closed, uint256 remaining)",
]);
const reactiveAbi = parseAbi([
  "struct MirrorRule { bytes32 poolId; int24 lowerTick; int24 upperTick; bool exists; uint64 pendingSince; uint32 index; }",
  "function mirror(uint256 chainId, uint256 ruleId) view returns (MirrorRule)",
  "event PanicRelayed(uint256 indexed fromChain, uint256 indexed toChain, address indexed owner)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address who) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);
const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)"]);

const key = process.env.PRIVATE_KEY ?? readFileSync(join(ROOT, ".env"), "utf8").match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m)?.[1];
const account = privateKeyToAccount(key);
const transport = (url) => http(url, { retryCount: 6, retryDelay: 800, timeout: 20_000 });
const reactive = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/5318007.json"), "utf8")).parallaxReactive;
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

function side(name) {
  const C = CHAINS[name];
  const dep = JSON.parse(readFileSync(join(ROOT, "contracts/deployments", `${C.chain.id}.json`), "utf8"));
  const pub = createPublicClient({ chain: C.chain, transport: transport(C.rpc) });
  const wallet = createWalletClient({ account, chain: C.chain, transport: transport(C.rpc) });
  const weth = dep.mockWETH;
  const usdc = dep.mockUSDC;
  const wethIs0 = weth.toLowerCase() < usdc.toLowerCase();
  const poolKey = { currency0: wethIs0 ? weth : usdc, currency1: wethIs0 ? usdc : weth, fee: 3000, tickSpacing: 60,
    hooks: "0x0000000000000000000000000000000000000000" };
  const send = async (req) => {
    const hash = await wallet.writeContract(req);
    const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS });
    if (rc.status !== "success") throw new Error(`reverted: ${hash}`);
    return rc;
  };
  return { name, C, pub, executor: dep.parallaxExecutor, weth, wethIs0, poolKey, poolId: dep.poolId, send };
}

async function armStop(s) {
  if ((await s.pub.readContract({ address: s.weth, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) < RULE_WETH)
    await s.send({ address: s.weth, abi: erc20Abi, functionName: "mint", args: [account.address, 10n * 10n ** 18n] });
  if ((await s.pub.readContract({ address: s.weth, abi: erc20Abi, functionName: "allowance", args: [account.address, s.executor] })) < RULE_WETH)
    await s.send({ address: s.weth, abi: erc20Abi, functionName: "approve", args: [s.executor, 2n ** 255n] });
  const t = (await s.pub.readContract({ address: s.C.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [s.poolId] }))[1];
  const [lower, upper] = s.wethIs0 ? [t - 50, NO_UPPER] : [NO_LOWER, t + 50];
  const rc = await s.send({ address: s.executor, abi: executorAbi, functionName: "createRule", args: [s.poolKey, 0, s.wethIs0, lower, upper, RULE_WETH, 300] });
  const [ev] = parseEventLogs({ abi: executorAbi, eventName: "RuleCreated", logs: rc.logs });
  await until(`${s.name} mirror`, async () => (await lpub.readContract({ address: reactive, abi: reactiveAbi, functionName: "mirror", args: [BigInt(s.C.chain.id), ev.args.ruleId] })).exists);
  return { ruleId: ev.args.ruleId, createTx: rc.transactionHash };
}

const fromName = process.env.FROM || "base";
const toName = fromName === "base" ? "unichain" : "base";
const from = side(fromName);
const to = side(toName);
console.log(`Panic Exit · from ${from.C.chain.name} → ${to.C.chain.name} · reactive ${reactive}`);

const [a, b] = await Promise.all([armStop(from), armStop(to)]);
console.log(`armed rule ${a.ruleId} on ${from.name}, rule ${b.ruleId} on ${to.name}; both mirrored on Lasna`);

const lasnaFrom = await lpub.getBlockNumber();
const toFrom = await to.pub.getBlockNumber();
const tSend = Date.now();
const panicRc = await from.send({ address: from.executor, abi: executorAbi, functionName: "panic", args: [] });
const [req] = parseEventLogs({ abi: executorAbi, eventName: "PanicRequested", logs: panicRc.logs });
const fromStatus = (await from.pub.readContract({ address: from.executor, abi: executorAbi, functionName: "getRule", args: [a.ruleId] })).status;
console.log(`panic() on ${from.name}: closed ${req.args.closed} in the same tx (rule ${a.ruleId} status ${fromStatus}) ${from.C.explorer}${panicRc.transactionHash}`);

const executed = await until(`PanicExecuted on ${to.name}`, async () => {
  const logs = await to.pub.getContractEvents({ address: to.executor, abi: executorAbi, eventName: "PanicExecuted", args: { owner: account.address }, fromBlock: toFrom });
  return logs[0];
});
const tSeen = Date.now();
const relayed = await lpub.getContractEvents({ address: reactive, abi: reactiveAbi, eventName: "PanicRelayed", args: { owner: account.address }, fromBlock: lasnaFrom });
const toStatus = (await to.pub.readContract({ address: to.executor, abi: executorAbi, functionName: "getRule", args: [b.ruleId] })).status;
const [panicBlock, execBlock] = await Promise.all([
  from.pub.getBlock({ blockNumber: panicRc.blockNumber }), to.pub.getBlock({ blockNumber: executed.blockNumber }),
]);
const out = {
  ranAt: new Date().toISOString(), from: fromName, to: toName, reactive,
  armed: { [fromName]: { ruleId: Number(a.ruleId), tx: a.createTx }, [toName]: { ruleId: Number(b.ruleId), tx: b.createTx } },
  panicTx: panicRc.transactionHash, closedHere: Number(req.args.closed), fromRuleStatus: fromStatus,
  reactiveTx: relayed[0]?.transactionHash, remoteTx: executed.transactionHash, closedThere: Number(executed.args.closed),
  toRuleStatus: toStatus,
  crossChainSecondsByTimestamp: Number(execBlock.timestamp) - Number(panicBlock.timestamp),
  wallClockMs: tSeen - tSend,
};
out.ok = fromStatus === 2 && toStatus === 2 && out.closedThere >= 1; // 2 = EXECUTED
console.log(`Lasna relayed https://lasna.reactscan.net/tx/${out.reactiveTx}`);
console.log(`${to.name} closed ${out.closedThere} rule(s) (rule ${b.ruleId} status ${toStatus}) ${to.C.explorer}${out.remoteTx}`);
console.log(`cross-chain leg: ${out.crossChainSecondsByTimestamp} s by block timestamps, ${(out.wallClockMs / 1000).toFixed(1)} s wall clock`);
writeFileSync(join(ROOT, "results", `panic-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`), JSON.stringify(out, null, 2));
console.log(out.ok ? "OK: both chains closed" : "NOT OK");
