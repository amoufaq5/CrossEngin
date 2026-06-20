import type { Config } from "tailwindcss";

/**
 * CrossEngin Operate design system — a crisp white canvas with a single
 * salient red as the brand accent. Red is reserved for identity, primary
 * actions, active navigation, and key figures; everything else stays
 * neutral so the red reads as deliberate, not loud.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#E5132B",
          50: "#fff1f2",
          100: "#ffe1e3",
          200: "#ffc8cc",
          300: "#ffa1a8",
          400: "#fb6b76",
          500: "#ef3c4a",
          600: "#E5132B",
          700: "#c00f23",
          800: "#9e1121",
          900: "#831421",
        },
        ink: {
          DEFAULT: "#16181d",
          muted: "#5b6472",
          faint: "#8a93a3",
        },
        surface: {
          DEFAULT: "#ffffff",
          soft: "#f7f8fa",
          sunken: "#f1f3f6",
        },
        line: "#e7eaef",
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)",
        pop: "0 8px 24px rgba(16,24,40,0.12)",
      },
      borderRadius: {
        xl: "0.9rem",
      },
    },
  },
  plugins: [],
};

export default config;
