// Smoke test for the vault panel + real-user counter data paths (no browser):  npm run smoke:vault
// Mirrors src/hooks/useVault.ts and useRealUsers.ts. Lasna is optional (some networks block it).
import { createPublicClient, decodeEventLog, defineChain, http, parseAbi, toEventSelector, toHex } from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";

const VAULT = "0x94Bdad7429FAF003f2aDda78B04aB901A5f10C8F";
const VAULT_BLOCK = 59098404n;
const BRAIN = "0x4dDaD9D71Bd31bF69E6c12ab103123870BBC3A24";
const BRAIN_BLOCK = 8404251n;
const DEPLOYER = "0xacf40822e48ddb5f5220d37beb7d6830dd2deeb3";
const SCOUT = { base: "https://base-sepolia.blockscout.com/api", unichain: "https://unichain-sepolia.blockscout.com/api" };
const EXECUTORS = [
  ["base", "0x2f772766ec926359093FA2d478FBDdcd828304Ff", 59073292n],
  ["unichain", "0x5F4159fEF569FbDe44C069751A57e38e97b1109D", 67884067n],
];

const vaultAbi = parseAbi([
  "function mode() view returns (uint8)",
  "function tickLower() view returns (int24)",
  "function tickUpper() view returns (int24)",
  "function inRange() view returns (bool)",
  "function totalValue0() view returns (uint256)",
  "function rebalances() view returns (uint32)",
  "function evacuations() view returns (uint32)",
  "function reentries() view returns (uint32)",
  "event Deposited(address indexed owner, uint256 amount0, uint256 amount1, uint256 shares)",
  "event Withdrawn(address indexed owner, uint256 shares, uint256 amount0, uint256 amount1)",
  "event VaultPositioned(uint256 positionId, int24 tickLower, int24 tickUpper, int24 anchorTick, uint8 reason)",
  "event VaultEvacuated(int24 tick, uint256 amount0, uint256 amount1)",
  "event VaultSkipped(uint8 action, uint8 reason, int24 tick)",
]);
const brainAbi = parseAbi(["event VaultActionRequested(uint8 action, int24 tick, int24 windowMove, uint256 originTxHash)"]);
const RULE_CREATED = toEventSelector("RuleCreated(uint256,address,bytes32,uint8,int24,int24,bool,uint128,uint256,int24)");
const DEPOSITED = toEventSelector("Deposited(address,uint256,uint256,uint256)");

let failures = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => (failures++, console.log(`✗ ${m}`));

async function scout(api, address, from, topic0) {
  const url = `${api}?module=logs&action=getLogs&fromBlock=${from}&toBlock=latest&address=${address}${topic0 ? `&topic0=${topic0}` : ""}`;
  for (let i = 0; i < 4; i++) {
    const body = await (await fetch(url)).json().catch(() => ({}));
    if (Array.isArray(body.result)) return body.result;
    await new Promise((r) => setTimeout(r, 1500)); // rate limited: retry, like react-query does
  }
  throw new Error(`Blockscout unavailable for ${address}`);
}

const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const uni = createPublicClient({ chain: unichainSepolia, transport: http("https://sepolia.unichain.org") });

// Same fallback as useRealUsers: Blockscout first, chunked eth_getLogs if it rate-limits.
async function scoutOrRpc(k, address, from, topic0) {
  try {
    return await scout(SCOUT[k], address, from, topic0);
  } catch {
    const [client, span] = k === "base" ? [base, 200n] : [uni, 1000n];
    const latest = await client.getBlockNumber();
    const out = [];
    for (let f = from; f <= latest; f += span) {
      const t = f + span - 1n > latest ? latest : f + span - 1n;
      out.push(...(await client.request({ method: "eth_getLogs", params: [{ address, topics: [topic0], fromBlock: toHex(f), toBlock: toHex(t) }] })));
    }
    console.log(`  (${k}: Blockscout rate-limited, used ${((latest - from) / span + 1n).toString()} RPC getLogs calls)`);
    return out;
  }
}
const read = (functionName) => base.readContract({ address: VAULT, abi: vaultAbi, functionName });
const [mode, tl, tu, inRange, tvl, r, e, re] = await Promise.all(
  ["mode", "tickLower", "tickUpper", "inRange", "totalValue0", "rebalances", "evacuations", "reentries"].map(read),
);
ok(`vault state: mode ${["empty", "positioned", "evacuated"][mode]}, range [${tl}, ${tu}), in range ${inRange}, value $${(Number(tvl) / 1e6).toFixed(0)}, re-centred ${r} / evacuated ${e} / re-entered ${re}`);

const logs = await scout(SCOUT.base, VAULT, VAULT_BLOCK);
const events = [];
for (const l of logs) {
  try {
    events.push(decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics.filter(Boolean) }).eventName);
  } catch {
    /* ERC-20 Transfer */
  }
}
events.length ? ok(`vault history from Blockscout: ${events.join(", ")}`) : bad("no vault events decoded");

try {
  const lasna = createPublicClient({
    chain: defineChain({ id: 5318007, name: "Lasna", nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 }, rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } } }),
    transport: http(),
  });
  const latest = await lasna.getBlockNumber();
  const reqs = [];
  for (let from = BRAIN_BLOCK; from <= latest; from += 10_000n) {
    const to = from + 9_999n > latest ? latest : from + 9_999n;
    reqs.push(...(await lasna.getContractEvents({ address: BRAIN, abi: brainAbi, eventName: "VaultActionRequested", fromBlock: from, toBlock: to })));
  }
  ok(`brain requests on Lasna: ${reqs.map((x) => `${["rebalance", "evacuate", "reenter"][x.args.action]} (origin ${toHex(x.args.originTxHash, { size: 32 }).slice(0, 10)}…)`).join(", ")}`);
} catch (err) {
  console.log(`! Lasna unreachable from this network (${String(err.shortMessage ?? err.message).split("\n")[0]}); the panel shows the Base side only`);
}

const owners = new Set();
for (const [k, addr, from] of EXECUTORS) for (const l of await scoutOrRpc(k, addr, from, RULE_CREATED)) owners.add(`0x${l.topics[2].slice(26)}`);
const depositors = new Set((await scout(SCOUT.base, VAULT, VAULT_BLOCK, DEPOSITED)).map((l) => `0x${l.topics[1].slice(26)}`));
const real = new Set([...owners, ...depositors].filter((a) => a.toLowerCase() !== DEPLOYER));
ok(`real-user counter: ${real.size} wallet(s) besides the deployer (${owners.size} rule owner(s) and ${depositors.size} depositor(s) incl. deployer)`);

console.log(failures ? `\n${failures} check(s) failed` : "\nvault + user-counter data paths OK");
process.exit(failures ? 1 : 0);
