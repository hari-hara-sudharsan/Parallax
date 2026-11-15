import { createPublicClient, http } from "viem";
import { lasna, unichainSepolia } from "./chains";

/** Read-only clients used outside wagmi hooks (feed enrichment, cross-chain lookups). */
export const unichainClient = createPublicClient({
  chain: unichainSepolia,
  transport: http(process.env.NEXT_PUBLIC_UNICHAIN_RPC ?? "https://sepolia.unichain.org"),
});

export const lasnaClient = createPublicClient({
  chain: lasna,
  transport: http(process.env.NEXT_PUBLIC_LASNA_RPC ?? "https://lasna-rpc.rnk.dev/"),
});
