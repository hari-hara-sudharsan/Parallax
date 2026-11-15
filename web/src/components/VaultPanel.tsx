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
import { AnimatedNumber, Button, Chip, Field, Panel, Stat, TxLink, cx, inputClass } from "./ui";

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
  if (e.kind === "skipped") return `Skipped ${LABEL[e.reason!]?.toLowerCase() ?? ""}: condition no longer true on-chain`;
  if (e.kind === "positioned" && e.reason === "deposit") return "Opened the position";
  return LABEL[e.reason ?? e.kind] ?? e.kind;
}

/** The Vault view: figures, where the liquidity sits, deposit/withdraw, and every action with its full loop. */
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

  const status = !s ? null : s.mode === "evacuated" ? (
    <Chip tone="danger">Evacuated, waiting for calm</Chip>
  ) : s.mode === "empty" ? (
    <Chip tone="cancelled">Empty</Chip>
  ) : s.inRange ? (
    <Chip tone="executed" pulse>
      In range, earning fees
    </Chip>
  ) : (
    <Chip tone="triggered" pulse>
      Out of range, re-centring
    </Chip>
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

  async function getTokens() {
    await flow.run([
      { label: "Mint mWETH", request: { address: chain.mockWETH, abi: mockErc20Abi, functionName: "mint", args: [address!, parseUnits("5", WETH_DECIMALS)], chainId: chain.chainId } },
      { label: "Mint mUSDC", request: { address: chain.mockUSDC, abi: mockErc20Abi, functionName: "mint", args: [address!, parseUnits("10000", USDC_DECIMALS)], chainId: chain.chainId } },
    ]);
    refetch();
  }

  // Where the price sits inside the band (0–100%), for the range bar.
  const pos = range && price ? Math.max(0, Math.min(100, ((price - range[0]) / (range[1] - range[0])) * 100)) : undefined;
  const previewUsd = price ? (Number(wethIn) || 0) * price + (Number(usdcIn) || 0) : 0;
  const needsTokens = Boolean(address) && weth !== undefined && usdc !== undefined && weth < 0.001 && usdc < 1;
  const reacted = (history ?? []).filter((e) => e.reason && e.reason !== "deposit");

  return (
    <div className="grid gap-6">
      <section aria-label="Vault figures" style={{ "--i": 0 } as React.CSSProperties} className="m-rise rounded-[6px] bg-panel shadow-[0_12px_28px_rgba(0,0,0,.2)]">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[6px] bg-line lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
          <div className="col-span-2 bg-panel px-6 py-5 lg:col-span-1">
            <Stat lead label="Vault value" value={<AnimatedNumber value={tvl} format={(n) => `$${usd(n)}`} />} sub="position plus idle tokens, at the live pool price" />
          </div>
          <div className="col-span-2 bg-panel px-6 py-5 sm:col-span-1">
            <div className="text-[12px] text-muted">State</div>
            <div key={s?.mode + String(s?.inRange)} className="m-fade mt-2">{status ?? <span className="num text-faint">—</span>}</div>
          </div>
          <div className="bg-panel px-6 py-5 max-sm:col-span-2">
            <Stat label="Re-centred" value={<AnimatedNumber value={s?.rebalances} format={(n) => String(Math.round(n))} />} sub="the price drifted out" />
          </div>
          <div className="bg-panel px-6 py-5">
            <Stat label="Evacuated" value={<AnimatedNumber value={s?.evacuations} format={(n) => String(Math.round(n))} />} sub={`a ≥ ${VAULT.breakerTicks / 100}% move in ${VAULT.windowSeconds} s`} />
          </div>
          <div className="bg-panel px-6 py-5">
            <Stat label="Re-entered" value={<AnimatedNumber value={s?.reentries} format={(n) => String(Math.round(n))} />} sub={`after ${VAULT.calmSeconds} s of calm`} />
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-12">
        <Panel
          i={1}
          className="lg:col-span-7"
          title="Where the liquidity sits"
          aside={<span className="num text-[12px] text-faint">{price ? `price $${usd(price)}` : ""}</span>}
        >
          {range ? (
            <>
              <div className="relative mt-2 h-10" role="img" aria-label={`Range $${usd(range[0])} to $${usd(range[1])}`}>
                <div className="absolute inset-x-0 top-[18px] h-1 rounded-full bg-raised" />
                <div className={cx("absolute inset-x-[8%] top-[18px] h-1 rounded-full transition-colors duration-500", s?.inRange ? "bg-active" : "bg-triggered")} />
                {pos !== undefined && (
                  <div
                    className="absolute top-[6px] h-7 w-0.5 rounded bg-ink transition-[left] duration-500"
                    style={{ left: `calc(8% + ${pos * 0.84}% - 1px)` }}
                    title="current price"
                  />
                )}
              </div>
              <div className="num flex justify-between px-[8%] text-[12px] text-faint">
                <span>${usd(range[0])}</span>
                <span>${usd(range[1])}</span>
              </div>
              <p className="mt-4 text-[13px] text-muted">
                Liquidity sits in a ±{VAULT.halfWidthTicks / 100}% band around the price and earns fees while the price is inside it.
              </p>
            </>
          ) : (
            <p className="text-[13px] text-muted">
              {s?.mode === "evacuated"
                ? `All liquidity is out of the pool. It goes back in ${VAULT.calmSeconds} s after the crash, on the first swap that shows the price has calmed.`
                : "No liquidity deployed yet. The first deposit opens the position."}
            </p>
          )}
          <dl className="mt-5 grid gap-px overflow-hidden rounded-[6px] bg-line text-[13px] sm:grid-cols-3">
            {[
              ["Range", `±${VAULT.halfWidthTicks / 100}% around the price`, "re-centred when the price leaves it"],
              ["Crash breaker", `≥ ${VAULT.breakerTicks / 100}% in ${VAULT.windowSeconds} s`, "pulls all liquidity out"],
              ["Calm period", `${VAULT.calmSeconds} s`, "before it goes back in"],
            ].map(([k, v, d]) => (
              <div key={k} className="bg-raised px-4 py-3">
                <dt className="text-[12px] text-muted">{k}</dt>
                <dd className="num mt-1 text-ink">{v}</dd>
                <dd className="mt-0.5 text-[12px] text-muted">{d}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel
          i={2}
          className="lg:col-span-5"
          title="Deposit"
          aside={<span className="num text-[12px] text-faint">{address ? `your share $${usd(mine)}` : ""}</span>}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="mWETH" hint={weth !== undefined ? `you have ${fmtToken(weth, 3)}` : undefined}>
              <input className={inputClass} inputMode="decimal" value={wethIn} onChange={(e) => setWethIn(e.target.value)} />
            </Field>
            <Field label="mUSDC" hint={usdc !== undefined ? `you have ${fmtToken(usdc, 0)}` : undefined}>
              <input className={inputClass} inputMode="decimal" value={usdcIn} onChange={(e) => setUsdcIn(e.target.value)} />
            </Field>
          </div>
          <div className="mt-4 rounded-[6px] bg-raised px-4 py-3 text-[13px]">
            {previewUsd > 0 && price ? (
              <>
                You deposit <span className="num text-ink">≈ ${usd(previewUsd)}</span> at the live price and own{" "}
                <span className="num text-ink">{((previewUsd / ((tvl ?? 0) + previewUsd)) * 100).toFixed(1)}%</span> of the vault.
              </>
            ) : (
              <span className="text-muted">Enter amounts to see what they are worth at the live price.</span>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {needsTokens ? (
              <Button disabled={flow.busy} busy={flow.busy} onClick={getTokens}>
                {flow.state.status === "running" ? `${flow.state.step}…` : "Get test tokens"}
              </Button>
            ) : (
              <Button
                disabled={!address || flow.busy}
                busy={flow.busy}
                progress={flow.state.status === "running" ? (flow.state.index + 0.5) / flow.state.total : undefined}
                onClick={deposit}
              >
                {!address ? "Connect a wallet to deposit" : flow.state.status === "running" ? `${flow.state.step}…` : "Deposit"}
              </Button>
            )}
            {s && s.myShares > 0n && (
              <Button variant="ghost" disabled={flow.busy} onClick={withdrawAll}>
                Withdraw all
              </Button>
            )}
          </div>
          {flow.state.status === "error" && <p className="mt-3 text-[12px] text-danger">{flow.state.message}</p>}
          {flow.state.status === "done" && (
            <p className="mt-3 text-[12px] text-muted">
              Done <TxLink href={chain.explorerTx(flow.state.hash)} hash={flow.state.hash} />
            </p>
          )}
          <p className="mt-4 text-[12px] leading-relaxed text-faint">
            Shares are priced at the live pool price. Withdraw any time for your slice of the position and the idle tokens.
          </p>
        </Panel>
      </div>

      <Panel i={3} title="What the vault did, on-chain" aside={<span className="num text-[12px] text-faint">{reacted.length} reactive actions</span>}>
        <ul className="-mx-6">
          {(history ?? []).slice(0, 8).map((e, i) => (
            <li key={`${e.tx}-${e.kind}`} style={{ "--i": i } as React.CSSProperties} className="m-row transition-colors duration-200 hover:bg-raised/40 grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-t border-rule px-6 py-3 first:border-t-0">
              <span className={cx("text-[13px]", e.reason === "evacuate" ? "text-danger" : e.kind === "skipped" ? "text-muted" : "text-ink")}>{eventLabel(e)}</span>
              <span className="num row-span-2 text-right text-[13px] text-ink">
                {e.latencyBlocks !== undefined ? (
                  <>
                    {e.latencyBlocks} blocks
                    <span className="block text-[12px] text-faint">≈ {((e.latencyBlocks * chain.blockMs) / 1000).toFixed(1)} s after the swap</span>
                  </>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </span>
              <span className="flex flex-wrap gap-x-4 text-[13px] text-faint">
                {e.originTx && (
                  <span>
                    ① <TxLink href={chain.explorerTx(e.originTx)} hash={e.originTx} />
                  </span>
                )}
                {e.reactiveTx && (
                  <span>
                    ② <TxLink href={LINKS.lasnaTx(e.reactiveTx)} hash={e.reactiveTx} />
                  </span>
                )}
                <span>
                  {e.reason && e.reason !== "deposit" ? "③ " : ""}
                  <TxLink href={chain.explorerTx(e.tx)} hash={e.tx} />
                </span>
              </span>
            </li>
          ))}
          {!history && <li className="px-6 text-[13px] text-muted">Reading the vault’s history…</li>}
          {history && !history.length && <li className="px-6 text-[13px] text-muted">No activity yet.</li>}
        </ul>
        <p className="mt-4 text-[12px] leading-relaxed text-faint">
          Honest limits: stepping out of a crash avoids being sold into it, but if the price snaps straight back the vault goes back in lower and can end
          slightly behind a passive LP. Testnet tokens only. Every action re-checks the pool on-chain before it moves money.{" "}
          <a className="underline decoration-control underline-offset-4 hover:text-muted" href={chain.explorerAddress(VAULT.address)} target="_blank" rel="noreferrer">
            Vault contract
          </a>{" "}
          ·{" "}
          <a className="underline decoration-control underline-offset-4 hover:text-muted" href={LINKS.lasnaAddress(VAULT.brain)} target="_blank" rel="noreferrer">
            Reactive brain
          </a>
        </p>
      </Panel>
    </div>
  );
}
