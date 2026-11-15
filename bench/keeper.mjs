// Keeper-bot baseline: the same stop-loss Parallax runs, but executed by a classic off-chain bot.
//
//   CHAIN=base node keeper.mjs 20        (or: CHAIN=base ./tw.sh keeper 20)
//
// Each round: the bot arms a stop 0.5% below spot IN MEMORY, polls the pool every POLL_MS over the public
// RPC, and the moment it sees the tick cross, sends its own market sell (Uniswap v4 PoolSwapTest).
// Measured: blocks from the crossing (origin) swap to the bot's sell, same pool and chain as bench.mjs.
// Written to results/keeper-<chain>-<date>.json; results/SUMMARY.md gains a comparison table.
//
// Honest framing: this bot is fast (250 ms polling, warm RPC connection, no queueing, own funded hot key).
// Real keepers add infrastructure risk we do not model: downtime, gas spikes, unprofitable-order skipping.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, unichainSepolia } from "viem/chains";
import { writeSummary } from "./summary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHAINS = {
  unichain: { chain: unichainSepolia, rpc: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org",
    stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222", poolSwapTest: "0x9140a78c1a137c7ff1c151ec8231272af78a99a4", nominalBlockMs: 1000 },
  base: { chain: baseSepolia, rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4", poolSwapTest: "0x8b5bcc363dde2614281ad875bad385e0a785d3b9", nominalBlockMs: 200 },
};
const POLL_MS = Number(process.env.KEEPER_POLL_MS || 250);
const MOVE_TICKS = 50;
const SELL_WETH = parseUnits("0.05", 18); // same size Parallax sells in bench.mjs
const PUSH_WETH = parseUnits("2", 18); //    same crossing swap as bench.mjs
const PUSH_USDC = parseUnits("6000", 6); //   recovery swap between rounds
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

const swapAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
  "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
  "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)"]);

const chainName = process.env.CHAIN || "base";
const C = CHAINS[chainName];
const rounds = Number(process.argv[2] || 10);
const key0 = (process.env.PRIVATE_KEY || readFileSync(join(ROOT, ".env"), "utf8").match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m)?.[1]);
const account = privateKeyToAccount(key0);
const dep = JSON.parse(readFileSync(join(ROOT, "contracts/deployments", `${C.chain.id}.json`), "utf8"));
const weth = dep.mockWETH, usdc = dep.mockUSDC, poolId = dep.poolId;
const wethIs0 = weth.toLowerCase() < usdc.toLowerCase();
const key = { currency0: wethIs0 ? weth : usdc, currency1: wethIs0 ? usdc : weth, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" };
const pub = createPublicClient({ chain: C.chain, transport: http(C.rpc) });
const wallet = createWalletClient({ account, chain: C.chain, transport: http(C.rpc) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async () => (await pub.readContract({ address: C.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }))[1];

async function swap(sellWeth, amount) {
  const tokenIn = sellWeth ? weth : usdc;
  const zeroForOne = tokenIn.toLowerCase() === key.currency0.toLowerCase();
  const hash = await wallet.writeContract({
    address: C.poolSwapTest, abi: swapAbi, functionName: "swap",
    args: [key, { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x"],
  });
  return pub.waitForTransactionReceipt({ hash, pollingInterval: 200 });
}

async function round(i) {
  const r = { round: i, chain: chainName, chainId: C.chain.id, kind: "KEEPER_STOP_LOSS", pollMs: POLL_MS, startedAt: new Date().toISOString() };
  try {
    // Bot arms a stop 0.5% below spot (in tick space: WETH price falls ⇔ tick falls iff WETH is currency0).
    const t = await tick();
    const stop = wethIs0 ? t - MOVE_TICKS : t + MOVE_TICKS;
    const crossed = (x) => (wethIs0 ? x <= stop : x >= stop);

    // The bot loop starts BEFORE the crash, exactly like a real keeper watching the pool.
    let botDone;
    const bot = (async () => {
      for (;;) {
        if (crossed(await tick())) return swap(true, SELL_WETH);
        await sleep(POLL_MS);
      }
    })().then((rc) => (botDone = rc));

    await sleep(600);
    const origin = await swap(true, PUSH_WETH); // the crash (origin event)
    const deadline = Date.now() + 60_000;
    while (!botDone && Date.now() < deadline) await sleep(100);
    if (!botDone) throw new Error("bot did not fill within 60 s");
    Object.assign(r, {
      originTx: origin.transactionHash,
      originBlock: Number(origin.blockNumber),
      callbackTx: botDone.transactionHash, // the bot's fill (column reused by summary.mjs)
      executedBlock: Number(botDone.blockNumber),
      latencyBlocks: Number(botDone.blockNumber) - Number(origin.blockNumber),
      ok: true,
    });
    r.latencySecondsByBlocks = (r.latencyBlocks * C.nominalBlockMs) / 1000;
  } catch (e) {
    r.ok = false;
    r.error = String(e?.shortMessage ?? e?.message ?? e).split("\n")[0];
  }
  await swap(false, PUSH_USDC).catch(() => {}); // pump back so the next round starts near the same price
  return r;
}

const outDir = join(ROOT, "results");
if (!existsSync(outDir)) mkdirSync(outDir);
const outFile = join(outDir, `keeper-${chainName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
console.log(`Keeper-bot baseline · ${C.chain.name} · ${rounds} rounds · polling every ${POLL_MS} ms`);
for (const [token] of [[weth], [usdc]]) {
  const a = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, C.poolSwapTest] });
  if (a < 10n ** 30n) await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [C.poolSwapTest, 2n ** 255n] }) });
}
const all = [];
for (let i = 1; i <= rounds; i++) {
  const r = await round(i);
  all.push(r);
  writeFileSync(outFile, JSON.stringify(all, null, 2));
  console.log(r.ok ? `#${i} bot filled ${r.latencyBlocks} blocks after the crash` : `#${i} ✗ ${r.error}`);
}
writeSummary(outDir);
console.log(`\nwrote ${outFile} and results/SUMMARY.md`);
