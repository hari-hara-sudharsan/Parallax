import type { Config } from "tailwindcss";

/**
 * Tripwire design tokens. Dark, precise, trading-desk feel: one neutral ramp + one colour per
 * rule state, so colour always means the same thing:
 *   active = blue · triggered (in flight) = amber · executed = green · cancelled = grey · danger = red
 */
export default {
  content: ["./src/components/**/*.{ts,tsx}", "./src/app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        raised: "rgb(var(--raised) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        faint: "rgb(var(--faint) / <alpha-value>)",
        active: "rgb(var(--active) / <alpha-value>)",
        triggered: "rgb(var(--triggered) / <alpha-value>)",
        executed: "rgb(var(--executed) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      keyframes: {
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 rgb(var(--triggered) / 0.55)" },
          "100%": { boxShadow: "0 0 0 10px rgb(var(--triggered) / 0)" },
        },
        "slide-in": {
          "0%": { opacity: "0", transform: "translateY(-6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 1.2s ease-out infinite",
        "slide-in": "slide-in 0.35s ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
