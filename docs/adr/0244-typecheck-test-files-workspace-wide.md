# ADR-0244: Type-check `*.test.ts` workspace-wide

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-25 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0243 (debt paydown, future Q1), ADR-0047 (kernel-pg / build setup) |

## Context

ADR-0243 restored the "all green, zero type errors" invariant after discovering
that `pnpm -r typecheck` reported 13 errors and `pnpm -r test` had a failing test
while README + CLAUDE.md claimed otherwise. It identified the **systemic cause**:
`*.test.ts` files are NOT type-checked. Each package's `tsconfig.json` carries
`"exclude": ["dist", "node_modules", "**/*.test.ts"]`; `typecheck` is
`tsc --noEmit` over that config and `build` is `tsc` over the same. Vitest
transpiles test files without type-checking. So a test fixture can use a stale
shape, an unused import can accumulate, a `readonly[]` can be `.sort()`-mutated,
or a capability object can omit a required field — all invisible to CI. ADR-0243
documented this as the recurrence risk and named the durable fix as future Q1:
**type-check `*.test.ts` in CI to catch src/test drift at the source.**

This milestone (`M-maint.typecheck-tests`) closes that gap. When the guard was
first run it surfaced **134 pre-existing test-file type errors across 24
packages** — none caught by `pnpm -r test` because they are type-only (the tests
pass at runtime). The work: reproduce the backlog with a low-churn mechanism, fix
all 134, and wire the guard so the gap cannot silently reopen.

## Decision

1. **Single-root-pass mechanism.** Add `tsconfig.typecheck-tests.json` at the repo
   root that extends `@crossengin/config/typescript/base.json`, sets
   `noEmit: true` + `composite: false`, and `include`s
   `packages/*/src/**/*.test.ts` + `apps/*/src/**/*.test.ts`. Cross-package
   `@crossengin/*` imports resolve through built `dist/*.d.ts`, so the guard
   requires a prior `pnpm build`. One file, no per-package config churn.

2. **Fix all 134 errors at the source — no suppression.** No `@ts-expect-error`,
   no `as any`. Fixes are real: complete stale fixtures, drop unused imports,
   copy-before-sort `readonly` arrays, type implicit-any bindings, route imports
   through types that are actually dependencies.

3. **Wire the guard.** Add root script
   `"typecheck:tests": "pnpm build && tsc -p tsconfig.typecheck-tests.json"`. It
   is self-contained (builds the workspace, then type-checks every test file) so
   a CI gate is a single `pnpm typecheck:tests`. `pnpm typecheck` (per-package
   src via turbo) is left unchanged so the fast local loop is unaffected; CI runs
   both.

The invariant is now genuinely workspace-wide: **0 src type errors + 0 test-file
type errors + 0 failing tests.**

## Alternatives considered

- **Drop `**/*.test.ts` from each package's `tsconfig` exclude.**
  - **Pros:** test files checked by the same per-package `typecheck`/`build` that
    already runs.
  - **Cons:** `build` emits `dist`, so test files would compile into shipped
    output unless a separate emit-excluding config is added per package; 25
    packages each need a second tsconfig + script. High churn.
  - **Why not:** the single-root-pass gets the same coverage with one file.

- **Per-package `tsconfig.test.json` + per-package `typecheck:tests` script.**
  - **Pros:** parallelizable via turbo; co-located.
  - **Cons:** 25 near-identical configs + scripts to maintain; cross-package
    resolution still needs upstream `dist`.
  - **Why not:** churn without benefit at this stage; revisit if the root pass
    becomes a bottleneck.

- **Suppress with `@ts-expect-error` / `as any` to reach zero fast.**
  - **Cons:** hides genuinely-broken fixtures (the exact failure mode ADR-0243
    was created to fix); a stale fixture would pass `@ts-expect-error` forever.
  - **Why not:** defeats the purpose.

- **Chain the test-typecheck into the default `pnpm typecheck`.**
  - **Cons:** forces a full `pnpm build` on every local `typecheck`; turbo's
    per-package `typecheck` is fast and parallel today.
  - **Why not:** keep the fast loop fast; CI runs the heavier `typecheck:tests`.

## Consequences

- **Positive:** test fixtures can no longer drift from production types unnoticed;
  the recurrence risk ADR-0243 named is closed; `pnpm typecheck:tests` is a
  one-command CI gate.
- **Negative:** the guard needs a full `pnpm build` first (cross-package `dist`
  resolution); CI pays a build it usually pays anyway.
- **Neutral:** test files now bound by the same strict flags as src
  (`noUnusedLocals`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, etc.).
- **Reversibility:** trivial — delete the script + config. No production code
  depends on it.

