import { createPublicClient, http, type PublicClient } from "viem";
import { baseSepolia, lasna, unichainSepolia } from "./chains";
import type { ChainKey } from "./deployment";

/** Read-only clients used outside wagmi hooks (feed enrichment, cross-chain lookups). */
export const chainClients: Record<ChainKey, PublicClient> = {
  unichain: createPublicClient({
    chain: unichainSepolia,
    transport: http(process.env.NEXT_PUBLIC_UNICHAIN_RPC ?? "https://sepolia.unichain.org"),
  }) as PublicClient,
  base: createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.NEXT_PUBLIC_BASE_RPC ?? "https://sepolia.base.org"),
  }) as PublicClient,
};

export const lasnaClient = createPublicClient({
  chain: lasna,
  transport: http(process.env.NEXT_PUBLIC_LASNA_RPC ?? "https://lasna-rpc.rnk.dev/", { timeout: 4_000, retryCount: 1 }),
});
