// Smoke test for the dashboard's live data paths (no browser needed):  npm run smoke
// Mirrors what src/hooks/* do: pool price, rules, Lasna mirror, execution history, reactive-tx lookup.
import { createPublicClient, decodeEventLog, http, parseAbi, toHex } from "viem";
import { unichainSepolia } from "viem/chains";

const D = {
  executor: "0x87Ce29239B4F63a2C00DDa8F6e058ACDeB9181af",
  reactive: "0xC3C04592057E816EB706eF0E9A9438267537B2A2",
  stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222",
  poolId: "0xade8c1a33dc66fd63e7f08b4af96a01c31ab4c5346a374a5d82d4d3a6f89763c",
  weth: "0x6D489Fa6F5c837B79A7FF8Dcc2B488CbD14309A5",
  usdc: "0x0bE64D69008Afbef624B2ea7A5062a53E844Dc6c",
  deployBlock: 67867605n,
};
const uni = createPublicClient({ chain: unichainSepolia, transport: http("https://sepolia.unichain.org") });
const lasna = createPublicClient({
  chain: { id: 5318007, name: "Lasna", nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 }, rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } } },
  transport: http("https://lasna-rpc.rnk.dev/"),
});

const executorAbi = parseAbi([
  "function nextRuleId() view returns (uint256)",
  "event RuleExecuted(uint256 indexed ruleId, address indexed owner, int24 tick, uint256 amount0Out, uint256 amount1Out, uint256 originTxHash, uint256 executedAt)",
]);
const reactiveAbi = parseAbi([
  "function mirror(uint256) view returns (bytes32 poolId, int24 lowerTick, int24 upperTick, bool exists, uint64 pendingSince, uint32 index)",
  "event RuleTriggered(uint256 indexed ruleId, bytes32 indexed poolId, int24 tick, uint256 originTxHash)",
]);

let failures = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => (failures++, console.log(`✗ ${m}`));

// 1. Pool price
const [sqrtP, tick] = await uni.readContract({
  address: D.stateView,
  abi: parseAbi(["function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)"]),
  functionName: "getSlot0",
  args: [D.poolId],
});
const wethIs0 = D.weth.toLowerCase() < D.usdc.toLowerCase();
const raw = (Number(sqrtP) / 2 ** 96) ** 2;
const price = wethIs0 ? raw * 1e12 : 1e12 / raw;
price > 0 ? ok(`pool price $${price.toFixed(2)} (tick ${tick})`) : bad("pool price");

// 2. Rules
const next = await uni.readContract({ address: D.executor, abi: executorAbi, functionName: "nextRuleId" });
ok(`executor has ${next - 1n} rule(s)`);

// 3. Lasna mirror read (CORS-free here, but same RPC the browser uses)
const m = await lasna.readContract({ address: D.reactive, abi: reactiveAbi, functionName: "mirror", args: [1n] });
ok(`Lasna mirror(1) readable (exists=${m[3]})`);

// 4. Execution history from Blockscout
const topic0 = "0xcbeb28ddf63a16f9ba21436a6f32ae913942898c76c4f272a2325b4c5fe7ebaa";
const url = `https://unichain-sepolia.blockscout.com/api?module=logs&action=getLogs&address=${D.executor}&topic0=${topic0}&fromBlock=${D.deployBlock}&toBlock=latest`;
const { result } = await (await fetch(url)).json();
Array.isArray(result) && result.length ? ok(`Blockscout returned ${result.length} RuleExecuted log(s)`) : bad("Blockscout history");

// 5. For each execution: origin T0, reactive tx via the timestamp-window search, latency
for (const l of result ?? []) {
  const ev = decodeEventLog({ abi: executorAbi, data: l.data, topics: l.topics.filter(Boolean) });
  const origin = toHex(ev.args.originTxHash, { size: 32 });
  const r = await uni.getTransactionReceipt({ hash: origin });
  const t0 = Number((await uni.getBlock({ blockNumber: r.blockNumber })).timestamp);
  const latest = await lasna.getBlock();
  const est = latest.number - BigInt(Math.max(0, Number(latest.timestamp) - t0));
  const logs = await lasna.getContractEvents({
    address: D.reactive,
    abi: reactiveAbi,
    eventName: "RuleTriggered",
    fromBlock: est - 300n,
    toBlock: est + 300n > latest.number ? latest.number : est + 300n,
  });
  const hit = logs.find((x) => toHex(x.args.originTxHash, { size: 32 }) === origin);
  const latency = Number(ev.args.executedAt) - t0;
  const line = `rule ${ev.args.ruleId}: origin ${origin.slice(0, 10)}… → reactive ${hit ? hit.transactionHash.slice(0, 10) + "…" : "NOT FOUND"} → callback ${l.transactionHash.slice(0, 10)}…  latency ${latency}s`;
  hit ? ok(line) : bad(line);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall data paths OK");
process.exit(failures ? 1 : 0);
