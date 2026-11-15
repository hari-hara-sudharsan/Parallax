import type { Address, Hex } from "viem";

/**
 * Official contract addresses. Every value is sourced in deployments/addresses.md.
 * Our own deployments (tokens, pool, Tripwire contracts) come from env vars that the
 * deploy scripts write into contracts/deployments/1301.json → copy them to web/.env.local.
 */
export const UNICHAIN = {
  poolManager: "0x00b036b58a818b1bc34d502d3fe730db729e62ac",
  positionManager: "0xf969aee60879c54baaed9f3ed26147db216fd664",
  stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222",
  poolSwapTest: "0x9140a78c1a137c7ff1c151ec8231272af78a99a4",
  callbackProxy: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
} as const satisfies Record<string, Address>;

export const REACTIVE = {
  systemContract: "0x8888888888888888888888888888888888888888",
} as const satisfies Record<string, Address>;

export const DEMO = {
  mockWETH: process.env.NEXT_PUBLIC_MOCK_WETH as Address | undefined,
  mockUSDC: process.env.NEXT_PUBLIC_MOCK_USDC as Address | undefined,
  poolId: process.env.NEXT_PUBLIC_POOL_ID as Hex | undefined,
  executor: process.env.NEXT_PUBLIC_TRIPWIRE_EXECUTOR as Address | undefined,
  reactive: process.env.NEXT_PUBLIC_TRIPWIRE_REACTIVE as Address | undefined,
};
