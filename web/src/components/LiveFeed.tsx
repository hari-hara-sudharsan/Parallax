"use client";

import { formatUnits } from "viem";
import { useActivity, type FeedItem } from "@/hooks/useActivity";
import { LINKS, USDC_DECIMALS, WETH_DECIMALS, WETH_IS_CURRENCY0 } from "@/lib/deployment";
import { fmtToken } from "@/lib/price";
import { Chip, Panel, TxLink, cx } from "./ui";

/**
 * The hero of the demo: every execution followed across both chains.
 *   ① Origin swap (Unichain, T0) → ② Reactive tx (Lasna) → ③ Callback (Unichain, T1), latency = T1 − T0
 */
export function LiveFeed() {
  const { data, isLoading } = useActivity();

  return (
    <Panel
      title="Live activity"
      aside={
        <span className="flex items-center gap-1.5 text-[11px] text-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-executed" /> polling both chains
        </span>
      }
    >
      {isLoading ? (
        <p className="py-8 text-center text-sm text-faint">Reading Unichain + Lasna…</p>
      ) : !data?.length ? (
        <p className="py-8 text-center text-sm text-faint">No executions yet. Arm a rule, then crash the price.</p>
      ) : (
        <ol className="space-y-3">
          {data.map((it) => (
            <Row key={it.key} it={it} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function Row({ it }: { it: FeedItem }) {
  const done = it.state === "executed";
  const latency = it.t0 !== undefined && it.t1 !== undefined ? it.t1 - it.t0 : undefined;
  return (
    <li
      className={cx(
        "animate-slide-in rounded-xl border bg-bg p-4",
        done ? "border-line" : "border-triggered/40 animate-pulse-ring",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="num text-xs text-faint">rule #{it.ruleId.toString()}</span>
            {done ? <Chip tone="executed">Executed</Chip> : <Chip tone="triggered" pulse>Reactive fired · executing</Chip>}
          </div>

          <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
            <Step n={1} ok label="Origin swap" />
            <span className="flex flex-wrap items-center gap-x-2">
              <TxLink href={LINKS.unichainTx(it.originTx)} hash={it.originTx} />
              <span className="text-faint">Unichain{it.t0 ? ` · ${clock(it.t0)}` : ""}</span>
            </span>
            <Step n={2} ok={Boolean(it.reactiveTx)} label="Reactive tx" />
            <span className="flex flex-wrap items-center gap-x-2">
              <TxLink href={it.reactiveTx ? LINKS.lasnaTx(it.reactiveTx) : "#"} hash={it.reactiveTx} />
              <span className="text-faint">Lasna</span>
            </span>
            <Step n={3} ok={done} label="Callback" />
            <span className="flex flex-wrap items-center gap-x-2">
              <TxLink href={it.callbackTx ? LINKS.unichainTx(it.callbackTx) : "#"} hash={it.callbackTx} />
              <span className="text-faint">Unichain{it.t1 ? ` · ${clock(it.t1)}` : ""}</span>
            </span>
          </div>

          {done && <p className="mt-3 text-xs text-muted">{outcome(it)}</p>}
        </div>

        <div className="shrink-0 text-right">
          <div className={cx("num text-4xl font-semibold leading-none", done ? "text-executed" : "text-triggered")}>
            {latency !== undefined ? latency : "…"}
            <span className="ml-0.5 text-base font-normal text-muted">s</span>
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-widest text-faint">T1 − T0</div>
        </div>
      </div>
    </li>
  );
}

function Step({ n, ok, label }: { n: number; ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-2 text-muted">
      <span
        className={cx(
          "num flex h-4 w-4 items-center justify-center rounded-full text-[9px] ring-1",
          ok ? "bg-executed/15 text-executed ring-executed/40" : "bg-raised text-faint ring-line",
        )}
      >
        {n}
      </span>
      {label}
    </span>
  );
}

function outcome(it: FeedItem) {
  const weth = WETH_IS_CURRENCY0 ? it.amount0Out : it.amount1Out;
  const usdc = WETH_IS_CURRENCY0 ? it.amount1Out : it.amount0Out;
  const parts: string[] = [];
  if (usdc) parts.push(`${fmtToken(Number(formatUnits(usdc, USDC_DECIMALS)), 2)} mUSDC`);
  if (weth) parts.push(`${fmtToken(Number(formatUnits(weth, WETH_DECIMALS)), 4)} mWETH`);
  return parts.length ? `Sent to owner: ${parts.join(" + ")}` : "Executed";
}

const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
