"use client";

import { parseUnits } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { useBalances } from "@/hooks/useBalances";
import { useTxFlow, type Step } from "@/hooks/useTxFlow";
import { mockErc20Abi, poolSwapTestAbi } from "@/lib/abis";
import { USDC_DECIMALS, WETH_DECIMALS, WETH_IS_CURRENCY0, poolKeyOf } from "@/lib/deployment";
import { useChain } from "@/hooks/useChain";
import { usePool } from "@/hooks/usePool";
import { fmtToken, fmtUsd } from "@/lib/price";
import { ChainSwitch } from "./Header";
import { AnimatedNumber, Button, Panel, TxLink } from "./ui";

// TickMath.MIN_SQRT_PRICE + 1 / MAX_SQRT_PRICE - 1 (v4-core): "no price limit" for a swap.
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

const CRASH_WETH = parseUnits("20", WETH_DECIMALS);
const PUMP_USDC = parseUnits("60000", USDC_DECIMALS);

/**
 * Testnet-only levers so anyone can watch the loop: free demo tokens, and big swaps through
 * Uniswap's PoolSwapTest router to push the price across a rule. Each swap is an ORIGIN event.
 */
/** The price, big, and the levers to move it (testnet): the hero card of the Guards view. */
export function DemoPanel() {
  const { chain } = useChain();
  const { address } = useAccount();
  const { weth, usdc, refetch } = useBalances(address, chain);
  const { price, tick } = usePool(chain);
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

  const busy = faucet.busy || crash.busy || pump.busy;
  const last = [crash, pump].find((f) => f.state.status === "done");
  const err = [faucet, crash, pump].find((f) => f.state.status === "error");

  return (
    <Panel i={0}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[15px] text-muted">mWETH price</span>
        <ChainSwitch />
      </div>
      <div className="mt-3 text-[56px] font-semibold leading-[64px] tracking-[-0.035em]">
        <AnimatedNumber value={price} format={(n) => `$${fmtUsd(n)}`} flash="up-good" className="num" />
      </div>
      <div className="num mt-1 text-[14px] text-faint">
        {chain.name} · Uniswap v4 · tick {tick?.toLocaleString("en-US") ?? "…"}
      </div>

      <div className="mt-8 rounded-[16px] bg-raised/60 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[15px] font-medium text-ink">Try it</span>
          <span className="num text-[13px] text-faint">
            {address ? `${weth !== undefined ? fmtToken(weth, 2) : "…"} mWETH · ${usdc !== undefined ? fmtToken(usdc, 0) : "…"} mUSDC` : "connect a wallet"}
          </span>
        </div>
        <p className="mt-1 text-[13px] text-muted">Move the market with an ordinary Uniswap swap and watch Parallax react.</p>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Button
            variant="ghost"
            disabled={!address || busy}
            busy={faucet.busy}
            onClick={async () => {
              await faucet.run([
                { label: "Mint mWETH", request: { address: chain.mockWETH, abi: mockErc20Abi, functionName: "mint", args: [address!, parseUnits("50", WETH_DECIMALS)], chainId: chain.chainId } },
                { label: "Mint mUSDC", request: { address: chain.mockUSDC, abi: mockErc20Abi, functionName: "mint", args: [address!, parseUnits("150000", USDC_DECIMALS)], chainId: chain.chainId } },
              ]);
              after();
            }}
          >
            {faucet.busy ? "Minting…" : "Get tokens"}
          </Button>
          <Button
            variant="danger"
            disabled={!address || busy || (weth ?? 0) < 20}
            busy={crash.busy}
            onClick={async () => {
              await crash.run(swapSteps(true));
              after();
            }}
          >
            {crash.busy ? "Selling…" : "Crash −12%"}
          </Button>
          <Button
            variant="ghost"
            disabled={!address || busy || (usdc ?? 0) < 60000}
            busy={pump.busy}
            onClick={async () => {
              await pump.run(swapSteps(false));
              after();
            }}
          >
            {pump.busy ? "Buying…" : "Pump +12%"}
          </Button>
        </div>
        {last?.state.status === "done" && (
          <p className="m-fade mt-3 text-[13px] text-muted">
            Swap sent <TxLink href={chain.explorerTx(last.state.hash)} hash={last.state.hash} />. Parallax answers in about a second.
          </p>
        )}
        {err?.state.status === "error" && <p className="m-fade mt-3 text-[13px] text-danger">{err.state.message}</p>}
      </div>
    </Panel>
  );
}
