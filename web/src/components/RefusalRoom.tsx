"use client";

import type { ReactNode } from "react";
import data from "@/lib/refusals.json";
import { CHAINS, LINKS } from "@/lib/deployment";
import { Chip, Panel, TxLink } from "./ui";

type R = Record<string, string | number | boolean | undefined>;
const base = (data as Record<string, Record<string, R>>).base ?? {};
const tx = (h?: unknown) => (typeof h === "string" ? <TxLink href={CHAINS.base.explorerTx(h)} hash={h} /> : null);
const lasna = (h?: unknown) => (typeof h === "string" ? <TxLink href={LINKS.lasnaTx(h)} hash={h} /> : null);

const ROWS: { key: string; claim: string; evidence: (r: R) => ReactNode }[] = [
  {
    key: "unauthorized",
    claim: "Nobody but Reactive can fire a rule",
    evidence: (r) => <>An outsider called <code>execute()</code> directly: reverted <code>NotAuthorized</code> {tx(r.tx)}</>,
  },
  {
    key: "inBand",
    claim: "A swap that stops short of the line does nothing",
    evidence: (r) => <>Swap {tx(r.originTx)} moved the tick {String(r.tickBefore)} → {String(r.tickAfter)} (line {String(r.line)}). Lasna reacted {lasna(r.reactiveTx)} and requested no callback.</>,
  },
  {
    key: "stale",
    claim: "A stale trigger can't force a bad sale",
    evidence: (r) => <>Crossed {tx(r.crossTx)}, snapped back {tx(r.snapBackTx)}. The executor re-read the price and skipped {tx(r.skippedTx)}, Lasna re-armed {lasna(r.rearmTx)}, and the next real cross filled it {tx(r.filledTx)}.</>,
  },
  {
    key: "dedupe",
    claim: "Two crossing swaps, one sale",
    evidence: (r) => <>Swaps {tx(r.swap1Tx)} and {tx(r.swap2Tx)}: {String(r.triggers)} trigger, {String(r.executions)} execution {tx(r.filledTx)}.</>,
  },
  {
    key: "cancelled",
    claim: "A cancelled rule never fires",
    evidence: (r) => <>Cancelled {tx(r.cancelTx)}, unmirrored on Lasna {lasna(r.removedTx)}, then a crossing swap {tx(r.crossTx)}: {String(r.triggers)} triggers, {String(r.executions)} executions.</>,
  },
];

/** What Parallax refuses to do, each shown with real testnet transactions (bench/refusals.mjs). */
export function RefusalRoom() {
  return (
    <Panel i={2} title="What it refuses to do" aside={<span className="text-[13px] text-faint">live on Base Sepolia</span>}>
      <ul className="grid gap-3">
        {ROWS.map(({ key, claim, evidence }) => {
          const r = base[key];
          return (
            <li key={key} className="rounded-[14px] bg-raised/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-medium text-ink">{claim}</span>
                <Chip tone={r?.proven ? "executed" : "danger"}>{r?.proven ? "proven" : "not yet run"}</Chip>
              </div>
              {r?.proven && <p className="mt-2 text-[13px] leading-6 text-muted">{evidence(r)}</p>}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
