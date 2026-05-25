# ADR-0246: ESLint v9 flat config + lint gate

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-25 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0244 (type-check `*.test.ts`, future Q2), ADR-0245 (CI gate) |

## Context

ADR-0244 closed the src/test type-drift gap and named future Q2: a lint rule
forbidding `@ts-expect-error` / `as any` in `*.test.ts`, so the strict
type-invariant can't be quietly suppressed inside a test. CLAUDE.md recorded
"no top-level lint script; ESLint not migrated to v9 flat config; ignore lint
until asked." A scaffolded flat-config base existed at
`@crossengin/config/eslint/base.mjs` — but it was **unwired** (no root config,
no `lint` script, no CI step), its lint deps were only *peer*-declared, and it
selected `recommendedTypeChecked` (the type-aware ruleset). Type-aware linting
across 57 packages would be slow and would surface a large, open-ended backlog
(`no-floating-promises`, `no-unsafe-*`, `restrict-template-expressions`, …) —
turning "add a lint gate" into "fix the whole codebase's lint debt."

ADR-0245 had just added CI; the lint gate is the natural completion.

## Decision

Wire ESLint v9 flat config workspace-wide, **non-type-aware**, green on first
run, enforced in CI.

1. **One root pass.** `eslint.config.mjs` at the repo root re-exports the shared
   `@crossengin/config/eslint/base.mjs` (imported by relative path, so the root
   needs no workspace-package dependency). Root script `"lint": "eslint ."`
   lints the whole monorepo in a single invocation. The lint deps
   (`eslint`, `@eslint/js`, `typescript-eslint`) are declared as **root
   devDependencies** so CI resolution doesn't depend on pnpm's hoist defaults.

2. **Non-type-aware ruleset.** `base.mjs` now uses
   `js.configs.recommended` + `tseslint.configs.recommended` (not
   `recommendedTypeChecked`) + two project rules: `no-unused-vars`
   (`^_`-ignored) and `consistent-type-imports`
   (`disallowTypeAnnotations: false` — enforce `import type` for module-level
   type-only imports, which matters under `verbatimModuleSyntax`, while allowing
   concise inline `import()` type annotations). Rationale: `pnpm -r typecheck`
   plus the ADR-0244 `pnpm typecheck:tests` already cover type correctness;
   ESLint's job is the syntactic rules tsc doesn't enforce. Type-aware linting
   is a deferred opt-in (Open questions).

3. **ADR-0244 Q2 rule (the headline).** A `**/*.test.ts` override fully bans
   `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` (`ban-ts-comment` with
   `ts-expect-error: true`, vs. recommended's allow-with-description) and sets
   `no-explicit-any: error`. Tests can no longer opt out of the type-checker.
   `require-yield` is turned off for test files only (mock generators
   legitimately throw / return without yielding to simulate provider failures).

4. **CI gate.** A `Lint` step (`pnpm lint`) runs in `.github/workflows/ci.yml`
   between build and type-check.

The first run surfaced **25 violations**; all fixed: 6 auto-fixed
(`prefer-const`, `no-regex-spaces`, `consistent-type-imports` hoists), the inline
`import()` annotations resolved by `disallowTypeAnnotations: false` (13), the
mock-generator `require-yield` resolved by the test-file override (5), and one
manual `no-useless-escape` (`pwa/manifest.ts` regex char-class). Lint is green;
`pnpm -r typecheck`, `pnpm typecheck:tests`, and the affected packages' tests
re-verified after the autofixes.

## Alternatives considered

- **Keep `recommendedTypeChecked` (type-aware), fix the whole backlog.**
  - **Pros:** catches `no-floating-promises`, unsafe-`any` flows, etc.
  - **Cons:** slow (per-file type info); surfaces a large, open-ended backlog
    unrelated to this milestone's goal.
  - **Why not:** scope explosion. Deferred to an incremental opt-in.

- **Per-package `eslint.config` + `turbo run lint`.**
  - **Cons:** 25+ near-identical configs; the single root pass covers the
    monorepo with one file.
  - **Why not:** churn without benefit; flat config + one root run is idiomatic.

- **Fix all 13 inline `import()` type annotations instead of
  `disallowTypeAnnotations: false`.**
  - **Cons:** 13 hoist edits across 6 files for a stylistic rule; inline
    `import()` types in tests are a legitimate, concise pattern.
  - **Why not:** the rule's real value (module-level `import type` consistency)
    is retained; the inline restriction isn't worth the churn.

- **`eslint-disable` comments for the 5 `require-yield` mock generators.**
  - **Cons:** five scattered disable comments vs. one documented config line;
    the pattern (throwing mock generator) is test-wide.
  - **Why not:** a scoped config rule is cleaner and self-documenting.

- **Rely on pnpm's default `public-hoist-pattern` (`*eslint*`) for CI.**
  - **Cons:** implicit; a future `.npmrc` clearing the pattern would break root
    `eslint .`.
  - **Why not:** declaring root devDependencies is explicit and robust (the
    install was offline; lockfile churn was +9 lines; frozen install still
    passes).

## Consequences

- **Positive:** the ADR-0244 Q2 invariant is enforced — tests cannot suppress
  the type-checker; flat config is established and green; lint is a CI gate.
- **Negative:** CI gains a lint step (seconds, non-type-aware); type-aware bug
  classes (`no-floating-promises`, unsafe-`any`) are not yet caught.
- **Neutral:** `base.mjs` changed from type-aware to non-type-aware (it was
  unused, so no consumer churn); the CLAUDE.md "ignore lint" note is retired.
- **Reversibility:** trivial — delete `eslint.config.mjs` + the `lint` script /
  CI step.

## Implementation notes

- `consistent-type-imports` is non-type-aware (usage-based within a file) — no
  `parserOptions.project` needed; that keeps lint fast.
- The non-type-aware autofixes were verified safe: `pnpm -r typecheck` (0),
  `pnpm typecheck:tests` (0), and the 5 affected packages' tests (1,594 passing)
  after `--fix`. `verbatimModuleSyntax` makes the `import type` hoists correct.
- The `Lint` CI step runs after build (so output is grouped with the other
  checks) though it needs no build (non-type-aware).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Incrementally opt packages into `recommendedTypeChecked` (type-aware) as their backlog is cleared | platform | _deferred_ |
| Add a Prettier `--check` step to CI (`@crossengin/config/prettier` exists) | platform | _deferred_ |
| Mark `verify` (incl. lint) a required check in branch protection (pairs with ADR-0245 Q1) | platform | 2026-06-30 |
| Lint the flat-config `.mjs` files themselves | platform | _deferred_ |

## References

- ADR-0244 — Type-check `*.test.ts` workspace-wide (Q2 is the ban-ts-comment rule here).
- ADR-0245 — CI gate (this adds the lint step).
- `eslint.config.mjs`, `packages/config/eslint/base.mjs`, root `package.json` `lint` script.
