"use client";

import { formatUnits, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { mockErc20Abi } from "@/lib/abis";
import { USDC_DECIMALS, WETH_DECIMALS, type ChainDeployment } from "@/lib/deployment";

/** The user's mWETH / mUSDC balances on `chain` (demo tokens). */
export function useBalances(user: Address | undefined, chain: ChainDeployment) {
  const chainId = chain.chainId as 84532 | 1301;
  const { data, refetch } = useReadContracts({
    allowFailure: false,
    query: { enabled: Boolean(user), refetchInterval: 4_000 },
    contracts: [
      { address: chain.mockWETH, abi: mockErc20Abi, functionName: "balanceOf", args: [user!], chainId },
      { address: chain.mockUSDC, abi: mockErc20Abi, functionName: "balanceOf", args: [user!], chainId },
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
