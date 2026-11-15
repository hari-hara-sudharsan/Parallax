"use client";

import { useEffect, useRef, useState } from "react";
import { usePool } from "@/hooks/usePool";
import { useActivity } from "@/hooks/useActivity";
import { fmtUsd } from "@/lib/price";
import { cx } from "./ui";

/** Top band: the live price being watched, and the headline number, i.e. how fast Tripwire reacted. */
export function Hero() {
  const { price, tick } = usePool();
  const { data: feed } = useActivity();

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

  const executed = (feed ?? []).filter((f) => f.state === "executed" && f.t0 && f.t1);
  const last = executed[0];
  const lastLatency = last ? last.t1! - last.t0! : undefined;
  const avg = executed.length ? executed.reduce((s, f) => s + (f.t1! - f.t0!), 0) / executed.length : undefined;

  return (
    <section className="relative overflow-hidden border-b border-line">
      <div className="grid-bg pointer-events-none absolute inset-0" />
      <div className="relative mx-auto grid max-w-6xl gap-4 px-4 py-10 md:grid-cols-[1.4fr_1fr] md:py-14">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-faint">Reactive Omni · Uniswap v4</p>
          <h1 className="mt-3 max-w-xl text-3xl font-semibold leading-tight tracking-tight md:text-[42px]">
            Stop-losses and LP range guards that fire in about a second.
          </h1>
          <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted">
            Set a rule once. A reactive contract watches every swap and the moment the price crosses your line it
            calls back and executes. No keeper bots, no server.
          </p>

          <div className="mt-7 inline-flex items-end gap-5 rounded-2xl border border-line bg-panel/80 px-5 py-4 backdrop-blur">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-faint">mWETH / mUSDC</div>
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
        </div>

        <div className="flex flex-col justify-end">
          <div className="rounded-2xl border border-line bg-panel/80 p-6 backdrop-blur">
            <div className="text-[11px] uppercase tracking-widest text-faint">Last trigger → execution</div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="num text-7xl font-semibold tracking-tight text-executed">
                {lastLatency !== undefined ? lastLatency : "–"}
              </span>
              <span className="text-xl text-muted">s</span>
            </div>
            <div className="mt-3 flex gap-6 text-xs text-muted">
              <span>
                avg <span className="num text-ink">{avg !== undefined ? avg.toFixed(1) : "–"} s</span>
              </span>
              <span>
                executions <span className="num text-ink">{executed.length}</span>
              </span>
              <span>
                legacy blocks <span className="num text-ink">~7 s</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
