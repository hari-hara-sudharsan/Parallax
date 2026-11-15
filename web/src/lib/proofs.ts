import type { Hex } from "viem";
import data from "./proofs.json";
import type { ChainKey } from "./deployment";

/**
 * Proven loops frozen from chain by `npm run snapshot` (scripts/snapshot.mjs). Lasna prunes old blocks, so a
 * reactive tx found today may be unreadable later; the dashboard falls back to these stored rows whenever a
 * live lookup comes back empty. Every field was read from Base, Unichain or Lasna; nothing is typed by hand.
 */
export type StoredExecution = {
  source: "live" | "bench";
  version: string;
  kind?: string;
  chain: ChainKey;
  ruleId: number;
  owner?: string;
  originTx: Hex;
  originBlock: number;
  t0: number;
  reactiveTx: Hex | null;
  callbackTx: Hex | null;
  executedBlock: number;
  t1: number;
  latencyBlocks: number;
};
export type StoredVaultAction = {
  action: "rebalance" | "evacuate" | "reenter";
  skipped: boolean;
  originTx: Hex;
  originBlock: number;
  reactiveTx: Hex;
  callbackTx: Hex;
  callbackBlock: number;
  latencyBlocks: number;
};

export const PROOFS = data as unknown as { updated: string; executions: StoredExecution[]; bench: StoredExecution[]; vault: StoredVaultAction[] };

export const storedExecution = (chain: ChainKey, ruleId: bigint) =>
  PROOFS.executions.find((e) => e.chain === chain && BigInt(e.ruleId) === ruleId);
export const storedVaultAction = (callbackTx: string) =>
  PROOFS.vault.find((v) => v.callbackTx.toLowerCase() === callbackTx.toLowerCase());
