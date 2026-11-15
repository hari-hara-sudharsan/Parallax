"use client";

import { useEffect, useState } from "react";
import { useAccount, useBlockNumber, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useChain } from "@/hooks/useChain";
import { CHAIN_LIST, type ChainKey } from "@/lib/deployment";
import { Button, Segmented } from "./ui";

/** Parallax mark: one point seen from two vantage points (the pool's chain and Reactive's). */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden>
      <path d="M8 21 14 7" fill="none" strokeWidth="2.2" strokeLinecap="round" className="stroke-muted" />
      <path d="M14 21 20 7" fill="none" strokeWidth="2.2" strokeLinecap="round" className="stroke-active" />
      <circle cx="17" cy="14" r="1.9" className="fill-ink" />
    </svg>
  );
}

function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/** Which chain the forms, balances and price act on. The feed always shows both. */
export function ChainSwitch() {
  const { chain, setChain } = useChain();
  const mounted = useMounted();
  if (!mounted) return <div className="h-[34px] w-40" />;
  return (
    <Segmented<ChainKey>
      label="Chain"
      options={CHAIN_LIST.map((c) => c.key)}
      value={chain.key}
      onChange={setChain}
      render={(k) => {
        const c = CHAIN_LIST.find((x) => x.key === k)!;
        return (
          <>
            {c.name} <span className="num text-faint">{c.blockMs} ms</span>
          </>
        );
      }}
    />
  );
}

/** Freshness stamp: the selected chain's latest block, updating live. */
export function BlockStamp() {
  const { chain } = useChain();
  const mounted = useMounted();
  const { data: block } = useBlockNumber({ chainId: chain.chainId, watch: true });
  if (!mounted) return null;
  return (
    <span className="hidden items-center gap-2 whitespace-nowrap text-[12px] text-faint lg:flex" title={`Latest ${chain.name} block`}>
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-executed" />
      <span className="num">{block ? `#${block.toLocaleString("en-US")}` : "…"}</span>
    </span>
  );
}

export function WalletButton() {
  const mounted = useMounted();
  const { chain } = useChain();
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  if (!mounted) return <div className="h-[34px] w-36" />;
  if (isConnected && chainId !== chain.chainId)
    return (
      <Button variant="danger" onClick={() => switchChain({ chainId: chain.chainId })} disabled={switching}>
        {switching ? "Switching…" : `Switch to ${chain.short}`}
      </Button>
    );
  if (isConnected)
    return (
      <Button variant="ghost" onClick={() => disconnect()} title="Disconnect">
        <span className="h-1.5 w-1.5 rounded-full bg-executed" />
        <span className="num">
          {address!.slice(0, 6)}…{address!.slice(-4)}
        </span>
      </Button>
    );
  return (
    <Button onClick={() => connectors[0] && connect({ connector: connectors[0], chainId: chain.chainId })} disabled={isPending || connectors.length === 0}>
      {connectors.length === 0 ? "No wallet found" : isPending ? "Connecting…" : "Connect wallet"}
    </Button>
  );
}
