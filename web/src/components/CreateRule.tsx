"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { parseUnits, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { usePool } from "@/hooks/usePool";
import { useTxFlow, type Step } from "@/hooks/useTxFlow";
import { useBalances } from "@/hooks/useBalances";
import { mockErc20Abi, positionManagerAbi, parallaxExecutorAbi } from "@/lib/abis";
import { chainClients } from "@/lib/clients";
import { useChain } from "@/hooks/useChain";
import { WETH_DECIMALS, WETH_IS_CURRENCY0, poolKeyOf, type ChainDeployment } from "@/lib/deployment";
import { boundsForPrice, fmtToken, fmtUsd, tickToPrice } from "@/lib/price";
import { Button, Field, Panel, Segmented, Slider, TxLink, cx, inputClass } from "./ui";

type Tab = "stop" | "take" | "trail" | "range";
const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: "stop", label: "Stop-loss", blurb: "Sell if the price falls to your level" },
  { id: "take", label: "Take-profit", blurb: "Sell if the price rises to your target" },
  { id: "trail", label: "Trailing", blurb: "Sell if the price falls a set % below its best level; the stop follows the price up" },
  { id: "range", label: "Range guard", blurb: "Keep LP liquidity in range: re-centre it, or pull it out" },
];
const SLIPPAGE = [50, 100, 300, 500];

