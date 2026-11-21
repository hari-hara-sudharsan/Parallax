// Parallax live benchmark: N automated rounds on a real testnet, every leg measured.
//
//   CHAIN=base     node bench.mjs 30      (or: CHAIN=base ./tw.sh bench 30 from the repo root)
//   CHAIN=unichain node bench.mjs 30
//
// Each round:
//   1. create a STOP_LOSS or TAKE_PROFIT (alternating, so the price mean-reverts) 0.5% from spot
//   2. wait until ParallaxReactive on Lasna has mirrored it
//   3. ORIGIN: swap across the trigger (Uniswap v4 PoolSwapTest)
//   4. wait for the CALLBACK to execute it; read the executor's on-chain Execution record
//   5. find the REACTIVE tx (RuleTriggered on Lasna)
// Every round, including failures, is appended to results/<chain>-<date>.json; results/SUMMARY.md is
// regenerated at the end. Block counts are exact (from the on-chain record); wall-clock times come from
// polling public RPCs, so they are upper bounds.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, toHex, defineChain, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, unichainSepolia } from "viem/chains";
import { writeSummary } from "./summary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// ── Config ────────────────────────────────────────────────────────────────
const CHAINS = {
  unichain: {
    chain: unichainSepolia,
    rpc: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org",
    stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222",
    poolSwapTest: "0x9140a78c1a137c7ff1c151ec8231272af78a99a4",
    nominalBlockMs: 1000,
  },
  base: {
    chain: baseSepolia,
    rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4",
    poolSwapTest: "0x8b5bcc363dde2614281ad875bad385e0a785d3b9",
    nominalBlockMs: 200,
  },
};
const lasna = defineChain({
  id: 5318007,
  name: "Reactive Lasna",
  nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: [process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/"] } },
});

const MOVE_TICKS = Number(process.env.BENCH_MOVE_TICKS || 50); //      trigger 0.5% from spot
const RULE_WETH = parseUnits(process.env.BENCH_RULE_WETH || "0.05", 18); // amount each rule sells
const PUSH_WETH = parseUnits(process.env.BENCH_PUSH_WETH || "2", 18); //    stop-loss crossing swap
const PUSH_USDC = parseUnits(process.env.BENCH_PUSH_USDC || "6000", 6); //  take-profit crossing swap
const MIRROR_TIMEOUT_MS = 40_000;
const EXEC_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

const NO_LOWER = -(2 ** 23);
const NO_UPPER = 2 ** 23 - 1;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

// ── ABIs (human-readable, matching contracts/src) ─────────────────────────
const executorAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Rule { address owner; uint8 ruleType; uint8 status; bool zeroForOne; int24 lowerTick; int24 upperTick; uint16 maxSlippageBps; uint128 amountIn; uint64 createdAt; int24 trailTicks; bool recenter; bytes32 poolId; uint256 positionId; }",
  "function createRule(PoolKey key, uint8 ruleType, bool zeroForOne, int24 lowerTick, int24 upperTick, uint128 amountIn, uint16 maxSlippageBps) returns (uint256)",
  "function cancelRule(uint256 ruleId)",
  "function getRule(uint256 ruleId) view returns (Rule)",
  "function nextRuleId() view returns (uint256)",
  "function executions(uint256 ruleId) view returns (uint256 originTxHash, uint64 originBlock, uint64 executedBlock, uint64 executedAt)",
  "event RuleCreated(uint256 indexed ruleId, address indexed owner, bytes32 indexed poolId, uint8 ruleType, int24 lowerTick, int24 upperTick, bool zeroForOne, uint128 amountIn, uint256 positionId, int24 trailTicks)",
  "event RuleExecuted(uint256 indexed ruleId, address indexed owner, int24 tick, uint256 amount0Out, uint256 amount1Out, uint256 originTxHash, uint256 originBlock, uint256 executedAt)",
  "event RuleSkipped(uint256 indexed ruleId, uint8 reason, int24 tick, uint256 originTxHash)",
]);
const reactiveAbi = parseAbi([
  "struct MirrorRule { bytes32 poolId; int24 lowerTick; int24 upperTick; bool exists; uint64 pendingSince; uint32 index; }",
  "function mirror(uint256 chainId, uint256 ruleId) view returns (MirrorRule)",
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

// ── Setup ─────────────────────────────────────────────────────────────────
const chainName = process.env.CHAIN || "unichain";
const C = CHAINS[chainName];
if (!C) throw new Error(`CHAIN must be one of ${Object.keys(CHAINS).join(", ")}`);
const rounds = Number(process.argv[2] || 10);

function loadEnvKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  const env = readFileSync(join(ROOT, ".env"), "utf8");
  const m = env.match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
  if (!m) throw new Error("PRIVATE_KEY missing in .env");
  return m[1];
}
const account = privateKeyToAccount(loadEnvKey());
const dep = JSON.parse(readFileSync(join(ROOT, "contracts/deployments", `${C.chain.id}.json`), "utf8"));
const lasnaDep = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/5318007.json"), "utf8"));
const executor = dep.parallaxExecutor;
const reactive = lasnaDep.parallaxReactive;
const weth = dep.mockWETH;
const usdc = dep.mockUSDC;
const poolId = dep.poolId;
const wethIs0 = weth.toLowerCase() < usdc.toLowerCase();
const key = {
  currency0: wethIs0 ? weth : usdc,
  currency1: wethIs0 ? usdc : weth,
  fee: 3000,
  tickSpacing: 60,
  hooks: "0x0000000000000000000000000000000000000000",
};

const pub = createPublicClient({ chain: C.chain, transport: http(C.rpc) });
const wallet = createWalletClient({ account, chain: C.chain, transport: http(C.rpc) });
const lpub = createPublicClient({ chain: lasna, transport: http() });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Unichain's public RPC serves Flashblocks: receipts arrive at ~200 ms preconfirmation, BEFORE the block
 * is sealed. So never derive state from a follow-up "latest" read right after a receipt, and retry
 * block lookups until the block exists.
 */
async function sealedBlock(blockNumber) {
  for (let i = 0; i < 40; i++) {
    try {
      return await pub.getBlock({ blockNumber });
    } catch {
      await sleep(POLL_MS);
    }
  }
  throw new Error(`block ${blockNumber} not sealed after 10 s`);
}

const tick = async () => (await pub.readContract({ address: C.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }))[1];

async function send(req) {
  const hash = await wallet.writeContract(req);
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return receipt;
}

async function ensureTokens() {
  const [bw, bu] = await Promise.all([
    pub.readContract({ address: weth, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    pub.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  ]);
  if (bw < 100n * 10n ** 18n) await send({ address: weth, abi: erc20Abi, functionName: "mint", args: [account.address, 500n * 10n ** 18n] });
  if (bu < 1_000_000n * 10n ** 6n) await send({ address: usdc, abi: erc20Abi, functionName: "mint", args: [account.address, 3_000_000n * 10n ** 6n] });
  const max = 2n ** 255n;
  for (const [token, spender] of [[weth, executor], [weth, C.poolSwapTest], [usdc, C.poolSwapTest]]) {
    const a = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] });
    if (a < 10n ** 30n) await send({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, max] });
  }
}

