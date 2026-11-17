// The workspace's one ESLint entry point, and the first reader `packages/config/eslint/base.mjs` has
// had: that config existed, was exported as `@crossengin/config/eslint/base`, and nothing imported
// it, while `pnpm lint` ran `next lint` in one app and exited 1 on an interactive prompt.
//
// Type-aware rules read each file through its package's `tsconfig.json`, and every cross-package
// import resolves to that package's `dist/*.d.ts`. So this runs AFTER `pnpm -r build`, exactly as
// `pnpm -r typecheck` does; before a build every workspace import is unresolved and the unsafe-*
// rules report the build's absence rather than the code.
//
// Test files, and the `src/test-*.ts` fakes they share, are not linted. They are outside every
// `tsconfig.json` (each package's `tsconfig.typecheck.json` re-includes them, ADR-0307), so the
// project service cannot type them, and `pnpm -r typecheck` already checks them. A
// `vitest.config.ts` is in the same position.
//
// Existing violations are recorded in `eslint-suppressions.json` (ESLint's bulk suppressions) and
// that file is the backlog: a new violation fails, a fixed one must be pruned with
// `pnpm lint --prune-suppressions`, and the counts can only go down.
import base from "./packages/config/eslint/base.mjs";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.test.ts",
      "**/src/test-*.ts",
      "**/vitest.config.ts",
      "**/next-env.d.ts",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "web-ui/**",
      "docs/**",
      "deploy/**",
      "scripts/**",
    ],
  },
  ...base,
];
