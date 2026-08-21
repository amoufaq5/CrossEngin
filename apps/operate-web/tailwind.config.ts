import type { Config } from "tailwindcss";

/**
 * CrossEngin Operate design system — an SAP-Fiori-flavored enterprise shell in
 * the CrossEngin palette: a cool neutral canvas, a translucent shell bar, dense
 * data tables, and tile launchpads, with the brand red (#E5132B) reserved for
 * selection, primary actions, and the brand mark. Type is Inter, set bold.
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
          DEFAULT: "#12141a",
          muted: "#5b636f",
          faint: "#8b93a1",
        },
        surface: {
          DEFAULT: "#ffffff",
          soft: "#f4f6f9",
          sunken: "#eceef2",
        },
        line: "#e2e5ea",
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
        // Fiori-style elevation: flat tiles that lift on hover; `pop` for menus.
        card: "0 1px 2px rgba(16,24,40,0.04)",
        tile: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)",
        "tile-hover": "0 10px 28px rgba(16,24,40,0.12)",
        shell: "0 1px 0 rgba(16,24,40,0.06)",
        pop: "0 8px 24px rgba(16,24,40,0.12)",
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      backdropBlur: {
        shell: "18px",
      },
    },
  },
  plugins: [],
};

export default config;
