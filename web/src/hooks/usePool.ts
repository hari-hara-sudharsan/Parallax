"use client";

import { useReadContract } from "wagmi";
import { stateViewAbi } from "@/lib/abis";
import type { ChainDeployment } from "@/lib/deployment";
import { sqrtPriceX96ToPrice } from "@/lib/price";

/** Live demo-pool state on `chain`, refreshed every 2 s. */
export function usePool(chain: ChainDeployment) {
  const { data, isLoading, error, dataUpdatedAt } = useReadContract({
    address: chain.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [chain.poolId],
    chainId: chain.chainId as 84532 | 1301,
    query: { refetchInterval: 2_000 },
  });

  const sqrtPriceX96 = data?.[0];
  const tick = data?.[1];
  return {
    tick,
    price: sqrtPriceX96 ? sqrtPriceX96ToPrice(sqrtPriceX96) : undefined,
    isLoading,
    error,
    updatedAt: dataUpdatedAt,
  };
}
