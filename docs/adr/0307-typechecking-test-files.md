# ADR-0307: Typechecking the test files (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0294 (open-episode hydration), ADR-0302 (bounces feed suppressions), ADR-0289 (re-parse on read) |

## Context

No test file in this repository had ever been typechecked. Every package's `tsconfig.json` excludes
`**/*.test.ts` — correctly, because tests must not land in `dist` — and vitest transpiles without
checking. So the exclusion that kept tests out of the build also kept them out of `tsc` entirely.

The cost was not theoretical. ADR-0294 recorded the first instance: a test double missing a newly added
interface method threw a `TypeError` that a deliberate catch swallowed, so the suite stayed green while
the new path went unexercised. The same shape recurred twice more in the session that produced
ADR-0302, each time costing a round of debugging that a compiler would have answered instantly.

Measured across the workspace, enabling it produced **230 errors in 38 of 87 packages**. The
distribution is the argument: 50 were TS2741/TS2739 — "property missing in type" — which is precisely
*a test double that no longer satisfies the interface it claims*, and 41 were TS2339, reading a property
that does not exist. Those 91 are not ceremony; each one is a test asserting against a shape the
production code never produces.

## Decision

`typecheck` runs a config that includes the tests; `build` keeps the one that excludes them.

Each package gains a `tsconfig.typecheck.json` of two lines — `extends: ["./tsconfig.json",
"@crossengin/config/typescript/typecheck.json"]` — and its `typecheck` script becomes
`tsc -p tsconfig.typecheck.json`. The shared base sets `noEmit` and replaces the `exclude` array, which
drops both `**/*.test.ts` and the `src/test-fakes.ts` exclusions eight packages carried. One invocation
covers everything the build config covered plus the tests, so `typecheck` is not run twice.

`apps/operate-web` keeps its own `npx tsc --noEmit`, since it is a Next app outside this layout.

**Policy for the fixes**, because "make it compile" and "keep the test honest" are not the same thing:

- **A test double that does not satisfy its interface gets fixed, not cast.** `FakeStore` in
  `operate-runtime` was missing `list` entirely and its `listPage` returned `{data, page}` where
  `ListPage` is `{records, nextCursor}` — a shape no handler could read. The fake now implements the
  interface.
- **A fixture typed as the parsed record spells its `.default(...)` fields.** `z.infer` output requires
  a field the input may omit, so `autoDeclaredFor: null` and friends are what a parsed record actually
  looks like. Where a fixture had drifted far from its schema, it is now built by *parsing* it —
  eighteen manifest fixtures in `kernel` were `as Manifest` casts, meaning they were never checked
  against the schema at all.
- **Optional chaining only where absence still fails the assertion.** `expect(captured[0]?.url).toBe(x)`
  is fine: an empty array yields undefined and the test fails. `expect(captured[0]?.headers.auth)
  .toBeUndefined()` is **not** fine — it would pass on an empty array, reporting "no auth header" when
  in truth no request was made. Those sites assert the length first.
- **An unused import is a question, not lint.** Two packages imported a `*_TRANSITIONS` map and never
  used it, while testing three hardcoded transitions — against this repo's own "walk the map" rule. They
  now walk it. `api-gateway` had two `describe` blocks named after parser functions that never called
  them; they now do.
- **Where a test encoded an assumption the domain does not share, the test is pinned and the question
  is left open.** `failed` is in `TERMINAL_INSTANCE_STATUSES` *and* has `failed → compensating`, so
  `isInstanceTerminal` answers "done" for a status the map says you may still move. The test records
  that exception rather than resolving it: which side should change is a lifecycle decision.

## Alternatives considered

- **Option A: leave tests unchecked.**
  - **Pros:** no diff; 230 errors stay someone else's problem.
  - **Cons:** the defect class is proven and recurring, and it costs debugging time every time, in the
    worst way — a green suite over an unexercised path.
  - **Why not:** three occurrences in two sessions is a pattern, not luck.

