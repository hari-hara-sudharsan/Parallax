import type { ButtonHTMLAttributes, ReactNode } from "react";

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
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cx("rounded-[6px] bg-panel shadow-[0_12px_28px_rgba(0,0,0,.2)]", className)}>
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
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex h-[34px] flex-none items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 text-[13px] font-medium transition duration-150",
        "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
        // Primary by inversion: a white pill with black text.
        variant === "primary" && "bg-ink text-bg hover:bg-ink/85",
        variant === "ghost" && "text-ink ring-1 ring-inset ring-control hover:ring-muted",
        variant === "danger" && "text-danger ring-1 ring-inset ring-danger/50 hover:ring-danger",
        className,
      )}
    />
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
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("flex h-[34px] items-stretch gap-5 border-b border-line", className)}
      onKeyDown={(e) => {
        const i = options.indexOf(value);
        if (e.key === "ArrowRight") onChange(options[(i + 1) % options.length]);
        if (e.key === "ArrowLeft") onChange(options[(i - 1 + options.length) % options.length]);
      }}
    >
      {options.map((o) => {
        const on = o === value;
        return (
          <button
            key={String(o)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o)}
            className={cx("relative -mb-px whitespace-nowrap text-[13px] transition-colors", on ? "text-ink" : "text-muted hover:text-ink")}
          >
            {render ? render(o) : String(o)}
            <span className={cx("absolute inset-x-0 bottom-0 h-px transition-opacity", on ? "bg-active opacity-100" : "opacity-0")} />
          </button>
        );
      })}
    </div>
  );
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
