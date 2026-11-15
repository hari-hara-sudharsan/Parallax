"use client";

import { useReadContract } from "wagmi";
import { stateViewAbi } from "@/lib/abis";
import { DEPLOYMENT, UNICHAIN } from "@/lib/deployment";
import { sqrtPriceX96ToPrice } from "@/lib/price";
import { unichainSepolia } from "@/lib/chains";

/** Live demo-pool state, refreshed every 2 s (Unichain makes a block every ~1 s). */
export function usePool() {
  const { data, isLoading, error, dataUpdatedAt } = useReadContract({
    address: UNICHAIN.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [DEPLOYMENT.poolId],
    chainId: unichainSepolia.id,
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
