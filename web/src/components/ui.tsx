import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Small shared primitives so every panel, chip and link looks the same. */

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("rounded-2xl border border-line bg-panel", className)}>
      {(title || aside) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-[13px] font-medium tracking-wide text-muted">{title}</h2>
          {aside}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type Tone = "active" | "triggered" | "executed" | "cancelled" | "danger";
const toneClass: Record<Tone, string> = {
  active: "text-active bg-active/10 ring-active/25",
  triggered: "text-triggered bg-triggered/10 ring-triggered/30",
  executed: "text-executed bg-executed/10 ring-executed/25",
  cancelled: "text-muted bg-raised ring-line",
  danger: "text-danger bg-danger/10 ring-danger/25",
};

export function Chip({ tone, children, pulse }: { tone: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        toneClass[tone],
      )}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full bg-current", pulse && "animate-pulse")} />
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
        "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition",
        "disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-active/60",
        variant === "primary" && "bg-ink text-bg hover:bg-white",
        variant === "ghost" && "border border-line bg-raised text-ink hover:border-faint",
        variant === "danger" && "border border-danger/30 bg-danger/10 text-danger hover:bg-danger/15",
        className,
      )}
    />
  );
}

export function TxLink({ href, hash, label }: { href: string; hash?: string; label?: string }) {
  if (!hash) return <span className="num text-faint">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="num text-ink underline decoration-line underline-offset-4 transition hover:decoration-ink"
      title={hash}
    >
      {label ?? `${hash.slice(0, 6)}…${hash.slice(-4)}`}
    </a>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between text-xs text-muted">
        {label}
        {hint && <span className="text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "num h-11 w-full rounded-xl border border-line bg-bg px-3.5 text-[15px] text-ink placeholder:text-faint " +
  "focus:border-faint focus:outline-none focus:ring-2 focus:ring-active/30";
