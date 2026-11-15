"use client";

import { useQuery } from "@tanstack/react-query";
import { toHex, type Address, type Hex } from "viem";
import { parallaxExecutorAbi, parallaxReactiveAbi } from "@/lib/abis";
import { chainClients, lasnaClient } from "@/lib/clients";
import { CHAIN_LIST, REACTIVE, type ChainDeployment, type ChainKey } from "@/lib/deployment";
import { PROOFS, storedExecution } from "@/lib/proofs";

/**
 * One Parallax execution, followed across chains:
 *   ① origin Swap (Base or Unichain, T0) → ② reactive tx (Lasna) → ③ callback on the same chain (T1)
 *
 * No indexer needed: each executor stores an on-chain Execution record
 * (originTxHash, originBlock, executedBlock, executedAt). From that:
 *   • latency in blocks = executedBlock − originBlock (exact, for every execution, one multicall)
 *   • callback tx      = the RuleExecuted log in block `executedBlock` (1-block query)
 *   • T0               = timestamp of `originBlock`
 *   • reactive tx      = RuleTriggered(chainId, ruleId) on Lasna (indexed filter)
 */
export type FeedItem = {
  key: string;
  chain: ChainKey;
  ruleId: bigint;
  state: "reacting" | "executed";
  originTx: Hex;
  originBlock?: number;
  t0?: number;
  reactiveTx?: Hex;
  reactiveAt?: number; // Lasna block timestamp of the reactive tx (s), when Lasna is readable
  callbackTx?: Hex;
  executedBlock?: number;
  t1?: number;
  latencyBlocks?: number;
  latencySeconds?: number; // blocks × nominal block time (Base 200 ms, Unichain 1 s)
  owner?: Address;
  amount0Out?: bigint;
  amount1Out?: bigint;
};

export type ChainStats = { n: number; p50Blocks?: number; p50Seconds?: number; minSeconds?: number };
export type Activity = { items: FeedItem[]; stats: Record<ChainKey, ChainStats>; last?: FeedItem };

type ExecRecord = { originTxHash: bigint; originBlock: number; executedBlock: number; executedAt: number };

const ENRICH_NEWEST = 12; // only the newest rows need tx hashes; stats use every record
const LASNA_TAIL = 300n;

// Caches (executed records are final on-chain, so they never need re-reading).
const finalStatus = new Map<string, number>(); //  chain:ruleId → 2 executed / 3 cancelled
const records = new Map<string, ExecRecord>();
const enriched = new Map<string, Partial<FeedItem>>();
const partial = new Map<string, Partial<FeedItem>>(); // best effort so far, retried until complete
const inFlight = new Set<string>();
const blockTs = new Map<string, number>();

const k = (c: ChainKey, id: bigint) => `${c}:${id}`;
const originHex = (x: bigint) => toHex(x, { size: 32 });

async function loadRecords(chain: ChainDeployment) {
  const client = chainClients[chain.key];
  const next = await client.readContract({ address: chain.executor, abi: parallaxExecutorAbi, functionName: "nextRuleId" });
  const open = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1)).filter((id) => !finalStatus.has(k(chain.key, id)));
  if (!open.length) return;
  const res = await client.multicall({
    allowFailure: false,
    contracts: open.flatMap((id) => [
      { address: chain.executor, abi: parallaxExecutorAbi, functionName: "getRule" as const, args: [id] as const },
      { address: chain.executor, abi: parallaxExecutorAbi, functionName: "executions" as const, args: [id] as const },
    ]),
  });
  open.forEach((id, i) => {
    const rule = res[2 * i] as { status: number };
    const ex = res[2 * i + 1] as readonly [bigint, bigint, bigint, bigint];
    if (rule.status === 3) finalStatus.set(k(chain.key, id), 3);
    if (rule.status === 2 && ex[2] > 0n) {
      finalStatus.set(k(chain.key, id), 2);
      records.set(k(chain.key, id), {
        originTxHash: ex[0],
        originBlock: Number(ex[1]),
        executedBlock: Number(ex[2]),
        executedAt: Number(ex[3]),
      });
    }
  });
}

async function timestampOf(chain: ChainKey, block: number) {
  const id = `${chain}:${block}`;
  if (!blockTs.has(id)) blockTs.set(id, Number((await chainClients[chain].getBlock({ blockNumber: BigInt(block) })).timestamp));
  return blockTs.get(id)!;
}