export function CreateRule() {
  const [tab, setTab] = useState<Tab>("stop");
  return (
    <Panel title="Protect a position" i={1}>
      <Segmented<Tab>
        label="Rule type"
        options={TABS.map((t) => t.id)}
        value={tab}
        onChange={setTab}
        render={(id) => TABS.find((t) => t.id === id)!.label}
        className="overflow-x-auto"
      />
      <p className="mt-4 text-[15px] text-muted">{TABS.find((t) => t.id === tab)!.blurb}</p>
      <div className="mt-6">
        <div key={tab} className="m-fade">
          {tab === "range" ? <RangeGuardForm /> : tab === "trail" ? <TrailingForm /> : <PriceRuleForm kind={tab} key={tab} />}
        </div>
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Stop-loss / take-profit
// ─────────────────────────────────────────────────────────────────────────────

function PriceRuleForm({ kind }: { kind: "stop" | "take" }) {
  const { chain } = useChain();
  const isStop = kind === "stop";
  const { address } = useAccount();
  const { price } = usePool(chain);
  const { weth } = useBalances(address, chain);
  const flow = useTxFlow();

  const [trigger, setTrigger] = useState("");
  const [amount, setAmount] = useState("1");
  const [slippage, setSlippage] = useState(300);
  const [editing, setEditing] = useState(false);

  // Default the trigger 3% away from the live price, once.
  useEffect(() => {
    if (price && trigger === "") setTrigger((price * (isStop ? 0.97 : 1.03)).toFixed(2));
  }, [price, trigger, isStop]);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: chain.mockWETH,
    abi: mockErc20Abi,
    functionName: "allowance",
    args: [address!, chain.executor],
    chainId: chain.chainId,
    query: { enabled: Boolean(address) },
  });

  const t = Number(trigger);
  const a = Number(amount);
  const movePct = price && t ? ((t - price) / price) * 100 : undefined;
  const wrongSide = price !== undefined && t > 0 && (isStop ? t >= price : t <= price);
  const insufficient = weth !== undefined && a > weth;
  const valid = t > 0 && a > 0 && !wrongSide && !insufficient;

  const bounds = valid ? boundsForPrice(t, isStop) : undefined;

  async function submit() {
    if (!bounds || !address) return;
    const amountIn = parseUnits(amount, WETH_DECIMALS);
    const steps: Step[] = [];
    if ((allowance ?? 0n) < amountIn) {
      steps.push({
        label: "Approve mWETH",
        request: { address: chain.mockWETH, abi: mockErc20Abi, functionName: "approve", args: [chain.executor, amountIn], chainId: chain.chainId },
      });
    }
    steps.push({
      label: isStop ? "Arm stop-loss" : "Arm take-profit",
      request: {
        address: chain.executor,
        abi: parallaxExecutorAbi,
        functionName: "createRule",
        args: [poolKeyOf(chain), isStop ? 0 : 1, WETH_IS_CURRENCY0, bounds.lower, bounds.upper, amountIn, slippage],
        chainId: chain.chainId,
      },
    });
    await flow.run(steps);
    refetchAllowance();
  }

  // The slider sets how far from the live price the line sits (0.5–15%).
  const dist = movePct !== undefined ? Math.min(15, Math.max(0.5, Math.abs(movePct))) : 3;
  const setDist = (d: number) => price && setTrigger((price * (isStop ? 1 - d / 100 : 1 + d / 100)).toFixed(2));
  const AMOUNTS = ["0.25", "0.5", "1", "Max"] as const;
  const amountKey = (AMOUNTS as readonly string[]).includes(amount) ? amount : weth !== undefined && a === Number(weth.toFixed(4)) ? "Max" : "";

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[13px] text-muted">{isStop ? "Sell if the price falls to" : "Sell if the price rises to"}</div>
          {editing ? (
            <input
              autoFocus
              className={cx(inputClass, "mt-2 w-48 text-[28px] font-semibold", wrongSide && "ring-danger")}
              inputMode="decimal"
              type="number"
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              onBlur={() => setEditing(false)}
              aria-label="Trigger price"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="num m-lift mt-1 block text-[44px] font-semibold leading-[52px] tracking-[-0.03em] text-ink"
              title="Type an exact price"
            >
              {t ? `$${fmtUsd(t)}` : "—"}
            </button>
          )}
        </div>
        {movePct !== undefined && (
          <span className={cx("num mb-2 rounded-full px-3 py-1 text-[14px] font-medium", movePct < 0 ? "bg-danger/15 text-danger" : "bg-executed/15 text-executed")}>
            {movePct > 0 ? "+" : ""}
            {movePct.toFixed(1)}%
          </span>
        )}
      </div>

      <div className="mt-5">
        <Slider label="Distance from the live price" min={0.5} max={15} step={0.1} value={dist} onChange={setDist} />
        <div className="num mt-1 flex justify-between text-[13px] text-faint">
          <span>{price ? `now $${fmtUsd(price)}` : ""}</span>
          <button type="button" className="text-muted hover:text-ink" onClick={() => setEditing(true)}>
            Type an exact price
          </button>
        </div>
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-muted">
          Amount <span className="num text-faint">{weth !== undefined ? `· you have ${fmtToken(weth, 3)} mWETH` : ""}</span>
        </div>
        <Segmented<string>
          label="Amount"
          options={AMOUNTS}
          value={amountKey || "1"}
          onChange={(v) => setAmount(v === "Max" ? (weth !== undefined ? weth.toFixed(4) : "0") : v)}
          render={(v) => <span className="num">{v === "Max" ? "Max" : `${v}`}</span>}
        />
      </div>

      <details className="group mt-5">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] text-muted transition-colors hover:text-ink">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="transition-transform duration-300 group-open:rotate-90">
            <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Advanced · max slippage {slippage / 100}%
        </summary>
        <div className="m-open mt-3">
          <Segmented<number> label="Max slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} render={(v) => <span className="num">{v / 100}%</span>} />
        </div>
      </details>

      <p className="mt-7 text-[17px] leading-7 text-ink">
        {wrongSide ? (
          <span className="text-danger">
            A {isStop ? "stop-loss" : "take-profit"} must be {isStop ? "below" : "above"} the current price.
          </span>
        ) : insufficient ? (
          <span className="text-danger">Not enough mWETH. Get test tokens first.</span>
        ) : (
          <>
            Sell <span className="num font-semibold">{amount || "0"} mWETH</span> the moment the price {isStop ? "falls to" : "rises to"}{" "}
            <span className="num font-semibold">${t ? fmtUsd(t) : "…"}</span>.
          </>
        )}
      </p>

      <div className="mt-6">
        <SubmitRow
          disabled={!address || !valid || flow.busy}
          label={!address ? "Connect a wallet" : isStop ? "Protect with a stop-loss" : "Set a take-profit"}
          onClick={submit}
          flow={flow}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trailing stop
// ─────────────────────────────────────────────────────────────────────────────

const TRAILS = [100, 200, 300, 500]; // ticks ≈ bps: 1%, 2%, 3%, 5%

