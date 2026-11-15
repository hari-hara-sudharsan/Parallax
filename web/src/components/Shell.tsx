"use client";

import { useEffect, useState, type ReactNode } from "react";
import { LINKS } from "@/lib/deployment";
import { BlockStamp, ChainSwitch, Mark, WalletButton } from "./Header";
import { cx } from "./ui";

/**
 * Shell: an icon rail (55px) on the page ground with a 1px edge; three destinations, each its own view
 * (hash route, so the static GitHub Pages build works). The active item is marked the style's one way: a
 * 1px accent line on the rail's edge. On a phone the rail becomes a bottom bar with short labels.
 */
export type View = "guards" | "vault" | "proof";
const VIEWS: { id: View; label: string; icon: ReactNode }[] = [
  {
    id: "guards",
    label: "Guards",
    icon: (
      <path d="M9 2.5 3.5 4.6v4.1c0 3.4 2.3 6 5.5 6.8 3.2-.8 5.5-3.4 5.5-6.8V4.6L9 2.5Z M6.4 9l1.8 1.8L11.8 7" />
    ),
  },
  {
    id: "vault",
    label: "Vault",
    icon: <path d="M2.5 6.5h13M2.5 11.5h13M4 3.5h10a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V5A1.5 1.5 0 0 1 4 3.5Z" />,
  },
  {
    id: "proof",
    label: "Proof",
    icon: <path d="M3 14.5h12M5 11.5V8M9 11.5V4M13 11.5V6.5" />,
  },
];

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>("guards");
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.slice(1);
      setView(h === "vault" || h === "proof" ? h : "guards");
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const go = (v: View) => {
    window.location.hash = v;
    window.scrollTo({ top: 0 });
  };
  return [view, go];
}

export function Shell({ view, onView, children }: { view: View; onView: (v: View) => void; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      {/* Desktop rail */}
      <nav aria-label="Parallax" className="fixed inset-y-0 left-0 z-30 hidden w-[55px] flex-col items-center border-r border-line bg-bg py-4 md:flex">
        <a href="#guards" aria-label="Parallax home" className="mb-6">
          <Mark />
        </a>
        <ul className="relative flex flex-col gap-2">
          <span
            aria-hidden
            className="m-slide absolute right-[-1px] top-2 h-6 w-px bg-active"
            style={{ transform: `translateY(${VIEWS.findIndex((x) => x.id === view) * 48}px)` }}
          />
          {VIEWS.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => onView(v.id)}
                aria-label={v.label}
                aria-current={view === v.id ? "page" : undefined}
                title={v.label}
                className={cx(
                  "relative flex h-10 w-[55px] items-center justify-center transition-colors",
                  view === v.id ? "text-ink" : "text-faint hover:text-ink",
                )}
              >
                <span className="m-lift inline-flex">
                  <Icon>{v.icon}</Icon>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <a href={LINKS.repo} target="_blank" rel="noreferrer" aria-label="Source on GitHub" title="Source on GitHub" className="mt-auto flex h-10 w-[55px] items-center justify-center text-faint transition-colors hover:text-ink">
          <Icon>
            <path d="M6.5 14.5c-3 .9-3-1.5-4.2-1.8m8.4 3.6v-2.4c0-.7.1-1.2-.4-1.6 2-.2 4.2-1 4.2-4.5a3.5 3.5 0 0 0-1-2.4 3.2 3.2 0 0 0-.1-2.4s-.8-.2-2.6 1a9 9 0 0 0-4.6 0C4.4 3 3.6 3.2 3.6 3.2a3.2 3.2 0 0 0-.1 2.4 3.5 3.5 0 0 0-1 2.4c0 3.5 2.2 4.3 4.2 4.5-.4.4-.5.9-.4 1.6v2.4" />
          </Icon>
        </a>
      </nav>

      {/* Phone: name + wallet on top, destinations at the bottom */}
      <div className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-b border-line bg-bg px-4 md:hidden">
        <span className="flex items-center gap-2 text-[14px] font-semibold">
          <Mark size={24} /> Parallax
        </span>
        <WalletButton />
      </div>
      <nav aria-label="Parallax views" className="fixed inset-x-0 bottom-0 z-30 grid h-14 grid-cols-3 border-t border-line bg-bg md:hidden">
        <span
          aria-hidden
          className="m-slide absolute left-0 top-[-1px] h-px w-1/3 bg-active"
          style={{ transform: `translateX(${VIEWS.findIndex((x) => x.id === view) * 100}%)` }}
        />
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onView(v.id)}
            aria-current={view === v.id ? "page" : undefined}
            className={cx("relative flex flex-col items-center justify-center gap-0.5 text-[11px]", view === v.id ? "text-ink" : "text-faint")}
          >
            <Icon>{v.icon}</Icon>
            {v.label}
          </button>
        ))}
      </nav>

      <main className="px-5 pb-28 pt-8 md:ml-[55px] md:px-12 md:pb-16 md:pt-12">
        <div className="mx-auto max-w-[1200px]">{children}</div>
      </main>
    </div>
  );
}

/** The title row every view shares: the h1, one sentence about the data, and the real controls. */
export function TitleRow({ title, sub, chainSwitch = true }: { title: string; sub: ReactNode; chainSwitch?: boolean }) {
  return (
    <div className="mb-10 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-8 tracking-[-0.03em] md:text-[32px] md:leading-10">{title}</h1>
        <p className="mt-2 max-w-[60ch] text-[15px] leading-6 text-muted md:text-[17px] md:leading-7">{sub}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {chainSwitch && <ChainSwitch />}
        <BlockStamp />
        <span className="hidden md:inline-flex">
          <WalletButton />
        </span>
      </div>
    </div>
  );
}
