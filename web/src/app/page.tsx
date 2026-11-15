"use client";

import { CreateRule } from "@/components/CreateRule";
import { DemoPanel } from "@/components/DemoPanel";
import { AnswerStrip, LoopStrip } from "@/components/GuardsOverview";
import { LiveFeed } from "@/components/LiveFeed";
import { MyRules } from "@/components/MyRules";
import { ProofView } from "@/components/ProofView";
import { Shell, TitleRow, useView } from "@/components/Shell";
import { VaultPanel } from "@/components/VaultPanel";

/*
 * Grid (desktop, 1440): rail 55 + 32 gutter, canvas up to 1312. One gap (24px) everywhere.
 * Guards: 12 columns. Row 2: loop 8 + demo 4. Row 3: arm a rule 5 + feed/rules 7. 8+4 = 5+7 = 12.
 */
export default function Home() {
  const [view, setView] = useView();

  return (
    <Shell view={view} onView={setView}>
      {view === "guards" && (
        <>
          <TitleRow
            title="Guards"
            sub="Stop-losses, take-profits, trailing stops and LP range guards on Uniswap v4. One reactive contract on Lasna watches every swap and executes on the chain it happened, with no bot and no server."
          />
          <div className="grid gap-6">
            <AnswerStrip />
            <div className="grid gap-6 lg:grid-cols-12">
              <div className="flex lg:col-span-8 [&>section]:flex-1">
                <LoopStrip />
              </div>
              <div className="flex lg:col-span-4 [&>section]:flex-1">
                <DemoPanel />
              </div>
            </div>
            <div className="grid items-start gap-6 lg:grid-cols-12">
              <div className="lg:col-span-5">
                <CreateRule />
              </div>
              <div className="grid gap-6 lg:col-span-7">
                <LiveFeed />
                <MyRules />
              </div>
            </div>
          </div>
        </>
      )}

      {view === "vault" && (
        <>
          <TitleRow
            chainSwitch={false}
            title="Vault"
            sub="One deposit, managed liquidity on the Base mWETH/mUSDC pool. It re-centres when the price drifts out, steps out of a crash, and goes back in when the market is calm."
          />
          <VaultPanel />
        </>
      )}

      {view === "proof" && (
        <>
          <TitleRow
            chainSwitch={false}
            title="Proof"
            sub="Every loop Parallax has run on testnet, with its three transactions and block-exact latency, stored in the app so it outlives Lasna’s block pruning."
          />
          <ProofView />
        </>
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
