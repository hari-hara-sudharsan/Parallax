import type { Address, Hex } from "viem";

/**
 * The live testnet deployment (v4.1: multi-chain, trailing stops, re-centring range guards, raise-gas fix). Sources + deploy txs: deployments/addresses.md.
 * One ParallaxReactive on Reactive Lasna guards a ParallaxExecutor on each chain below.
 */

export type ChainKey = "unichain" | "base";
export type SupportedChainId = 1301 | 84532;

export type ChainDeployment = {
  key: ChainKey;
  chainId: SupportedChainId;
  name: string;
  short: string;
  blockMs: number; //        nominal block time
  executor: Address;
  executorDeployBlock: bigint;
  mockWETH: Address;
  mockUSDC: Address;
  poolId: Hex;
  // Official Uniswap v4 + Reactive addresses on this chain
  poolManager: Address;
  positionManager: Address;
  stateView: Address;
  poolSwapTest: Address;
  callbackProxy: Address;
  explorerTx: (h: string) => string;
  explorerAddress: (a: string) => string;
  blockscoutApi: string;
};

const MOCK_WETH = "0x6D489Fa6F5c837B79A7FF8Dcc2B488CbD14309A5" as Address; // same nonce → same address on both chains
const MOCK_USDC = "0x0bE64D69008Afbef624B2ea7A5062a53E844Dc6c" as Address;
const POOL_ID = "0xade8c1a33dc66fd63e7f08b4af96a01c31ab4c5346a374a5d82d4d3a6f89763c" as Hex; // same tokens + key → same id

export const CHAINS: Record<ChainKey, ChainDeployment> = {
  unichain: {
    key: "unichain",
    chainId: 1301,
    name: "Unichain Sepolia",
    short: "Unichain",
    blockMs: 1000,
    executor: "0x5F4159fEF569FbDe44C069751A57e38e97b1109D",
    executorDeployBlock: 67884067n,
    mockWETH: MOCK_WETH,
    mockUSDC: MOCK_USDC,
    poolId: POOL_ID,
    poolManager: "0x00b036b58a818b1bc34d502d3fe730db729e62ac",
    positionManager: "0xf969aee60879c54baaed9f3ed26147db216fd664",
    stateView: "0xc199f1072a74d4e905aba1a84d9a45e2546b6222",
    poolSwapTest: "0x9140a78c1a137c7ff1c151ec8231272af78a99a4",
    callbackProxy: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
    explorerTx: (h) => `https://sepolia.uniscan.xyz/tx/${h}`,
    explorerAddress: (a) => `https://sepolia.uniscan.xyz/address/${a}`,
    blockscoutApi: "https://unichain-sepolia.blockscout.com/api",
  },
  base: {
    key: "base",
    chainId: 84532,
    name: "Base Sepolia",
    short: "Base",
    blockMs: 200,
    executor: "0x2f772766ec926359093FA2d478FBDdcd828304Ff",
    executorDeployBlock: 59073292n,
    mockWETH: MOCK_WETH,
    mockUSDC: MOCK_USDC,
    poolId: POOL_ID,
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    positionManager: "0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80",
    stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4",
    poolSwapTest: "0x8b5bcc363dde2614281ad875bad385e0a785d3b9",
    callbackProxy: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
    explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}`,
    explorerAddress: (a) => `https://sepolia.basescan.org/address/${a}`,
    blockscoutApi: "https://base-sepolia.blockscout.com/api",
  },
};

export const CHAIN_LIST = [CHAINS.base, CHAINS.unichain];
export const chainById = (id: number) => CHAIN_LIST.find((c) => c.chainId === id);

export const REACTIVE = {
  address: "0xDf554201dec784F0541FA5fc884240c73113e334" as Address,
  deployBlock: 8399503n, // Lasna nodes prune old blocks: searches start here, never at block 1
  systemContract: "0x8888888888888888888888888888888888888888" as Address,
};

/**
 * Parallax Vault v2 (keeperless managed LP) on the Base demo pool. Its brain runs on Lasna.
 * v1 (retired, quiet-pool bug) is listed for the real-user count only. Sources: deployments/addresses.md.
 */
export const VAULT = {
  chain: "base" as ChainKey,
  address: "0x94Bdad7429FAF003f2aDda78B04aB901A5f10C8F" as Address,
  deployBlock: 59098404n,
  brain: "0x4dDaD9D71Bd31bF69E6c12ab103123870BBC3A24" as Address,
  brainDeployBlock: 8404251n,
  halfWidthTicks: 300,
  breakerTicks: 200,
  windowSeconds: 60,
  calmSeconds: 60,
};

/** The deployer wallet runs the scripted demo; it is excluded from the real-user count. */
export const DEPLOYER = "0xACf40822E48ddb5f5220d37beb7d6830dD2DEEb3" as Address;

export const WETH_DECIMALS = 18;
export const USDC_DECIMALS = 6;

/** v4 sorts currencies by address: currency0 < currency1. (Identical on both chains here.) */
export const wethIsCurrency0 = (c: ChainDeployment) => c.mockWETH.toLowerCase() < c.mockUSDC.toLowerCase();

/** Same token addresses on both chains ⇒ same order, so price↔tick math is chain-agnostic. */
export const WETH_IS_CURRENCY0 = wethIsCurrency0(CHAINS.base);

export const poolKeyOf = (c: ChainDeployment) => {
  const w0 = wethIsCurrency0(c);
  return {
    currency0: w0 ? c.mockWETH : c.mockUSDC,
    currency1: w0 ? c.mockUSDC : c.mockWETH,
    fee: 3000,
    tickSpacing: 60,
    hooks: "0x0000000000000000000000000000000000000000" as Address,
  } as const;
};

/** "No bound on this side" (mirrors NO_LOWER / NO_UPPER in RuleTypes.sol). */
export const NO_LOWER = -(2 ** 23);
export const NO_UPPER = 2 ** 23 - 1;

export const LINKS = {
  lasnaTx: (h: string) => `https://lasna.reactscan.net/tx/${h}`,
  lasnaAddress: (a: string) => `https://lasna.reactscan.net/address/${a}`,
  repo: "https://github.com/hari-hara-sudharsan/Parallax",
};
