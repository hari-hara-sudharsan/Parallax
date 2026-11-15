import { CreateRule } from "@/components/CreateRule";
import { DemoPanel } from "@/components/DemoPanel";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { LiveFeed } from "@/components/LiveFeed";
import { MyRules } from "@/components/MyRules";
import { VaultPanel } from "@/components/VaultPanel";
import { CHAINS, LINKS, REACTIVE } from "@/lib/deployment";

const FLOW = [
  { n: "1", title: "You arm a rule", body: "Deposit tokens or an LP NFT into ParallaxExecutor on Base or Unichain. It emits RuleCreated." },
  { n: "2", title: "Reactive mirrors it", body: "One ParallaxReactive on Lasna guards both chains: it picks up the event and subscribes to that pool's swaps." },
  { n: "3", title: "Price crosses", body: "Any swap that moves the tick past your line reaches react() about a second later." },
  { n: "4", title: "Callback executes", body: "The executor on the same chain re-checks the price on-chain, swaps or withdraws, and records the latency." },
];

export default function Home() {
  return (
    <>
      <Header />
      <Hero />

      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="space-y-4">
            <CreateRule />
            <DemoPanel />
          </div>
          <div className="space-y-4">
            <LiveFeed />
            <MyRules />
          </div>
        </div>

        <div className="mt-4">
          <VaultPanel />
        </div>

        <section className="mt-12">
          <h2 className="text-[13px] font-medium tracking-wide text-muted">How it works</h2>
          <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FLOW.map((s) => (
              <li key={s.n} className="rounded-2xl border border-line bg-panel p-5">
                <span className="num text-xs text-triggered">0{s.n}</span>
                <h3 className="mt-2 text-sm font-medium">{s.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <footer className="mt-12 flex flex-col gap-2 border-t border-line pt-6 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
          <span>Built for the Reactive Omni Buildathon · Track 1 “Every Second Counts”</span>
          <span className="flex gap-4">
            <a className="hover:text-muted" href={CHAINS.base.explorerAddress(CHAINS.base.executor)} target="_blank" rel="noreferrer">
              Base executor ↗
            </a>
            <a className="hover:text-muted" href={CHAINS.unichain.explorerAddress(CHAINS.unichain.executor)} target="_blank" rel="noreferrer">
              Unichain executor ↗
            </a>
            <a className="hover:text-muted" href={LINKS.lasnaAddress(REACTIVE.address)} target="_blank" rel="noreferrer">
              Reactive ↗
            </a>
            <a className="hover:text-muted" href={LINKS.repo} target="_blank" rel="noreferrer">
              Source ↗
            </a>
          </span>
        </footer>
      </main>
    </>
  );
}