/** Tx hashes + amounts for one executed rule (once; then cached). */
async function enrich(chain: ChainDeployment, ruleId: bigint, rec: ExecRecord): Promise<Partial<FeedItem>> {
  const id = k(chain.key, ruleId);
  if (enriched.has(id)) return enriched.get(id)!;
  const out: Partial<FeedItem> = {};
  try {
    const [log] = await chainClients[chain.key].getContractEvents({
      address: chain.executor,
      abi: parallaxExecutorAbi,
      eventName: "RuleExecuted",
      args: { ruleId },
      fromBlock: BigInt(rec.executedBlock),
      toBlock: BigInt(rec.executedBlock),
    });
    if (log) Object.assign(out, { callbackTx: log.transactionHash, owner: log.args.owner, amount0Out: log.args.amount0Out, amount1Out: log.args.amount1Out });
    out.t0 = await timestampOf(chain.key, rec.originBlock);
    partial.set(id, { ...out }); // the Base side is ready; show it while Lasna is looked up
  } catch {
    return out; // retried next poll
  }
  try {
    out.reactiveTx = await findReactiveTx(chain, ruleId, out.t0);
  } catch {
    /* Lasna unreachable or pruned: fall back to the stored proof below */
  }
  // Lasna prunes old blocks: use the loop frozen by `npm run snapshot` when the live lookup finds nothing.
  const stored = storedExecution(chain.key, ruleId);
  if (!out.reactiveTx && stored?.reactiveTx) out.reactiveTx = stored.reactiveTx;
  if (!out.callbackTx && stored?.callbackTx) out.callbackTx = stored.callbackTx;
  if (out.reactiveTx) {
    try {
      const rc = await lasnaClient.getTransactionReceipt({ hash: out.reactiveTx });
      out.reactiveAt = await lasnaTimestamp(rc.blockNumber);
    } catch {
      /* position on the loop strip is optional */
    }
  }
  if (out.callbackTx && out.reactiveTx) enriched.set(id, out);
  return out;
}

/** Lasna block timestamps, cached (blocks are final, and each lookup below reads ~23 of them). */
const lasnaTs = new Map<bigint, number>();
async function lasnaTimestamp(n: bigint) {
  let t = lasnaTs.get(n);
  if (t === undefined) {
    t = Number((await lasnaClient.getBlock({ blockNumber: n })).timestamp);
    lasnaTs.set(n, t);
  }
  return t;
}

/**
 * First Lasna block at or after timestamp `ts`, by binary search. Lasna blocks are ~1.06 s, not exactly
 * 1 s, so a "1 block per second" estimate drifts by hundreds of blocks within a few hours.
 */
async function lasnaBlockAt(ts: number, latest: bigint): Promise<bigint> {
  let lo = REACTIVE.deployBlock;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await lasnaTimestamp(mid)) < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/** Lasna has no logs API here: locate the Lasna block for T0, then search a short window after it. */
async function findReactiveTx(chain: ChainDeployment, ruleId: bigint, t0: number): Promise<Hex | undefined> {
  const latest = await lasnaClient.getBlockNumber();
  const start = await lasnaBlockAt(t0, latest);
  const from = start > 60n ? start - 60n : 0n; // clocks differ slightly between chains
  const logs = await lasnaClient.getContractEvents({
    address: REACTIVE.address,
    abi: parallaxReactiveAbi,
    eventName: "RuleTriggered",
    args: { chainId: BigInt(chain.chainId), ruleId },
    fromBlock: from,
    toBlock: start + 600n > latest ? latest : start + 600n,
  });
  return logs.at(-1)?.transactionHash;
}

function pct(xs: number[], p: number) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