function TrailingForm() {
  const { chain } = useChain();
  const { address } = useAccount();
  const { price } = usePool(chain);
  const { weth } = useBalances(address, chain);
  const flow = useTxFlow();
  const [amount, setAmount] = useState("1");
  const [trail, setTrail] = useState(300);
  const [slippage, setSlippage] = useState(300);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: chain.mockWETH,
    abi: mockErc20Abi,
    functionName: "allowance",
    args: [address!, chain.executor],
    chainId: chain.chainId,
    query: { enabled: Boolean(address) },
  });

  const a = Number(amount);
  const insufficient = weth !== undefined && a > weth;
  const valid = a > 0 && !insufficient;
  const startStop = price !== undefined ? price * (1 - trail / 10_000) : undefined;

  async function submit() {
    if (!address || !valid) return;
    const amountIn = parseUnits(amount, WETH_DECIMALS);
    const steps: Step[] = [];
    if ((allowance ?? 0n) < amountIn) {
      steps.push({
        label: "Approve mWETH",
        request: { address: chain.mockWETH, abi: mockErc20Abi, functionName: "approve", args: [chain.executor, amountIn], chainId: chain.chainId },
      });
    }
    // Selling WETH; its price moves WITH the tick iff WETH is currency0, so the stop sits below the tick then.
    steps.push({
      label: "Arm trailing stop",
      request: {
        address: chain.executor,
        abi: parallaxExecutorAbi,
        functionName: "createTrailingStop",
        args: [poolKeyOf(chain), WETH_IS_CURRENCY0, WETH_IS_CURRENCY0, trail, amountIn, slippage],
        chainId: chain.chainId,
      },
    });
    await flow.run(steps);
    refetchAllowance();
  }

  return (
    <div className="space-y-4">
      <Field label="Trail distance" hint={price ? `now $${fmtUsd(price)}` : undefined}>
        <Segmented<number> label="Trail distance" options={TRAILS} value={trail} onChange={setTrail} render={(v) => <span className="num">{v / 100}%</span>} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount" hint={weth !== undefined ? `bal ${fmtToken(weth, 3)}` : undefined}>
          <div className="relative">
            <input className={cx(inputClass, "pr-16", insufficient && "ring-danger")} inputMode="decimal" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] text-faint">mWETH</span>
          </div>
        </Field>
        <Field label="Max slippage">
          <Segmented<number> label="Max slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} render={(v) => <span className="num">{v / 100}%</span>} />
        </Field>
      </div>

      <Preview>
        {insufficient ? (
          <span className="text-danger">Not enough mWETH. Grab some from the demo panel.</span>
        ) : (
          <>
            Sell <b className="num text-ink">{amount || "0"} mWETH</b> if the price falls <b className="num text-ink">{trail / 100}%</b> below
            its best level from now on. The stop starts at <b className="num text-ink">${startStop ? fmtUsd(startStop) : "…"}</b> and only
            moves up: Reactive asks to raise it as the price climbs, and the executor checks every raise against the live price.
          </>
        )}
      </Preview>

      <SubmitRow disabled={!address || !valid || flow.busy} label={!address ? "Connect a wallet" : "Arm trailing stop"} onClick={submit} flow={flow} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Range guard
// ─────────────────────────────────────────────────────────────────────────────

/** Signed 24-bit decode of PositionInfo: tickLower at bit 8, tickUpper at bit 32 (PositionInfoLibrary). */
function decodeTicks(info: bigint) {
  const s24 = (v: bigint) => {
    const n = Number(v & 0xffffffn);
    return n >= 0x800000 ? n - 0x1000000 : n;
  };
  return { tickLower: s24(info >> 8n), tickUpper: s24(info >> 32n) };
}

/** Best-effort list of the user's v4 LP NFTs, via Blockscout's ERC-721 transfer index. */
function useMyPositions(chain: ChainDeployment, user?: Address) {
  return useQuery({
    queryKey: ["positions", chain.key, user],
    enabled: Boolean(user),
    refetchInterval: 15_000,
    queryFn: async () => {
      const url = `${chain.blockscoutApi}?module=account&action=tokennfttx&address=${user}&contractaddress=${chain.positionManager}`;
      const json = (await (await fetch(url)).json()) as { result?: { tokenID: string }[] };
      const ids = [...new Set((json.result ?? []).map((t) => t.tokenID))].map(BigInt);
      const owned = await Promise.all(
        ids.map(async (id) => {
          try {
            const [owner, liq] = await Promise.all([
              chainClients[chain.key].readContract({ address: chain.positionManager, abi: positionManagerAbi, functionName: "ownerOf", args: [id] }),
              chainClients[chain.key].readContract({ address: chain.positionManager, abi: positionManagerAbi, functionName: "getPositionLiquidity", args: [id] }),
            ]);
            return owner.toLowerCase() === user!.toLowerCase() && liq > 0n ? id : null;
          } catch {
            return null;
          }
        }),
      );
      return owned.filter((x): x is bigint => x !== null).sort((a, b) => Number(b - a));
    },
  });
}

