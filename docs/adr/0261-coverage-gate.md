# ADR-0261: Workspace-wide coverage gate

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0245 (CI gate baseline), ADR-0246 (lint flat config gate), ADR-0250 (Prettier format gate), ADR-0244 (typecheck:tests gate) |

## Context

After ADR-0245 (CI gate), ADR-0246 (lint), ADR-0250 (format), and
ADR-0244 (typecheck:tests), the workspace had a four-step
static-quality pipeline enforced by CI: **build → lint → format
→ typecheck → typecheck:tests → test**. Tests ran but coverage
was unmeasured.

This session shipped 12 milestones from M-maint.prettier-gate
(ADR-0250) through M4.13 (ADR-0260) and grew the test count from
9,405 to 9,507 (+102 tests). Without a coverage gate, that
growth is **count-vanity**:

- A 200-line module covered by 1 happy-path test passes CI.
- A new milestone with 10 tests that all stub the same path can
  inflate the total without exercising new code.
- Future regressions in untested branches go silent.

The vitest preset already had `provider: "v8"` configured —
running `vitest run --coverage` would work if the
`@vitest/coverage-v8` peer dep were installed. That's the only
substrate gap.

## Decision

Wire `@vitest/coverage-v8` as a root workspace devDependency,
extend the shared `vitestPreset` with thresholds + exclusions,
add a root `pnpm coverage` script, and add a CI step that
enforces it.

**Substrate:**

1. **Root devDep.** `@vitest/coverage-v8 ^2.1.0` in
   `package.json` devDependencies — installed at the root so
   every workspace package (which links the root binary cache)
   can find it via pnpm's hoisted layout.

2. **Preset thresholds** in
   `packages/testing/src/vitest-preset.ts`:

   ```ts
   coverage: {
     provider: "v8",
     reporter: ["text", "html", "json", "json-summary"],
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
   }
   ```

3. **Exclusions rationale.** Re-export barrels (`src/index.ts`,
   `src/**/index.ts`) are pure `export * from ...` aggregators
   with no runtime logic — including them in coverage drags the
   percentage down for no honest reason (they're 0-statement
   files V8 reports as "uncovered"). `.d.ts` files are
   type-only. `dist/` is build output. Test files are the
   harness. `vitest.config.ts` is itself the test config.
   Excluding these keeps coverage honest — measured % reflects
   actual code paths.

4. **Threshold values.** Conservative defaults sized to the
   workspace's current state (measured before commit):
   - **80% statements / lines / functions** — every package
     comfortably exceeds (lowest: `api-gateway-runtime` at 86.44%).
   - **70% branches** — branches are stricter because path
     explosion in error handlers + defensive checks pulls
     percentages down; every package still exceeds (lowest:
     `api-gateway-runtime` at 80.4%).

5. **Root script.**
   ```
   "coverage": "pnpm build && pnpm -r --filter \"!@crossengin/config\" exec vitest run --coverage"
   ```
   Filter excludes `@crossengin/config` (TypeScript / ESLint /
   Prettier config files only — no vitest dep, no tests).
   Every other workspace package has a `vitest.config.ts`
   re-exporting the preset, so the threshold flows through
   automatically.

6. **CI step.** Added after `Test all packages` in
   `.github/workflows/ci.yml`. The step name is
   "Coverage gate (V8, workspace-wide)" and the verify job's
   name expands to
   `build · lint · format · typecheck · typecheck:tests · test · coverage`.
   Timeout bumped 20 → 30 minutes (coverage adds ~2x test
   runtime under V8 instrumentation).

## Alternatives considered

- **Per-package thresholds tuned to each package's current
  coverage.**
  - **Why not:** 57 separate threshold blocks would need
    maintenance + per-package PR review to bump. A single
    workspace-wide floor is the simpler invariant. Packages
    with weaker coverage (none currently) become known-debt
    to address before the next milestone.

- **Lower threshold (e.g. 50%) to bias against false
  positives.**
  - **Why not:** the workspace already exceeds 80%+ everywhere.
    Setting the floor lower would be ceremonial — would never
    fire. 80% is the actual operating point + threshold
    matches reality.

- **Include re-export barrels (`index.ts`) in coverage.**
  - **Why not:** Vitest V8 reports `export * from ...` lines as
    0 statements covered (no runtime call). Including them
    artificially pulls the All-files % down (was visible in
    `types` package: 96.87% with barrels vs 100% without).
    Honest threshold matters more than blanket inclusion.

- **Coverage as a separate workflow (decoupled from CI verify
  job).**
  - **Why not:** decoupled gates drift. ADR-0245 established a
    single `verify` job for all static-quality gates;
    coverage belongs in the same job for atomic
    pass/fail signal on each PR.

