"use client";

import { useQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import { chainClients, lasnaClient } from "@/lib/clients";
import { CHAIN_LIST, LINKS, REACTIVE } from "@/lib/deployment";
import { Chip, Panel } from "./ui";

/** Measured on Lasna (results/costs.md): about three reactive txs of ~0.02 lREACT per full loop. */
const LREACT_PER_LOOP = 0.063;

const systemAbi = [
  { type: "function", name: "reserves", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "debt", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Is Parallax awake? A reactive contract that owes Reactive Network anything is not called at all, so this panel
 * shows the funding that keeps the loop alive: lREACT on Lasna (pays for every reaction) and ETH in each executor
 * (pays for every callback).
 */
export function HealthPanel() {
  const { data } = useQuery({
    queryKey: ["health"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const [reserves, debt, balance, ...executors] = await Promise.all([
        lasnaClient.readContract({ address: REACTIVE.systemContract, abi: systemAbi, functionName: "reserves", args: [REACTIVE.address] }),
        lasnaClient.readContract({ address: REACTIVE.systemContract, abi: systemAbi, functionName: "debt", args: [REACTIVE.address] }),
        lasnaClient.getBalance({ address: REACTIVE.address }),
        ...CHAIN_LIST.map((c) => chainClients[c.key].getBalance({ address: c.executor })),
      ]);
      return { reserves, debt, balance, executors };
    },
  });

  const lreact = data ? Number(formatEther(data.reserves + data.balance)) : undefined;
  const debt = data ? Number(formatEther(data.debt)) : 0;
  const loops = lreact !== undefined ? Math.floor(lreact / LREACT_PER_LOOP) : undefined;
  const healthy = data && debt === 0 && (loops ?? 0) > 5;

  return (
    <Panel
      i={5}
      title="Is it awake?"
      aside={data ? <Chip tone={healthy ? "executed" : debt > 0 ? "danger" : "triggered"} pulse={!healthy}>{healthy ? "live" : debt > 0 ? "paused: in debt" : "low on lREACT"}</Chip> : null}
    >
      <div className="num grid grid-cols-2 gap-3 text-[13px]">
        <div>
          <div className="text-muted">Reactive contract (Lasna)</div>
          <div className="text-[20px] font-semibold text-ink">{lreact !== undefined ? `${lreact.toFixed(2)} lREACT` : "…"}</div>
          <div className="text-faint">{loops !== undefined ? `≈ ${loops} more loops` : ""}{debt > 0 ? ` · owes ${debt.toFixed(4)}` : ""}</div>
        </div>
        <div>
          <div className="text-muted">Callback gas</div>
          {CHAIN_LIST.map((c, i) => (
            <div key={c.key} className="text-faint">
              {c.short}: <span className="text-ink">{data ? Number(formatEther(data.executors[i])).toFixed(5) : "…"} ETH</span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-3 text-[12px] text-faint">
        A reactive contract in debt is not called at all, and events in the meantime are lost; after topping up, anyone can
        call <code>resync(ruleId)</code> on an executor to repair the mirror.{" "}
        <a className="hover:text-muted" href={LINKS.lasnaAddress(REACTIVE.address)} target="_blank" rel="noreferrer">
          See it on Reactscan
        </a>
      </p>
    </Panel>
  );
}