function RangeGuardForm() {
  const { chain } = useChain();
  const { address } = useAccount();
  const { tick } = usePool(chain);
  const flow = useTxFlow();
  const { data: myPositions } = useMyPositions(chain, address);
  const [idText, setIdText] = useState("");
  const [slippage, setSlippage] = useState(300);
  const [recenter, setRecenter] = useState(true);

  useEffect(() => {
    if (idText === "" && myPositions?.length) setIdText(myPositions[0].toString());
  }, [myPositions, idText]);

  const positionId = /^\d+$/.test(idText) ? BigInt(idText) : undefined;

  const { data: pos } = useQuery({
    queryKey: ["position", chain.key, positionId?.toString()],
    enabled: positionId !== undefined,
    refetchInterval: 4_000,
    queryFn: async () => {
      const [owner, liquidity, info, approved] = await Promise.all([
        chainClients[chain.key].readContract({ address: chain.positionManager, abi: positionManagerAbi, functionName: "ownerOf", args: [positionId!] }),
        chainClients[chain.key].readContract({ address: chain.positionManager, abi: positionManagerAbi, functionName: "getPositionLiquidity", args: [positionId!] }),
        chainClients[chain.key].readContract({ address: chain.positionManager, abi: positionManagerAbi, functionName: "positionInfo", args: [positionId!] }),
        chainClients[chain.key].readContract({ address: chain.positionManager, abi: positionManagerAbi, functionName: "getApproved", args: [positionId!] }),
      ]);
      // PositionInfo's top 25 bytes are the first 25 bytes of the poolId.
      const poolPrefix = `0x${info.toString(16).padStart(64, "0").slice(0, 50)}`;
      return { owner, liquidity, approved, samePool: chain.poolId.toLowerCase().startsWith(poolPrefix), ...decodeTicks(info) };
    },
  });

  const mine = pos && address && pos.owner.toLowerCase() === address.toLowerCase();
  const inRange = pos && tick !== undefined && tick >= pos.tickLower && tick < pos.tickUpper;
  const [pLo, pHi] = pos ? [tickToPrice(pos.tickLower), tickToPrice(pos.tickUpper)].sort((x, y) => x - y) : [];
  const problem = !pos
    ? undefined
    : !mine
      ? "This position isn't owned by your wallet."
      : !pos.samePool
        ? "This position is in a different pool."
        : pos.liquidity === 0n
          ? "This position has no liquidity."
          : !inRange
            ? "This position is already out of range; nothing to guard."
            : undefined;

  async function submit() {
    if (positionId === undefined || !pos) return;
    const steps: Step[] = [];
    if (pos.approved.toLowerCase() !== chain.executor.toLowerCase()) {
      steps.push({
        label: "Approve LP NFT",
        request: { address: chain.positionManager, abi: positionManagerAbi, functionName: "approve", args: [chain.executor, positionId], chainId: chain.chainId },
      });
    }
    steps.push({
      label: "Arm range guard",
      request: { address: chain.executor, abi: parallaxExecutorAbi, functionName: "createRangeGuard", args: [positionId, slippage, recenter], chainId: chain.chainId },
    });
    await flow.run(steps);
  }

  return (
    <div className="space-y-4">
      <Field
        label="LP position (Uniswap v4 NFT id)"
        hint={myPositions?.length ? `${myPositions.length} found in your wallet` : undefined}
      >
        {myPositions && myPositions.length > 0 ? (
          <select className={cx(inputClass, "appearance-none")} value={idText} onChange={(e) => setIdText(e.target.value)}>
            {myPositions.map((id) => (
              <option key={id.toString()} value={id.toString()}>
                #{id.toString()}
              </option>
            ))}
          </select>
        ) : (
          <input className={inputClass} placeholder="e.g. 8025" value={idText} onChange={(e) => setIdText(e.target.value.trim())} />
        )}
      </Field>

      {pos && (
        <div className="rounded-[6px] bg-raised p-4">
          <RangeBar lo={pos.tickLower} hi={pos.tickUpper} tick={tick} />
          <div className="mt-3 flex items-center justify-between text-[12px]">
            <span className="num text-muted">
              ${fmtUsd(pLo!)} – ${fmtUsd(pHi!)}
            </span>
            <span className={inRange ? "text-executed" : "text-danger"}>{inRange ? "in range, earning fees" : "out of range"}</span>
          </div>
        </div>
      )}

      <label className="flex cursor-pointer items-start gap-3 rounded-[6px] bg-raised p-3.5">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--executed))]" checked={recenter} onChange={(e) => setRecenter(e.target.checked)} />
        <span className="text-[13px] leading-snug">
          <span className="font-medium text-ink">Re-centre automatically</span>
          <span className="block text-[12px] text-muted">
            When the price leaves your range, re-open the same-width position around the new price and keep guarding it.
            Off = just withdraw everything to you.
          </span>
        </span>
      </label>

      <Field label="Max slippage">
        <Segmented<number> label="Max slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} render={(v) => <span className="num">{v / 100}%</span>} />
      </Field>

      <Preview>
        {problem ? (
          <span className="text-danger">{problem}</span>
        ) : pos ? (
          <>
            Watch position <b className="num text-ink">#{idText}</b>. The moment the price leaves{" "}
            <b className="num text-ink">${fmtUsd(pLo!)}–${fmtUsd(pHi!)}</b>,{" "}
            {recenter
              ? "re-open the liquidity as a same-width position centred on the new price, and keep guarding it. You can cancel any time to get the position back."
              : "withdraw all liquidity and fees back to you and return the NFT."}
          </>
        ) : (
          <>
            Pick one of your LP positions. No position yet? Run <code className="num text-ink">./tw.sh create-range-guard</code> to mint
            a demo one.
          </>
        )}
      </Preview>

      <SubmitRow
        disabled={!address || !pos || Boolean(problem) || flow.busy}
        label={!address ? "Connect a wallet" : "Arm range guard"}
        onClick={submit}
        flow={flow}
      />
    </div>
  );
}

