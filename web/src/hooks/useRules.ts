"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { parallaxExecutorAbi, parallaxReactiveAbi } from "@/lib/abis";
import { chainClients, lasnaClient } from "@/lib/clients";
import { REACTIVE, type ChainDeployment } from "@/lib/deployment";

export type RuleView = {
  id: bigint;
  owner: Address;
  ruleType: number; // 0 STOP_LOSS, 1 TAKE_PROFIT, 2 RANGE_GUARD, 3 TRAILING_STOP
  status: number; //   1 ACTIVE, 2 EXECUTED, 3 CANCELLED
  zeroForOne: boolean;
  lowerTick: number;
  upperTick: number;
  maxSlippageBps: number;
  amountIn: bigint;
  createdAt: number;
  positionId: bigint;
  trailTicks: number;
  recenter: boolean;
  /** Reactive has fired and a callback is in flight (read from the Lasna mirror). */
  triggered: boolean;
};

/**
 * All rules owned by `owner` on `chain`. Reads executor storage directly (getRule for ids
 * 1..nextRuleId-1, batched with multicall) instead of scanning logs, so it works no matter how long
 * ago the rules were created. For ACTIVE rules it also reads the Lasna mirror to show "Triggered".
 */
export function useRules(owner: Address | undefined, chain: ChainDeployment) {
  return useQuery({
    queryKey: ["rules", owner, chain.key, chain.executor],
    enabled: Boolean(owner),
    refetchInterval: 3_000,
    queryFn: async (): Promise<RuleView[]> => {
      const client = chainClients[chain.key];
      const next = await client.readContract({ address: chain.executor, abi: parallaxExecutorAbi, functionName: "nextRuleId" });
      const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));
      if (!ids.length) return [];
      const rules = await client.multicall({
        allowFailure: false,
        contracts: ids.map((id) => ({ address: chain.executor, abi: parallaxExecutorAbi, functionName: "getRule" as const, args: [id] as const })),
      });

      const mine = rules
        .map((r, i) => ({ r, id: ids[i] }))
        .filter(({ r }) => r.owner.toLowerCase() === owner!.toLowerCase());

      const views = await Promise.all(
        mine.map(async ({ r, id }) => {
          let triggered = false;
          if (r.status === 1) {
            try {
              const m = await lasnaClient.readContract({
                address: REACTIVE.address,
                abi: parallaxReactiveAbi,
                functionName: "mirror",
                args: [BigInt(chain.chainId), id],
              });
              triggered = m.pendingSince > 0n;
            } catch {
              /* Lasna unreachable: show as Active */
            }
          }
          return {
            id,
            owner: r.owner,
            ruleType: r.ruleType,
            status: r.status,
            zeroForOne: r.zeroForOne,
            lowerTick: r.lowerTick,
            upperTick: r.upperTick,
            maxSlippageBps: r.maxSlippageBps,
            amountIn: r.amountIn,
            createdAt: Number(r.createdAt),
            positionId: r.positionId,
            trailTicks: r.trailTicks,
            recenter: r.recenter,
            triggered,
          } satisfies RuleView;
        }),
      );
      return views.sort((a, b) => Number(b.id - a.id));
    },
  });
}
