"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useActivity, type FeedItem } from "@/hooks/useActivity";
import { usePool } from "@/hooks/usePool";
import { CHAINS, LINKS } from "@/lib/deployment";
import { fmtUsd } from "@/lib/price";
import { PROOFS } from "@/lib/proofs";
import { Mark } from "./Header";
import { AnimatedNumber, cx } from "./ui";

/*
 * The Parallax home page ("One motif", seed 526283314).
 * Idea: the loop Parallax produces on every execution (swap → Reactive on Lasna → executed, three stations on one
 * line) becomes the page's one shape: a capsule track with three dots. It is the hero at enormous scale replaying the
 * real latest loop, the bullet, the band between the page's halves, the button, and the footer's mark.
 * Every interface piece on the page is a real fragment of the app (data-ui); every figure is measured on-chain.
 */

const S = (i: number) => ({ "--i": i }) as CSSProperties;

/** Marks <html class="js"> and reveals [data-reveal] elements as they scroll in (content stays visible without JS). */
function useReveal() {
  useEffect(() => {
    document.documentElement.classList.add("js");
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/** Bench measurements (results/SUMMARY.md) and the stored proofs, so every figure on the page is on-chain. */
function useFacts() {
  const all = [...PROOFS.executions, ...PROOFS.bench];
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
  const base = all.filter((e) => e.chain === "base").map((e) => e.latencyBlocks);
  const uni = all.filter((e) => e.chain === "unichain").map((e) => e.latencyBlocks);
  return {
    loops: all.length + PROOFS.vault.length,
    baseBlocks: median(base),
    baseSeconds: (median(base) * 200) / 1000,
    uniBlocks: median(uni),
    keeperBlocks: 10,
  };
}

/** The newest loop: live when the executors are readable, else the newest stored one. */
function useLatestLoop(): FeedItem | undefined {
  const { data } = useActivity();
  const live = data?.items.find((x) => x.state === "executed" && x.latencyBlocks !== undefined);
  if (live) return live;
  const e = [...PROOFS.executions].sort((a, b) => b.t1 - a.t1)[0];
  if (!e) return undefined;
  return {
    key: `stored:${e.chain}:${e.ruleId}`,
    chain: e.chain,
    ruleId: BigInt(e.ruleId),
    state: "executed",
    originTx: e.originTx,
    originBlock: e.originBlock,
    reactiveTx: e.reactiveTx ?? undefined,
    callbackTx: e.callbackTx ?? undefined,
    executedBlock: e.executedBlock,
    latencyBlocks: e.latencyBlocks,
    latencySeconds: (e.latencyBlocks * CHAINS[e.chain].blockMs) / 1000,
  };
}

export function Landing() {
  useReveal();
  return (
    <div className="overflow-x-clip bg-bg text-ink">
      <Hero />
      <Intro />
      <HowItWorks />
      <Showcase />
      <Proof />
      <Features />
      <Cta />
      <Footer />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hero: the giant loop, cropped by the viewport, replaying the real latest execution
// ─────────────────────────────────────────────────────────────────────────────

function Hero() {
  const loop = useLatestLoop();
  const facts = useFacts();
  const [replay, setReplay] = useState(0);
  return (
    <header className="relative min-h-[100svh] overflow-hidden">
      <nav className="relative z-20 mx-auto flex max-w-[1360px] items-center justify-between px-5 pt-6 md:px-10">
        <Link href="/" className="flex items-center gap-2.5 text-[19px] font-semibold tracking-[-0.02em]">
          <Mark size={32} /> Parallax
        </Link>
        <div className="flex items-center gap-6 text-[16px] text-muted">
          <a href="#how" className="hidden transition-colors hover:text-ink sm:inline">
            How it works
          </a>
          <a href="#proof" className="hidden transition-colors hover:text-ink sm:inline">
            Proof
          </a>
          <a href={LINKS.repo} target="_blank" rel="noreferrer" className="transition-colors hover:text-ink">
            GitHub
          </a>
        </div>
      </nav>

      {/* The motif at enormous scale: right of centre on desktop, at the bottom on a phone. */}
      <div
        aria-hidden
        className="lp-shutter absolute bottom-[-16svh] left-[-12vw] right-[-12vw] top-[66svh] rounded-full bg-active lg:bottom-[-22vh] lg:left-[47vw] lg:right-[-34vw] lg:top-[10vh]"
      >
        <div className="lp-settle absolute inset-0">
          <HeroLoop key={replay} loop={loop} />
        </div>
      </div>

      <div className="relative z-10 mx-auto flex min-h-[calc(100svh-80px)] max-w-[1360px] flex-col justify-start px-5 pt-[8svh] md:px-10 lg:justify-center lg:pt-0">
        <div className="max-w-[640px] lg:max-w-[42vw]">
          <h1 className="m-view text-[clamp(52px,11.5vw,88px)] font-bold leading-[0.98] tracking-[-0.04em] lg:text-[clamp(64px,6.4vw,100px)]">
            Stops that
            <br />
            never sleep.
          </h1>
          <p className="m-view mt-7 max-w-[34ch] text-[17px] leading-7 text-muted lg:mt-10 lg:text-[19px] lg:leading-8" style={{ animationDelay: "120ms" }}>
            Parallax sells your Uniswap position the moment the price crosses your line, about{" "}
            <span className="num text-ink">{facts.baseSeconds.toFixed(1)} s</span> later. Reactive Network runs it, so there is no bot to fail.
          </p>
          <div className="m-view mt-9 flex flex-wrap items-center gap-4" style={{ animationDelay: "220ms" }}>
            <Link href="/app#guards" className="m-lift inline-flex h-[56px] items-center gap-3 rounded-full bg-ink px-8 text-[17px] font-semibold text-bg">
              Open the app <span className="lp-bullet" aria-hidden><i /><i /><i /></span>
            </Link>
            {loop && (
              <button type="button" onClick={() => setReplay((r) => r + 1)} className="m-lift hidden h-[56px] rounded-full px-5 text-[16px] text-muted transition-colors hover:text-ink lg:inline-block">
                ↻ Replay the last loop
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function HeroLoop({ loop }: { loop?: FeedItem }) {
  const n = loop?.latencyBlocks ?? 10;
  const c = loop ? CHAINS[loop.chain] : CHAINS.base;
  // Stations along the capsule's centre line (desktop crops the right end, so the loop sits in the visible left part).
  // [phone/tablet, desktop] positions, as % of the shape: only its left part is on screen at each size.
  const start: Pos = [24, 11];
  const end: Pos = [70, 44];
  const lasna: Pos = [start[0] + (end[0] - start[0]) * 0.45, start[1] + (end[1] - start[1]) * 0.45];
  const at = (ms: number) => ({ "--delay": `${ms}ms` }) as CSSProperties;
  return (
    <div className="absolute inset-0 text-black">
      <div className="absolute left-[var(--x)] top-[38%] h-[6px] -translate-y-1/2 rounded-full bg-black/15 lg:left-[var(--xl)] lg:top-1/2" style={{ ...px(start), right: "-5%" } as CSSProperties} />
      <div
        className="lp-track absolute left-[var(--x)] top-[38%] h-[6px] w-[var(--w)] -translate-y-1/2 rounded-full bg-black lg:left-[var(--xl)] lg:top-1/2 lg:w-[var(--wl)]"
        style={{ ...px(start), "--w": `${end[0] - start[0]}%`, "--wl": `${end[1] - start[1]}%`, ...at(1100), "--dur": "1200ms" } as CSSProperties}
      />
      <Dot x={start} delay={1000} />
      <Dot x={lasna} delay={1600} hollow />
      <Dot x={end} delay={2300} big />
      <Label x={start} delay={1100} top="Swap" sub={loop?.originBlock ? `block ${loop.originBlock.toLocaleString("en-US")}` : "the price crosses"} />
      <Label x={lasna} delay={1700} top="Reactive" sub="on Lasna" />
      <Label x={end} delay={2400} top={`${((n * c.blockMs) / 1000).toFixed(1)} s`} sub={`executed, ${n} blocks`} strong />
    </div>
  );
}

type Pos = [number, number];
const px = (p: Pos) => ({ "--x": `${p[0]}%`, "--xl": `${p[1]}%` }) as CSSProperties;

function Dot({ x, delay, big, hollow }: { x: Pos; delay: number; big?: boolean; hollow?: boolean }) {
  return (
    <span
      className={cx(
        "lp-pop absolute left-[var(--x)] top-[38%] rounded-full lg:left-[var(--xl)] lg:top-1/2",
        big ? "h-9 w-9 bg-black lg:h-12 lg:w-12" : "h-6 w-6 lg:h-8 lg:w-8",
        hollow ? "bg-active ring-[5px] ring-inset ring-black" : !big && "bg-black",
      )}
      style={{ ...px(x), "--delay": `${delay}ms` } as CSSProperties}
    />
  );
}

function Label({ x, delay, top, sub, strong }: { x: Pos; delay: number; top: string; sub: string; strong?: boolean }) {
  return (
    <span className="lp-fade absolute left-[var(--x)] top-[calc(38%+30px)] -translate-x-1/2 whitespace-nowrap text-center lg:left-[var(--xl)] lg:top-[calc(50%+44px)]" style={{ ...px(x), "--delay": `${delay}ms` } as CSSProperties}>
      <span className={cx("num block font-semibold tracking-[-0.02em]", strong ? "text-[24px] lg:text-[40px]" : "text-[16px] lg:text-[24px]")}>{top}</span>
      <span className="block text-[13px] text-black/70 lg:text-[16px]">{sub}</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Intro: the problem, as a statement with interface frames inline
// ─────────────────────────────────────────────────────────────────────────────

function Frame({ children }: { children: ReactNode }) {
  return (
    <span data-ui className="mx-[0.12em] inline-flex h-[0.95em] min-w-[2.2em] items-center justify-center rounded-full bg-panel px-[0.4em] align-[-0.12em] text-[0.42em] font-medium">
      {children}
    </span>
  );
}

function Intro() {
  return (
    <section aria-labelledby="problem" className="mx-auto max-w-[1360px] px-5 py-[16vh] md:px-10">
      <h2 id="problem" className="sr-only">
        The problem
      </h2>
      <p data-reveal className="mx-auto max-w-[24ch] text-[24px] font-semibold leading-[1.25] tracking-[-0.025em] md:max-w-[32ch] md:text-[32px] md:leading-[1.2] lg:max-w-[30ch] lg:text-[36px]">
        Uniswap has no stop-loss <Frame><span className="text-danger">−12%</span></Frame>. Keeper bots go offline or arrive late{" "}
        <Frame><span className="num text-muted">+10 blocks</span></Frame>, and a late exit costs the most.
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  How it works: one rule card, four fields, further along each time (real values from a run on Base)
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  { clause: "First you set a line.", field: "bg-[#0d0d0e]" },
  { clause: "Then the market crosses it.", field: "bg-[#161618]" },
  { clause: "Reactive sees it on Lasna.", field: "bg-[#202023]" },
  { clause: "Your stop executes, 2 s later.", field: "bg-active text-black" },
];

function RuleCard({ step }: { step: number }) {
  const row = (k: string, v: ReactNode, on = true) => (
    <div className={cx("flex items-baseline justify-between gap-3 transition-opacity", on ? "opacity-100" : "opacity-30")}>
      <span className="text-[13px] text-muted">{k}</span>
      <span className="num text-[15px] text-ink">{v}</span>
    </div>
  );
  return (
    <div data-ui className="lp-lift w-[260px] rounded-[20px] bg-black p-5 text-left text-ink shadow-[0_18px_40px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold">Stop-loss</span>
        <span
          className={cx(
            "rounded-full px-2.5 py-0.5 text-[13px] font-medium",
            step === 3 ? "bg-executed/15 text-executed" : step >= 1 ? "bg-triggered/15 text-triggered" : "bg-raised text-muted",
          )}
        >
          {step === 0 ? "Armed" : step === 1 ? "Crossed" : step === 2 ? "Firing" : "Executed"}
        </span>
      </div>
      <div className="num mt-3 text-[32px] font-semibold tracking-[-0.03em]">$1,928.17</div>
      <div className="mt-1 text-[13px] text-muted">sell 0.5 mWETH at or below</div>
      <div className="mt-4 space-y-2">
        {row("Price", step === 0 ? "$1,935.89" : "$1,922.01", true)}
        {row("Reactive", step >= 2 ? "fired" : "watching", step >= 2)}
        {row("Paid", "957.21 mUSDC", step >= 3)}
      </div>
    </div>
  );
}

function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-h" className="grid md:grid-cols-4">
      {STEPS.map((s, i) => (
        <div key={i} data-reveal style={S(i)} className={cx("relative flex min-h-[64svh] flex-col px-5 pb-8 pt-8 md:min-h-[84svh] md:px-7", s.field)}>
          {i === 0 && (
            <h2 id="how-h" className="text-[24px] font-bold tracking-[-0.02em] md:text-[32px]">
              How it works
            </h2>
          )}
          <div className="flex flex-1 items-center justify-start md:justify-center">
            <RuleCard step={i} />
          </div>
          <p className={cx("max-w-[14ch] text-[24px] font-semibold leading-[1.15] tracking-[-0.02em] md:text-[clamp(22px,2vw,32px)]", i === 3 ? "text-black" : "text-ink")}>
            {s.clause}
          </p>
        </div>
      ))}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Showcase: one control blown up; it works, and it swaps the field and one word
// ─────────────────────────────────────────────────────────────────────────────

function Showcase() {
  const [mode, setMode] = useState<"stop" | "take">("stop");
  const { price } = usePool(CHAINS.base);
  const p = price ?? 1935.89;
  const line = mode === "stop" ? p * 0.97 : p * 1.05;
  const take = mode === "take";
  return (
    <section
      aria-labelledby="show-h"
      className={cx("relative min-h-[72svh] overflow-hidden transition-colors duration-500 lg:min-h-[86svh]", take ? "bg-ink text-black" : "bg-active text-black")}
    >
      <div className="mx-auto max-w-[1360px] px-5 pt-14 md:px-10 md:pt-20">
        <h2 id="show-h" data-reveal className="text-[26px] font-bold leading-tight tracking-[-0.025em] md:text-[clamp(28px,2.6vw,40px)]">
          Sell if it {take ? "rises" : "falls"}.
        </h2>
        <p data-reveal style={S(1)} className="mt-3 max-w-[38ch] text-[16px] leading-7 text-black/75 md:text-[17px]">
          One switch decides which way you are protected. Your line now:{" "}
          <span className="num font-semibold text-black">${fmtUsd(line)}</span>, {take ? "5% above" : "3% below"} the live price.
        </p>
      </div>

      {/* The real segmented control, built in em and enlarged to poster size; it works. */}
      <div data-ui className="absolute bottom-[14svh] left-[5vw] text-[clamp(30px,8.4vw,44px)] md:bottom-[16vh] md:left-auto md:right-[-6vw] md:text-[clamp(44px,6.2vw,96px)]">
        <div role="radiogroup" aria-label="Protect against" className="relative inline-flex items-stretch rounded-full bg-black/90 p-[0.12em]">
          <span
            aria-hidden
            className="m-slide absolute bottom-[0.12em] top-[0.12em] w-[calc(50%-0.12em)] rounded-full bg-[#4a4a4f]"
            style={{ transform: take ? "translateX(100%)" : "translateX(0)" }}
          />
          {(["stop", "take"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cx("relative z-10 w-[5.6em] whitespace-nowrap rounded-full px-[0.6em] py-[0.32em] font-semibold tracking-[-0.03em] transition-colors", mode === m ? "text-ink" : "text-muted hover:text-ink")}
            >
              {m === "stop" ? "Stop-loss" : "Take-profit"}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Proof: large marks on tiles. Measured figures only; nothing invented.
// ─────────────────────────────────────────────────────────────────────────────

function Proof() {
  const f = useFacts();
  const tiles: [string, string][] = [
    [`${f.baseSeconds.toFixed(1)} s`, `median on Base, ${f.baseBlocks} blocks`],
    ["32 of 32", "benchmark stops filled on Base"],
    [`${f.keeperBlocks} blocks`, "a keeper bot’s median, same pool"],
    [`${f.uniBlocks} blocks`, "median on Unichain, 1 s blocks"],
    [`${f.loops}`, "loops stored with all three transactions"],
    ["0", "bots, servers or keys of ours in the loop"],
  ];
  return (
    <section id="proof" aria-labelledby="proof-h" className="mx-auto max-w-[1360px] px-5 py-24 md:px-10 md:py-32">
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4 md:gap-2">
        <div data-reveal className="col-span-2 flex min-h-[120px] flex-col justify-between rounded-[20px] bg-active p-6 text-black md:aspect-[3/1] md:min-h-0">
          <h2 id="proof-h" className="text-[28px] font-bold leading-tight tracking-[-0.025em] md:text-[clamp(28px,3vw,48px)]">
            Measured, not promised
          </h2>
          <Link href="/app#proof" className="text-[16px] font-medium underline decoration-black/30 underline-offset-4 hover:decoration-black">
            Every transaction, in the app
          </Link>
        </div>
        {tiles.map(([big, small], i) => (
          <div key={big + small} data-reveal style={S(i + 1)} className="flex aspect-[3/2] flex-col justify-end rounded-[20px] bg-panel p-5 md:p-6">
            <span className="num text-[24px] font-bold leading-tight tracking-[-0.025em] md:text-[40px]">{big}</span>
            <span className="mt-1 text-[13px] leading-5 text-muted md:text-[15px]">{small}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Features: close-ups of real controls on a board
// ─────────────────────────────────────────────────────────────────────────────

function Tile({ className, caption, line, children, i }: { className: string; caption: string; line: string; children: ReactNode; i: number }) {
  return (
    <div data-reveal style={S(i)} className={cx("relative overflow-hidden rounded-[20px]", className)}>
      <div data-ui className="absolute inset-0 p-5">{children}</div>
      <div className="absolute bottom-5 left-5 right-5">
        <div className="text-[18px] font-medium">{caption}</div>
        <div className="mt-0.5 text-[15px] text-muted">{line}</div>
      </div>
    </div>
  );
}

function Features() {
  return (
    <section aria-labelledby="feat-h" className="mx-auto max-w-[1360px] px-2.5 pb-24 md:pb-32">
      <div className="grid auto-rows-[28vw] grid-cols-2 gap-1.5 md:auto-rows-[104px] md:grid-cols-12 md:gap-2">
        <div data-reveal className="col-span-2 row-span-2 flex items-start rounded-[20px] bg-panel p-6 md:col-span-6 md:row-span-2">
          <h2 id="feat-h" className="text-[9vw] font-bold leading-none tracking-[-0.035em] md:text-[clamp(36px,4vw,60px)]">
            Everything it guards
          </h2>
        </div>
        <Tile i={1} className="row-span-2 bg-[#202023] md:col-span-3 md:row-span-2" caption="Trailing stop" line="Follows the price up">
          <span className="inline-block rounded-full bg-active/15 px-[0.5em] py-[0.15em] text-[32px] font-semibold text-active md:text-[44px]">−2%</span>
        </Tile>
        <Tile i={2} className="row-span-2 bg-panel md:col-span-3 md:row-span-2" caption="Range guard" line="Re-centres your LP">
          <span className="relative mt-6 block h-[10px] w-[115%] rounded-full bg-raised">
            <span className="absolute left-[14%] right-[22%] h-[10px] rounded-full bg-active" />
            <span className="absolute left-[44%] top-[-14px] h-[38px] w-[3px] rounded bg-ink" />
          </span>
        </Tile>
        <Tile i={3} className="col-span-2 row-span-3 bg-panel md:col-span-6 md:row-span-4" caption="Stop-loss" line="Drag the line; that is the whole setup">
          <span className="mt-16 block w-[150%] text-[64px]">
            <span className="relative block h-[0.16em] rounded-full bg-raised">
              <span className="absolute inset-y-0 left-0 w-[46%] rounded-full bg-active" />
              <span className="absolute left-[46%] top-1/2 h-[0.9em] w-[0.9em] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-[0.08em] ring-black/30" />
            </span>
          </span>
        </Tile>
        <Tile i={4} className="row-span-2 bg-[#0e2a17] md:col-span-3 md:row-span-4" caption="Re-checked on-chain" line="Nothing executes on stale data">
          <span className="mt-1 inline-block rounded-full bg-executed/20 px-[0.55em] py-[0.12em] text-[24px] font-semibold text-executed md:text-[30px] lg:text-[44px]">Executed</span>
        </Tile>
        <Tile i={5} className="row-span-2 bg-[#202023] md:col-span-3 md:row-span-4" caption="About a second" line="Swap to execution on Base">
          <span className="num block text-[72px] font-bold leading-none tracking-[-0.05em] md:text-[110px]">1.6</span>
        </Tile>
        <Tile i={6} className="col-span-2 row-span-2 bg-panel md:col-span-6 md:row-span-2" caption="Vault" line="Steps out of a crash, back in when calm">
          <span className="flex flex-wrap gap-3 text-[20px] font-semibold md:text-[30px]">
            <span className="rounded-full bg-danger/15 px-[0.5em] py-[0.1em] text-danger">Evacuated</span>
            <span className="rounded-full bg-executed/15 px-[0.5em] py-[0.1em] text-executed">Re-entered</span>
          </span>
        </Tile>
        <Tile i={7} className="col-span-2 row-span-2 bg-[#202023] md:col-span-6 md:row-span-2" caption="Base and Unichain" line="One reactive contract guards both">
          <span className="inline-flex rounded-full bg-raised p-[0.1em] text-[20px] font-semibold md:text-[30px]">
            <span className="rounded-full bg-[#4a4a4f] px-[0.6em] py-[0.1em]">Base</span>
            <span className="px-[0.6em] py-[0.1em] text-muted">Unichain</span>
          </span>
        </Tile>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  CTA: the first step already open; it carries what you choose into the app
// ─────────────────────────────────────────────────────────────────────────────

function Cta() {
  const [amount, setAmount] = useState("1");
  const [kind, setKind] = useState<"stop" | "take">("stop");
  const href = `/app?kind=${kind}&amount=${encodeURIComponent(amount || "1")}#guards`;
  return (
    <section aria-labelledby="cta-h" className="relative bg-active text-black">
      <div className="mx-auto grid min-h-[72svh] max-w-[1360px] items-center gap-10 px-5 py-16 md:min-h-[76svh] md:grid-cols-12 md:px-10 md:py-20">
        <div className="flex flex-col justify-center md:col-span-5">
          <h2 id="cta-h" data-reveal className="text-[13vw] font-bold leading-[0.92] tracking-[-0.045em] md:text-[clamp(56px,7vw,112px)]">
            Set your
            <br />
            line.
          </h2>
          <p data-reveal style={S(1)} className="mt-6 max-w-[34ch] text-[16px] leading-7 text-black/75 md:text-[17px]">
            The app opens with this filled in. Connect a wallet on Base Sepolia, drag your line, and Parallax watches it from then on.
          </p>
        </div>
        <div className="flex items-end md:col-span-6 md:col-start-7 md:items-center">
          <div data-ui data-reveal style={S(2)} className="w-full max-w-[440px] rounded-[24px] bg-panel p-7 text-ink shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
            <div className="text-[19px] font-semibold tracking-[-0.02em]">Protect a position</div>
            <div className="mt-5 inline-flex rounded-full bg-raised p-[3px]">
              {(["stop", "take"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  aria-pressed={kind === k}
                  className={cx("rounded-full px-4 py-1.5 text-[14px] font-medium transition-colors", kind === k ? "bg-[#4a4a4f] text-ink" : "text-muted hover:text-ink")}
                >
                  {k === "stop" ? "Stop-loss" : "Take-profit"}
                </button>
              ))}
            </div>
            <label className="mt-5 block">
              <span className="text-[13px] text-muted">Amount to protect</span>
              <span className="relative mt-2 block">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                  className="num h-14 w-full rounded-[14px] bg-raised px-4 pr-20 text-[22px] font-semibold text-ink outline-none ring-1 ring-inset ring-transparent focus:ring-active"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[15px] text-muted">mWETH</span>
              </span>
            </label>
            <Link href={href} className="m-lift mt-6 flex h-[52px] w-full items-center justify-center rounded-full bg-ink text-[17px] font-semibold text-bg">
              Continue in the app
            </Link>
            <p className="mt-3 text-center text-[13px] text-faint">Testnet tokens only. Free from the app.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Footer: the mark, built large from the motif
// ─────────────────────────────────────────────────────────────────────────────

function Footer() {
  const cols: [string, [string, string][]][] = [
    ["App", [["Guards", "/app#guards"], ["Vault", "/app#vault"], ["Proof", "/app#proof"]]],
    ["Build", [["Source", LINKS.repo], ["Contracts", `${LINKS.repo}/tree/main/contracts`], ["Proofs", `${LINKS.repo}/blob/main/deployments/tx-proofs.md`]]],
    ["Runs on", [["Reactive Network", "https://reactive.network"], ["Uniswap v4", "https://docs.uniswap.org/contracts/v4/overview"]]],
  ];
  return (
    <footer className="bg-bg px-5 pb-10 pt-20 md:px-10">
      <div className="mx-auto max-w-[1360px]">
        {/* The motif, built from flat shapes with 4px gaps: track segments and three stations. */}
        <svg viewBox="0 0 1200 240" className="h-auto w-full" role="img" aria-label="Parallax">
          <rect x="0" y="0" width="1200" height="240" rx="120" fill="rgb(var(--active))" />
          <rect x="150" y="114" width="296" height="12" rx="6" fill="#000" />
          <rect x="450" y="114" width="296" height="12" rx="6" fill="#000" />
          <rect x="750" y="114" width="90" height="12" rx="6" fill="#000" opacity="0.2" />
          <circle cx="150" cy="120" r="34" fill="#000" />
          <circle cx="448" cy="120" r="30" fill="rgb(var(--active))" stroke="#000" strokeWidth="12" />
          <circle cx="748" cy="120" r="46" fill="#000" />
          <text x="1050" y="138" textAnchor="end" fontSize="52" fontWeight="700" fill="#000" letterSpacing="-2">
            Parallax
          </text>
        </svg>
        <div className="mt-14 grid gap-10 sm:grid-cols-2 md:grid-cols-12">
          {cols.map(([h, links]) => (
            <div key={h} className="md:col-span-2">
              <div className="text-[15px] text-faint">{h}</div>
              <ul className="mt-3 space-y-2">
                {links.map(([label, href]) => (
                  <li key={label}>
                    {href.startsWith("/") ? (
                      <Link href={href} className="text-[15px] text-ink transition-colors hover:text-active">
                        {label}
                      </Link>
                    ) : (
                      <a href={href} target="_blank" rel="noreferrer" className="text-[15px] text-ink transition-colors hover:text-active">
                        {label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="md:col-span-4 md:col-start-9">
            <div className="text-[15px] text-faint">Built for</div>
            <p className="mt-3 text-[15px] leading-6 text-ink">Reactive Omni Buildathon, Track 1 “Every Second Counts”. Testnet only, not audited.</p>
          </div>
        </div>
        <div className="mt-14 flex items-center justify-between gap-4">
          <span className="text-[13px] text-faint">Parallax · MIT licence</span>
          <Link href="/app#guards" className="m-lift rounded-full bg-ink px-5 py-2 text-[15px] font-semibold text-bg">
            Open the app
          </Link>
        </div>
      </div>
    </footer>
  );
}
