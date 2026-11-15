// Smoke test for the dashboard's live data paths (no browser, no indexer):  npm run smoke
// Mirrors src/hooks/*: per chain → pool price, rules, on-chain execution records, callback tx,
// Lasna mirror + reactive tx. Uses only public RPCs.
import { createPublicClient, http, parseAbi, toHex, defineChain } from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";

const REACTIVE = "0x52e292188E7f8dB587cB60fdd683100A8815eC89";
const POOL_ID = "0xade8c1a33dc66fd63e7f08b4af96a01c31ab4c5346a374a5d82d4d3a6f89763c";
const CHAINS = [
  { name: "Base Sepolia", chain: baseSepolia, rpc: "https://sepolia.base.org", blockMs: 200,
    executor: "0x4d4f9688CA21f7acD88031BeDAA52579925BCbf9", stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4" },
  { name: "Unichain Sepolia", chain: unichainSepolia, rpc: "https://sepolia.unichain.org", blockMs: 1000,
    executor: "0x86338DDBD3E2E8546Ff48b3fd4cdb41D40A11181", stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222" },
];
const lasna = createPublicClient({
  chain: defineChain({ id: 5318007, name: "Lasna", nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 }, rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } } }),
  transport: http(),
});

const executorAbi = parseAbi([
  "function nextRuleId() view returns (uint256)",
  "function executions(uint256) view returns (uint256 originTxHash, uint64 originBlock, uint64 executedBlock, uint64 executedAt)",
  "event RuleExecuted(uint256 indexed ruleId, address indexed owner, int24 tick, uint256 amount0Out, uint256 amount1Out, uint256 originTxHash, uint256 originBlock, uint256 executedAt)",
]);
const reactiveAbi = parseAbi([
  "function chainCount() view returns (uint256)",
  "event RuleTriggered(uint256 indexed chainId, uint256 indexed ruleId, bytes32 indexed poolId, int24 tick, uint256 originTxHash)",
]);
const stateViewAbi = parseAbi(["function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)"]);

let failures = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => (failures++, console.log(`✗ ${m}`));

const n = await lasna.readContract({ address: REACTIVE, abi: reactiveAbi, functionName: "chainCount" });
n === 2n ? ok(`ParallaxReactive guards ${n} chains`) : bad(`ParallaxReactive chainCount = ${n}`);

for (const C of CHAINS) {
  const pub = createPublicClient({ chain: C.chain, transport: http(C.rpc) });
  const [sqrtP, tick] = await pub.readContract({ address: C.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [POOL_ID] });
  const raw = (Number(sqrtP) / 2 ** 96) ** 2;
  ok(`${C.name}: pool price $${(1e12 / raw).toFixed(2)} (tick ${tick})`);

  const next = await pub.readContract({ address: C.executor, abi: executorAbi, functionName: "nextRuleId" });
  let latest;
  for (let id = next - 1n; id >= 1n && !latest; id--) {
    const ex = await pub.readContract({ address: C.executor, abi: executorAbi, functionName: "executions", args: [id] });
    if (ex[2] > 0n) latest = { id, ex };
  }
  if (!latest) { console.log(`! ${C.name}: no executions yet`); continue; }
  const { id, ex } = latest;
  const blocks = Number(ex[2] - ex[1]);
  const [log] = await pub.getContractEvents({ address: C.executor, abi: executorAbi, eventName: "RuleExecuted", args: { ruleId: id }, fromBlock: ex[2], toBlock: ex[2] });
  log ? ok(`${C.name}: rule ${id} callback ${log.transactionHash.slice(0, 10)}… found from the on-chain record (1-block query)`) : bad(`${C.name}: callback log not found`);

  const t0 = Number((await pub.getBlock({ blockNumber: ex[1] })).timestamp);
  const lb = await lasna.getBlock();
  const est = lb.number - BigInt(Math.max(0, Number(lb.timestamp) - t0));
  const trig = await lasna.getContractEvents({
    address: REACTIVE, abi: reactiveAbi, eventName: "RuleTriggered", args: { chainId: BigInt(C.chain.id), ruleId: id },
    fromBlock: est - 300n, toBlock: est + 300n > lb.number ? lb.number : est + 300n,
  });
  const hit = trig.find((t) => toHex(t.args.originTxHash, { size: 32 }) === toHex(ex[0], { size: 32 }));
  hit
    ? ok(`${C.name}: rule ${id} origin → reactive ${hit.transactionHash.slice(0, 10)}… → callback, ${blocks} blocks (${((blocks * C.blockMs) / 1000).toFixed(1)} s)`)
    : bad(`${C.name}: reactive tx for rule ${id} not found`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall data paths OK (no indexer used)");
process.exit(failures ? 1 : 0);
