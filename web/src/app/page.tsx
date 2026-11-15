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
        <div key="guards" className="m-view">
          <TitleRow
            title="Guards"
            sub="Stop-losses, take-profits, trailing stops and LP range guards on Uniswap v4. One reactive contract on Lasna watches every swap and executes on the chain it happened, with no bot and no server."
          />
          <div className="grid gap-6">
            <div className="m-rise" style={{ "--i": 0 } as React.CSSProperties}>
              <AnswerStrip />
            </div>
            <div className="grid gap-6 lg:grid-cols-12">
              <div className="m-rise flex lg:col-span-8 [&>section]:flex-1" style={{ "--i": 1 } as React.CSSProperties}>
                <LoopStrip />
              </div>
              <div className="m-rise flex lg:col-span-4 [&>section]:flex-1" style={{ "--i": 2 } as React.CSSProperties}>
                <DemoPanel />
              </div>
            </div>
            <div className="grid items-start gap-6 lg:grid-cols-12">
              <div className="m-rise lg:col-span-5" style={{ "--i": 3 } as React.CSSProperties}>
                <CreateRule />
              </div>
              <div className="grid gap-6 lg:col-span-7">
                <div className="m-rise" style={{ "--i": 4 } as React.CSSProperties}>
                  <LiveFeed />
                </div>
                <div className="m-rise" style={{ "--i": 5 } as React.CSSProperties}>
                  <MyRules />
                </div>
              </div>
            </div>
          </div>
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
