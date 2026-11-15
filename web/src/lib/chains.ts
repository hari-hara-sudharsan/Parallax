import { defineChain } from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";

/**
 * Reactive Lasna testnet.
 * Source: Reactive docs, "Reactive Mainnet / Lasna Testnet" (see deployments/addresses.md).
 */
export const lasna = defineChain({
  id: 5318007,
  name: "Reactive Lasna",
  nativeCurrency: { name: "Lasna REACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } },
  blockExplorers: { default: { name: "Reactscan", url: "https://lasna.reactscan.net" } },
  testnet: true,
});

export { unichainSepolia, baseSepolia };

/** Explorer link helpers (URLs from the Reactive testnet chain table). */
export const explorer = {
  unichainTx: (hash: string) => `https://sepolia.uniscan.xyz/tx/${hash}`,
  unichainAddress: (addr: string) => `https://sepolia.uniscan.xyz/address/${addr}`,
  baseTx: (hash: string) => `https://sepolia.basescan.org/tx/${hash}`,
  lasnaTx: (hash: string) => `https://lasna.reactscan.net/tx/${hash}`,
  lasnaAddress: (addr: string) => `https://lasna.reactscan.net/address/${addr}`,
};
