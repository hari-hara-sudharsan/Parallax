"use client";

import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { useRules, type RuleView } from "@/hooks/useRules";
import { useTxFlow } from "@/hooks/useTxFlow";
import { parallaxExecutorAbi } from "@/lib/abis";
import { LINKS, REACTIVE, WETH_DECIMALS } from "@/lib/deployment";
import { useChain } from "@/hooks/useChain";
import { boundsToPrices, fmtToken, fmtUsd, tickToPrice } from "@/lib/price";
import { Button, Chip, Panel } from "./ui";

const TYPE_LABEL = ["Stop-loss", "Take-profit", "Range guard", "Trailing stop"];

function StatusChip({ r }: { r: RuleView }) {
  if (r.status === 2) return <Chip tone="executed">Executed</Chip>;
  if (r.status === 3) return <Chip tone="cancelled">Cancelled</Chip>;
  if (r.triggered) return <Chip tone="triggered" pulse>Triggered</Chip>;
  return <Chip tone="active">Active</Chip>;
}

function describe(r: RuleView): string {
  if (r.ruleType === 2) {
    // Range guard bounds are [tickLower-1, tickUpper]; show the position's price range.
    const [a, b] = [tickToPrice(r.lowerTick + 1), tickToPrice(r.upperTick)].sort((x, y) => x - y);
    return `LP #${r.positionId} · ${r.recenter ? "re-centre" : "withdraw"} outside $${fmtUsd(a, 0)}–$${fmtUsd(b, 0)}`;
  }
  const { below, above } = boundsToPrices(r.lowerTick, r.upperTick);
  const amt = fmtToken(Number(formatUnits(r.amountIn, WETH_DECIMALS)), 4);
  const when = [below && `≤ $${fmtUsd(below)}`, above && `≥ $${fmtUsd(above)}`].filter(Boolean).join(" or ");
  if (r.ruleType === 3) return `Sell ${amt} mWETH · trails ${r.trailTicks / 100}% · stop now ${when}`;
  return `Sell ${amt} mWETH if price ${when}`;
}

export function MyRules() {
  const { chain } = useChain();
  const { address } = useAccount();
  const { data: rules, isLoading } = useRules(address, chain);
  const flow = useTxFlow();

  const active = rules?.filter((r) => r.status === 1).length ?? 0;

  return (
    <Panel i={4} title="Your rules" aside={rules?.length ? <span className="num text-[12px] text-faint">{active} active of {rules.length}</span> : null}>
      {!address ? (
        <Empty>Connect a wallet to see your rules.</Empty>
      ) : isLoading ? (
        <Empty>Loading…</Empty>
      ) : !rules?.length ? (
        <Empty>No rules yet. Protect a position to add one.</Empty>
      ) : (
        <ul className="-mx-7">
          {rules.map((r, i) => (
            <li key={r.id.toString()} style={{ "--i": i } as React.CSSProperties} className="m-row transition-colors duration-200 hover:bg-raised/40 flex min-h-[64px] items-center gap-3 border-t border-rule px-7 py-3 first:border-t-0">
              <span className="num w-9 shrink-0 text-[12px] text-faint">#{r.id.toString()}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-medium">{TYPE_LABEL[r.ruleType]}</span>
                  <StatusChip r={r} />
                </div>
                <p className="num mt-0.5 truncate text-[13px] text-muted">{describe(r)}</p>
              </div>
              {r.status === 1 && !r.triggered && (
                <Button
                  variant="ghost"
                  className="h-8 px-3 text-[12px]"
                  disabled={flow.busy}
                  onClick={() =>
                    flow.run([
                      {
                        label: "Cancel",
                        request: { address: chain.executor, abi: parallaxExecutorAbi, functionName: "cancelRule", args: [r.id], chainId: chain.chainId },
                      },
                    ])
                  }
                >
                  Cancel
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {flow.state.status === "error" && <p className="mt-3 text-[12px] text-danger">{flow.state.message}</p>}
      <p className="mt-4 text-[12px] text-faint">
        Rules live in{" "}
        <a className="underline decoration-control underline-offset-2 hover:text-muted" href={chain.explorerAddress(chain.executor)} target="_blank" rel="noreferrer">
          ParallaxExecutor
        </a>{" "}
        and are mirrored by{" "}
        <a className="underline decoration-control underline-offset-2 hover:text-muted" href={LINKS.lasnaAddress(REACTIVE.address)} target="_blank" rel="noreferrer">
          ParallaxReactive
        </a>{" "}
        on Reactive Lasna.
      </p>
    </Panel>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[15px] text-muted">{children}</p>;
}
