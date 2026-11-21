"use client";

import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { useChain } from "@/hooks/useChain";
import { useTxFlow } from "@/hooks/useTxFlow";
import { parallaxExecutorAbi } from "@/lib/abis";
import { chainClients } from "@/lib/clients";
import { CHAINS, type ChainKey } from "@/lib/deployment";
import { Button, Panel, TxLink } from "./ui";

type Remote = { key: ChainKey; tx?: Hex; closed?: number; at?: number };

/**
 * Panic Exit: one transaction on this chain closes every rule you have here, and Reactive relays it so your rules
 * on the other chain close too. Each rule sells at market within its own slippage cap, or is refunded if it can't.
 */
export function PanicPanel() {
  const { chain } = useChain();
  const { address } = useAccount();
  const flow = useTxFlow();
  const other = chain.key === "base" ? CHAINS.unichain : CHAINS.base;
  const [sentAt, setSentAt] = useState<number>();
  const [remote, setRemote] = useState<Remote>();

  const { data: counts, refetch } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(address), refetchInterval: 6000 },
    contracts: [CHAINS.base, CHAINS.unichain].map((c) => ({
      address: c.executor,
      abi: parallaxExecutorAbi,
      functionName: "activeRulesOf",
      args: [address!],
      chainId: c.chainId,
    })),
  });
  const active = { base: Number(counts?.[0]?.result ?? 0n), unichain: Number(counts?.[1]?.result ?? 0n) };
  const total = active.base + active.unichain;

  // After a panic, wait for the relayed PanicExecuted on the other chain.
  useEffect(() => {
    if (!sentAt || !address || remote?.tx) return;
    const client = chainClients[other.key];
    let from: bigint | undefined;
    const id = setInterval(async () => {
      try {
        from ??= (await client.getBlockNumber()) - 50n;
        const [log] = await client.getContractEvents({
          address: other.executor,
          abi: parallaxExecutorAbi,
          eventName: "PanicExecuted",
          args: { owner: address },
          fromBlock: from,
        });
        if (log) {
          setRemote({ key: other.key, tx: log.transactionHash, closed: Number(log.args.closed), at: Date.now() });
          refetch();
        }
      } catch {
        /* retry next tick */
      }
    }, 800);
    return () => clearInterval(id);
  }, [sentAt, address, other, remote?.tx, refetch]);

  async function onPanic() {
    setRemote(undefined);
    setSentAt(undefined);
    const hash = await flow.run([
      { label: "Panic", request: { address: chain.executor, abi: parallaxExecutorAbi, functionName: "panic", args: [], chainId: chain.chainId } },
    ]);
    if (hash) {
      setSentAt(Date.now());
      refetch();
    }
  }

  return (
    <Panel i={4} title="Panic Exit" aside={<span className="num text-[13px] text-faint">{address ? `${total} active` : ""}</span>}>
      <p className="text-[14px] text-muted">
        Close everything, everywhere, with one transaction. Your rules on {chain.short} close in that same transaction;
        Reactive closes the ones on {other.short}.
      </p>
      <div className="num mt-4 grid grid-cols-2 gap-2 text-[13px]">
        {(["base", "unichain"] as const).map((k) => (
          <div key={k} className="rounded-[12px] bg-raised/50 px-3 py-2">
            <div className="text-faint">{CHAINS[k].short}</div>
            <div className="text-[20px] font-semibold text-ink">{address ? active[k] : "–"}</div>
            <div className="text-faint">active rules</div>
          </div>
        ))}
      </div>
      <Button className="mt-4 w-full" variant="danger" disabled={!address || total === 0 || flow.busy} busy={flow.busy} onClick={onPanic}>
        {flow.busy ? "Closing…" : `Panic: close all ${total || ""} on both chains`}
      </Button>
      {flow.state.status === "done" && (
        <div className="m-fade mt-3 grid gap-1 text-[13px] text-muted">
          <span>
            {chain.short}: closed in <TxLink href={chain.explorerTx(flow.state.hash)} hash={flow.state.hash} />
          </span>
          <span>
            {other.short}:{" "}
            {remote?.tx ? (
              <>
                closed {remote.closed} in <TxLink href={other.explorerTx(remote.tx)} hash={remote.tx} />
                {sentAt && remote.at ? ` · ${((remote.at - sentAt) / 1000).toFixed(1)} s later` : ""}
              </>
            ) : (
              "waiting for Reactive…"
            )}
          </span>
        </div>
      )}
      {flow.state.status === "error" && <p className="m-fade mt-3 text-[13px] text-danger">{flow.state.message}</p>}
    </Panel>
  );
}
