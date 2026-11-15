"use client";

import { useMemo, useState } from "react";
import { CHAINS, LINKS, type ChainKey } from "@/lib/deployment";
import { PROOFS, type StoredExecution } from "@/lib/proofs";
import { AnimatedNumber, Panel, Segmented, Stat, TxLink } from "./ui";

/**
 * Every proven loop, stored in the app (src/lib/proofs.json, frozen from chain by `npm run snapshot`), so the
 * evidence survives Lasna pruning its old blocks. Three hashes per row and the block-exact latency.
 */
type Row = { key: string; what: string; chain: ChainKey; originTx: string; reactiveTx: string | null; callbackTx: string | null; blocks: number; t0?: number; group: string };

const rows: Row[] = [
  ...PROOFS.vault.map((v) => ({
    key: `vault:${v.callbackTx}`,
    what: v.action === "evacuate" ? "Vault evacuated" : v.action === "reenter" ? "Vault re-entered" : "Vault re-centred",
    chain: "base" as ChainKey,
    originTx: v.originTx,
    reactiveTx: v.reactiveTx,
    callbackTx: v.callbackTx,
    blocks: v.latencyBlocks,
    group: "Vault",
  })),
  ...[...PROOFS.executions, ...PROOFS.bench].map((e: StoredExecution) => ({
    key: `${e.source}:${e.chain}:${e.ruleId}:${e.originTx}`,
    what: `${e.kind ? e.kind.replace("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "Rule"} #${e.ruleId}`,
    chain: e.chain,
    originTx: e.originTx,
    reactiveTx: e.reactiveTx,
    callbackTx: e.callbackTx,
    blocks: e.latencyBlocks,
    t0: e.t0,
    group: e.source === "bench" ? `Benchmark (${e.version})` : `Live (${e.version})`,
  })),
];

function median(xs: number[]) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

type Filter = "All" | "Base" | "Unichain" | "Vault";
const FILTERS: Filter[] = ["All", "Base", "Unichain", "Vault"];

export function ProofView() {
  const [filter, setFilter] = useState<Filter>("All");
  const shown = useMemo(
    () => rows.filter((r) => (filter === "All" ? true : filter === "Vault" ? r.group === "Vault" : r.group !== "Vault" && CHAINS[r.chain].short === filter)),
    [filter],
  );

  const base = rows.filter((r) => r.chain === "base" && r.group !== "Vault").map((r) => r.blocks);
  const uni = rows.filter((r) => r.chain === "unichain").map((r) => r.blocks);
  const withReactive = rows.filter((r) => r.reactiveTx).length;

  return (
    <div className="grid min-w-0 gap-8">
      <section aria-label="Proof figures" style={{ "--i": 0 } as React.CSSProperties} className="m-rise rounded-[20px] bg-panel">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[20px] bg-line lg:grid-cols-4">
          <div className="col-span-2 bg-panel px-7 py-6 lg:col-span-1">
            <Stat lead label="Proven loops" value={<AnimatedNumber value={rows.length} format={(n) => Math.round(n).toLocaleString("en-US")} />} sub={`${withReactive} with all three transactions stored`} />
          </div>
          <div className="bg-panel px-7 py-6">
            <Stat label="Base median" value={base.length ? `${median(base)} blocks` : "—"} sub={base.length ? `≈ ${((median(base)! * 200) / 1000).toFixed(1)} s · ${base.length} loops` : undefined} />
          </div>
          <div className="bg-panel px-7 py-6">
            <Stat label="Unichain median" value={uni.length ? `${median(uni)} blocks` : "—"} sub={uni.length ? `≈ ${median(uni)} s · ${uni.length} loops` : undefined} />
          </div>
          <div className="bg-panel px-7 py-6">
            <Stat label="Keeper bot, Base (same pool, same RPC)" value="10 blocks" sub="median of 20 runs · bench/keeper.mjs" />
          </div>
        </div>
      </section>

      <Panel i={1} className="min-w-0" title="Every loop, origin → reactive → callback" aside={<Segmented label="Show" options={FILTERS} value={filter} onChange={setFilter} />}>
        <div className="-mx-7 overflow-x-auto">
          <table className="w-full min-w-[900px] text-[14px] [&_td]:pr-6 [&_th]:pr-6">
            <thead>
              <tr className="text-left text-[13px] text-muted">
                <th className="h-11 px-7 font-normal">Loop</th>
                <th className="h-10 font-normal">Chain</th>
                <th className="h-10 font-normal">① Origin swap</th>
                <th className="h-10 font-normal">② Reactive tx, Lasna</th>
                <th className="h-10 font-normal">③ Callback</th>
                <th className="h-11 px-7 text-right font-normal">Latency</th>
              </tr>
            </thead>
            <tbody key={filter}>
              {shown.map((r, i) => {
                const c = CHAINS[r.chain];
                return (
                  <tr key={r.key} style={{ "--i": Math.min(i, 14) } as React.CSSProperties} className="m-row border-t border-rule transition-colors duration-200 hover:bg-raised/60">
                    <td className="h-[52px] px-7">
                      <span className="text-ink">{r.what}</span> <span className="text-faint">· {r.group}</span>
                    </td>
                    <td className="text-muted">{c.short}</td>
                    <td>
                      <TxLink href={c.explorerTx(r.originTx)} hash={r.originTx} />
                    </td>
                    <td>
                      <TxLink href={r.reactiveTx ? LINKS.lasnaTx(r.reactiveTx) : "#"} hash={r.reactiveTx ?? undefined} />
                    </td>
                    <td>
                      <TxLink href={r.callbackTx ? c.explorerTx(r.callbackTx) : "#"} hash={r.callbackTx ?? undefined} />
                    </td>
                    <td className="num px-7 text-right">
                      {r.blocks} <span className="text-faint">blocks · {((r.blocks * c.blockMs) / 1000).toFixed(1)} s</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-[12px] text-faint">
          Stored in the app on {new Date(PROOFS.updated).toISOString().slice(0, 10)} from Base, Unichain and Lasna, so these links outlive Lasna’s block pruning.
          Latency is block-exact: the executor records the origin block and the block it executed in.
        </p>
      </Panel>
    </div>
  );
}
