"use client";

import { useQuery } from "@tanstack/react-query";
import { encodeEventTopics, type Address, type Hex } from "viem";
import { parallaxExecutorAbi, parallaxVaultAbi } from "@/lib/abis";
import { chainClients } from "@/lib/clients";
import { CHAIN_LIST, DEPLOYER, VAULT, CHAINS, type ChainKey } from "@/lib/deployment";

/**
 * How many distinct wallets have actually used Parallax: rule owners on every live executor plus vault
 * depositors, excluding the deployer (which runs the scripted demo). Counted from on-chain logs via the
 * Blockscout API, so anyone can recompute it.
 */
const RULE_CREATED = encodeEventTopics({ abi: parallaxExecutorAbi, eventName: "RuleCreated" })[0];
const DEPOSITED = encodeEventTopics({ abi: parallaxVaultAbi, eventName: "Deposited" })[0];

type ScoutLog = { topics: (Hex | null)[] };

/** RPC fallback when Blockscout rate-limits: public RPCs cap getLogs ranges (Base 200, Unichain 1000 blocks). */
const RPC_SPAN: Record<ChainKey, bigint> = { base: 200n, unichain: 1000n };

/** Logs already scanned via RPC, so each refresh only reads the blocks it has not seen yet. */
const rpcCache = new Map<string, { next: bigint; logs: ScoutLog[] }>();

async function rpcLogs(chain: ChainKey, address: Address, fromBlock: bigint, topic0: Hex): Promise<ScoutLog[]> {
  const client = chainClients[chain];
  const latest = await client.getBlockNumber();
  const key = `${chain}:${address}:${topic0}`;
  const cached = rpcCache.get(key) ?? { next: fromBlock, logs: [] };
  const out: ScoutLog[] = [...cached.logs];
  for (let from = cached.next; from <= latest; from += RPC_SPAN[chain]) {
    const to = from + RPC_SPAN[chain] - 1n > latest ? latest : from + RPC_SPAN[chain] - 1n;
    const got = await client.request({
      method: "eth_getLogs",
      params: [{ address, topics: [topic0], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
    });
    out.push(...(got as ScoutLog[]));
    rpcCache.set(key, { next: to + 1n, logs: [...out] });
  }
  return out;
}

async function logs(chain: ChainKey, address: Address, fromBlock: bigint, topic0: Hex): Promise<ScoutLog[]> {
  try {
    return await scoutLogs(CHAINS[chain].blockscoutApi, address, fromBlock, topic0);
  } catch {
    return rpcLogs(chain, address, fromBlock, topic0);
  }
}

async function scoutLogs(api: string, address: Address, fromBlock: bigint, topic0: Hex): Promise<ScoutLog[]> {
  const url = `${api}?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=latest&address=${address}&topic0=${topic0}`;
  const res = await fetch(url);
  const body = (await res.json()) as { result?: ScoutLog[] | string };
  // "No logs found" is a valid empty answer; anything else (e.g. 429 rate limit) throws so react-query
  // retries and keeps the last good data instead of showing a false zero.
  if (Array.isArray(body.result)) return body.result;
  if ((body as { message?: string }).message === "No logs found") return [];
  throw new Error(`Blockscout: ${(body as { message?: string }).message ?? res.status}`);
}

const topicAddr = (t: Hex | null | undefined) => (t ? (`0x${t.slice(26)}` as Address).toLowerCase() : undefined);

export function useRealUsers() {
  return useQuery({
    queryKey: ["real-users"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const [ruleLogs, depositLogs] = await Promise.all([
        Promise.all(CHAIN_LIST.map((c) => logs(c.key, c.executor, c.executorDeployBlock, RULE_CREATED))),
        logs(VAULT.chain, VAULT.address, VAULT.deployBlock, DEPOSITED),
      ]);
      const me = DEPLOYER.toLowerCase();
      const ruleOwners = new Set(ruleLogs.flat().map((l) => topicAddr(l.topics[2])).filter((a) => a && a !== me));
      const depositors = new Set(depositLogs.map((l) => topicAddr(l.topics[1])).filter((a) => a && a !== me));
      const all = new Set([...ruleOwners, ...depositors]);
      return { wallets: all.size, ruleOwners: ruleOwners.size, depositors: depositors.size };
    },
  });
}
