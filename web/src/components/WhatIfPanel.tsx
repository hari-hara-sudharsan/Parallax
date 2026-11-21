"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "wagmi";
import { useChain } from "@/hooks/useChain";
import { usePool } from "@/hooks/usePool";
import { parallaxExecutorAbi } from "@/lib/abis";
import { chainClients } from "@/lib/clients";
import { boundsToPrices, fmtUsd, priceToTick } from "@/lib/price";
import { Chip, Panel, Segmented } from "./ui";

const TYPES = ["Stop-loss", "Take-profit", "Range guard", "Trailing stop"];
const SCAN = 300n; // newest rule ids read per refresh: keeps the multicall small

type Active = { id: bigint; owner: string; ruleType: number; lower: number; upper: number };

/**
 * What if the price moved here? Drag a price and see which armed rules Reactive would fire, using the executor's own
 * trigger test (tick <= lowerTick || tick >= upperTick) on the rules read live from chain. Nothing is sent.
 */
export function WhatIfPanel() {
  const { chain } = useChain();
  const { address } = useAccount();
  const pool = usePool(chain);
  const [move, setMove] = useState(0); // % from the current price
  const [scope, setScope] = useState<"All rules" | "Mine">("All rules");

  const { data: rules } = useQuery({
    queryKey: ["whatif", chain.key, chain.executor],
    refetchInterval: 10_000,
    queryFn: async (): Promise<Active[]> => {
      const client = chainClients[chain.key];
      const next = await client.readContract({ address: chain.executor, abi: parallaxExecutorAbi, functionName: "nextRuleId" });
      const from = next > SCAN ? next - SCAN : 1n;
      const ids = Array.from({ length: Number(next - from) }, (_, i) => from + BigInt(i));
      if (!ids.length) return [];
      const got = await client.multicall({
        allowFailure: true,
        contracts: ids.map((id) => ({ address: chain.executor, abi: parallaxExecutorAbi, functionName: "getRule" as const, args: [id] as const })),
      });
      return got.flatMap((g, i) =>
        g.status === "success" && g.result.status === 1
          ? [{ id: ids[i], owner: g.result.owner, ruleType: g.result.ruleType, lower: g.result.lowerTick, upper: g.result.upperTick }]
          : [],
      );
    },
  });

  const price = pool.price ? pool.price * (1 + move / 100) : undefined;
  const tick = price ? priceToTick(price) : undefined;
  const shown = (rules ?? []).filter((r) => scope === "All rules" || r.owner.toLowerCase() === address?.toLowerCase());
  const fires = (r: Active) => tick !== undefined && (tick <= r.lower || tick >= r.upper);
  const firing = shown.filter(fires);

  return (
    <Panel
      i={6}
      title="What if the price moved?"
      aside={<Segmented label="Rules" options={["All rules", "Mine"] as const} value={scope} onChange={setScope} />}
    >
      <p className="text-[14px] text-muted">
        Drag the price. Each armed rule is checked with the executor’s own trigger test, on rules read live from {chain.short}. Nothing is sent.
      </p>
      <div className="mt-5 flex items-baseline justify-between">
        <span className="num text-[28px] font-semibold tracking-[-0.02em]">{price ? `$${fmtUsd(price)}` : "…"}</span>
        <span className={move < 0 ? "num text-danger" : move > 0 ? "num text-executed" : "num text-faint"}>
          {move > 0 ? "+" : ""}
          {move}% from now
        </span>
      </div>
      <input
        type="range"
        min={-30}
        max={30}
        step={1}
        value={move}
        onChange={(e) => setMove(Number(e.target.value))}
        aria-label="Price move from the current pool price, in percent"
        className="mt-3 w-full accent-[rgb(var(--active))]"
      />
      <div className="num mt-1 flex justify-between text-[11px] text-faint">
        <span>−30%</span>
        <span>now</span>
        <span>+30%</span>
      </div>

      <div className="mt-5 text-[14px]">
        {rules === undefined ? (
          <span className="text-faint">Reading armed rules…</span>
        ) : shown.length === 0 ? (
          <span className="text-faint">{scope === "Mine" ? (address ? "You have no armed rules here." : "Connect a wallet to see your rules.") : "No armed rules on this chain right now."}</span>
        ) : (
          <>
            <span className="text-ink">
              <span className="num font-semibold">{firing.length}</span> of <span className="num">{shown.length}</span> armed rules would fire
            </span>
            <ul className="mt-3 grid max-h-[220px] gap-1.5 overflow-y-auto pr-1">
              {shown.slice(0, 40).map((r) => {
                const at = boundsToPrices(r.lower, r.upper);
                const line = [at.below && `≤ $${fmtUsd(at.below, 0)}`, at.above && `≥ $${fmtUsd(at.above, 0)}`].filter(Boolean).join(" or ");
                return (
                  <li key={r.id.toString()} className="flex items-center justify-between gap-3 rounded-[10px] bg-raised/40 px-3 py-1.5 text-[13px]">
                    <span className="min-w-0 truncate">
                      <span className="num text-faint">#{r.id.toString()}</span> {TYPES[r.ruleType] ?? "Rule"} <span className="text-faint">{line}</span>
                    </span>
                    <Chip tone={fires(r) ? "triggered" : "active"}>{fires(r) ? "fires" : "holds"}</Chip>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Panel>
  );
}
