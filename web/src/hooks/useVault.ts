"use client";

import { useQuery } from "@tanstack/react-query";
import { decodeEventLog, toHex, type Address, type Hex } from "viem";
import { parallaxVaultAbi, parallaxVaultReactiveAbi, stateViewAbi } from "@/lib/abis";
import { chainClients, lasnaClient } from "@/lib/clients";
import { CHAINS, VAULT } from "@/lib/deployment";
import { storedVaultAction } from "@/lib/proofs";

/**
 * Parallax Vault, read straight from chain (no indexer):
 *   • live state: one multicall on Base (mode, range, value, counters, your shares) + the pool tick
 *   • history:    the vault's own events on Base (Blockscout log API, no block-range limit)
 *   • the loop:   each action the brain requested on Lasna (VaultActionRequested carries the origin
 *                 swap hash), matched in order to the vault callback that followed it on Base.
 */

const chain = CHAINS[VAULT.chain];
const client = chainClients[VAULT.chain];

export type VaultMode = "empty" | "positioned" | "evacuated";
const MODES: VaultMode[] = ["empty", "positioned", "evacuated"];
const ACTIONS = ["rebalance", "evacuate", "reenter"] as const;
export type VaultAction = (typeof ACTIONS)[number];

export type VaultState = {
  mode: VaultMode;
  tick: number;
  tickLower: number;
  tickUpper: number;
  inRange: boolean;
  rebalances: number;
  evacuations: number;
  reentries: number;
  totalSupply: bigint;
  totalValue0: bigint; // valued in currency0 (mUSDC, 6 dp) at the live price
  myShares: bigint;
};

export type VaultEvent = {
  kind: "deposit" | "withdraw" | "positioned" | "evacuated" | "skipped";
  reason?: "deposit" | VaultAction; // positioned: 0 first deposit, 1 rebalance, 2 re-entry
  tx: Hex;
  block: number;
  timestamp: number;
  tickLower?: number;
  tickUpper?: number;
  tick?: number;
  owner?: Address;
  // filled in for reactive actions when the Lasna side could be read
  originTx?: Hex;
  originBlock?: number;
  reactiveTx?: Hex;
  latencyBlocks?: number;
};

export function useVaultState(account?: Address) {
  return useQuery({
    queryKey: ["vault-state", account],
    refetchInterval: 4_000,
    queryFn: async (): Promise<VaultState> => {
      const v = { address: VAULT.address, abi: parallaxVaultAbi } as const;
      const r = await client.multicall({
        allowFailure: false,
        contracts: [
          { ...v, functionName: "mode" },
          { ...v, functionName: "tickLower" },
          { ...v, functionName: "tickUpper" },
          { ...v, functionName: "inRange" },
          { ...v, functionName: "rebalances" },
          { ...v, functionName: "evacuations" },
          { ...v, functionName: "reentries" },
          { ...v, functionName: "totalSupply" },
          { ...v, functionName: "totalValue0" },
          { ...v, functionName: "balanceOf", args: [account ?? "0x0000000000000000000000000000000000000000"] },
          { address: chain.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [chain.poolId] },
        ],
      });
      return {
        mode: MODES[Number(r[0])] ?? "empty",
        tickLower: Number(r[1]),
        tickUpper: Number(r[2]),
        inRange: r[3] as boolean,
        rebalances: Number(r[4]),
        evacuations: Number(r[5]),
        reentries: Number(r[6]),
        totalSupply: r[7] as bigint,
        totalValue0: r[8] as bigint,
        myShares: r[9] as bigint,
        tick: Number((r[10] as readonly [bigint, number, number, number])[1]),
      };
    },
  });
}

type ScoutLog = { blockNumber: Hex; timeStamp: Hex; transactionHash: Hex; data: Hex; topics: (Hex | null)[] };

async function vaultLogs(): Promise<ScoutLog[]> {
  const url = `${chain.blockscoutApi}?module=logs&action=getLogs&fromBlock=${VAULT.deployBlock}&toBlock=latest&address=${VAULT.address}`;
  const res = await fetch(url);
  const body = (await res.json()) as { result?: ScoutLog[] | string };
  // "No logs found" is a valid empty answer; anything else (e.g. 429 rate limit) throws so react-query
  // retries and keeps the last good data instead of showing a false zero.
  if (Array.isArray(body.result)) return body.result;
  if ((body as { message?: string }).message === "No logs found") return [];
  throw new Error(`Blockscout: ${(body as { message?: string }).message ?? res.status}`);
}

