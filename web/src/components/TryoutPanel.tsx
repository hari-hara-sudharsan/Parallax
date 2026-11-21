"use client";

import { useEffect, useRef, useState } from "react";
import { parseEventLogs, type Hex } from "viem";
import { useAccount } from "wagmi";
import { useChain } from "@/hooks/useChain";
import { useTxFlow } from "@/hooks/useTxFlow";
import { parallaxExecutorAbi, parallaxReactiveAbi, parallaxTryoutAbi } from "@/lib/abis";
import { chainClients, lasnaClient } from "@/lib/clients";
import { LINKS, REACTIVE } from "@/lib/deployment";
import { Button, Chip, Panel, TxLink } from "./ui";

type Run = {
  ruleId: bigint;
  armTx: Hex;
  mirrored: boolean;
  lasnaFrom: bigint;
  crashTx?: Hex;
  crashBlock?: bigint;
  crashAt?: number; //   wall clock (ms) when the crash receipt arrived
  reactiveTx?: Hex;
  callbackTx?: Hex;
  latencyBlocks?: number;
  filledAt?: number;
};

const POLL_MS = 600;

/**
 * The zero-setup judge path. ParallaxTryout mints its own demo tokens, so a wallet with only a little gas can run
 * a real loop: arm a funded stop one tick spacing below the price, then crash the price just past it. Reactive
 * Network does everything after that, and this panel follows each hop on its own chain.
 */
