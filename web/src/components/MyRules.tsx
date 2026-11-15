"use client";

import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { useRules, type RuleView } from "@/hooks/useRules";
import { useTxFlow } from "@/hooks/useTxFlow";
import { parallaxExecutorAbi } from "@/lib/abis";
import { DEPLOYMENT, LINKS, WETH_DECIMALS } from "@/lib/deployment";
import { boundsToPrices, fmtToken, fmtUsd, tickToPrice } from "@/lib/price";
import { unichainSepolia } from "@/lib/chains";
import { Button, Chip, Panel } from "./ui";

const TYPE_LABEL = ["Stop-loss", "Take-profit", "Range guard"];

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
    return `LP #${r.positionId} · withdraw outside $${fmtUsd(a, 0)}–$${fmtUsd(b, 0)}`;
  }
  const { below, above } = boundsToPrices(r.lowerTick, r.upperTick);
  const amt = fmtToken(Number(formatUnits(r.amountIn, WETH_DECIMALS)), 4);
  const when = [below && `≤ $${fmtUsd(below)}`, above && `≥ $${fmtUsd(above)}`].filter(Boolean).join(" or ");
  return `Sell ${amt} mWETH if price ${when}`;
}

export function MyRules() {
  const { address } = useAccount();
  const { data: rules, isLoading } = useRules(address);
  const flow = useTxFlow();

  const active = rules?.filter((r) => r.status === 1).length ?? 0;

  return (
    <Panel title="My rules" aside={rules?.length ? <span className="num text-xs text-faint">{active} active / {rules.length}</span> : null}>
      {!address ? (
        <Empty>Connect a wallet to see your rules.</Empty>
      ) : isLoading ? (
        <Empty>Loading…</Empty>
      ) : !rules?.length ? (
        <Empty>No rules yet. Arm one on the left.</Empty>
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {rules.map((r) => (
            <li key={r.id.toString()} className="flex items-center gap-3 py-3">
              <span className="num w-8 shrink-0 text-xs text-faint">#{r.id.toString()}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{TYPE_LABEL[r.ruleType]}</span>
                  <StatusChip r={r} />
                </div>
                <p className="num mt-0.5 truncate text-xs text-muted">{describe(r)}</p>
              </div>
              {r.status === 1 && !r.triggered && (
                <Button
                  variant="ghost"
                  className="h-8 px-3 text-xs"
                  disabled={flow.busy}
                  onClick={() =>
                    flow.run([
                      {
                        label: "Cancel",
                        request: { address: DEPLOYMENT.executor, abi: parallaxExecutorAbi, functionName: "cancelRule", args: [r.id], chainId: unichainSepolia.id },
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
      {flow.state.status === "error" && <p className="mt-3 text-xs text-danger">{flow.state.message}</p>}
      <p className="mt-4 text-[11px] text-faint">
        Rules live in{" "}
        <a className="underline decoration-line underline-offset-2 hover:text-muted" href={LINKS.unichainAddress(DEPLOYMENT.executor)} target="_blank" rel="noreferrer">
          ParallaxExecutor
        </a>{" "}
        and are mirrored by{" "}
        <a className="underline decoration-line underline-offset-2 hover:text-muted" href={LINKS.lasnaAddress(DEPLOYMENT.reactive)} target="_blank" rel="noreferrer">
          ParallaxReactive
        </a>{" "}
        on Reactive Lasna.
      </p>
    </Panel>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-faint">{children}</p>;
}
