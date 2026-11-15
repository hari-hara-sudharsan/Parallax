// A real user's journey on Base Sepolia, end to end, with the exact contract calls the dashboard makes:  npm run journey
//
//   1. get test tokens        (Demo controls → "Get test tokens")
//   2. arm a stop-loss         (Create a rule → Stop-loss: approve mWETH, createRule)
//   3. the market moves        (Demo controls → "Crash": an ordinary Uniswap v4 swap)
//   4. Parallax executes       (nothing from us: Reactive Network calls the executor back)
//   5. the user is paid        (mUSDC lands in the wallet; the on-chain Execution record gives the latency)
//   6. vault in and out        (Vault → Deposit, then Withdraw all)
//
// Every step is a real testnet transaction from the wallet in ../.env. Read-only checks fail loudly.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
// The same ABIs the dashboard uses (web/src/lib/generated/abis.ts is generated from these artifacts).
const abi = (f) => JSON.parse(readFileSync(new URL(`../../contracts/out/${f}`, import.meta.url), "utf8")).abi;
const executorAbi = abi("ParallaxExecutor.sol/ParallaxExecutor.json");
const vaultAbi = abi("ParallaxVault.sol/ParallaxVault.json");
const erc20Abi = abi("MockERC20.sol/MockERC20.json");
const swapAbi = abi("PoolSwapTest.sol/PoolSwapTest.json");
const stateViewAbi = [{ type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] }];

// web/src/lib/deployment.ts (Base Sepolia)
const C = {
  executor: "0x2f772766ec926359093FA2d478FBDdcd828304Ff",
  vault: "0x94Bdad7429FAF003f2aDda78B04aB901A5f10C8F",
  weth: "0x6D489Fa6F5c837B79A7FF8Dcc2B488CbD14309A5",
  usdc: "0x0bE64D69008Afbef624B2ea7A5062a53E844Dc6c",
  poolId: "0xade8c1a33dc66fd63e7f08b4af96a01c31ab4c5346a374a5d82d4d3a6f89763c",
  stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4",
  poolSwapTest: "0x8b5bcc363dde2614281ad875bad385e0a785d3b9",
  blockMs: 200,
};
const NO_LOWER = -(2 ** 23);
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const wethIs0 = C.weth.toLowerCase() < C.usdc.toLowerCase();
const key = { currency0: wethIs0 ? C.weth : C.usdc, currency1: wethIs0 ? C.usdc : C.weth, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" };

const account = privateKeyToAccount(env.PRIVATE_KEY);
const pub = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC || "https://sepolia.base.org") });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC || "https://sepolia.base.org") });
const me = account.address;