export function TryoutPanel() {
  const { chain } = useChain();
  const { address } = useAccount();
  const arm = useTxFlow();
  const crash = useTxFlow();
  const [run, setRun] = useState<Run | null>(null);
  const [now, setNow] = useState(Date.now());
  const runRef = useRef(run);
  runRef.current = run;

  // Tick a clock while a loop is in flight so the timer moves.
  useEffect(() => {
    if (!run?.crashAt || run.filledAt) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [run?.crashAt, run?.filledAt]);

  // Follow the loop: mirrored on Lasna → (after the crash) RuleTriggered on Lasna → execution record on the executor.
  // Restart polling only when a new rule is armed (or the chain changes); the loop reads the latest run from runRef.
  const ruleId = run?.ruleId;
  useEffect(() => {
    if (ruleId === undefined) return;
    let stop = false;
    const id = setInterval(async () => {
      const r = runRef.current;
      if (!r || stop) return;
      try {
        if (!r.mirrored) {
          const m = await lasnaClient.readContract({
            address: REACTIVE.address,
            abi: parallaxReactiveAbi,
            functionName: "mirror",
            args: [BigInt(chain.chainId), r.ruleId],
          });
          if ((m as { exists: boolean }).exists) setRun((x) => (x ? { ...x, mirrored: true } : x));
        }
        if (r.crashTx && !r.reactiveTx) {
          const logs = await lasnaClient.getContractEvents({
            address: REACTIVE.address,
            abi: parallaxReactiveAbi,
            eventName: "RuleTriggered",
            args: { chainId: BigInt(chain.chainId), ruleId: r.ruleId },
            fromBlock: r.lasnaFrom,
          });
          if (logs[0]) setRun((x) => (x ? { ...x, reactiveTx: logs[0].transactionHash } : x));
        }
        if (r.crashTx && !r.callbackTx) {
          const e = (await chainClients[chain.key].readContract({
            address: chain.executor,
            abi: parallaxExecutorAbi,
            functionName: "executions",
            args: [r.ruleId],
          })) as readonly [bigint, bigint, bigint, bigint];
          if (e[2] > 0n) {
            const [log] = await chainClients[chain.key].getContractEvents({
              address: chain.executor,
              abi: parallaxExecutorAbi,
              eventName: "RuleExecuted",
              args: { ruleId: r.ruleId },
              fromBlock: e[2],
              toBlock: e[2],
            });
            setRun((x) =>
              x ? { ...x, callbackTx: log?.transactionHash, latencyBlocks: Number(e[2] - e[1]), filledAt: Date.now() } : x,
            );
          }
        }
      } catch {
        /* public RPCs blip; the next poll retries */
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [ruleId, chain]);

  async function onArm() {
    setRun(null);
    crash.reset();
    const lasnaFrom = await lasnaClient.getBlockNumber().catch(() => 0n);
    const hash = await arm.run([
      { label: "Arm a stop", request: { address: chain.tryout, abi: parallaxTryoutAbi, functionName: "arm", args: [], chainId: chain.chainId } },
    ]);
    if (!hash) return;
    const receipt = await chainClients[chain.key].getTransactionReceipt({ hash });
    const [ev] = parseEventLogs({ abi: parallaxTryoutAbi, eventName: "Armed", logs: receipt.logs });
    if (ev) setRun({ ruleId: ev.args.ruleId, armTx: hash, mirrored: false, lasnaFrom });
  }

  async function onCrash() {
    if (!run) return;
    const hash = await crash.run([
      { label: "Crash the price", request: { address: chain.tryout, abi: parallaxTryoutAbi, functionName: "crash", args: [run.ruleId], chainId: chain.chainId } },
    ]);
    if (!hash) return;
    const receipt = await chainClients[chain.key].getTransactionReceipt({ hash });
    setRun((x) => (x ? { ...x, crashTx: hash, crashBlock: receipt.blockNumber, crashAt: Date.now() } : x));
  }

  const elapsed = run?.crashAt ? ((run.filledAt ?? now) - run.crashAt) / 1000 : 0;
  const err = [arm, crash].find((f) => f.state.status === "error");

  return (
    <Panel
      i={1}
      title="Run a loop yourself"
      aside={<Chip tone="active">only gas needed</Chip>}
    >
      <p className="text-[14px] text-muted">
        No tokens, no setup. The tryout contract arms a funded stop for you, then you crash the price through it.
        After that nobody presses anything: Reactive sees the swap, decides, and the executor sells.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button disabled={!address || arm.busy || crash.busy} busy={arm.busy} onClick={onArm}>
          {arm.busy ? "Arming…" : run ? "Arm another" : "1 · Arm a stop"}
        </Button>
        <Button
          variant="danger"
          disabled={!address || !run?.mirrored || Boolean(run?.crashTx) || crash.busy}
          busy={crash.busy}
          onClick={onCrash}
        >
          {crash.busy ? "Crashing…" : "2 · Crash it"}
        </Button>
      </div>
      {!address && <p className="mt-3 text-[13px] text-faint">Connect a wallet on {chain.name} to start.</p>}
      {err?.state.status === "error" && <p className="m-fade mt-3 text-[13px] text-danger">{err.state.message}</p>}

      {run && (
        <ol className="m-fade mt-5 grid gap-2 text-[13px]">
          <Hop
            n="0"
            label={`Stop armed (rule ${run.ruleId.toString()})`}
            done
            link={<TxLink href={chain.explorerTx(run.armTx)} hash={run.armTx} />}
            note={run.mirrored ? "mirrored on Lasna" : "waiting for Lasna to mirror it…"}
          />
          <Hop
            n="1"
            label="Origin: your crash swap"
            done={Boolean(run.crashTx)}
            link={run.crashTx && <TxLink href={chain.explorerTx(run.crashTx)} hash={run.crashTx} />}
          />
          <Hop
            n="2"
            label="Reactive: Lasna decides and requests the callback"
            done={Boolean(run.reactiveTx)}
            link={run.reactiveTx && <TxLink href={LINKS.lasnaTx(run.reactiveTx)} hash={run.reactiveTx} />}
          />
          <Hop
            n="3"
            label="Callback: the executor re-checks the price and sells"
            done={Boolean(run.callbackTx)}
            link={run.callbackTx && <TxLink href={chain.explorerTx(run.callbackTx)} hash={run.callbackTx} />}
          />
        </ol>
      )}

      {run?.crashAt && (
        <div className="m-fade mt-5 flex items-baseline justify-between rounded-[14px] bg-raised/60 px-4 py-3">
          <span className="text-[13px] text-muted">{run.filledAt ? "Filled" : "Waiting for Reactive…"}</span>
          <span className="num text-[22px] font-semibold tracking-[-0.02em]">
            {run.latencyBlocks !== undefined
              ? `${run.latencyBlocks} blocks · ${((run.latencyBlocks * chain.blockMs) / 1000).toFixed(1)} s`
              : `${elapsed.toFixed(1)} s`}
          </span>
        </div>
      )}
      {run?.latencyBlocks !== undefined && (
        <p className="m-fade mt-2 text-[12px] text-faint">
          Blocks counted from the executor’s own on-chain record (origin block → execution block). The wall clock above
          was {elapsed.toFixed(1)} s, which includes public-RPC polling.
        </p>
      )}
    </Panel>
  );
}

function Hop({ n, label, done, link, note }: { n: string; label: string; done: boolean; link?: React.ReactNode; note?: string }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-[12px] bg-raised/40 px-3 py-2">
      <span className="flex min-w-0 items-center gap-2">
        <span className={done ? "text-executed" : "text-faint"}>{done ? "●" : "○"}</span>
        <span className="num text-faint">{n}</span>
        <span className="truncate text-ink">{label}</span>
        {note && <span className="hidden truncate text-faint sm:inline">· {note}</span>}
      </span>
      <span className="shrink-0">{link ?? <span className="text-faint">…</span>}</span>
    </li>
  );
}
