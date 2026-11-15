"use client";

import { useQuery } from "@tanstack/react-query";
import { decodeEventLog, toHex, type Address, type Hex } from "viem";
import { tripwireExecutorAbi, tripwireReactiveAbi } from "@/lib/abis";
import { lasnaClient, unichainClient } from "@/lib/clients";
import { DEPLOYMENT, LINKS } from "@/lib/deployment";

/**
 * One Tripwire execution, followed across both chains:
 *   ① origin Swap on Unichain (T0) → ② reactive tx on Lasna → ③ callback tx on Unichain (T1)
 * The origin tx hash is the join key: the reactive contract emits it in RuleTriggered and the
 * executor emits it in RuleExecuted.
 */
export type FeedItem = {
  key: string;
  ruleId: bigint;
  originTx: Hex;
  t0?: number;
  reactiveTx?: Hex;
  callbackTx?: Hex;
  t1?: number;
  owner?: Address;
  amount0Out?: bigint;
  amount1Out?: bigint;
  tickAfter?: number;
  state: "reacting" | "executed";
};

const TAIL_BLOCKS = 300n; // ~5 min on 1 s chains; history beyond that comes from Blockscout
const HISTORY_EVERY = 6; //  refresh Blockscout history every 6th poll (~15 s)

// Module-level caches: enrichment is paid once per origin tx.
const originTs = new Map<string, number>();
const reactiveByOrigin = new Map<string, Hex>();
const executedHistory = new Map<string, FeedItem>();
let polls = 0;

const originHex = (x: bigint) => toHex(x, { size: 32 });

async function fetchTriggeredTail() {
  const latest = await lasnaClient.getBlockNumber();
  return lasnaClient.getContractEvents({
    address: DEPLOYMENT.reactive,
    abi: tripwireReactiveAbi,
    eventName: "RuleTriggered",
    fromBlock: latest > TAIL_BLOCKS ? latest - TAIL_BLOCKS : 0n,
    toBlock: latest,
  });
}

async function fetchExecutedTail() {
  const latest = await unichainClient.getBlockNumber();
  return unichainClient.getContractEvents({
    address: DEPLOYMENT.executor,
    abi: tripwireExecutorAbi,
    eventName: "RuleExecuted",
    fromBlock: latest - TAIL_BLOCKS,
    toBlock: latest,
  });
}

/** Full RuleExecuted history from Blockscout (the public RPC caps getLogs at 1,000 blocks). */
async function fetchExecutedHistory(): Promise<FeedItem[]> {
  const topic0 = "0xcbeb28ddf63a16f9ba21436a6f32ae913942898c76c4f272a2325b4c5fe7ebaa"; // RuleExecuted
  const url =
    `${LINKS.blockscoutApi}?module=logs&action=getLogs&address=${DEPLOYMENT.executor}` +
    `&topic0=${topic0}&fromBlock=${DEPLOYMENT.executorDeployBlock}&toBlock=latest`;
  const res = await fetch(url);
  const json = (await res.json()) as { result?: { data: Hex; topics: (Hex | null)[]; transactionHash: Hex }[] };
  if (!Array.isArray(json.result)) return [];
  return json.result.map((l) => {
    const ev = decodeEventLog({
      abi: tripwireExecutorAbi,
      eventName: "RuleExecuted",
      data: l.data,
      topics: l.topics.filter(Boolean) as [Hex, ...Hex[]],
    });
    return executedToItem(ev.args, l.transactionHash);
  });
}

type ExecutedArgs = {
  ruleId: bigint;
  owner: Address;
  tick: number;
  amount0Out: bigint;
  amount1Out: bigint;
  originTxHash: bigint;
  executedAt: bigint;
};

