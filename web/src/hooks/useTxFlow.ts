"use client";

import { useCallback, useState } from "react";
import type { Hex } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { unichainSepolia } from "@/lib/chains";

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
  const client = usePublicClient({ chainId: unichainSepolia.id });
  const [state, setState] = useState<FlowState>({ status: "idle" });

  const run = useCallback(
    async (steps: Step[]) => {
      if (!client) return;
      let last: Hex | undefined;
      try {
        for (let i = 0; i < steps.length; i++) {
          setState({ status: "running", step: steps[i].label, index: i, total: steps.length });
          // Steps are built from typed ABIs at the call site; the stored union loses wagmi's generics.
          const hash = await writeContractAsync(steps[i].request as Parameters<typeof writeContractAsync>[0] & never);
          setState({ status: "running", step: steps[i].label, index: i, total: steps.length, hash });
          const receipt = await client.waitForTransactionReceipt({ hash });
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
    [client, writeContractAsync],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset, busy: state.status === "running" };
}
