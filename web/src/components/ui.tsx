"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * Shared primitives. A calm, Apple-like dark system: soft 20px cards one lightness step above true black,
 * generous padding, large type, pill controls, and detail kept behind a tap. Hashes alone are monospace.
 */

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Panel({
  title,
  aside,
  children,
  className,
  id,
  i,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  /** Entrance order: cards rise in one after another (80 ms apart). */
  i?: number;
}) {
  return (
    <section
      id={id}
      className={cx("rounded-[20px] bg-panel", i !== undefined && "m-rise", className)}
      style={i !== undefined ? ({ "--i": i } as React.CSSProperties) : undefined}
    >
      {(title || aside) && (
        <header className="flex min-h-[56px] flex-wrap items-center justify-between gap-x-3 gap-y-2 px-7 pt-6">
          <h2 className="text-[19px] font-semibold leading-7 tracking-[-0.02em] text-ink">{title}</h2>
          {aside}
        </header>
      )}
      <div className="px-7 pb-7 pt-4">{children}</div>
    </section>
  );
}

type Tone = "active" | "triggered" | "executed" | "cancelled" | "danger";
const toneClass: Record<Tone, string> = {
  active: "text-ink bg-raised",
  triggered: "text-triggered bg-triggered/10",
  executed: "text-executed bg-executed/10",
  cancelled: "text-muted bg-raised",
  danger: "text-danger bg-danger/10",
};
const dotClass: Record<Tone, string> = {
  active: "bg-active",
  triggered: "bg-triggered",
  executed: "bg-executed",
  cancelled: "bg-faint",
  danger: "bg-danger",
};

/** Status pill: a pale tint with text of the same hue (never a saturated fill). */
export function Chip({ tone, children, pulse }: { tone: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={cx("inline-flex h-6 flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium", toneClass[tone])}>
      <span className={cx("h-1.5 w-1.5 rounded-full", dotClass[tone], pulse && "opacity-80")} />
      {children}
    </span>
  );
}

export function Button({
  variant = "primary",
  className,
  busy,
  progress,
  children,
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
  size?: "md" | "lg";
  /** A transaction is pending: a light sweeps across the button. */
  busy?: boolean;
  /** Multi-step flows: 0–1, drawn as a bar along the button's foot. */
  progress?: number;
}) {
  return (
    <button
      {...props}
      className={cx(
        "m-lift relative inline-flex flex-none items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-full font-medium",
        size === "lg" ? "h-[52px] px-7 text-[17px]" : "h-9 px-4 text-[14px]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Primary by inversion: a white pill with black text.
        variant === "primary" && "bg-ink text-bg hover:bg-ink/85",
        variant === "ghost" && "bg-raised text-ink hover:bg-[#2f2f33]",
        variant === "danger" && "bg-danger/15 text-danger hover:bg-danger/25",
        busy && "disabled:opacity-80",
        className,
      )}
    >
      {busy && (
        <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
          <span className="m-sweep absolute inset-y-0 w-1/2 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.22),transparent)]" />
        </span>
      )}
      {progress !== undefined && (
        <span aria-hidden className="absolute inset-x-3 bottom-[3px] h-[2px] overflow-hidden rounded-full bg-black/10">
          <span className="m-slide block h-full origin-left rounded-full bg-active" style={{ transform: `scaleX(${Math.max(0.04, progress)})` }} />
        </span>
      )}
      <span className="relative">{children}</span>
    </button>
  );
}

