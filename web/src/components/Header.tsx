"use client";

import { useEffect, useState } from "react";
import { useAccount, useBlockNumber, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useChain } from "@/hooks/useChain";
import { CHAIN_LIST, LINKS } from "@/lib/deployment";
import { Button, cx } from "./ui";

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      {/* Parallax: one point seen from two vantage points (the pool's chain and Reactive's). */}
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect x="0.5" y="0.5" width="25" height="25" rx="7" className="fill-raised stroke-line" />
        <path d="M7.5 19 13 7" fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-faint" />
        <path d="M13 19 18.5 7" fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-triggered" />
        <circle cx="15.75" cy="13" r="1.7" className="fill-ink" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">Parallax</span>
      <span className="hidden rounded-md border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-faint sm:inline">
        testnet
      </span>
    </div>
  );
}

/** Segmented control: which chain the forms, balances and price act on. */
function ChainSwitch() {
  const { chain, setChain } = useChain();
  return (
    <div className="flex rounded-xl border border-line bg-bg p-0.5" role="tablist" aria-label="Chain">
      {CHAIN_LIST.map((c) => (
        <button
          key={c.key}
          role="tab"
          aria-selected={chain.key === c.key}
          onClick={() => setChain(c.key)}
          className={cx(
            "rounded-[10px] px-2.5 py-1.5 text-xs font-medium transition",
            chain.key === c.key ? "bg-raised text-ink ring-1 ring-line" : "text-muted hover:text-ink",
          )}
        >
          {c.short}
          <span className="num ml-1 hidden text-[10px] text-faint sm:inline">{c.blockMs} ms</span>
        </button>
      ))}
    </div>
  );
}

export function Header() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { chain } = useChain();
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: block } = useBlockNumber({ chainId: chain.chainId, watch: true });

  const wrongChain = isConnected && chainId !== chain.chainId;

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
        <Logo />
        <div className="flex items-center gap-2.5">
          <span className="hidden items-center gap-2 text-xs text-muted lg:flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-executed" />
            <span className="num text-faint">#{block?.toString() ?? "…"}</span>
          </span>
          {mounted && <ChainSwitch />}
          <a href={LINKS.repo} target="_blank" rel="noreferrer" className="hidden text-xs text-muted hover:text-ink md:inline">
            GitHub
          </a>
          {!mounted ? (
            <div className="h-10 w-32" />
          ) : wrongChain ? (
            <Button variant="danger" onClick={() => switchChain({ chainId: chain.chainId })} disabled={switching}>
              {switching ? "Switching…" : `Switch to ${chain.short}`}
            </Button>
          ) : isConnected ? (
            <Button variant="ghost" onClick={() => disconnect()} title="Disconnect">
              <span className="h-2 w-2 rounded-full bg-executed" />
              <span className="num">{address!.slice(0, 6)}…{address!.slice(-4)}</span>
            </Button>
          ) : (
            <Button
              onClick={() => connectors[0] && connect({ connector: connectors[0], chainId: chain.chainId })}
              disabled={isPending || connectors.length === 0}
            >
              {connectors.length === 0 ? "No wallet found" : isPending ? "Connecting…" : "Connect wallet"}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
