import { vitestPreset } from "@crossengin/testing/vitest";
import { mergeConfig } from "vitest/config";

// SSR-only: components render via react-dom/server in a Node environment.
// No jsdom; esbuild handles the automatic JSX transform so .tsx test files
// compile without a bundler in the test path.
export default mergeConfig(vitestPreset, {
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});
