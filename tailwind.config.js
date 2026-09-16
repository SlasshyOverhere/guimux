/** @type {import('tailwindcss').Config} */
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
      colors: {
        // Graphite workbench. Grays carry the chrome; color is for state only.
        ink: {
          950: "#0a0a0a",
          900: "#171717",
          850: "#1e1e1e",
          800: "#262626",
          700: "#2a2a2a",
          600: "#404040",
          500: "#737373",
          400: "#a1a1a1",
          300: "#d4d4d4",
          200: "#e5e5e5",
          100: "#fafafa",
        },
        accent: {
          400: "#fafafa",
          500: "#e5e5e5",
          600: "#a1a1a1",
        },
        moss: {
          400: "#81b88b",
        },
        clay: {
          400: "#c74e39",
        },
      },
      boxShadow: {
        pop: "0 10px 24px rgba(0, 0, 0, 0.18)",
      },
    },
  },
  plugins: [],
};
