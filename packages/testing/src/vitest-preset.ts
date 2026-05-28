import { defineConfig } from "vitest/config";

export const vitestPreset = defineConfig({
  test: {
    globals: false,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json", "json-summary"],
      // Re-export barrels (`src/index.ts`, `src/**/index.ts`) are
      // pure `export * from ...` aggregators with no testable logic;
      // d.ts files are type-only; dist/ is build output; test files
      // are themselves the harness. Excluding them keeps coverage
      // honest — measured % reflects actual code paths.
      exclude: [
        "**/dist/**",
        "**/node_modules/**",
        "**/*.d.ts",
        "**/*.test.ts",
        "**/index.ts",
        "**/vitest.config.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
