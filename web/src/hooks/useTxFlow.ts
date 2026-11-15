"use client";

import { useCallback, useState } from "react";
import type { Hex } from "viem";
import { useWriteContract } from "wagmi";
import { chainClients } from "@/lib/clients";
import { chainById } from "@/lib/deployment";

type WriteArgs = Parameters<ReturnType<typeof useWriteContract>["writeContractAsync"]>[0];

export type Step = { label: string; request: WriteArgs };

export type FlowState =
  | { status: "idle" }
  | { status: "running"; step: string; index: number; total: number; hash?: Hex }
  | { status: "done"; hash: Hex }
  | { status: "error"; message: string };

/**
 * Runs a list of contract writes one after another (e.g. approve → createRule), waiting for each
 * receipt before sending the next, and exposes a single status for the UI.
 */
export function useTxFlow() {
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<FlowState>({ status: "idle" });

  const run = useCallback(
    async (steps: Step[]) => {
      let last: Hex | undefined;
      try {
        for (let i = 0; i < steps.length; i++) {
          setState({ status: "running", step: steps[i].label, index: i, total: steps.length });
          // Steps are built from typed ABIs at the call site; the stored union loses wagmi's generics.
          const hash = await writeContractAsync(steps[i].request as Parameters<typeof writeContractAsync>[0] & never);
          setState({ status: "running", step: steps[i].label, index: i, total: steps.length, hash });
          // Wait on the chain the step was sent to (Base or Unichain), not a fixed one.
          const chain = chainById(Number((steps[i].request as { chainId?: number }).chainId));
          if (!chain) throw new Error(`${steps[i].label}: unsupported chain`);
          const receipt = await chainClients[chain.key].waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`${steps[i].label} reverted`);
          last = hash;
        }
        if (last) setState({ status: "done", hash: last });
        return last;
      } catch (e) {
        const message = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
        setState({ status: "error", message: message.split("\n")[0] });
      }
    },
    [writeContractAsync],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset, busy: state.status === "running" };
}
