/** ABIs used by the app. Tripwire + mocks are generated from the Foundry build (see ./generated). */
export { tripwireExecutorAbi, tripwireReactiveAbi, poolSwapTestAbi, mockErc20Abi } from "./generated/abis";

/** Uniswap v4 StateView (lens over PoolManager storage). */
export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

/** Uniswap v4 PositionManager: only what the range-guard flow needs (ERC-721 + position reads). */
export const positionManagerAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getApproved",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "payable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getPositionLiquidity",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
  {
    type: "function",
    name: "positionInfo",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "info", type: "uint256" }],
  },
] as const;