- **Option B: include tests in `tsconfig.json` and exclude them at build time another way.**
  - **Pros:** one config per package.
  - **Cons:** `tsc` *is* the build, so the exclusion has to live where the build reads it. Any other
    arrangement risks emitting tests into `dist`.
  - **Why not:** the split is the point. A regression here ships test files to consumers.

- **Option C: relax `noUncheckedIndexedAccess` or `noUnusedLocals` for tests.**
  - **Pros:** roughly 46 of the 230 would vanish.
  - **Cons:** those two flags found the vacuous-assertion sites and the untested-parser blocks. A test
    that indexes an empty array and asserts `toBeUndefined()` passes for the wrong reason, which is the
    exact failure mode this ADR exists to remove.
  - **Why not:** the noisy flags were the informative ones.

- **Option D: `// @ts-expect-error` at the failing sites.**
  - **Pros:** fastest path to zero.
  - **Cons:** records that a test is wrong without fixing it, and silently absorbs the *next* breakage
    at the same site.
  - **Why not:** not used anywhere in this change.

## Consequences

- **Positive:** a double that stops satisfying its interface now fails at `typecheck`. Demonstrated by
  deleting one required field from a stub's return: `tsc` reports it and all 54 tests in that package
  still pass.
- **Positive:** two genuinely missing dependencies surfaced — `workflow-signal-bridge` imported types
  from `@crossengin/api-gateway` and `operate-server` from `@crossengin/types`, neither declared. Only
  the test files referenced them, so nothing had ever resolved them.
- **Positive:** several tests that passed for the wrong reason now assert what they claim. The
  idempotency-scoping test stored a record under one key and looked up another, so its null came from
  the key, not the tenant. `marketplace-runtime` set `contactEmail` on an author whose field is `email`,
  five times. Six fixtures gave `ChainSignatureVerdict` an `entries` array it does not have while
  omitting both fields it does.
- **Negative:** `typecheck` is slower, since it compiles roughly twice the files.
- **Negative:** 87 new two-line config files, and a new package must remember one. A missing
  `tsconfig.typecheck.json` makes that package's `typecheck` fail loudly rather than silently skip, so
  the failure mode is acceptable.
- **Neutral:** the fixes are concentrated where the layering is thickest — `operate-server`, `kernel`,
  `kernel-pg` and `operate-runtime` held 133 of the 230.
- **Reversibility:** pointing the scripts back at `tsc --noEmit` restores the old behaviour in one
  change. The fixed fixtures and doubles stay correct either way.

## Implementation notes

- `packages/config/typescript/typecheck.json`, exported from the config package.
- 29 of `kernel-pg`'s 35 errors were `constraintBacked` missing from `LiveIndex` fixtures — a field
  added days earlier by ADR-0302. Every one of those suites was green because the omission read as
  `false`, which happened to be the pre-ADR behaviour. That is this ADR's case in a single example.
- `CountingIncidentDeclarer.findOpen`/`closeOut` declared **no parameters** while implementing an
  interface that has them. A method with fewer parameters satisfies one with more, so it typechecked —
  and every argument a caller passed was unpassable, which a test had been doing. They now take the
  interface's parameters and ignore them explicitly.
- `let x = null` assigned only inside a callback is narrowed to `null`, so three tests were reading
  properties off `never`. Those collect into an array instead, which also lets them assert that exactly
  one call happened.
- `PageSink` returns `void | Promise<void>`, but `page: (p) => pages.push(p)` returns the array's new
  length. Block bodies, in four places.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `failed` is both terminal and compensatable (`workflow-engine`). Should `TERMINAL_INSTANCE_STATUSES` drop it, or should `isInstanceTerminal` answer differently? | amoufaq5 | _unscheduled_ |
| `apps/operate-web` is still checked separately and is not covered by `pnpm -r typecheck`. | amoufaq5 | _unscheduled_ |
| Nothing enforces that a new package has a `tsconfig.typecheck.json`; a lint or a test over the workspace could. | amoufaq5 | _unscheduled_ |

## References

- ADR-0289, ADR-0294, ADR-0302.
- TypeScript: method parameter bivariance; `noUncheckedIndexedAccess`; implicit index signatures on type aliases but not interfaces.