let failures = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => (failures++, console.log(`✗ ${m}`));
const send = async (label, req) => {
  const hash = await wallet.writeContract(req);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`  ${label}: ${hash}`);
  return rc;
};
const bal = async (t) => pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [me] });
const tick = async () => Number((await pub.readContract({ address: C.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [C.poolId] }))[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Journey as ${me} on Base Sepolia (ETH ${formatUnits(await pub.getBalance({ address: me }), 18)})\n`);

// 1. Test tokens
await send("mint 5 mWETH", { address: C.weth, abi: erc20Abi, functionName: "mint", args: [me, parseUnits("5", 18)] });
await send("mint 10,000 mUSDC", { address: C.usdc, abi: erc20Abi, functionName: "mint", args: [me, parseUnits("10000", 6)] });
ok("1. test tokens in the wallet");

// 2. Arm a stop-loss 0.4% below the price (the WETH price falls when the tick rises: USDC is currency0).
const t0 = await tick();
const amount = parseUnits("0.5", 18);
const [lower, upper] = wethIs0 ? [t0 - 40, 2 ** 23 - 1] : [NO_LOWER, t0 + 40];
await send("approve mWETH → executor", { address: C.weth, abi: erc20Abi, functionName: "approve", args: [C.executor, amount] });
const rc = await send("createRule(STOP_LOSS)", { address: C.executor, abi: executorAbi, functionName: "createRule", args: [key, 0, wethIs0, lower, upper, amount, 300] });
const created = rc.logs.find((l) => l.address.toLowerCase() === C.executor.toLowerCase() && l.topics.length === 4);
const ruleId = BigInt(created.topics[1]);
ok(`2. stop-loss #${ruleId} armed at tick ${wethIs0 ? lower : upper} (price now at tick ${t0})`);

console.log("  waiting 15 s for Reactive to mirror the rule…");
await sleep(15_000);

// 3. The market moves: sell 2 mWETH through Uniswap v4 (what "Crash" does, smaller).
const crash = parseUnits("2", 18);
await send("approve mWETH → PoolSwapTest", { address: C.weth, abi: erc20Abi, functionName: "approve", args: [C.poolSwapTest, crash] });
const swapRc = await send("swap 2 mWETH (the origin event)", {
  address: C.poolSwapTest,
  abi: swapAbi,
  functionName: "swap",
  args: [key, { zeroForOne: wethIs0, amountSpecified: -crash, sqrtPriceLimitX96: wethIs0 ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x"],
});
ok(`3. price moved: tick ${t0} → ${await tick()} in block ${swapRc.blockNumber}`);

// 4–5. Wait for Parallax (nothing else sends anything).
let rule;
for (let i = 0; i < 40; i++) {
  rule = await pub.readContract({ address: C.executor, abi: executorAbi, functionName: "getRule", args: [ruleId] });
  if (rule.status !== 1) break;
  await sleep(1_500);
}
if (rule.status === 2) {
  const ex = await pub.readContract({ address: C.executor, abi: executorAbi, functionName: "executions", args: [ruleId] });
  const blocks = Number(ex[2] - ex[1]);
  // The payout is what the executor's RuleExecuted event says it sent (the wallet balance also moved with our own swap).
  const [log] = await pub.getContractEvents({ address: C.executor, abi: executorAbi, eventName: "RuleExecuted", args: { ruleId }, fromBlock: ex[2], toBlock: ex[2] });
  const paid = wethIs0 ? log.args.amount1Out : log.args.amount0Out;
  console.log(`   callback tx: ${log.transactionHash}`);
  ok(`4. Reactive executed rule #${ruleId}: ${blocks} blocks ≈ ${((blocks * C.blockMs) / 1000).toFixed(1)} s after the swap`);
  paid > 0n ? ok(`5. the user was paid ${formatUnits(paid, 6)} mUSDC for 0.5 mWETH`) : bad("5. no mUSDC arrived");
  ex[0] === BigInt(swapRc.transactionHash) ? ok("   the execution record names our swap as its origin") : console.log("   (record names a later swap as origin)");
} else {
  bad(`4. rule #${ruleId} not executed after 60 s (status ${rule.status}); check Lasna reserves and executor debt`);
}

// 6. Vault: deposit, then withdraw everything.
const [w0, u0] = [await bal(C.weth), await bal(C.usdc)];
// Only this run's shares move: the wallet may already hold the vault's demo position, which must stay in.
const sharesBefore = await pub.readContract({ address: C.vault, abi: vaultAbi, functionName: "balanceOf", args: [me] });
const dw = parseUnits("0.2", 18);
const du = parseUnits("400", 6);
await send("approve mWETH → vault", { address: C.weth, abi: erc20Abi, functionName: "approve", args: [C.vault, dw] });
await send("approve mUSDC → vault", { address: C.usdc, abi: erc20Abi, functionName: "approve", args: [C.vault, du] });
await send("deposit", { address: C.vault, abi: vaultAbi, functionName: "deposit", args: wethIs0 ? [dw, du] : [du, dw] });
const shares = (await pub.readContract({ address: C.vault, abi: vaultAbi, functionName: "balanceOf", args: [me] })) - sharesBefore;
shares > 0n ? ok(`6a. vault deposit: ${shares} pxLP shares`) : bad("6a. no shares minted");
await send("withdraw this run's shares", { address: C.vault, abi: vaultAbi, functionName: "withdraw", args: [shares] });
const [w1, u1] = [await bal(C.weth), await bal(C.usdc)];
const left = await pub.readContract({ address: C.vault, abi: vaultAbi, functionName: "balanceOf", args: [me] });
left === sharesBefore ? ok("6b. withdrew every share this run deposited") : bad(`6b. share balance ${left}, expected ${sharesBefore}`);
const px = 1.0001 ** (await tick()); // raw currency1 per currency0
const wethUsd = wethIs0 ? px * 1e12 : 1e12 / px;
const net = Number(formatUnits(w1 - w0, 18)) * wethUsd + Number(formatUnits(u1 - u0, 6));
console.log(`   round trip: mWETH ${formatUnits(w1 - w0, 18)}, mUSDC ${formatUnits(u1 - u0, 6)}; net ${net >= 0 ? "+" : ""}${net.toFixed(2)} USDC at the pool price (rebalanced to the range's ratio)`);

console.log(failures ? `\n${failures} step(s) failed` : "\nthe whole user journey works on-chain");
process.exit(failures ? 1 : 0);
