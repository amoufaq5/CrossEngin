import { defineConfig } from "vitest/config";

export const vitestPreset = defineConfig({
  test: {
    globals: false,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
    },
  },
});