// ── One round ─────────────────────────────────────────────────────────────
async function round(i) {
  const kind = i % 2 === 0 ? "STOP_LOSS" : "TAKE_PROFIT";
  const r = { round: i, chain: chainName, chainId: C.chain.id, kind, startedAt: new Date().toISOString() };
  try {
    // 1. Rule 0.5% away from spot. WETH falling = tick falling iff WETH is currency0.
    const t = await tick();
    const tickDown = (kind === "STOP_LOSS") === wethIs0;
    const lower = tickDown ? t - MOVE_TICKS : NO_LOWER;
    const upper = tickDown ? NO_UPPER : t + MOVE_TICKS;
    const created = await send({
      address: executor,
      abi: executorAbi,
      functionName: "createRule",
      args: [key, kind === "STOP_LOSS" ? 0 : 1, wethIs0, lower, upper, RULE_WETH, 300],
    });
    // Rule id from the RuleCreated event in our own receipt (a follow-up read can lag under Flashblocks).
    const [ev] = parseEventLogs({ abi: executorAbi, eventName: "RuleCreated", logs: created.logs });
    if (!ev) throw new Error("RuleCreated event missing from receipt");
    const ruleId = ev.args.ruleId;
    Object.assign(r, { ruleId: Number(ruleId), createTx: created.transactionHash, tickAtCreate: t, lower, upper });

    // 2. Wait for the reactive mirror (Lasna picked up RuleCreated and subscribed to the pool).
    const lasnaStart = await lpub.getBlockNumber();
    const mStart = Date.now();
    for (;;) {
      const m = await lpub.readContract({ address: reactive, abi: reactiveAbi, functionName: "mirror", args: [BigInt(C.chain.id), ruleId] });
      if (m.exists) break;
      if (Date.now() - mStart > MIRROR_TIMEOUT_MS) throw new Error("mirror timeout (is ParallaxReactive funded / not in debt?)");
      await sleep(POLL_MS);
    }
    r.mirrorMs = Date.now() - mStart;

    // 3. ORIGIN: the crossing swap. Selling WETH crashes its price (stop-loss); selling USDC pumps it.
    const sellWeth = kind === "STOP_LOSS";
    const tokenIn = sellWeth ? weth : usdc;
    const zeroForOne = tokenIn.toLowerCase() === key.currency0.toLowerCase();
    const tSend = Date.now();
    const origin = await send({
      address: C.poolSwapTest,
      abi: swapAbi,
      functionName: "swap",
      args: [
        key,
        { zeroForOne, amountSpecified: -(sellWeth ? PUSH_WETH : PUSH_USDC), sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
        { takeClaims: false, settleUsingBurn: false },
        "0x",
      ],
    });
    const tOrigin = Date.now();
    const originBlock = await sealedBlock(origin.blockNumber);
    Object.assign(r, {
      originTx: origin.transactionHash,
      originBlock: Number(origin.blockNumber),
      originTimestamp: Number(originBlock.timestamp),
      tickAfterOrigin: await tick(),
    });

    // 4. Wait for the CALLBACK (executor stores an Execution record when it fills).
    let exec;
    for (;;) {
      exec = await pub.readContract({ address: executor, abi: executorAbi, functionName: "executions", args: [ruleId] });
      if (exec[2] > 0n) break;
      if (Date.now() - tOrigin > EXEC_TIMEOUT_MS) {
        const skips = await pub.getContractEvents({ address: executor, abi: executorAbi, eventName: "RuleSkipped", args: { ruleId }, fromBlock: origin.blockNumber });
        throw new Error(skips.length ? `skipped (reason ${skips.at(-1).args.reason})` : "callback timeout");
      }
      await sleep(POLL_MS);
    }
    const tSeen = Date.now();
    const [execLog] = await pub.getContractEvents({
      address: executor, abi: executorAbi, eventName: "RuleExecuted", args: { ruleId }, fromBlock: exec[2], toBlock: exec[2],
    });
    Object.assign(r, {
      callbackTx: execLog?.transactionHash,
      executedBlock: Number(exec[2]),
      executedAt: Number(exec[3]),
      recordedOriginTx: toHex(exec[0], { size: 32 }),
      recordedOriginBlock: Number(exec[1]),
      latencyBlocks: Number(exec[2]) - Number(origin.blockNumber),
      latencySecondsByTimestamp: Number(exec[3]) - Number(originBlock.timestamp),
      wallClockMs: tSeen - tSend, //  upper bound: includes our own send + RPC polling
      wallClockFromOriginReceiptMs: tSeen - tOrigin,
    });
    r.latencySecondsByBlocks = (r.latencyBlocks * C.nominalBlockMs) / 1000;

    // 5. REACTIVE tx on Lasna.
    const trig = await lpub.getContractEvents({
      address: reactive, abi: reactiveAbi, eventName: "RuleTriggered", args: { chainId: BigInt(C.chain.id), ruleId }, fromBlock: lasnaStart,
    });
    if (trig.length) {
      const b = await lpub.getBlock({ blockNumber: trig[0].blockNumber });
      Object.assign(r, { reactiveTx: trig[0].transactionHash, reactiveBlock: Number(trig[0].blockNumber), reactiveTimestamp: Number(b.timestamp) });
    }
    r.ok = r.recordedOriginTx.toLowerCase() === origin.transactionHash.toLowerCase();
    if (!r.ok) r.error = "execution record points at a different origin tx";
  } catch (e) {
    r.ok = false;
    r.error = String(e?.shortMessage ?? e?.message ?? e).split("\n")[0];
    // Leave nothing armed behind: cancel a rule that didn't fill (refunds the deposit).
    if (r.ruleId) {
      try {
        const rule = await pub.readContract({ address: executor, abi: executorAbi, functionName: "getRule", args: [BigInt(r.ruleId)] });
        if (rule.status === 1) await send({ address: executor, abi: executorAbi, functionName: "cancelRule", args: [BigInt(r.ruleId)] });
      } catch { /* best effort */ }
    }
  }
  return r;
}

// ── Main ──────────────────────────────────────────────────────────────────
const outDir = join(ROOT, "results");
if (!existsSync(outDir)) mkdirSync(outDir);
const outFile = join(outDir, `${chainName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
const all = [];

console.log(`Parallax bench · ${C.chain.name} · ${rounds} rounds · executor ${executor} · reactive ${reactive}`);
await ensureTokens();
for (let i = 1; i <= rounds; i++) {
  const r = await round(i);
  all.push(r);
  writeFileSync(outFile, JSON.stringify(all, null, 2));
  console.log(
    r.ok
      ? `#${i} ${r.kind.padEnd(11)} rule ${r.ruleId}  ${r.latencyBlocks} blocks · ${r.latencySecondsByTimestamp}s by timestamp · wall ${(r.wallClockMs / 1000).toFixed(2)}s`
      : `#${i} ${r.kind.padEnd(11)} ✗ ${r.error}`,
  );
  await sleep(1500); // let the cleanup reactive tx (RuleRemoved) land before the next rule
}
writeSummary(outDir);
console.log(`\nwrote ${outFile} and results/SUMMARY.md`);
