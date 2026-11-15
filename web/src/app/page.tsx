import { PoolStatus } from "@/components/PoolStatus";

/** Phase 1 placeholder. The real dashboard (create rule, my rules, live feed) lands in Phase 4. */
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">Reactive Omni · Uniswap v4</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Tripwire</h1>
      <p className="mt-3 text-neutral-600 dark:text-neutral-400">
        Set a rule once. When the price crosses, Reactive executes it in about a second. No bots, no servers.
      </p>
      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium text-neutral-500">Demo pool · mWETH / mUSDC · Unichain Sepolia</h2>
        <PoolStatus />
      </section>
    </main>
  );
}
