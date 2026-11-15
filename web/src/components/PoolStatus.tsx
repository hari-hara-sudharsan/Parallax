"use client";

import { useReadContract } from "wagmi";
import { DEMO, UNICHAIN } from "@/lib/addresses";
import { stateViewAbi } from "@/lib/abis";

/**
 * Phase 1 smoke test for the web stack: reads the demo pool's live tick from Unichain Sepolia.
 * Becomes the price header of the dashboard in Phase 4.
 */
export function PoolStatus() {
  const poolId = DEMO.poolId;
  const { data, isLoading, error } = useReadContract({
    address: UNICHAIN.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: poolId ? [poolId] : undefined,
    query: { enabled: Boolean(poolId), refetchInterval: 2_000 },
  });

  if (!poolId) {
    return (
      <p className="text-sm text-neutral-500">
        Set <code className="font-mono">NEXT_PUBLIC_POOL_ID</code> in <code className="font-mono">web/.env.local</code>{" "}
        after running <code className="font-mono">./tw.sh demo-pool</code>.
      </p>
    );
  }
  if (isLoading) return <p className="text-sm text-neutral-500">Reading pool…</p>;
  if (error) return <p className="text-sm text-red-600">Could not read pool: {error.message.split("\n")[0]}</p>;

  const [sqrtPriceX96, tick] = data!;
  const initialized = sqrtPriceX96 !== 0n;

  return (
    <dl className="grid grid-cols-2 gap-4">
      <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <dt className="text-xs uppercase tracking-wide text-neutral-500">Pool tick</dt>
        <dd className="mt-1 font-mono text-2xl tabular-nums">{initialized ? tick : "—"}</dd>
      </div>
      <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <dt className="text-xs uppercase tracking-wide text-neutral-500">Status</dt>
        <dd className="mt-1 text-2xl">{initialized ? "Live" : "Not initialized"}</dd>
      </div>
    </dl>
  );
}