/**
 * Segmented control, iOS style: a pill track; the selected option sits on a lighter thumb that slides
 * between options. Keyboard: arrow keys move the selection.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  render,
  className,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  render?: (v: T) => ReactNode;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const index = options.indexOf(value);
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[index];
      if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [index, options.length]);

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("relative inline-flex h-9 max-w-full items-stretch overflow-x-auto rounded-full bg-raised p-[3px]", className)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onChange(options[(index + 1) % options.length]);
        if (e.key === "ArrowLeft") onChange(options[(index - 1 + options.length) % options.length]);
      }}
    >
      <span
        aria-hidden
        className="m-slide absolute bottom-[3px] left-0 top-[3px] rounded-full bg-[#4a4a4f] shadow-[0_1px_4px_rgba(0,0,0,0.35)]"
        style={thumb ? { transform: `translateX(${thumb.x}px)`, width: thumb.w } : { opacity: 0 }}
      />
      {options.map((o, i) => {
        const on = o === value;
        return (
          <button
            key={String(o)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o)}
            className={cx(
              "relative z-10 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors duration-200",
              on ? "text-ink" : "text-muted hover:text-ink",
            )}
          >
            {render ? render(o) : String(o)}
          </button>
        );
      })}
    </div>
  );
}

/** A large slider with a filled track (the fill follows the thumb). */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <input
      type="range"
      aria-label={label}
      className="px-range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ "--fill": fill } as React.CSSProperties}
    />
  );
}

/** A row that opens to show its detail (the transactions behind an execution, say). */
export function Disclosure({ summary, children, i }: { summary: ReactNode; children: ReactNode; i?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="m-row border-t border-rule first:border-t-0" style={i !== undefined ? ({ "--i": i } as React.CSSProperties) : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-4 px-7 py-4 text-left transition-colors duration-200 hover:bg-raised/50"
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden
          className={cx("flex-none text-faint transition-transform duration-300", open && "rotate-90")}
        >
          <path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="m-open px-7 pb-5">{children}</div>}
    </li>
  );
}

/**
 * A figure that counts to its new value (600 ms, ease-out) instead of jumping, and flashes the
 * good/bad colour for a moment when `flash` is set and the value moves.
 */
export function AnimatedNumber({
  value,
  format,
  flash,
  className,
}: {
  value: number | undefined;
  format: (n: number) => string;
  flash?: "up-good" | "up-bad";
  className?: string;
}) {
  const [shown, setShown] = useState<number | undefined>(value);
  const [tone, setTone] = useState<"" | "m-flash-up" | "m-flash-down">("");
  const from = useRef<number | undefined>(value);
  const tick = useRef(0);

  useEffect(() => {
    if (value === undefined) return;
    const start = from.current;
    from.current = value;
    if (start === undefined || start === value) {
      setShown(value);
      return;
    }
    if (flash) {
      const up = value > start;
      setTone(up === (flash === "up-good") ? "m-flash-up" : "m-flash-down");
      tick.current++;
    }
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 600);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(start + (value - start) * e);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, flash]);

  if (shown === undefined) return <span className={className}>—</span>;
  return (
    <span key={tick.current} className={cx(tone, className)}>
      {format(shown)}
    </span>
  );
}

/** Count up from 0 on first show (for figures that arrive once, like a latency on the loop strip). */
export function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return setV(target);
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function TxLink({ href, hash, label }: { href: string; hash?: string; label?: string }) {
  if (!hash) return <span className="text-faint">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mono whitespace-nowrap text-ink underline decoration-control underline-offset-4 transition hover:decoration-ink"
      title={hash}
    >
      {label ?? `${hash.slice(0, 6)}…${hash.slice(-4)}`}
    </a>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline justify-between gap-3 text-[13px] text-muted">
        {label}
        {hint && <span className="text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** A KPI: label over value, no tile, no icon. */
export function Stat({ label, value, sub, lead }: { label: string; value: ReactNode; sub?: ReactNode; lead?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={cx("num mt-1 truncate font-semibold tracking-[-0.02em] text-ink", lead ? "text-[40px] leading-[48px]" : "text-[24px] leading-8")}>{value}</div>
      {sub && <div className="mt-1 truncate text-[13px] text-faint">{sub}</div>}
    </div>
  );
}

export const inputClass =
  "num h-12 w-full rounded-[14px] bg-raised px-4 text-[17px] text-ink ring-1 ring-inset ring-transparent placeholder:text-faint " +
  "transition focus:outline-none focus:ring-active";
