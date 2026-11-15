"use client";

import { formatUnits } from "viem";
import { useActivity, type FeedItem } from "@/hooks/useActivity";
import { CHAINS, LINKS, USDC_DECIMALS, WETH_DECIMALS, WETH_IS_CURRENCY0 } from "@/lib/deployment";
import { fmtToken } from "@/lib/price";
import { Chip, Disclosure, Panel, TxLink } from "./ui";

/**
 * Activity: every execution across both chains, newest first. Each row shows only what matters (where,
 * status, how fast) and opens to show the three transactions behind it and what the owner received.
 */
export function LiveFeed() {
  const { data, isPending, isPlaceholderData, isError } = useActivity();
  const isLoading = isPending || isPlaceholderData; // placeholder figures carry no rows
  const items = data?.items.slice(0, 4) ?? [];

  return (
    <Panel i={3} title="Activity" aside={<span className="text-[13px] text-faint">Base and Unichain, live</span>}>
      {isLoading ? (
        <ul className="-mx-7 -mb-3">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex h-[60px] items-center gap-4 border-t border-rule px-7 first:border-t-0">
              <span className="h-3.5 w-44 rounded-full bg-raised" />
              <span className="ml-auto h-5 w-12 rounded-full bg-raised" />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <p className="text-[15px] text-muted">Couldn’t read the executors. Trying again.</p>
      ) : !items.length ? (
        <p className="text-[15px] text-muted">Nothing yet. Protect a position, then crash the price.</p>
      ) : (
        <ol className="-mx-7 -mb-3">
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
    <Disclosure
      i={i}
      summary={
        <span className="block">
          <span className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-[15px] text-ink">
              {c.short} <span className="text-muted">· rule {it.ruleId.toString()}</span>
            </span>
            {done ? <Chip tone="executed">Executed</Chip> : <Chip tone="triggered">On its way</Chip>}
            <span className="num w-16 text-right text-[17px] font-semibold text-ink">
              {it.latencySeconds !== undefined ? `${it.latencySeconds.toFixed(1)} s` : "…"}
            </span>
          </span>
          {!done && (
            // In flight: Reactive has fired on Lasna and the execution is on its way back to the origin chain.
            <span className="relative mt-3 block h-[3px] overflow-hidden rounded-full bg-raised" aria-label="Execution in flight">
              <span className="m-travel absolute inset-0" style={{ "--travel": "calc(100% - 48px)" } as React.CSSProperties}>
                <span className="block h-[3px] w-12 rounded-full bg-triggered" />
              </span>
            </span>
          )}
        </span>
      }
    >
      <dl className="grid gap-3 rounded-[14px] bg-raised/60 p-4 text-[14px] sm:grid-cols-3">
        <div>
          <dt className="text-faint">Swap</dt>
          <dd className="mt-0.5">
            <TxLink href={c.explorerTx(it.originTx)} hash={it.originTx} />
          </dd>
        </div>
        <div>
          <dt className="text-faint">Reactive, on Lasna</dt>
          <dd className="mt-0.5">
            <TxLink href={it.reactiveTx ? LINKS.lasnaTx(it.reactiveTx) : "#"} hash={it.reactiveTx} />
          </dd>
        </div>
        <div>
          <dt className="text-faint">Execution</dt>
          <dd className="mt-0.5">
            <TxLink href={it.callbackTx ? c.explorerTx(it.callbackTx) : "#"} hash={it.callbackTx} />
          </dd>
        </div>
        {done && (
          <div className="sm:col-span-3">
            <dt className="text-faint">Result</dt>
            <dd className="mt-0.5 text-ink">
              {outcome(it) || "executed"}
              {it.latencyBlocks !== undefined && <span className="num text-muted"> · {it.latencyBlocks} blocks after the swap</span>}
            </dd>
          </div>
        )}
      </dl>
    </Disclosure>
  );
}

function outcome(it: FeedItem) {
  const weth = WETH_IS_CURRENCY0 ? it.amount0Out : it.amount1Out;
  const usdc = WETH_IS_CURRENCY0 ? it.amount1Out : it.amount0Out;
  const parts: string[] = [];
  if (usdc) parts.push(`${fmtToken(Number(formatUnits(usdc, USDC_DECIMALS)), 2)} mUSDC`);
  if (weth) parts.push(`${fmtToken(Number(formatUnits(weth, WETH_DECIMALS)), 4)} mWETH`);
  return parts.length ? `Paid ${parts.join(" + ")} to the owner` : "";
}