async function loadActivity(): Promise<Activity> {
  await Promise.allSettled(CHAIN_LIST.map(loadRecords));

  // Executed rows (from on-chain records), newest first.
  const executed: FeedItem[] = [];
  for (const chain of CHAIN_LIST) {
    for (const [id, rec] of records) {
      if (!id.startsWith(`${chain.key}:`)) continue;
      const blocks = rec.executedBlock - rec.originBlock;
      executed.push({
        key: id,
        chain: chain.key,
        ruleId: BigInt(id.split(":")[1]),
        state: "executed",
        originTx: originHex(rec.originTxHash),
        originBlock: rec.originBlock,
        executedBlock: rec.executedBlock,
        t1: rec.executedAt,
        latencyBlocks: blocks,
        latencySeconds: (blocks * chain.blockMs) / 1000,
      });
    }
  }
  executed.sort((a, b) => (b.t1 ?? 0) - (a.t1 ?? 0));

  // Stats over every proven loop: the live executors' records plus the stored ones (benchmark rounds and
  // earlier live runs), one row per origin swap. Block counts are exact either way.
  const stats = Object.fromEntries(
    CHAIN_LIST.map((c) => {
      const byOrigin = new Map<string, number>();
      for (const e of [...PROOFS.executions, ...PROOFS.bench]) if (e.chain === c.key) byOrigin.set(e.originTx.toLowerCase(), e.latencyBlocks);
      for (const e of executed) if (e.chain === c.key) byOrigin.set(e.originTx.toLowerCase(), e.latencyBlocks!);
      const b = [...byOrigin.values()];
      const s = b.map((x) => (x * c.blockMs) / 1000);
      return [c.key, { n: b.length, p50Blocks: pct(b, 50), p50Seconds: pct(s, 50), minSeconds: s.length ? Math.min(...s) : undefined }];
    }),
  ) as Record<ChainKey, ChainStats>;

  // Enrich only the newest rows with tx hashes.
  const newest = executed.slice(0, ENRICH_NEWEST);
  for (const it of newest) {
    const chain = CHAIN_LIST.find((c) => c.key === it.chain)!;
    const stored = storedExecution(it.chain, it.ruleId);
    if (stored) Object.assign(it, { reactiveTx: stored.reactiveTx ?? undefined, callbackTx: stored.callbackTx ?? undefined, t0: stored.t0 });
    const cached = enriched.get(it.key) ?? partial.get(it.key);
    if (cached) for (const [k2, v] of Object.entries(cached)) if (v !== undefined) Object.assign(it, { [k2]: v });
    if (!enriched.has(it.key) && !inFlight.has(it.key)) {
      // Never awaited: on a network that blocks Lasna the lookups can take seconds, and the screen must not wait.
      inFlight.add(it.key);
      enrich(chain, it.ruleId, records.get(it.key)!)
        .then((out) => partial.set(it.key, out))
        .finally(() => inFlight.delete(it.key));
    }
  }

  // In-flight rows (Lasna fired, callback not landed yet), refreshed in the background so a slow Lasna never
  // holds up the screen.
  if (!reactingInFlight) {
    reactingInFlight = true;
    loadReacting()
      .then((r) => (reactingCache = r))
      .catch(() => undefined)
      .finally(() => (reactingInFlight = false));
  }
  const reacting = reactingCache.filter((r) => !finalStatus.has(r.key));

  const items = [...new Map([...reacting, ...newest].map((i) => [i.key, i])).values()];
  return { items, stats, last: newest[0] };
}

let reactingCache: FeedItem[] = [];
let reactingInFlight = false;
async function loadReacting(): Promise<FeedItem[]> {
  const latest = await lasnaClient.getBlockNumber();
  const trig = await lasnaClient.getContractEvents({
    address: REACTIVE.address,
    abi: parallaxReactiveAbi,
    eventName: "RuleTriggered",
    fromBlock: latest - LASNA_TAIL,
    toBlock: latest,
  });
  const out: FeedItem[] = [];
  for (const l of trig) {
    const chain = CHAIN_LIST.find((c) => BigInt(c.chainId) === l.args.chainId);
    if (!chain) continue;
    out.push({
      key: k(chain.key, l.args.ruleId!),
      chain: chain.key,
      ruleId: l.args.ruleId!,
      state: "reacting",
      originTx: originHex(l.args.originTxHash!),
      reactiveTx: l.transactionHash,
    });
  }
  return out;
}

/** Figures from the stored proofs, shown until the first live read lands (never a blank strip). */
function storedStats(): Record<ChainKey, ChainStats> {
  return Object.fromEntries(
    CHAIN_LIST.map((c) => {
      const b = [...PROOFS.executions, ...PROOFS.bench].filter((e) => e.chain === c.key).map((e) => e.latencyBlocks);
      const s = b.map((x) => (x * c.blockMs) / 1000);
      return [c.key, { n: b.length, p50Blocks: pct(b, 50), p50Seconds: pct(s, 50), minSeconds: s.length ? Math.min(...s) : undefined }];
    }),
  ) as Record<ChainKey, ChainStats>;
}

/** Polls every 2.5 s, about the time Parallax takes end to end, so rows animate through their states. */
export function useActivity() {
  return useQuery({
    queryKey: ["activity", REACTIVE.address],
    queryFn: loadActivity,
    refetchInterval: 2_500,
    placeholderData: (prev) => prev ?? { items: [], stats: storedStats() },
  });
}