function executedToItem(a: ExecutedArgs, tx: Hex): FeedItem {
  const origin = originHex(a.originTxHash);
  return {
    key: `${origin}:${a.ruleId}`,
    ruleId: a.ruleId,
    originTx: origin,
    callbackTx: tx,
    t1: Number(a.executedAt),
    owner: a.owner,
    amount0Out: a.amount0Out,
    amount1Out: a.amount1Out,
    tickAfter: a.tick,
    state: "executed",
  };
}

async function originTimestamp(origin: Hex): Promise<number | undefined> {
  if (originTs.has(origin)) return originTs.get(origin);
  try {
    const r = await unichainClient.getTransactionReceipt({ hash: origin });
    const b = await unichainClient.getBlock({ blockNumber: r.blockNumber });
    originTs.set(origin, Number(b.timestamp));
    return Number(b.timestamp);
  } catch {
    return undefined;
  }
}

/**
 * Lasna has no public logs API, so for executions older than the tail we estimate the Lasna block
 * from the origin timestamp (Lasna makes ~1 block/s) and search a small window around it.
 */
async function findReactiveTx(origin: Hex, t0: number): Promise<Hex | undefined> {
  if (reactiveByOrigin.has(origin)) return reactiveByOrigin.get(origin);
  try {
    const latest = await lasnaClient.getBlock();
    const est = latest.number - BigInt(Math.max(0, Number(latest.timestamp) - t0));
    const logs = await lasnaClient.getContractEvents({
      address: DEPLOYMENT.reactive,
      abi: tripwireReactiveAbi,
      eventName: "RuleTriggered",
      fromBlock: est - 300n,
      toBlock: est + 300n > latest.number ? latest.number : est + 300n,
    });
    const hit = logs.find((l) => originHex(l.args.originTxHash!) === origin);
    if (hit) reactiveByOrigin.set(origin, hit.transactionHash);
    return hit?.transactionHash;
  } catch {
    return undefined;
  }
}

async function loadFeed(): Promise<FeedItem[]> {
  const items = new Map<string, FeedItem>();

  // History (Blockscout), refreshed occasionally and kept between polls.
  if (polls++ % HISTORY_EVERY === 0) {
    try {
      for (const it of await fetchExecutedHistory()) executedHistory.set(it.key, it);
    } catch {
      /* Blockscout down: the RPC tail still covers live demos */
    }
  }
  for (const [k, v] of executedHistory) items.set(k, { ...v });

  // Live tails from both chains.
  const [triggered, executed] = await Promise.allSettled([fetchTriggeredTail(), fetchExecutedTail()]);
  if (executed.status === "fulfilled") {
    for (const l of executed.value) {
      const it = executedToItem(l.args as ExecutedArgs, l.transactionHash);
      items.set(it.key, it);
      executedHistory.set(it.key, it);
    }
  }
  if (triggered.status === "fulfilled") {
    for (const l of triggered.value) {
      const origin = originHex(l.args.originTxHash!);
      reactiveByOrigin.set(origin, l.transactionHash);
      const key = `${origin}:${l.args.ruleId}`;
      if (!items.has(key)) {
        items.set(key, { key, ruleId: l.args.ruleId!, originTx: origin, reactiveTx: l.transactionHash, state: "reacting" });
      }
    }
  }

  // Enrichment: T0 for everything, reactive tx for history rows.
  const list = [...items.values()];
  await Promise.all(
    list.map(async (it) => {
      it.t0 = await originTimestamp(it.originTx);
      it.reactiveTx ??= reactiveByOrigin.get(it.originTx);
      if (!it.reactiveTx && it.t0) it.reactiveTx = await findReactiveTx(it.originTx, it.t0);
    }),
  );

  return list.sort((a, b) => (b.t0 ?? b.t1 ?? Infinity) - (a.t0 ?? a.t1 ?? Infinity)).slice(0, 12);
}

/** Polls every 2.5 s, roughly the time Tripwire takes end to end, so rows animate through their states. */
export function useActivity() {
  return useQuery({ queryKey: ["activity", DEPLOYMENT.executor], queryFn: loadFeed, refetchInterval: 2_500 });
}
