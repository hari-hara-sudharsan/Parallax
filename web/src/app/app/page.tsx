"use client";

import { CreateRule } from "@/components/CreateRule";
import { DemoPanel } from "@/components/DemoPanel";
import { HealthPanel } from "@/components/HealthPanel";
import { PanicPanel } from "@/components/PanicPanel";
import { RefusalRoom } from "@/components/RefusalRoom";
import { TryoutPanel } from "@/components/TryoutPanel";
import { WhatIfPanel } from "@/components/WhatIfPanel";
import { LoopStrip } from "@/components/GuardsOverview";
import { LiveFeed } from "@/components/LiveFeed";
import { MyRules } from "@/components/MyRules";
import { useAccount } from "wagmi";
import { ProofView } from "@/components/ProofView";
import { Shell, TitleRow, useView } from "@/components/Shell";
import { VaultPanel } from "@/components/VaultPanel";

/*
 * Grid (desktop, 1440): rail 55 + 48 gutter, canvas up to 1200. One gap (32px) everywhere.
 * Guards: 12 columns. Row 1: price + how fast (5) beside protect (7). Row 2: activity (7) + my rules (5).
 */
export default function App() {
  const [view, setView] = useView();

  return (
    <Shell view={view} onView={setView}>
      {view === "guards" && (
        <div key="guards" className="m-view">
          <TitleRow
            chainSwitch={false}
            title="Guards"
            sub="Set your line once. Parallax sells the moment the price crosses it, in about a second, with no bot and no server."
          />
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
            <div className="grid min-w-0 grid-cols-1 content-start gap-8 lg:col-span-5">
              <DemoPanel />
              <TryoutPanel />
              <LiveFeed />
            </div>
            <div className="grid min-w-0 grid-cols-1 content-start gap-8 lg:col-span-7">
              <CreateRule />
              <LoopStrip />
              <WhatIfPanel />
              <PanicPanel />
              <HealthPanel />
            </div>
          </div>
          <YourRules />
        </div>
      )}

      {view === "vault" && (
        <div key="vault" className="m-view">
          <TitleRow
            chainSwitch={false}
            title="Vault"
            sub="One deposit, managed liquidity on the Base mWETH/mUSDC pool. It re-centres when the price drifts out, steps out of a crash, and goes back in when the market is calm."
          />
          <VaultPanel />
        </div>
      )}

      {view === "proof" && (
        <div key="proof" className="m-view">
          <TitleRow
            chainSwitch={false}
            title="Proof"
            sub="Every loop Parallax has run on testnet, with its three transactions and block-exact latency, stored in the app so it outlives Lasna’s block pruning."
          />
          <ProofView />
          <div className="mt-8">
            <RefusalRoom />
          </div>
        </div>
      )}

      <footer className="mt-12 flex flex-col gap-2 text-[12px] text-faint sm:flex-row sm:items-center sm:justify-between">
        <span>Parallax · Reactive Omni Buildathon, Track 1 “Every Second Counts” · testnet tokens only</span>
        <a className="hover:text-muted" href="https://github.com/hari-hara-sudharsan/Parallax" target="_blank" rel="noreferrer">
          Source and docs on GitHub
        </a>
      </footer>
    </Shell>
  );
}

/** Your rules appear once a wallet is connected; before that there is nothing of yours to show. */
function YourRules() {
  const { address } = useAccount();
  if (!address) return null;
  return (
    <div className="mt-8">
      <MyRules />
    </div>
  );
}