/** Brain action requests on Lasna. Lasna has no indexer here, so read in chunks; failure is non-fatal. */
async function brainRequests() {
  const out: { tx: Hex; action: VaultAction; originTx: Hex }[] = [];
  try {
    const latest = await lasnaClient.getBlockNumber();
    const event = parallaxVaultReactiveAbi.find((x) => x.type === "event" && x.name === "VaultActionRequested");
    const CHUNK = 10_000n;
    for (let from = VAULT.brainDeployBlock; from <= latest; from += CHUNK) {
      const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
      const logs = await lasnaClient.getLogs({
        address: VAULT.brain,
        event: event as Extract<(typeof parallaxVaultReactiveAbi)[number], { name: "VaultActionRequested" }>,
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        const a = l.args as { action: number; originTxHash: bigint };
        out.push({ tx: l.transactionHash as Hex, action: ACTIONS[a.action], originTx: toHex(a.originTxHash, { size: 32 }) });
      }
    }
  } catch {
    /* Lasna unreachable: history still shows the Base side */
  }
  return out;
}

export function useVaultHistory() {
  return useQuery({
    queryKey: ["vault-history"],
    refetchInterval: 15_000,
    queryFn: async (): Promise<VaultEvent[]> => {
      const lasnaWithin3s = Promise.race([brainRequests(), new Promise<Awaited<ReturnType<typeof brainRequests>>>((r) => setTimeout(() => r([]), 3_000))]);
      const [logs, requests] = await Promise.all([vaultLogs(), lasnaWithin3s]);
      const events: VaultEvent[] = [];
      for (const l of logs) {
        let d;
        try {
          d = decodeEventLog({ abi: parallaxVaultAbi, data: l.data, topics: l.topics.filter(Boolean) as [Hex, ...Hex[]] });
        } catch {
          continue; // ERC-20 Transfer etc.
        }
        const base = { tx: l.transactionHash, block: Number(l.blockNumber), timestamp: Number(l.timeStamp) };
        const a = d.args as Record<string, unknown>;
        if (d.eventName === "Deposited") events.push({ ...base, kind: "deposit", owner: a.owner as Address });
        else if (d.eventName === "Withdrawn") events.push({ ...base, kind: "withdraw", owner: a.owner as Address });
        else if (d.eventName === "VaultPositioned")
          events.push({
            ...base,
            kind: "positioned",
            reason: (["deposit", "rebalance", "reenter"] as const)[Number(a.reason)],
            tickLower: Number(a.tickLower),
            tickUpper: Number(a.tickUpper),
            tick: Number(a.anchorTick),
          });
        else if (d.eventName === "VaultEvacuated") events.push({ ...base, kind: "evacuated", reason: "evacuate", tick: Number(a.tick) });
        else if (d.eventName === "VaultSkipped")
          events.push({ ...base, kind: "skipped", reason: ACTIONS[Number(a.action)], tick: Number(a.tick) });
      }
      events.sort((x, y) => x.block - y.block);

      // Reactive answers (positioned by rebalance/reenter, evacuated, skipped) map 1:1, in order, to brain requests.
      const answers = events.filter((e) => e.reason && e.reason !== "deposit");
      answers.forEach((e, i) => {
        const r = requests[i];
        if (r && r.action === e.reason) Object.assign(e, { reactiveTx: r.tx, originTx: r.originTx });
        // Lasna unreachable or pruned: the loop frozen by `npm run snapshot`.
        const stored = storedVaultAction(e.tx);
        if (!e.reactiveTx && stored) Object.assign(e, { reactiveTx: stored.reactiveTx, originTx: stored.originTx });
      });
      await Promise.all(
        answers
          .filter((e) => e.originTx)
          .map(async (e) => {
            try {
              const rc = await client.getTransactionReceipt({ hash: e.originTx! });
              e.originBlock = Number(rc.blockNumber);
              e.latencyBlocks = e.block - e.originBlock;
            } catch {
              /* origin receipt not available */
            }
          }),
      );
      return events.reverse();
    },
  });
}
