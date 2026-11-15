import type { Config } from "tailwindcss";

/**
 * Parallax design tokens ("data terminal" app style; values in globals.css). Colour means one thing each:
 *   active = the accent (selection lines, rule levels) · triggered = in flight · executed = done · danger = bad
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
        rule: "rgb(var(--rule) / <alpha-value>)",
        control: "rgb(var(--control) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        faint: "rgb(var(--faint) / <alpha-value>)",
        active: "rgb(var(--active) / <alpha-value>)",
        triggered: "rgb(var(--triggered) / <alpha-value>)",
        executed: "rgb(var(--executed) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
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
