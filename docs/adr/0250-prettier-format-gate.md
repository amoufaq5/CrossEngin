# ADR-0250: Prettier config + format scripts + CI gate

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-25 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0246 (lint gate — Q2 is this Prettier gate), ADR-0245 (CI gate), ADR-0244 (typecheck:tests) |

## Context

ADR-0246 wired the ESLint flat-config lint gate and named future Q2: "Add a
Prettier `--check` step to CI (`@crossengin/config/prettier` exists)." That
shared config (`@crossengin/config/prettier/index.json`) was a scaffold — present
but **unwired**: no root config, no `format` / `format:check` scripts, no CI
step, and `prettier` was only a *dependency of `@crossengin/config`* (hoisted),
not a root devDependency. Formatting across the monorepo was therefore
unenforced — whitespace drift was invisible to CI and to `pnpm lint` (ESLint is
non-type-aware and carries no formatting rules per ADR-0246).

A green `prettier --check` CI gate requires the tree to already be formatted, so
this is necessarily a two-part milestone: **(1)** a one-time reformat of the
existing TypeScript/JS source, then **(2)** the config + scripts + gate that keep
it that way. The reformat touches a lot of files; the question was whether to do
it. The user chose "Full reformat + gate."

## Decision

Wire Prettier workspace-wide, **green on first run**, enforced in CI — mirroring
the ADR-0246 lint-gate shape.

1. **Root config re-exports the shared base.** `.prettierrc.cjs` at the repo root
   is `module.exports = require("./packages/config/prettier/index.json")` —
   relative path, so the root needs no workspace-package dependency (exactly how
   `eslint.config.mjs` re-exports the shared ESLint base in ADR-0246). The
   previously-unused `@crossengin/config/prettier` scaffold is now the single
   source of truth; no duplication, no drift footgun. Settings: `semi: true`,
   `singleQuote: false`, `trailingComma: "all"`, `printWidth: 100`, `tabWidth: 2`,
   `arrowParens: "always"` — the de-facto style the codebase already used.

2. **Scoped to TS/JS source only.** `.prettierignore` excludes build/vendor
   output (`**/dist/**`, `**/.next/**`, `**/node_modules/**`, `**/coverage/**`,
   `pnpm-lock.yaml`) **and** all `**/*.md` / `**/*.json` / `**/*.yaml` /
   `**/*.yml`. Markdown (ADRs, CLAUDE.md, README) is hand-wrapped to a specific
   column rhythm that Prettier's prose-reflow would fight; JSON/YAML are
   hand-maintained config/data. Prettier governs TypeScript/JS source, where
   mechanical formatting has no downside.

3. **Root scripts.** `"format": "prettier --write ."` and
   `"format:check": "prettier --check ."`. `prettier` is declared as a **root
   devDependency** (`^3.3.0`, resolving to 3.8.3 — the same version
   `@crossengin/config` pins) so CI resolution doesn't depend on pnpm's hoist
   defaults — the identical robustness call ADR-0246 made for the ESLint deps.

4. **CI gate.** A `Format check (Prettier --check)` step (`pnpm format:check`)
   runs in `.github/workflows/ci.yml` immediately after `Lint` — the two
   static-style gates sit together, before the type-checks.

5. **The reformat.** `pnpm format` rewrote **636** TS/JS source + test files
   (whitespace only — indentation, line wrapping at 100 cols, trailing commas,
   quote normalization). One idempotency straggler
   (`packages/ai-router-pg/src/cost-ceiling-resolver.test.ts`) needed a second
   `--write` pass; after that `pnpm format:check` is clean (exit 0).

The reformat was verified **non-functional**: `pnpm -r typecheck` (0 errors),
`pnpm lint` (0 violations), `pnpm typecheck:tests` (0 errors), and `pnpm -r test`
all green at **9,405** tests — unchanged, because no test was added or removed
and the changes are whitespace.

## Alternatives considered

- **Gate without reforming (just add `format:check` to CI).**
  - **Why not:** impossible — `--check` fails on the first unformatted file. A
    green gate requires a formatted tree first. The reformat is the precondition.

- **Duplicate the six settings in a root `.prettierrc.json`** (the initial
  approach during this milestone).
  - **Cons:** two byte-identical copies of the config that can silently drift;
    the shared `@crossengin/config/prettier` would stay unused.
  - **Why not:** the re-export is the established pattern (ADR-0246 ESLint base)
    and removes the drift footgun for the cost of one `.cjs` line.

