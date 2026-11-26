import { fileURLToPath } from "node:url";

import { vitestPreset } from "@crossengin/testing/vitest";
import { defineConfig, mergeConfig } from "vitest/config";

// The shared preset (node environment: every module under test here is a pure `lib/` helper or an
// import-free `.mjs`, so no DOM is needed), plus the one thing this app has that a package does not:
// the `@/*` → `./*` path alias from `tsconfig.json`, without which any helper importing a sibling as
// `@/lib/...` could not be loaded.
export default mergeConfig(
  vitestPreset,
  defineConfig({
    resolve: {
      alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
    },
    test: {
      include: ["**/*.test.ts"],
      exclude: ["node_modules/**", ".next/**"],
    },
  }),
);
