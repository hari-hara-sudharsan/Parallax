import type { Address, Hex } from "viem";

/**
 * The live testnet deployment (see deployments/addresses.md for sources + tx hashes).
 * Every value can be overridden with a NEXT_PUBLIC_* env var for a fresh deployment.
 */
const env = (k: string) => process.env[k] as string | undefined;

export const DEPLOYMENT = {
  // Tripwire v2
  executor: (env("NEXT_PUBLIC_TRIPWIRE_EXECUTOR") ?? "0x87Ce29239B4F63a2C00DDa8F6e058ACDeB9181af") as Address,
  reactive: (env("NEXT_PUBLIC_TRIPWIRE_REACTIVE") ?? "0xC3C04592057E816EB706eF0E9A9438267537B2A2") as Address,
  executorDeployBlock: BigInt(env("NEXT_PUBLIC_EXECUTOR_DEPLOY_BLOCK") ?? "67867605"),

  // Demo pool (mUSDC/mWETH 0.30%, no hooks)
  mockWETH: (env("NEXT_PUBLIC_MOCK_WETH") ?? "0x6D489Fa6F5c837B79A7FF8Dcc2B488CbD14309A5") as Address,
  mockUSDC: (env("NEXT_PUBLIC_MOCK_USDC") ?? "0x0bE64D69008Afbef624B2ea7A5062a53E844Dc6c") as Address,
  poolId: (env("NEXT_PUBLIC_POOL_ID") ?? "0xade8c1a33dc66fd63e7f08b4af96a01c31ab4c5346a374a5d82d4d3a6f89763c") as Hex,
  fee: 3000,
  tickSpacing: 60,
} as const;

/** Official Unichain Sepolia addresses (Uniswap v4 docs + Reactive testnet chain table). */
export const UNICHAIN = {
  poolManager: "0x00b036b58a818b1bc34d502d3fe730db729e62ac",
  positionManager: "0xf969aee60879c54baaed9f3ed26147db216fd664",
  stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222",
  poolSwapTest: "0x9140a78c1a137c7ff1c151ec8231272af78a99a4",
  callbackProxy: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
} as const satisfies Record<string, Address>;

export const WETH_DECIMALS = 18;
export const USDC_DECIMALS = 6;

/** v4 sorts currencies by address: currency0 < currency1. */
export const WETH_IS_CURRENCY0 = DEPLOYMENT.mockWETH.toLowerCase() < DEPLOYMENT.mockUSDC.toLowerCase();

export const POOL_KEY = {
  currency0: WETH_IS_CURRENCY0 ? DEPLOYMENT.mockWETH : DEPLOYMENT.mockUSDC,
  currency1: WETH_IS_CURRENCY0 ? DEPLOYMENT.mockUSDC : DEPLOYMENT.mockWETH,
  fee: DEPLOYMENT.fee,
  tickSpacing: DEPLOYMENT.tickSpacing,
  hooks: "0x0000000000000000000000000000000000000000" as Address,
} as const;

/** "No bound on this side" (mirrors NO_LOWER / NO_UPPER in RuleTypes.sol). */
export const NO_LOWER = -(2 ** 23);
export const NO_UPPER = 2 ** 23 - 1;

/** Explorer + API endpoints (from the Reactive testnet chain table / Unichain docs). */
export const LINKS = {
  unichainTx: (h: string) => `https://sepolia.uniscan.xyz/tx/${h}`,
  unichainAddress: (a: string) => `https://sepolia.uniscan.xyz/address/${a}`,
  lasnaTx: (h: string) => `https://lasna.reactscan.net/tx/${h}`,
  lasnaAddress: (a: string) => `https://lasna.reactscan.net/address/${a}`,
  blockscoutApi: "https://unichain-sepolia.blockscout.com/api",
  repo: "https://github.com/hari-hara-sudharsan/TripWire",
};
