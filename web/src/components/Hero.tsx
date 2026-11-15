"use client";

import { useEffect, useRef, useState } from "react";
import { useActivity } from "@/hooks/useActivity";
import { useChain } from "@/hooks/useChain";
import { usePool } from "@/hooks/usePool";
import { useRealUsers } from "@/hooks/useRealUsers";
import { CHAINS } from "@/lib/deployment";
import { fmtUsd } from "@/lib/price";
import { cx } from "./ui";

/** Top band: the live price being watched, and the headline numbers, i.e. how fast Parallax reacts. */
export function Hero() {
  const { chain } = useChain();
  const { price, tick } = usePool(chain);
  const { data } = useActivity();
  const { data: users } = useRealUsers();

  // Flash the price green/red on each change.
  const prev = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (price === undefined) return;
    if (prev.current !== undefined && Math.abs(price - prev.current) > 1e-9) {
      setFlash(price > prev.current ? "up" : "down");
      const t = setTimeout(() => setFlash(null), 900);
      prev.current = price;
      return () => clearTimeout(t);
    }
    prev.current = price;
  }, [price]);

  const base = data?.stats.base;
  const uni = data?.stats.unichain;
  const last = data?.last;

  return (
    <section className="relative overflow-hidden border-b border-line">
      <div className="grid-bg pointer-events-none absolute inset-0" />
      <div className="relative mx-auto grid max-w-6xl gap-4 px-4 py-10 md:grid-cols-[1.4fr_1fr] md:py-14">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-faint">Parallax · Reactive Omni × Uniswap v4</p>
          <h1 className="mt-3 max-w-xl text-3xl font-semibold leading-tight tracking-tight md:text-[42px]">
            Stop-losses and LP range guards that fire in about a second.
          </h1>
          <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted">
            A guard that watches your position from a parallel chain. One reactive contract on Lasna protects rules on
            Base and Unichain; the moment a swap crosses your line it calls back and executes. No keeper bots, no server.
          </p>

          <div className="mt-7 inline-flex items-end gap-5 rounded-2xl border border-line bg-panel/80 px-5 py-4 backdrop-blur">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-faint">mWETH / mUSDC · {chain.short}</div>
              <div
                className={cx(
                  "num mt-1 text-3xl font-medium transition-colors duration-700",
                  flash === "up" && "text-executed",
                  flash === "down" && "text-danger",
                )}
              >
                {price !== undefined ? `$${fmtUsd(price)}` : "…"}
              </div>
            </div>
            <div className="pb-1 text-xs text-muted">
              tick <span className="num text-ink">{tick ?? "…"}</span>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted" title="Distinct wallets that created a rule or deposited into the vault, excluding the deployer. Counted from on-chain logs.">
            <span className="num text-ink">{users ? users.wallets : "…"}</span> real wallets have used Parallax
            {users && users.wallets > 0 && (
              <span className="text-faint"> · {users.ruleOwners} with rules, {users.depositors} in the vault</span>
            )}
          </p>
        </div>

        <div className="flex flex-col justify-end">
          <div className="rounded-2xl border border-line bg-panel/80 p-6 backdrop-blur">
            <div className="text-[11px] uppercase tracking-widest text-faint">Median swap → execution · Base</div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="num text-7xl font-semibold tracking-tight text-executed">
                {base?.p50Seconds !== undefined ? base.p50Seconds.toFixed(1) : "–"}
              </span>
              <span className="text-xl text-muted">s</span>
            </div>
            <div className="mt-1 text-xs text-muted">
              <span className="num text-ink">{base?.p50Blocks ?? "–"}</span> blocks of {CHAINS.base.blockMs} ms ·{" "}
              <span className="num text-ink">{base?.n ?? 0}</span> live executions, measured on-chain
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4 text-xs text-muted">
              <Stat label="Fastest" value={base?.minSeconds !== undefined ? `${base.minSeconds.toFixed(1)} s` : "–"} sub="Base" />
              <Stat label="Unichain p50" value={uni?.p50Seconds !== undefined ? `${uni.p50Seconds.toFixed(0)} s` : "–"} sub={`${uni?.n ?? 0} runs · 1 s blocks`} />
              <Stat
                label="Last"
                value={last?.latencySeconds !== undefined ? `${last.latencySeconds.toFixed(1)} s` : "–"}
                sub={last ? CHAINS[last.chain].short : ""}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-faint">{label}</div>
      <div className="num mt-1 text-lg text-ink">{value}</div>
      <div className="text-[11px] text-faint">{sub}</div>
    </div>
  );
}
