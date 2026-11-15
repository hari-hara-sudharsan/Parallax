"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CHAINS, type ChainDeployment, type ChainKey } from "@/lib/deployment";

type Ctx = { chain: ChainDeployment; setChain: (k: ChainKey) => void };
const ChainContext = createContext<Ctx | null>(null);
const STORAGE_KEY = "parallax:chain";

/** Which chain the forms, balances and price header act on. The live feed always shows both. */
export function ChainProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<ChainKey>("base");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "base" || saved === "unichain") setKey(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const setChain = (k: ChainKey) => {
    setKey(k);
    try {
      window.localStorage.setItem(STORAGE_KEY, k);
    } catch {
      /* storage unavailable */
    }
  };

  return <ChainContext.Provider value={{ chain: CHAINS[key], setChain }}>{children}</ChainContext.Provider>;
}

export function useChain() {
  const ctx = useContext(ChainContext);
  if (!ctx) throw new Error("useChain must be used inside <ChainProvider>");
  return ctx;
}
