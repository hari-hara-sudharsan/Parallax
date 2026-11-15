"use client";

import { parseUnits } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { useBalances } from "@/hooks/useBalances";
import { useTxFlow, type Step } from "@/hooks/useTxFlow";
import { mockErc20Abi, poolSwapTestAbi } from "@/lib/abis";
import { USDC_DECIMALS, WETH_DECIMALS, WETH_IS_CURRENCY0, poolKeyOf } from "@/lib/deployment";
import { useChain } from "@/hooks/useChain";
import { fmtToken } from "@/lib/price";
import { Button, Panel, TxLink } from "./ui";

// TickMath.MIN_SQRT_PRICE + 1 / MAX_SQRT_PRICE - 1 (v4-core): "no price limit" for a swap.
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

const CRASH_WETH = parseUnits("20", WETH_DECIMALS);
const PUMP_USDC = parseUnits("60000", USDC_DECIMALS);

/**
 * Testnet-only levers so anyone can watch the loop: free demo tokens, and big swaps through
 * Uniswap's PoolSwapTest router to push the price across a rule. Each swap is an ORIGIN event.
 */
export function DemoPanel() {
  const { chain } = useChain();
  const { address } = useAccount();
  const { weth, usdc, refetch } = useBalances(address, chain);
  const faucet = useTxFlow();
  const crash = useTxFlow();
  const pump = useTxFlow();

  const { data: allowances, refetch: refetchAllowances } = useReadContracts({
    allowFailure: false,
    query: { enabled: Boolean(address) },
    contracts: [
      { address: chain.mockWETH, abi: mockErc20Abi, functionName: "allowance", args: [address!, chain.poolSwapTest], chainId: chain.chainId },
      { address: chain.mockUSDC, abi: mockErc20Abi, functionName: "allowance", args: [address!, chain.poolSwapTest], chainId: chain.chainId },
    ],
  });

  function swapSteps(sellWeth: boolean): Step[] {
    const token = sellWeth ? chain.mockWETH : chain.mockUSDC;
    const amount = sellWeth ? CRASH_WETH : PUMP_USDC;
    const allowance = (sellWeth ? allowances?.[0] : allowances?.[1]) ?? 0n;
    const zeroForOne = sellWeth === WETH_IS_CURRENCY0; // selling currency0?
    const steps: Step[] = [];
    if (allowance < amount) {
      steps.push({
        label: `Approve ${sellWeth ? "mWETH" : "mUSDC"}`,
        request: { address: token, abi: mockErc20Abi, functionName: "approve", args: [chain.poolSwapTest, amount * 10n], chainId: chain.chainId },
      });
    }
    steps.push({
      label: sellWeth ? "Crash the price" : "Pump the price",
      request: {
        address: chain.poolSwapTest,
        abi: poolSwapTestAbi,
        functionName: "swap",
        args: [
          poolKeyOf(chain),
          { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
          { takeClaims: false, settleUsingBurn: false },
          "0x",
        ],
        chainId: chain.chainId,
      },
    });
    return steps;
  }

  const after = () => {
    refetch();
    refetchAllowances();
  };

  return (
    <Panel title="Demo controls" aside={<span className="text-[11px] uppercase tracking-widest text-faint">testnet</span>}>
      <div className="flex items-center justify-between rounded-xl border border-line bg-bg px-4 py-3 text-xs">
        <span className="text-muted">Your demo balance</span>
        <span className="num text-ink">
          {weth !== undefined ? fmtToken(weth, 3) : "–"} mWETH · {usdc !== undefined ? fmtToken(usdc, 0) : "–"} mUSDC
        </span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Button
          variant="ghost"
          disabled={!address || faucet.busy}
          onClick={async () => {
            await faucet.run([
              { label: "Mint mWETH", request: { address: chain.mockWETH, abi: mockErc20Abi, functionName: "mint", args: [address!, parseUnits("50", WETH_DECIMALS)], chainId: chain.chainId } },
              { label: "Mint mUSDC", request: { address: chain.mockUSDC, abi: mockErc20Abi, functionName: "mint", args: [address!, parseUnits("150000", USDC_DECIMALS)], chainId: chain.chainId } },
            ]);
            after();
          }}
        >
          {faucet.state.status === "running" ? `${faucet.state.step}…` : "Get test tokens"}
        </Button>
        <Button
          variant="danger"
          disabled={!address || crash.busy || (weth ?? 0) < 20}
          onClick={async () => {
            await crash.run(swapSteps(true));
            after();
          }}
        >
          {crash.state.status === "running" ? `${crash.state.step}…` : "▼ Crash the price"}
        </Button>
        <Button
          variant="ghost"
          disabled={!address || pump.busy || (usdc ?? 0) < 60000}
          onClick={async () => {
            await pump.run(swapSteps(false));
            after();
          }}
        >
          {pump.state.status === "running" ? `${pump.state.step}…` : "▲ Pump the price"}
        </Button>
      </div>

      <div className="mt-3 space-y-1 text-xs">
        {[crash, pump].map((f, i) =>
          f.state.status === "done" ? (
            <p key={i} className="text-muted">
              Origin swap sent <TxLink href={chain.explorerTx(f.state.hash)} hash={f.state.hash} />. Watch the feed.
            </p>
          ) : f.state.status === "error" ? (
            <p key={i} className="text-danger">{f.state.message}</p>
          ) : null,
        )}
        {faucet.state.status === "error" && <p className="text-danger">{faucet.state.message}</p>}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-faint">
        Crash sells 20 mWETH (about −12%); pump sells 60,000 mUSDC (about +12%). Both are ordinary Uniswap v4 swaps that anyone
        could make, and Parallax reacts to them exactly like it would to a real market move.
      </p>
    </Panel>
  );
}
