import { createConfig, http, injected } from "wagmi";
import { baseSepolia, unichainSepolia } from "./chains";

/** Wallet + RPC config: Parallax runs on Base Sepolia and Unichain Sepolia (one reactive contract on Lasna). */
export const wagmiConfig = createConfig({
  chains: [baseSepolia, unichainSepolia],
  connectors: [injected()],
  transports: {
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_BASE_RPC ?? "https://sepolia.base.org"),
    [unichainSepolia.id]: http(process.env.NEXT_PUBLIC_UNICHAIN_RPC ?? "https://sepolia.unichain.org"),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
