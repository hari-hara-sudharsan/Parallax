import { createConfig, http, injected } from "wagmi";
import { unichainSepolia } from "./chains";

/** Wallet + RPC config. The app's home chain is Unichain Sepolia (origin + destination). */
export const wagmiConfig = createConfig({
  chains: [unichainSepolia],
  connectors: [injected()],
  transports: {
    [unichainSepolia.id]: http(process.env.NEXT_PUBLIC_UNICHAIN_RPC ?? "https://sepolia.unichain.org"),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
