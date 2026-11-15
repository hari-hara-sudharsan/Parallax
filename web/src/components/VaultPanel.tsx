"use client";

import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useAccount } from "wagmi";
import { useBalances } from "@/hooks/useBalances";
import { useTxFlow, type Step } from "@/hooks/useTxFlow";
import { useVaultHistory, useVaultState, type VaultEvent } from "@/hooks/useVault";
import { mockErc20Abi, parallaxVaultAbi } from "@/lib/abis";
import { CHAINS, LINKS, USDC_DECIMALS, VAULT, WETH_DECIMALS, WETH_IS_CURRENCY0 } from "@/lib/deployment";
import { fmtToken, tickToPrice } from "@/lib/price";
import { Button, Chip, Field, Panel, TxLink, cx, inputClass } from "./ui";

const chain = CHAINS[VAULT.chain];
const usd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Price band of a tick range, low → high (the demo pool's axis is inverted, so sort). */
function band(tl: number, tu: number) {
  const a = tickToPrice(tl);
  const b = tickToPrice(tu);
  return [Math.min(a, b), Math.max(a, b)] as const;
}

const LABEL: Record<string, string> = {
  deposit: "Deposit",
  withdraw: "Withdraw",
  rebalance: "Re-centred",
  evacuate: "Evacuated",
  reenter: "Re-entered",
};

function eventLabel(e: VaultEvent) {
  if (e.kind === "skipped") return `Skipped ${LABEL[e.reason!]?.toLowerCase() ?? ""} (condition no longer true)`;
  if (e.kind === "positioned" && e.reason === "deposit") return "Opened position";
  return LABEL[e.reason ?? e.kind] ?? e.kind;
}

export function VaultPanel() {
  const { address } = useAccount();
  const { data: s } = useVaultState(address);
  const { data: history } = useVaultHistory();
  const { weth, usdc, refetch } = useBalances(address, chain);
  const flow = useTxFlow();
  const [wethIn, setWethIn] = useState("1");
  const [usdcIn, setUsdcIn] = useState("2000");

  const price = s ? tickToPrice(s.tick) : undefined;
  const range = s && s.mode === "positioned" ? band(s.tickLower, s.tickUpper) : undefined;
  const tvl = s ? Number(formatUnits(s.totalValue0, USDC_DECIMALS)) : undefined; // currency0 is mUSDC
  const mine = s && s.totalSupply > 0n ? (Number(s.myShares) / Number(s.totalSupply)) * (tvl ?? 0) : 0;

  const status =
    !s ? null : s.mode === "evacuated" ? (
      <Chip tone="danger">Evacuated · waiting for calm</Chip>
    ) : s.mode === "empty" ? (
      <Chip tone="cancelled">Empty</Chip>
    ) : s.inRange ? (
      <Chip tone="executed" pulse>In range · earning fees</Chip>
    ) : (
      <Chip tone="triggered" pulse>Out of range · re-centring</Chip>
    );

  async function deposit() {
    const w = parseUnits(wethIn || "0", WETH_DECIMALS);
    const u = parseUnits(usdcIn || "0", USDC_DECIMALS);
    const [a0, a1] = WETH_IS_CURRENCY0 ? [w, u] : [u, w];
    const steps: Step[] = [];
    if (w > 0n) steps.push({ label: "Approve mWETH", request: { address: chain.mockWETH, abi: mockErc20Abi, functionName: "approve", args: [VAULT.address, w], chainId: chain.chainId } });
    if (u > 0n) steps.push({ label: "Approve mUSDC", request: { address: chain.mockUSDC, abi: mockErc20Abi, functionName: "approve", args: [VAULT.address, u], chainId: chain.chainId } });
    steps.push({ label: "Deposit", request: { address: VAULT.address, abi: parallaxVaultAbi, functionName: "deposit", args: [a0, a1], chainId: chain.chainId } });
    await flow.run(steps);
    refetch();
  }

  async function withdrawAll() {
    if (!s?.myShares) return;
    await flow.run([{ label: "Withdraw", request: { address: VAULT.address, abi: parallaxVaultAbi, functionName: "withdraw", args: [s.myShares], chainId: chain.chainId } }]);
    refetch();
  }

  // Where the price sits inside the band (0–100%), for the range bar.
  const pos = range && price ? Math.max(0, Math.min(100, ((price - range[0]) / (range[1] - range[0])) * 100)) : undefined;

  return (
    <Panel title="Parallax Vault · keeperless LP on Base" aside={status}>
      <p className="text-[13px] leading-relaxed text-muted">
        Deposit once. The vault keeps your liquidity around the price, <span className="text-ink">steps out of a crash</span> the
        moment it starts, and goes back in when the market is calm. Reactive Network triggers every move; no bot, no server.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Vault value", tvl !== undefined ? `$${usd(tvl)}` : "–"],
          ["Re-centred", s?.rebalances ?? "–"],
          ["Evacuated", s?.evacuations ?? "–"],
          ["Re-entered", s?.reentries ?? "–"],
        ].map(([k, v]) => (
          <div key={k as string} className="rounded-xl border border-line bg-bg px-3 py-2.5">
            <div className="text-[11px] text-faint">{k}</div>
            <div className="num mt-0.5 text-[15px] text-ink">{v}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-line bg-bg px-4 py-3">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted">Price</span>
          <span className="num text-ink">{price ? `$${usd(price)}` : "–"}</span>
        </div>
        {range ? (
          <>
            <div className="relative mt-3 h-2 rounded-full bg-raised">
              <div className={cx("absolute inset-y-0 rounded-full", s?.inRange ? "bg-executed/40" : "bg-triggered/40")} style={{ left: 0, right: 0 }} />
              {pos !== undefined && (
                <div className="absolute -top-1 h-4 w-0.5 rounded bg-ink" style={{ left: `calc(${pos}% - 1px)` }} title="current price" />
              )}
            </div>
            <div className="num mt-1.5 flex justify-between text-[11px] text-faint">
              <span>${usd(range[0])}</span>
              <span>liquidity range (±{VAULT.halfWidthTicks / 100}%)</span>
              <span>${usd(range[1])}</span>
            </div>
          </>
        ) : (
          <p className="mt-2 text-[11px] text-faint">
            {s?.mode === "evacuated"
              ? `All liquidity is out of the pool. It re-enters ${VAULT.calmSeconds}s after the crash, once a swap shows the price has calmed.`
              : "No liquidity deployed yet."}
          </p>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="mWETH" hint={weth !== undefined ? `you have ${fmtToken(weth, 3)}` : undefined}>
          <input className={inputClass} inputMode="decimal" value={wethIn} onChange={(e) => setWethIn(e.target.value)} />
        </Field>
        <Field label="mUSDC" hint={usdc !== undefined ? `you have ${fmtToken(usdc, 0)}` : undefined}>
          <input className={inputClass} inputMode="decimal" value={usdcIn} onChange={(e) => setUsdcIn(e.target.value)} />
        </Field>
        <Button disabled={!address || flow.busy} onClick={deposit}>
          {flow.state.status === "running" ? `${flow.state.step}…` : "Deposit"}
        </Button>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-muted">
          Your share: <span className="num text-ink">{address ? `$${usd(mine)}` : "connect a wallet"}</span>
        </span>
        {s && s.myShares > 0n && (
          <button className="text-muted underline underline-offset-4 hover:text-ink" disabled={flow.busy} onClick={withdrawAll}>
            Withdraw all
          </button>
        )}
      </div>
      {flow.state.status === "error" && <p className="mt-2 text-xs text-danger">{flow.state.message}</p>}
      {flow.state.status === "done" && (
        <p className="mt-2 text-xs text-muted">
          Done <TxLink href={chain.explorerTx(flow.state.hash)} hash={flow.state.hash} />
        </p>
      )}
      <p className="mt-1 text-[11px] text-faint">No test tokens? Use “Get test tokens” in Demo controls (Base selected).</p>

      <h3 className="mt-6 text-xs font-medium text-muted">What the vault did, on-chain</h3>
      <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
        {(history ?? []).slice(0, 8).map((e) => (
          <li key={`${e.tx}-${e.kind}`} className="flex flex-col gap-1 px-4 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span className={cx(e.reason === "evacuate" ? "text-danger" : e.kind === "skipped" ? "text-faint" : "text-ink")}>
              {eventLabel(e)}
              {e.latencyBlocks !== undefined && (
                <span className="num ml-2 text-faint">
                  {e.latencyBlocks} blocks ≈ {((e.latencyBlocks * chain.blockMs) / 1000).toFixed(1)} s after the swap
                </span>
              )}
            </span>
            <span className="flex gap-3 text-faint">
              {e.originTx && <TxLink href={chain.explorerTx(e.originTx)} hash={e.originTx} label="① swap" />}
              {e.reactiveTx && <TxLink href={LINKS.lasnaTx(e.reactiveTx)} hash={e.reactiveTx} label="② reactive" />}
              <TxLink href={chain.explorerTx(e.tx)} hash={e.tx} label={e.reason && e.reason !== "deposit" ? "③ callback" : "tx"} />
            </span>
          </li>
        ))}
        {!history?.length && <li className="px-4 py-3 text-xs text-faint">Loading history…</li>}
      </ul>

      <p className="mt-4 text-[11px] leading-relaxed text-faint">
        Honest limits: evacuating protects against being sold into a crash, but if the price snaps straight back the vault
        re-enters lower and can end slightly behind a passive LP. Testnet tokens only. Every action re-checks the pool on-chain
        before it moves money. <a className="underline underline-offset-4" href={chain.explorerAddress(VAULT.address)} target="_blank" rel="noreferrer">Vault ↗</a>{" "}
        <a className="underline underline-offset-4" href={LINKS.lasnaAddress(VAULT.brain)} target="_blank" rel="noreferrer">Brain ↗</a>
      </p>
    </Panel>
  );
}
