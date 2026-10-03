/** @type {import('tailwindcss').Config} */
// Everything visual resolves to a --gm-* token in src/styles.css. The color
// scale maps onto the tokens; the type/space scales read them, so the compact
// density mode re-declares five variables and retunes the whole app.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      // Named type steps, not ad-hoc px. One scale for the whole app.
      fontSize: {
        label: ["var(--gm-fs-label)", { lineHeight: "1.4" }],
        meta: ["var(--gm-fs-meta)", { lineHeight: "1.5" }],
        body: ["var(--gm-fs-body)", { lineHeight: "1.5" }],
        strong: ["var(--gm-fs-strong)", { lineHeight: "1.45" }],
        title: ["var(--gm-fs-title)", { lineHeight: "1.3" }],
      },
      spacing: {
        row: "var(--gm-row-y)",
        tab: "var(--gm-tab-h)",
      },
      height: {
        ctl: "var(--gm-ctl-h)",
        tab: "var(--gm-tab-h)",
      },
      colors: {
        // Ink is text only, brightest to faintest. Surfaces are named by
        // elevation instead, so `bg-surface-raised` says what it is.
        ink: {
          100: "var(--gm-ink)",
          200: "var(--gm-ink-dim)",
          300: "var(--gm-ink-soft)",
          400: "var(--gm-ink-mute)",
          500: "var(--gm-ink-faint)",
        },
        surface: {
          canvas: "var(--gm-canvas)",
          panel: "var(--gm-panel)",
          raised: "var(--gm-raised)",
          dialog: "var(--gm-dialog)",
          term: "var(--gm-term)",
        },
        // Destructive actions only, on top of the same red the banner uses.
        clay: {
          400: "var(--gm-red)",
        },
      },
    },
  },
  plugins: [],
};
