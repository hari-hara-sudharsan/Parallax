"use client";

import { formatUnits } from "viem";
import { useActivity, type FeedItem } from "@/hooks/useActivity";
import { CHAINS, LINKS, USDC_DECIMALS, WETH_DECIMALS, WETH_IS_CURRENCY0 } from "@/lib/deployment";
import { fmtToken } from "@/lib/price";
import { Chip, Panel, TxLink } from "./ui";

/**
 * The hero of the demo: every execution followed across chains.
 *   ① Origin swap (Base / Unichain) → ② Reactive tx (Lasna) → ③ Callback (same chain)
 * Latency comes from the executor's on-chain record: executedBlock − originBlock.
 */
export function LiveFeed() {
  const { data, isPending, isPlaceholderData, isError } = useActivity();
  const isLoading = isPending || isPlaceholderData; // placeholder figures carry no rows
  const items = data?.items.slice(0, 6) ?? [];

  return (
    <Panel
      title="Live activity"
      aside={
        <span className="flex items-center gap-2 text-[12px] text-faint">
          Base, Unichain and Lasna, read every 2.5 s
        </span>
      }
    >
      {isLoading ? (
        <ul className="-mx-6">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex h-[64px] items-center gap-4 border-t border-rule px-6 first:border-t-0">
              <span className="h-3 w-40 rounded-sm bg-raised" />
              <span className="ml-auto h-5 w-14 rounded-sm bg-raised" />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <p className="text-[13px] text-muted">Couldn’t read the executors. Retrying.</p>
      ) : !items.length ? (
        <p className="text-[13px] text-muted">No executions yet. Arm a rule, then crash the price.</p>
      ) : (
        <ol className="-mx-6">
          {items.map((it, i) => (
            <Row key={it.key} it={it} i={i} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function Row({ it, i }: { it: FeedItem; i: number }) {
  const c = CHAINS[it.chain];
  const done = it.state === "executed";
  return (
    <li
      className="m-row grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-t border-rule px-6 py-3 transition-colors duration-200 first:border-t-0 hover:bg-raised/40"
      style={{ "--i": i } as React.CSSProperties}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13px] text-ink">
          {c.short} <span className="num text-muted">rule #{it.ruleId.toString()}</span>
        </span>
        {done ? <Chip tone="executed">Executed</Chip> : <Chip tone="triggered" pulse>Reactive fired, executing</Chip>}
      </div>
      <div className="row-span-2 text-right">
        <div className="num text-[20px] leading-7 text-ink">
          {it.latencySeconds !== undefined ? `${it.latencySeconds.toFixed(1)} s` : "…"}
        </div>
        <div className="num text-[12px] text-faint">{it.latencyBlocks !== undefined ? `${it.latencyBlocks} blocks` : "in flight"}</div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-faint">
        <span>
          ① <TxLink href={c.explorerTx(it.originTx)} hash={it.originTx} />
        </span>
        <span>
          ② <TxLink href={it.reactiveTx ? LINKS.lasnaTx(it.reactiveTx) : "#"} hash={it.reactiveTx} />
        </span>
        <span>
          ③ <TxLink href={it.callbackTx ? c.explorerTx(it.callbackTx) : "#"} hash={it.callbackTx} />
        </span>
        {done && <span className="text-muted">{outcome(it)}</span>}
      </div>
      {!done && (
        // In flight: Reactive has fired on Lasna and the callback is on its way back to the origin chain.
        <div className="relative col-span-2 mt-1 h-[2px] overflow-hidden rounded-full bg-raised" aria-label="Callback in flight">
          <span className="m-travel absolute inset-0" style={{ "--travel": "calc(100% - 40px)" } as React.CSSProperties}>
            <span className="block h-[2px] w-10 rounded-full bg-triggered" />
          </span>
        </div>
      )}
    </li>
  );
}

function outcome(it: FeedItem) {
  const weth = WETH_IS_CURRENCY0 ? it.amount0Out : it.amount1Out;
  const usdc = WETH_IS_CURRENCY0 ? it.amount1Out : it.amount0Out;
  const parts: string[] = [];
  if (usdc) parts.push(`${fmtToken(Number(formatUnits(usdc, USDC_DECIMALS)), 2)} mUSDC`);
  if (weth) parts.push(`${fmtToken(Number(formatUnits(weth, WETH_DECIMALS)), 4)} mWETH`);
  return parts.length ? `paid out ${parts.join(" + ")}` : "";
}
