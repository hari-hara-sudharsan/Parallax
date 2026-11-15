"use client";

import { formatUnits } from "viem";
import { useActivity, type FeedItem } from "@/hooks/useActivity";
import { CHAINS, LINKS, USDC_DECIMALS, WETH_DECIMALS, WETH_IS_CURRENCY0 } from "@/lib/deployment";
import { fmtToken } from "@/lib/price";
import { Chip, Panel, TxLink, cx } from "./ui";

/**
 * The hero of the demo: every execution followed across chains.
 *   ① Origin swap (Base / Unichain) → ② Reactive tx (Lasna) → ③ Callback (same chain)
 * Latency comes from the executor's on-chain record: executedBlock − originBlock.
 */
export function LiveFeed() {
  const { data, isLoading } = useActivity();

  return (
    <Panel
      title="Live activity · both chains"
      aside={
        <span className="flex items-center gap-1.5 text-[11px] text-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-executed" /> reading Base, Unichain + Lasna
        </span>
      }
    >
      {isLoading ? (
        <p className="py-8 text-center text-sm text-faint">Reading Base, Unichain and Lasna…</p>
      ) : !data?.items.length ? (
        <p className="py-8 text-center text-sm text-faint">No executions yet. Arm a rule, then crash the price.</p>
      ) : (
        <ol className="space-y-3">
          {data.items.map((it) => (
            <Row key={it.key} it={it} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function Row({ it }: { it: FeedItem }) {
  const c = CHAINS[it.chain];
  const done = it.state === "executed";
  return (
    <li className={cx("animate-slide-in rounded-xl border bg-bg p-4", done ? "border-line" : "animate-pulse-ring border-triggered/40")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
              {c.short}
            </span>
            <span className="num text-xs text-faint">rule #{it.ruleId.toString()}</span>
            {done ? <Chip tone="executed">Executed</Chip> : <Chip tone="triggered" pulse>Reactive fired · executing</Chip>}
          </div>

          <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
            <Step n={1} ok label="Origin swap" />
            <span className="flex flex-wrap items-center gap-x-2">
              <TxLink href={c.explorerTx(it.originTx)} hash={it.originTx} />
              <span className="text-faint">{it.originBlock ? `block ${it.originBlock}` : c.short}</span>
            </span>
            <Step n={2} ok={Boolean(it.reactiveTx)} label="Reactive tx" />
            <span className="flex flex-wrap items-center gap-x-2">
              <TxLink href={it.reactiveTx ? LINKS.lasnaTx(it.reactiveTx) : "#"} hash={it.reactiveTx} />
              <span className="text-faint">Lasna</span>
            </span>
            <Step n={3} ok={done} label="Callback" />
            <span className="flex flex-wrap items-center gap-x-2">
              <TxLink href={it.callbackTx ? c.explorerTx(it.callbackTx) : "#"} hash={it.callbackTx} />
              <span className="text-faint">{it.executedBlock ? `block ${it.executedBlock}` : c.short}</span>
            </span>
          </div>

          {done && <p className="mt-3 text-xs text-muted">{outcome(it)}</p>}
        </div>

        <div className="shrink-0 text-right">
          <div className={cx("num text-4xl font-semibold leading-none", done ? "text-executed" : "text-triggered")}>
            {it.latencySeconds !== undefined ? it.latencySeconds.toFixed(1) : "…"}
            <span className="ml-0.5 text-base font-normal text-muted">s</span>
          </div>
          <div className="num mt-1 text-[10px] uppercase tracking-widest text-faint">
            {it.latencyBlocks !== undefined ? `${it.latencyBlocks} blocks` : "in flight"}
          </div>
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
