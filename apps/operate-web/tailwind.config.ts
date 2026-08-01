import type { Config } from "tailwindcss";

/**
 * CrossEngin Operate design system — minimalist. A near-monochrome canvas with
 * generous whitespace, hairline borders, and no shadows; a single restrained red
 * accent is reserved for the brand mark and primary actions only, so the interface
 * reads as calm and content-first.
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
          50: "#fff5f5",
          100: "#ffe8ea",
          200: "#ffd2d6",
          300: "#ffa1a8",
          400: "#fb6b76",
          500: "#ef3c4a",
          600: "#E5132B",
          700: "#c00f23",
          800: "#9e1121",
          900: "#831421",
        },
        ink: {
          DEFAULT: "#1a1c20",
          muted: "#646c78",
          faint: "#9aa1ac",
        },
        surface: {
          DEFAULT: "#ffffff",
          soft: "#fafbfc",
          sunken: "#f2f4f6",
        },
        line: "#ecedf0",
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
        // Minimalist: flat by default; `pop` is a soft, low overlay for menus only.
        card: "none",
        pop: "0 6px 20px rgba(16,24,40,0.08)",
      },
      borderRadius: {
        xl: "0.625rem",
      },
    },
  },
  plugins: [],
};

export default config;