/** Mini visual: the position's range on a track, with the live price marker. */
function RangeBar({ lo, hi, tick }: { lo: number; hi: number; tick?: number }) {
  const pad = (hi - lo) * 0.6;
  const min = lo - pad;
  const max = hi + pad;
  const pct = (v: number) => `${Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100))}%`;
  const inRange = tick !== undefined && tick >= lo && tick < hi;
  return (
    <div className="relative h-8">
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-raised" />
      <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-active/60" style={{ left: pct(lo), right: `calc(100% - ${pct(hi)})` }} />
      {tick !== undefined && (
        <div className="absolute top-0 h-8 w-px -translate-x-1/2" style={{ left: pct(tick) }}>
          <div className={cx("mx-auto h-full w-0.5 rounded-full", inRange ? "bg-executed" : "bg-danger")} />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Preview({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[6px] bg-raised px-4 py-3 text-[14px] leading-relaxed text-ink">{children}</div>
  );
}

function SubmitRow({
  disabled,
  label,
  onClick,
  flow,
}: {
  disabled: boolean;
  label: string;
  onClick: () => void;
  flow: ReturnType<typeof useTxFlow>;
}) {
  const { chain } = useChain();
  const s = flow.state;
  const pendingLabel = useMemo(
    () => (s.status === "running" ? `${s.step}${s.total > 1 ? ` (${s.index + 1}/${s.total})` : ""}…` : null),
    [s],
  );
  return (
    <div className="space-y-2">
      <Button
        size="lg"
        className="w-full"
        disabled={disabled}
        onClick={onClick}
        busy={s.status === "running"}
        progress={s.status === "running" ? (s.index + (s.hash ? 0.5 : 0.15)) / s.total : undefined}
      >
        {pendingLabel ?? label}
      </Button>
      {s.status === "done" && (
        <p className="m-fade text-[12px] text-executed">
          Armed: <TxLink href={chain.explorerTx(s.hash)} hash={s.hash} />. Reactive mirrors it within a few seconds.
        </p>
      )}
      {s.status === "error" && <p className="text-[12px] text-danger">{s.message}</p>}
    </div>
  );
}
