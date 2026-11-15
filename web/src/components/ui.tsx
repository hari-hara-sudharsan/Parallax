"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * Shared primitives ("data terminal" style). Cards are a lightness step darker than the ground, with no
 * border; a selection is always the same 1px accent line, exactly as wide as its label; numbers are
 * JetBrains Mono with tabular digits (the style's chosen face: on-chain figures must stack; taste-skill-ignore); controls are full pills.
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
      className={cx("rounded-[6px] bg-panel shadow-[0_12px_28px_rgba(0,0,0,.2)]", i !== undefined && "m-rise", className)}
      style={i !== undefined ? ({ "--i": i } as React.CSSProperties) : undefined}
    >
      {(title || aside) && (
        <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-3 gap-y-2 px-6 pt-5">
          <h2 className="text-[16px] font-semibold leading-6 text-ink">{title}</h2>
          {aside}
        </header>
      )}
      <div className="px-6 pb-6 pt-4">{children}</div>
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
    <span className={cx("inline-flex h-5 flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12px] font-medium", toneClass[tone])}>
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
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
  /** A transaction is pending: a light sweeps across the button. */
  busy?: boolean;
  /** Multi-step flows: 0–1, drawn as a bar along the button's foot. */
  progress?: number;
}) {
  return (
    <button
      {...props}
      className={cx(
        "m-lift relative inline-flex h-[34px] flex-none items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-full px-4 text-[13px] font-medium",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Primary by inversion: a white pill with black text.
        variant === "primary" && "bg-ink text-bg hover:bg-ink/85",
        variant === "ghost" && "text-ink ring-1 ring-inset ring-control hover:ring-muted",
        variant === "danger" && "text-danger ring-1 ring-inset ring-danger/50 hover:ring-danger",
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
 * The style's one move: options as plain labels; the selected one gets a 1px accent line exactly as wide
 * as its label, on the control's bottom edge. Keyboard: arrow keys move the selection.
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
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  const index = options.indexOf(value);
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[index];
      if (el) setBar({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [index, options.length]);

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("relative flex h-[34px] items-stretch gap-5 border-b border-line", className)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onChange(options[(index + 1) % options.length]);
        if (e.key === "ArrowLeft") onChange(options[(index - 1 + options.length) % options.length]);
      }}
    >
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
            className={cx("relative -mb-px whitespace-nowrap text-[13px] transition-colors duration-200", on ? "text-ink" : "text-muted hover:text-ink")}
          >
            {render ? render(o) : String(o)}
          </button>
        );
      })}
      {/* The style's one selection mark: a 1px accent line exactly as wide as the label, sliding between options. */}
      <span
        aria-hidden
        className="m-slide absolute bottom-[-1px] left-0 h-px bg-active"
        style={bar ? { transform: `translateX(${bar.x}px)`, width: bar.w } : { opacity: 0 }}
      />
    </div>
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
  if (!hash) return <span className="num text-faint">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="num whitespace-nowrap text-ink underline decoration-control underline-offset-4 transition hover:decoration-ink"
      title={hash}
    >
      {label ?? `${hash.slice(0, 6)}…${hash.slice(-4)}`}
    </a>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline justify-between gap-3 text-[12px] text-muted">
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
      <div className="text-[12px] text-muted">{label}</div>
      <div className={cx("num mt-1 truncate text-ink", lead ? "text-[32px] leading-10" : "text-[20px] leading-7")}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[12px] text-faint">{sub}</div>}
    </div>
  );
}

export const inputClass =
  "num h-10 w-full rounded-[6px] bg-raised px-3.5 text-[14px] text-ink ring-1 ring-inset ring-control placeholder:text-faint " +
  "transition focus:outline-none focus:ring-active";
