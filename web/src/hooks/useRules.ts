"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { tripwireExecutorAbi, tripwireReactiveAbi } from "@/lib/abis";
import { lasnaClient, unichainClient } from "@/lib/clients";
import { DEPLOYMENT } from "@/lib/deployment";

export type RuleView = {
  id: bigint;
  owner: Address;
  ruleType: number; // 0 STOP_LOSS, 1 TAKE_PROFIT, 2 RANGE_GUARD
  status: number; //   1 ACTIVE, 2 EXECUTED, 3 CANCELLED
  zeroForOne: boolean;
  lowerTick: number;
  upperTick: number;
  maxSlippageBps: number;
  amountIn: bigint;
  createdAt: number;
  positionId: bigint;
  /** Reactive has fired and a callback is in flight (read from the Lasna mirror). */
  triggered: boolean;
};

/**
 * All rules owned by `owner`. Reads executor storage directly (getRule for ids 1..nextRuleId-1)
 * instead of scanning logs, so it works no matter how long ago the rules were created.
 * For ACTIVE rules it also reads the reactive contract's mirror on Lasna to show "Triggered".
 */
export function useRules(owner?: Address) {
  return useQuery({
    queryKey: ["rules", owner, DEPLOYMENT.executor],
    enabled: Boolean(owner),
    refetchInterval: 2_000,
    queryFn: async (): Promise<RuleView[]> => {
      const next = await unichainClient.readContract({
        address: DEPLOYMENT.executor,
        abi: tripwireExecutorAbi,
        functionName: "nextRuleId",
      });
      const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));
      const rules = await Promise.all(
        ids.map((id) =>
          unichainClient.readContract({
            address: DEPLOYMENT.executor,
            abi: tripwireExecutorAbi,
            functionName: "getRule",
            args: [id],
          }),
        ),
      );

      const mine = rules
        .map((r, i) => ({ r, id: ids[i] }))
        .filter(({ r }) => r.owner.toLowerCase() === owner!.toLowerCase());

      return Promise.all(
        mine.map(async ({ r, id }) => {
          let triggered = false;
          if (r.status === 1) {
            try {
              const m = await lasnaClient.readContract({
                address: DEPLOYMENT.reactive,
                abi: tripwireReactiveAbi,
                functionName: "mirror",
                args: [id],
              });
              triggered = m[4] > 0n; // pendingSince
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
            triggered,
          } satisfies RuleView;
        }),
      ).then((list) => list.sort((a, b) => Number(b.id - a.id)));
    },
  });
}