- **Aggregate coverage across the workspace via a custom
  collector script.**
  - **Why not:** per-package gates are stricter than aggregate.
    A 60% package + 100% package average above 80%, but the
    60% package is the one to address. Per-package thresholds
    surface that directly.

- **Coverage at function granularity only (`functions` threshold
  only, no statements/branches/lines).**
  - **Why not:** function coverage is the weakest signal —
    measures "was the function called" not "what fraction of
    its body ran." Statements + branches catch the cases that
    functions miss.

- **Use Istanbul instead of V8 provider.**
  - **Why not:** V8 is faster (no AST transform), already
    configured in the preset since pre-M-maint.prettier-gate,
    and matches Node's runtime profile. Istanbul's per-line
    detail is finer but irrelevant for a workspace-wide
    threshold gate.

- **Coverage tested only on PR (skipped on main pushes).**
  - **Why not:** main can drift if it's not enforced there. The
    CI workflow runs on both `push` to main/master and
    `pull_request`; the coverage gate runs on both.

## Consequences

- **Positive:** the static-quality gate quartet
  (lint / format / typecheck / coverage) is complete on top of
  build + tests. CI now enforces both that tests pass AND that
  they cover the code.
- **Positive:** future milestones must maintain ≥80% coverage
  to land. Test growth becomes measurable rather than
  count-vanity.
- **Positive:** the threshold reflects measured reality
  (current operating point), so the gate doesn't fire
  spuriously on existing code.
- **Positive:** Vitest V8 is fast — coverage adds ~30-40%
  runtime over baseline tests (verified locally on 57
  packages). CI runs comfortably within the 30-minute timeout.
- **Neutral:** root devDep grew by one (`@vitest/coverage-v8`).
  Installed via pnpm `-w`, available to every package without
  per-package install.
- **Neutral:** CI verify job timeout bumped 20 → 30 minutes.
- **Reversibility:** trivial — remove the `coverage` script
  from root + drop the CI step + revert preset thresholds. The
  test infrastructure stays unchanged.

## Implementation notes

- pnpm 9.x has a known parsing wrinkle with `--` arg
  forwarding through `pnpm -r run`: `pnpm -r test -- --coverage`
  does NOT forward `--coverage` to the script (it's silently
  dropped). The workaround is `pnpm -r exec vitest run
  --coverage`, which bypasses script-arg forwarding entirely.
- `pnpm -r exec` requires every filtered package to have the
  binary available; `@crossengin/config` has no vitest dep
  (it's a typescript/eslint/prettier config-only package), so
  the filter `!@crossengin/config` excludes it. Every other
  workspace package has `vitest.config.ts`.
- Vitest 2.1 exits with code 1 when threshold violations occur
  (verified: temporarily set statements threshold to 99% and
  ran `api-gateway-runtime` whose coverage is 86.44% — exit
  code 1 + "ERROR: Coverage for statements (86.44%) does not
  meet global threshold (99%)" stderr message).
- Lowest coverage in the workspace at landing time:
  `api-gateway-runtime` (86.44% statements, 80.4% branches,
  98.88% functions, 86.44% lines) — comfortably above
  thresholds. `runtime.ts` in that package has 78.25%
  statements / 69.4% branches (the M4 pipeline runner with
  many path branches); since the threshold is the package-
  level average not per-file, the package passes.
- Coverage directories (`coverage/`) are already in
  `.gitignore` — no change.
- Test count is unchanged (no new tests added; only the
  measurement gate). Workspace test count stays at 9,507 from
  M4.13.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Per-package thresholds for high-importance substrate packages (e.g. crypto, kernel-pg) at 90%+ — currently bundled with workspace floor at 80% | platform | _deferred_ |
| Codecov / Coveralls integration to publish coverage reports per PR (would surface line-by-line changes; requires API token + report upload step) | platform | _deferred_ |
| Differential coverage on PRs — "new code must be ≥X% covered" rather than uniform workspace threshold | platform | _deferred_ |
| Skip coverage on draft PRs to save CI minutes | platform | _deferred_ |
| Test the gate fires on a deliberate regression (e.g. add an untested code path + verify CI fails) — manual smoke test today; future Q for a self-test mechanism | platform | _deferred_ |
| Migration to Vitest 3.x when stable (config shape, threshold semantics may shift) | platform | _deferred_ |

## References

- ADR-0245 — CI gate baseline (one `verify` job containing all
  static-quality steps).
- ADR-0246 — ESLint flat config gate (lint as part of verify).
- ADR-0250 — Prettier format gate (format:check as part of
  verify).
- ADR-0244 — typecheck:tests gate (test-file type checking as
  part of verify).
- `package.json` — root `coverage` script.
- `packages/testing/src/vitest-preset.ts` — thresholds +
  exclusions config.
- `.github/workflows/ci.yml` — `Coverage gate (V8, workspace-wide)`
  step.
