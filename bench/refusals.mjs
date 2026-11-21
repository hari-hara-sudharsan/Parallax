// Parallax refusal room: every safety claim, shown as real testnet transactions.
//
//   CHAIN=base node refusals.mjs            (or: CHAIN=base ./tw.sh refusals)
//
// Five scenarios, each recorded with its transaction hashes in results/refusals-<chain>-<date>.json and
// rendered to results/REFUSALS.md:
//
//   1. unauthorized   anyone calling execute() directly is reverted (only the Callback Proxy + our reactive)
//   2. in-band        a swap that does not reach the line: Lasna reacts, requests NO callback, rule stays armed
//   3. stale          the price crosses, then snaps back before the callback lands: the executor re-checks the
//                     live tick, emits RuleSkipped(CONDITION_NOT_MET), Lasna re-arms, a later cross fills it
//   4. dedupe         two crossing swaps in a row: exactly one callback and one execution
//   5. cancelled      a cancelled rule is unmirrored and the pool unwatched: crossing it costs nothing
//
// Needs a funded PRIVATE_KEY (Base/Unichain ETH for gas) and a funded ParallaxReactive (~0.3 lREACT).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, defineChain, parseEventLogs, decodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, unichainSepolia } from "viem/chains";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const CHAINS = {
  unichain: { chain: unichainSepolia, rpc: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org",
    stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222", poolSwapTest: "0x9140a78c1a137c7ff1c151ec8231272af78a99a4",
    explorer: "https://sepolia.uniscan.xyz/tx/" },
  base: { chain: baseSepolia, rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4", poolSwapTest: "0x8b5bcc363dde2614281ad875bad385e0a785d3b9",
    explorer: "https://sepolia.basescan.org/tx/" },
};
const LASNA_RPC = process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/";
const LASNA_TX = "https://lasna.reactscan.net/tx/";
const lasna = defineChain({ id: 5318007, name: "Reactive Lasna", nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: [LASNA_RPC] } } });
const SYSTEM = "0x8888888888888888888888888888888888888888";
const CALLBACK_REQUEST_TOPIC = "0xef94dbc611c4b95bf4b8ba34b413972180c2faf26fbb480befacedd83e07b133"; // CallbackRequest(uint256,address,address,uint8,bytes)

const MOVE_TICKS = 50; //                 rule line 0.5% below spot
const RULE_WETH = parseUnits("0.05", 18);
const CROSS_WETH = parseUnits("2", 18); // ~ -100 ticks on the demo pool: crosses the line
const NUDGE_WETH = parseUnits("0.2", 18); // ~ -10 ticks: stays inside the band
const POLL_MS = 300;
const TIMEOUT_MS = 90_000;
const NO_LOWER = -(2 ** 23);
const NO_UPPER = 2 ** 23 - 1;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

const executorAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Rule { address owner; uint8 ruleType; uint8 status; bool zeroForOne; int24 lowerTick; int24 upperTick; uint16 maxSlippageBps; uint128 amountIn; uint64 createdAt; bytes32 poolId; uint256 positionId; }",
  "function createRule(PoolKey key, uint8 ruleType, bool zeroForOne, int24 lowerTick, int24 upperTick, uint128 amountIn, uint16 maxSlippageBps) returns (uint256)",
  "function cancelRule(uint256 ruleId)",
  "function getRule(uint256 ruleId) view returns (Rule)",
  "function execute(address reactiveSender, uint256 ruleId, int24 observedTick, uint256 originTxHash, uint256 originBlock)",
  "function executions(uint256 ruleId) view returns (uint256 originTxHash, uint64 originBlock, uint64 executedBlock, uint64 executedAt)",
  "event RuleCreated(uint256 indexed ruleId, address indexed owner, bytes32 indexed poolId, uint8 ruleType, int24 lowerTick, int24 upperTick, bool zeroForOne, uint128 amountIn, uint256 positionId)",
  "event RuleExecuted(uint256 indexed ruleId, address indexed owner, int24 tick, uint256 amount0Out, uint256 amount1Out, uint256 originTxHash, uint256 originBlock, uint256 executedAt)",
  "event RuleSkipped(uint256 indexed ruleId, uint8 reason, int24 tick, uint256 originTxHash)",
  "error NotAuthorized(address sender_, address provider_)",
  "error CallbackNotAuthorized(address sender_, address expectedSender_)",
]);
const reactiveAbi = parseAbi([
  "struct MirrorRule { bytes32 poolId; int24 lowerTick; int24 upperTick; bool exists; uint64 pendingSince; uint32 index; }",
  "function mirror(uint256 chainId, uint256 ruleId) view returns (MirrorRule)",
  "event RuleTriggered(uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId, int24 tick, uint256 originTxHash)",
  "event RuleRearmed(uint256 indexed chainId, uint256 indexed ruleId)",
  "event RuleRemoved(uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId)",
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
const chainName = process.env.CHAIN || "base";
const C = CHAINS[chainName];
if (!C) throw new Error(`CHAIN must be one of ${Object.keys(CHAINS).join(", ")}`);
function loadEnvKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  const m = readFileSync(join(ROOT, ".env"), "utf8").match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
  if (!m) throw new Error("PRIVATE_KEY missing in .env");
  return m[1];
}
const account = privateKeyToAccount(loadEnvKey());
const dep = JSON.parse(readFileSync(join(ROOT, "contracts/deployments", `${C.chain.id}.json`), "utf8"));
const reactive = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/5318007.json"), "utf8")).parallaxReactive;
const { parallaxExecutor: executor, mockWETH: weth, mockUSDC: usdc, poolId } = dep;
const wethIs0 = weth.toLowerCase() < usdc.toLowerCase();
const key = { currency0: wethIs0 ? weth : usdc, currency1: wethIs0 ? usdc : weth, fee: 3000, tickSpacing: 60,
  hooks: "0x0000000000000000000000000000000000000000" };
const pub = createPublicClient({ chain: C.chain, transport: http(C.rpc) });
const wallet = createWalletClient({ account, chain: C.chain, transport: http(C.rpc) });
const lpub = createPublicClient({ chain: lasna, transport: http() });
const CID = BigInt(C.chain.id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async () => (await pub.readContract({ address: C.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }))[1];
async function until(what, fn) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`timeout waiting for ${what}`);
    await sleep(POLL_MS);
  }
}
async function send(req, { allowRevert = false } = {}) {
  const hash = await wallet.writeContract(req);
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS });
  if (receipt.status !== "success" && !allowRevert) throw new Error(`tx reverted: ${hash}`);
  return receipt;
}
// Selling WETH lowers its price. With WETH as currency0 that lowers the tick.
const swapReq = (sellWeth, amount, exactOut = false) => {
  const tokenIn = sellWeth ? weth : usdc;
  const zeroForOne = tokenIn.toLowerCase() === key.currency0.toLowerCase();
  return { address: C.poolSwapTest, abi: swapAbi, functionName: "swap",
    args: [key, { zeroForOne, amountSpecified: exactOut ? amount : -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x"] };
};
async function ensureTokens() {
  const bal = (t) => pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if ((await bal(weth)) < 50n * 10n ** 18n) await send({ address: weth, abi: erc20Abi, functionName: "mint", args: [account.address, 200n * 10n ** 18n] });
  if ((await bal(usdc)) < 500_000n * 10n ** 6n) await send({ address: usdc, abi: erc20Abi, functionName: "mint", args: [account.address, 1_000_000n * 10n ** 6n] });
  for (const [t, s] of [[weth, executor], [weth, C.poolSwapTest], [usdc, C.poolSwapTest]]) {
    if ((await pub.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [account.address, s] })) < 10n ** 30n)
      await send({ address: t, abi: erc20Abi, functionName: "approve", args: [s, 2n ** 255n] });
  }
}

/** A stop-loss 0.5% below spot; waits until Lasna has mirrored it. */
async function armStop() {
  const t = await tick();
  const lower = wethIs0 ? t - MOVE_TICKS : NO_LOWER;
  const upper = wethIs0 ? NO_UPPER : t + MOVE_TICKS;
  const rc = await send({ address: executor, abi: executorAbi, functionName: "createRule", args: [key, 0, wethIs0, lower, upper, RULE_WETH, 300] });
  const [ev] = parseEventLogs({ abi: executorAbi, eventName: "RuleCreated", logs: rc.logs });
  const ruleId = ev.args.ruleId;
  await until("mirror", async () => (await lpub.readContract({ address: reactive, abi: reactiveAbi, functionName: "mirror", args: [CID, ruleId] })).exists);
  return { ruleId, createTx: rc.transactionHash, tickAtCreate: t, line: wethIs0 ? lower : upper };
}

/**
 * Waits for the Lasna transaction(s) that delivered a given origin tx to ParallaxReactive. A reactive tx is sent to
 * the system contract and its input carries both the target contract and the origin tx hash, so we scan new Lasna
 * blocks for that pair. This is how a reaction that emits no event (a swap inside the band) is still found.
 */
async function waitReactions(originHash, fromBlock) {
  const needle = originHash.slice(2).toLowerCase();
  const target = reactive.slice(2).toLowerCase();
  const found = [];
  let next = fromBlock;
  return until("reactive tx", async () => {
    const head = await lpub.getBlockNumber();
    for (; next <= head; next++) {
      const blk = await lpub.getBlock({ blockNumber: next, includeTransactions: true });
      for (const tx of blk.transactions) {
        const input = tx.input.toLowerCase();
        if (tx.to?.toLowerCase() !== SYSTEM || !input.includes(target) || !input.includes(needle)) continue;
        const rc = await lpub.getTransactionReceipt({ hash: tx.hash });
        found.push({ hash: tx.hash, block: Number(next), callbackRequested: rc.logs.some((l) => l.topics[0] === CALLBACK_REQUEST_TOPIC) });
      }
    }
    return found.length ? found : null;
  });
}
const lasnaEvents = (eventName, ruleId, fromBlock) =>
  lpub.getContractEvents({ address: reactive, abi: reactiveAbi, eventName, args: { chainId: CID, ruleId }, fromBlock });
const execEvents = (eventName, ruleId, fromBlock) =>
  pub.getContractEvents({ address: executor, abi: executorAbi, eventName, args: { ruleId }, fromBlock });
const status = async (ruleId) => ["ACTIVE", "EXECUTED", "CANCELLED"][(await pub.readContract({ address: executor, abi: executorAbi, functionName: "getRule", args: [ruleId] })).status - 1] ?? "NONE";
async function cancelIfActive(ruleId) {
  if ((await status(ruleId)) === "ACTIVE") await send({ address: executor, abi: executorAbi, functionName: "cancelRule", args: [ruleId] });
}

// ── Scenarios ─────────────────────────────────────────────────────────────
async function unauthorized() {
  // Fixed gas limit so the node does not refuse to send a tx that reverts in estimation: we want it mined.
  const req = { address: executor, abi: executorAbi, functionName: "execute", args: [account.address, 1n, 0, 0n, 0n], gas: 200_000n };
  // Decode the custom error from a simulation (the mined tx carries no revert data in its receipt).
  let reason = "reverted";
  try { await pub.simulateContract({ ...req, account }); } catch (e) {
    const raw = e?.walk?.((x) => typeof x?.data === "string" && x.data.startsWith("0x"))?.data;
    try {
      const d = decodeErrorResult({ abi: executorAbi, data: raw });
      reason = `${d.errorName}(${d.args.join(", ")})`;
    } catch { reason = raw ?? "reverted"; }
  }
  const rc = await send(req, { allowRevert: true });
  return { claim: "Only the Callback Proxy, carrying our reactive contract, can call execute()", tx: rc.transactionHash,
    status: rc.status, reason, proven: rc.status === "reverted" };
}

async function inBand() {
  const r = await armStop();
  const lasnaFrom = await lpub.getBlockNumber();
  const nudge = await send(swapReq(true, NUDGE_WETH));
  const after = await tick();
  const reactions = await waitReactions(nudge.transactionHash, lasnaFrom);
  await sleep(5000); // give a (wrong) callback time to show up
  const execs = await execEvents("RuleExecuted", r.ruleId, nudge.blockNumber);
  const out = { claim: "A swap that does not reach the line is seen on Lasna but requests no callback", ruleId: Number(r.ruleId),
    line: r.line, tickBefore: r.tickAtCreate, tickAfter: after, createTx: r.createTx, originTx: nudge.transactionHash,
    reactiveTx: reactions[0].hash, callbackRequested: reactions.some((x) => x.callbackRequested), executions: execs.length,
    ruleStatus: await status(r.ruleId) };
  out.proven = !out.callbackRequested && out.executions === 0 && out.ruleStatus === "ACTIVE";
  await cancelIfActive(r.ruleId);
  return out;
}

async function stale() {
  const r = await armStop();
  const lasnaFrom = await lpub.getBlockNumber();
  // Cross the line, then buy the same WETH straight back without waiting, so the price is back in the band
  // by the time the callback lands (~7 Base blocks later).
  const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const crossHash = await wallet.writeContract({ ...swapReq(true, CROSS_WETH), nonce });
  const backHash = await wallet.writeContract({ ...swapReq(false, CROSS_WETH, true), nonce: nonce + 1 });
  const cross = await pub.waitForTransactionReceipt({ hash: crossHash, pollingInterval: POLL_MS });
  const back = await pub.waitForTransactionReceipt({ hash: backHash, pollingInterval: POLL_MS });
  const skipped = await until("RuleSkipped", async () => (await execEvents("RuleSkipped", r.ruleId, cross.blockNumber))[0]);
  const rearmed = await until("RuleRearmed", async () => (await lasnaEvents("RuleRearmed", r.ruleId, lasnaFrom))[0]);
  const triggered = (await lasnaEvents("RuleTriggered", r.ruleId, lasnaFrom))[0];
  // Re-armed: a later real cross fills it.
  const lasnaFrom2 = await lpub.getBlockNumber();
  const cross2 = await send(swapReq(true, CROSS_WETH));
  const filled = await until("RuleExecuted", async () => (await execEvents("RuleExecuted", r.ruleId, cross2.blockNumber))[0]);
  const triggered2 = await until("second RuleTriggered", async () => (await lasnaEvents("RuleTriggered", r.ruleId, lasnaFrom2))[0]);
  const out = { claim: "A stale trigger is re-checked on-chain, skipped, re-armed, and fills on the next real cross",
    ruleId: Number(r.ruleId), line: r.line, createTx: r.createTx, crossTx: cross.transactionHash, snapBackTx: back.transactionHash,
    reactiveTx: triggered?.transactionHash, skippedTx: skipped.transactionHash, skipReason: Number(skipped.args.reason),
    skipTick: skipped.args.tick, rearmTx: rearmed.transactionHash, crossAgainTx: cross2.transactionHash,
    reactiveTx2: triggered2.transactionHash, filledTx: filled.transactionHash };
  out.proven = out.skipReason === 1 && !!out.filledTx; // 1 = CONDITION_NOT_MET
  return out;
}

async function dedupe() {
  const r = await armStop();
  const lasnaFrom = await lpub.getBlockNumber();
  const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const h1 = await wallet.writeContract({ ...swapReq(true, CROSS_WETH), nonce });
  const h2 = await wallet.writeContract({ ...swapReq(true, NUDGE_WETH), nonce: nonce + 1 });
  const s1 = await pub.waitForTransactionReceipt({ hash: h1, pollingInterval: POLL_MS });
  const s2 = await pub.waitForTransactionReceipt({ hash: h2, pollingInterval: POLL_MS });
  const filled = await until("RuleExecuted", async () => (await execEvents("RuleExecuted", r.ruleId, s1.blockNumber))[0]);
  const reactions2 = await waitReactions(s2.transactionHash, lasnaFrom);
  await sleep(8000);
  const triggers = await lasnaEvents("RuleTriggered", r.ruleId, lasnaFrom);
  const execs = await execEvents("RuleExecuted", r.ruleId, s1.blockNumber);
  const skips = await execEvents("RuleSkipped", r.ruleId, s1.blockNumber);
  const out = { claim: "Two crossing swaps in a row produce exactly one callback and one execution", ruleId: Number(r.ruleId),
    createTx: r.createTx, swap1Tx: s1.transactionHash, swap2Tx: s2.transactionHash, reactiveTx: triggers[0]?.transactionHash,
    secondReactiveTx: reactions2[0]?.hash, secondRequestedCallback: reactions2.some((x) => x.callbackRequested),
    triggers: triggers.length, executions: execs.length, skips: skips.length, filledTx: filled.transactionHash };
  out.proven = out.triggers === 1 && out.executions === 1;
  return out;
}

async function cancelled() {
  const r = await armStop();
  const lasnaFrom = await lpub.getBlockNumber();
  const c = await send({ address: executor, abi: executorAbi, functionName: "cancelRule", args: [r.ruleId] });
  const removed = await until("RuleRemoved", async () => (await lasnaEvents("RuleRemoved", r.ruleId, lasnaFrom))[0]);
  const cross = await send(swapReq(true, CROSS_WETH));
  await sleep(10_000);
  const triggers = await lasnaEvents("RuleTriggered", r.ruleId, lasnaFrom);
  const execs = await execEvents("RuleExecuted", r.ruleId, cross.blockNumber);
  const out = { claim: "A cancelled rule is unmirrored on Lasna and never fires", ruleId: Number(r.ruleId),
    createTx: r.createTx, cancelTx: c.transactionHash, removedTx: removed.transactionHash, crossTx: cross.transactionHash,
    triggers: triggers.length, executions: execs.length };
  out.proven = out.triggers === 0 && out.executions === 0;
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────
const outDir = join(ROOT, "results");
if (!existsSync(outDir)) mkdirSync(outDir);
const outFile = join(outDir, `refusals-${chainName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
const only = (process.env.ONLY || "unauthorized,inBand,stale,dedupe,cancelled").split(",");
const scenarios = { unauthorized, inBand, stale, dedupe, cancelled };
const results = {};

console.log(`Parallax refusal room · ${C.chain.name} · executor ${executor} · reactive ${reactive}`);
await ensureTokens();
for (const name of only) {
  process.stdout.write(`${name} … `);
  try { results[name] = await scenarios[name](); } catch (e) { results[name] = { proven: false, error: String(e?.shortMessage ?? e?.message ?? e).split("\n")[0] }; }
  console.log(results[name].proven ? "proven" : `NOT proven: ${results[name].error ?? JSON.stringify(results[name])}`);
  writeFileSync(outFile, JSON.stringify({ chain: chainName, chainId: C.chain.id, executor, reactive, ranAt: new Date().toISOString(), results },
    (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  await sleep(3000);
}
writeReport();
console.log(`wrote ${outFile} and results/REFUSALS.md`);

function writeReport() {
  const t = (h) => (h ? `[\`${h.slice(0, 10)}…\`](${C.explorer}${h})` : "—");
  const l = (h) => (h ? `[\`${h.slice(0, 10)}…\`](${LASNA_TX}${h})` : "—");
  const R = results;
  const rows = [
    ["Direct `execute()` from an outsider reverts", R.unauthorized, (x) => `${t(x.tx)} · ${x.status} (\`${x.reason}\`)`],
    ["Swap that stops short of the line: no callback", R.inBand, (x) => `swap ${t(x.originTx)} (tick ${x.tickBefore} → ${x.tickAfter}, line ${x.line}) · Lasna ${l(x.reactiveTx)} requested ${x.callbackRequested ? "a callback ✗" : "**no callback**"} · rule still ${x.ruleStatus}`],
    ["Stale trigger: re-checked, skipped, re-armed, then filled", R.stale, (x) => `cross ${t(x.crossTx)} → snap-back ${t(x.snapBackTx)} → Lasna ${l(x.reactiveTx)} → **skipped** ${t(x.skippedTx)} (CONDITION_NOT_MET at tick ${x.skipTick}) → re-armed ${l(x.rearmTx)} → cross ${t(x.crossAgainTx)} → Lasna ${l(x.reactiveTx2)} → **filled** ${t(x.filledTx)}`],
    ["Two crossing swaps: one callback, one execution", R.dedupe, (x) => `swaps ${t(x.swap1Tx)} + ${t(x.swap2Tx)} · Lasna ${l(x.reactiveTx)} · second swap's reaction ${l(x.secondReactiveTx)} requested ${x.secondRequestedCallback ? "a callback" : "none"} · triggers ${x.triggers}, executions ${x.executions} · ${t(x.filledTx)}`],
    ["Cancelled rule is unmirrored and never fires", R.cancelled, (x) => `cancel ${t(x.cancelTx)} · Lasna unmirror ${l(x.removedTx)} · crossing swap ${t(x.crossTx)} · triggers ${x.triggers}, executions ${x.executions}`],
  ].filter(([, x]) => x);
  const md = [
    "# Refusal room: what Parallax refuses to do, on-chain",
    "",
    `Generated by \`bench/refusals.mjs\` on ${C.chain.name} (${new Date().toISOString().slice(0, 10)}). Executor`,
    `\`${executor}\`, reactive contract \`${reactive}\` on Lasna. Every cell is a real transaction.`,
    "",
    "| Claim | Result | Evidence |",
    "|---|---|---|",
    ...rows.map(([claim, x, fmt]) => `| ${claim} | ${x.proven ? "✅ proven" : `❌ ${x.error ?? "not proven"}`} | ${x.error ? "—" : fmt(x)} |`),
    "",
  ].join("\n");
  writeFileSync(join(outDir, "REFUSALS.md"), md);
}
