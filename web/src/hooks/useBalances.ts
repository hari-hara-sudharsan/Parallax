"use client";

import { formatUnits, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { mockErc20Abi } from "@/lib/abis";
import { DEPLOYMENT, USDC_DECIMALS, WETH_DECIMALS } from "@/lib/deployment";
import { unichainSepolia } from "@/lib/chains";

/** The user's mWETH / mUSDC balances (demo tokens). */
export function useBalances(user?: Address) {
  const { data, refetch } = useReadContracts({
    allowFailure: false,
    query: { enabled: Boolean(user), refetchInterval: 4_000 },
    contracts: [
      { address: DEPLOYMENT.mockWETH, abi: mockErc20Abi, functionName: "balanceOf", args: [user!], chainId: unichainSepolia.id },
      { address: DEPLOYMENT.mockUSDC, abi: mockErc20Abi, functionName: "balanceOf", args: [user!], chainId: unichainSepolia.id },
    ],
  });
  return {
    weth: data ? Number(formatUnits(data[0], WETH_DECIMALS)) : undefined,
    usdc: data ? Number(formatUnits(data[1], USDC_DECIMALS)) : undefined,
    wethRaw: data?.[0],
    usdcRaw: data?.[1],
    refetch,
  };
}
