import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Non-type-aware flat config. The strict tsc pass (`pnpm -r typecheck`) plus the
// workspace-wide test-file type-check (`pnpm typecheck:tests`, ADR-0244) already
// cover type correctness; ESLint's job here is the syntactic rules tsc does not
// enforce. Type-aware linting (recommendedTypeChecked) is a deferred opt-in
// (ADR-0246) — it is slow and surfaces a large separate backlog.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Enforce `import type` for module-level type-only imports (matters under
      // verbatimModuleSyntax); allow concise inline `import()` type annotations.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", disallowTypeAnnotations: false },
      ],
    },
  },
  {
    // ADR-0244 Q2: test files may not suppress the type-checker. The strict
    // src/test type invariant is only meaningful if tests can't opt out of it.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": true,
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      // Mock generators in tests legitimately throw/return without yielding
      // (simulating provider failures / empty streams). Kept on for src.
      "require-yield": "off",
    },
  },
);