## Implementation notes

134 errors fixed; representative fix families:

- **Stale/incomplete fixtures (missing required fields).** Fields added with a
  schema-valid value: `evaluations.test.ts` result `costUsd`; `backfill.test.ts`
  job `durationSeconds`; `ediscovery.test.ts` `producedSizeBytes` +
  `productionSha256` + `productionStorageUri`; `split-brain.test.ts`
  `permanentPartitionAt`; `tombstone-proof.test.ts` `FIXTURE_BASE`
  `invalidationOfPriorTombstoneId` (the `.nullable().default(null)` field is
  required in the inferred *output* type even though optional in input — this
  fixes all 5 `populateTombstoneHashes` call sites at once).
- **`vision` capability completeness (ADR-0078).** `vision: false` added to
  capability fixtures in `chat.test.ts`, `commands.test.ts`,
  `ai-router/resolve.test.ts` (router StubProvider was handled in the committed
  ai-router batch).
- **`readonly[]` `.sort()` mutation.** `[...arr].sort()` in active-active/crdts,
  dr/replication, i18n/messageformat (`[...(phs[0].cases ?? [])]`), i18n/plurals,
  observability/redaction, search/manifest, search/permissions, views/views.
- **Unused imports / params** (`noUnusedLocals`/`noUnusedParameters`): deleted
  unused import members (access-reviews/exceptions, forensics/sealing,
  pack-erp-healthcare/entities, workflow-engine/instances, api-gateway/negotiation);
  `_`-prefixed surgically-unused mock params (ai-router-pg/latency-tracker,
  kernel-pg/trace-retention).
- **`Record` vs array fixture.** `manifest-io.test.ts` `workflows` is a
  `Record<string, …>` (keyed map), not an array — `{ wfd_x: {…} }` not `[{…}]`.
- **Implicit-any binding.** `sessions.test.ts` `getBySessionId` destructured param
  annotated `{ tenantId: string; sessionId: string }`.
- **Wrong fixture field name.** `stores.test.ts` idempotency record override
  `key` → `idempotencyKey` (the record field; `key` is only on the get/update
  input). The test now genuinely exercises tenant scoping rather than passing for
  the wrong reason.
- **Optional-chain depth (`noUncheckedIndexedAccess`/optional members).**
  `pack-erp-healthcare/jobs.test.ts` `retry?.backoff?.kind`;
  `workflows.test.ts` `t.trigger?.kind`.
- **Undeclared cross-package dependency.** `workflow-signal-bridge`'s
  `gateway-handler.test.ts` imported `IncomingRequest` / `ResolvedPrincipal` /
  `RouteDefinition` from `@crossengin/api-gateway`, which is not a dependency
  (only `@crossengin/api-gateway-runtime` is). Rerouted via indexed access on the
  already-imported `HandlerInput` (`HandlerInput["request"]`,
  `NonNullable<HandlerInput["principal"]>`, `HandlerInput["route"]`) —
  install-free, structurally identical types.
- **Closure-assignment narrowing to `never`.** `let captured: T | null = null`
  assigned only inside a `vi.fn` closure narrows to `null` at the read site, so
  `captured?.x` accesses a property on `never`. Fixed with a definite-assignment
  assertion (`let captured!: T`, no `| null`) in bridge/gateway-handler tests —
  the closure always runs before the assertion.
- **Mutable mock-state fields.** `applier.test.ts` `transactionsCommitted` /
  `transactionsRolledBack` and `replayer.test.ts` `recentIds` un-`readonly`'d
  (the mock mutates them).

Mechanism file `tsconfig.typecheck-tests.json` was committed earlier with the
ai-router + retention batch; this milestone adds the root `typecheck:tests`
script and the remaining fixes. Test count is **9,381** — no tests were added or
removed (every fix is type-only or fixture-completion); the `9,383` figure
carried in prior docs was itself an instance of the claimed-vs-actual drift this
work closes, now corrected to the measured value.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Wire `pnpm typecheck:tests` into the CI workflow as a required gate (config lives outside this repo today) | platform | 2026-06-30 |
| Lint rule forbidding `@ts-expect-error`/`as any` in `*.test.ts` so suppression can't reopen the gap | platform | 2026-07-31 |
| Pre-push hook running `typecheck:tests` (build cost vs. catch-early trade-off) | platform | _deferred_ |
| Migrate to per-package `tsconfig.test.json` if the single root pass becomes slow at >100 packages | platform | _deferred_ |

## References

- ADR-0243 — Type-check + test-suite debt paydown (this milestone closes its future Q1).
- `tsconfig.typecheck-tests.json`, root `package.json` `typecheck:tests` script.