- **Include Markdown / JSON / YAML in Prettier's scope.**
  - **Cons:** Markdown here is hand-wrapped (the ADRs + CLAUDE.md have a
    deliberate column rhythm Prettier's prose-wrap would rewrite wholesale);
    JSON/YAML are hand-maintained config/data where a reflow adds churn without
    correctness value.
  - **Why not:** TS/JS is where mechanical formatting pays off; the rest is
    governed by hand. Re-scoping later is a one-line `.prettierignore` edit.

- **Per-package `.prettierrc` + `turbo run format`.**
  - **Cons:** 57 near-identical configs; the single root pass covers the monorepo
    in one invocation (same reasoning as the ADR-0246 single root lint pass).

- **Rely on pnpm's default `public-hoist-pattern` (`*prettier*`) for CI.**
  - **Cons:** implicit; a future `.npmrc` clearing the pattern would break root
    `prettier --check`. ADR-0246 already rejected the equivalent for ESLint.
  - **Why not:** an explicit root devDependency is robust (lockfile churn was +3
    lines; frozen install still passes).

- **A bare module-string `.prettierrc` (`"@crossengin/config/prettier"`).**
  - **Cons:** needs `@crossengin/config` resolvable from the repo root (a root
    workspace dependency). The relative-path `.cjs` re-export avoids that, just
    as the ESLint root config avoids it with a relative import.

## Consequences

- **Positive:** ADR-0246 Q2 is closed — formatting is enforced in CI; `pnpm
  format` is the one-command fix; the shared `@crossengin/config/prettier`
  scaffold is finally the single source of truth. New code lands pre-formatted or
  fails the gate, so review threads about whitespace disappear.
- **Negative:** one large whitespace-only commit (636 files) sits in history —
  `git blame` on those lines points here. Mitigated by isolating the reformat in
  its own commit so the blame is one hop to "style: apply Prettier."
- **Neutral:** CI gains a sub-second `--check` step; Markdown/JSON/YAML stay
  hand-formatted (documented exclusion). Test count unchanged (9,405).
- **Reversibility:** trivial — delete `.prettierrc.cjs` + `.prettierignore` + the
  two scripts + the CI step. The reformat itself need not be reverted (it's
  valid TS either way).

## Implementation notes

- The reformat is committed **separately** from the tooling so the 636-file
  whitespace diff doesn't bury the config/CI/docs changes (and vice versa).
- `.prettierrc.cjs` (not `.json`/`.mjs`): the root has no `"type": "module"`, so
  a CJS module that `require()`s the shared JSON is the simplest correct form.
- The `Format check` CI step runs after `Lint` though it needs no build (Prettier
  is non-type-aware) — grouping it with the other static gates keeps the workflow
  legible.
- Verified after the `.json`→`.cjs` config swap: `prettier --find-config-path`
  resolves `.prettierrc.cjs`, the re-export yields the six expected options, and
  `format:check` stays green (resolved values are identical, so the 636 already
  formatted files don't move).
- Follow-up (fix-forward): `.prettierrc.cjs` is the repo's first CommonJS file,
  so the ESLint flat config flagged `module` / `require` (no-undef) and
  `no-require-imports`. The shared `@crossengin/config/eslint/base.mjs` gained a
  `**/*.cjs` override (`sourceType: "commonjs"` + `no-require-imports` off) so
  `.cjs` files lint as CommonJS. (Missed initially because `pnpm lint` was run
  before the `.json`→`.cjs` swap; the lint gate would have caught it in CI.)

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Format Markdown / JSON / YAML too (drop them from `.prettierignore`) once a prose-wrap convention is settled | platform | _deferred_ |
| `prettier-plugin-organize-imports` or an import-sort plugin (overlaps ESLint `consistent-type-imports`) | platform | _deferred_ |
| Pre-commit hook running `format` (pairs with ADR-0244 Q3 / ADR-0245 pre-push idea) | platform | _deferred_ |
| Mark `verify` (now incl. format) a required check in branch protection (pairs with ADR-0245 Q1 + ADR-0246 Q3) | platform | 2026-06-30 |

## References

- ADR-0246 — ESLint flat config + lint gate (Q2 is this Prettier gate; the
  re-export + root-devDependency + single-root-pass patterns are reused here).
- ADR-0245 — CI gate (this adds the `Format check` step).
- `.prettierrc.cjs`, `.prettierignore`, `packages/config/prettier/index.json`,
  root `package.json` `format` / `format:check` scripts, `.github/workflows/ci.yml`.
