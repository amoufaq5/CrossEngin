# ADR-0275: `--tenant <uuid|slug>` on retention list-policies / history / summary

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0273 (slug resolver — closes Q5), ADR-0269/0270/0271 (--tenant on housekeeping dashboards), ADR-0167 (host list-policies), ADR-0170 (host history), ADR-0232 (host summary) |

## Context

ADR-0273 (M4.14.o) shipped `--tenant <uuid|slug>` on
the two housekeeping dashboards via the new shared
`resolveTenantIdentifier(conn, value)` helper. Its Q5
explicitly carved out the natural extension:

> "Apply pattern to retention history /
> list-policies / summary"

These three retention actions had `--tenant <uuid>`
already (since their respective milestones — list-
policies M6.7.zz.tenant.opt-out.cli.list, history
M6.7.zz.tenant.opt-out.history, summary
M6.7.zz.tenant.opt-out.cli.summary), but they
passed the flag value through verbatim with no UUID
validation OR slug resolution. Operators typing
`--tenant acme-prod` instead of a UUID got opaque
PG errors (invalid UUID syntax) or silent empty
results.

After M4.14.o the operator-facing CLI surface was
inconsistent — `crossengin retention housekeeping
--tenant acme-prod` worked; `crossengin retention
list-policies --tenant acme-prod` returned an empty
result + no helpful error.

## Decision

Wire the M4.14.o `resolveTenantIdentifier` helper
into all three remaining retention actions that
accept `--tenant`. Behavior matches M4.14.o exactly:

- UUID-shaped values short-circuit (zero PG cost
  for scripted callers).
- Slug-shaped values resolve via one extra
  `SELECT id FROM meta.tenants WHERE slug = $1`
  BEFORE the action's gather queries run.
- Unknown slug exits 2 with explanatory error
  `no tenant with slug '<value>'`.

Implementation uses a shared private helper
`resolveTenantFlagFor(raw, conn, ctx, actionLabel)`
that wraps `resolveTenantIdentifier` with the
action-label prefix on the error message. The
ResolvedHandle from `resolveRetention` was extended
to expose the raw PG connection (`readonly conn:
PgConnection | undefined`) so the per-action
dispatchers can pass it through. Production callers
get the conn from `createNodePgConnection`; test
callers populate it via the existing
`ctx.pgConnectionOverride` field.

`--all-tenants` is **deliberately NOT added** to
these three surfaces because omitting `--tenant`
already produces "all tenants" behavior on each:

- **list-policies**: omitting `--tenant` already
  returns ALL per-tenant policies (filtering is
  inclusive — no filter means no narrowing).
- **history**: omitting `--tenant` already returns
  audit log entries across ALL tenants.
- **summary**: omitting `--tenant` aggregates
  across ALL tenants; `--group-by tenant` adds
  per-tenant grouping if operators want it. The
  combination covers the matrix-shape use case.

Adding `--all-tenants` as an alias for "no
`--tenant`" would be a no-op flag — confusing for
operators reading help text.

On the housekeeping side, `--all-tenants`
(M4.14.q) was meaningful because it changed the
DATA shape (per-table tenantOverrides array
appears under the flag). Here the data shape is
unchanged whether `--tenant` is set or not — only
the FILTER scope changes. Hence asymmetric design
across these two action families: housekeeping has
both flags, retention list/history/summary have
only `--tenant`.

Test path support — `ctx.pgConnectionOverride` is
optional on `RetentionContext`. When tests provide
`retentionOverride` WITHOUT `pgConnectionOverride`,
the slug resolver path falls back to "treat raw
value as already-resolved" so existing tests pass
UUIDs through verbatim. New M4.14.m tests provide
both overrides + exercise the slug path.

Help text on all three actions updated to mention
slug acceptance + the meta.tenants lookup +
unknown-slug exit-2 path.

## Rejected alternatives

1. **Add `--all-tenants` as a no-op alias for
   documentation symmetry** — no-op flags confuse
   operators reading help text. Documentation
   note in each action's --tenant description that
   "omit --tenant for all tenants" is clearer.

2. **Expose conn via a side-channel context field
   without changing ResolvedHandle** — would require
   the per-action dispatchers to reach into ctx for
   conn instead of receiving it via the handle.
   Threading via the existing handle pattern
   matches the dispatcher's resolveRetention
   contract.

3. **Substrate-side slug resolution (add a
   `resolveTenantBySlug` method on
   PostgresTraceRetention)** — substrate stays narrow.
   The slug resolver is operator-facing convenience
   that lives at the CLI layer; PostgresTraceRetention
   doesn't need to grow a tenant-discovery surface.

4. **Eager resolution at the dispatcher (before the
   action runs)** — would require the dispatcher to
   know which actions accept `--tenant`. Per-action
   resolution keeps the responsibility close to the
   action that needs it.

5. **Fail loudly when test path lacks
   pgConnectionOverride but supplies a slug** — the
   test path with retentionOverride is already a
   contained scope; operators in production always
   have conn. Falling back to "treat as UUID" is
   friendlier than a hard error for tests that
   happen to pass non-UUID strings.

6. **Drop the actionLabel parameter from
   resolveTenantFlagFor and use a generic
   "retention" prefix** — operators reading errors
   benefit from knowing which action surfaced the
   error. `retention list-policies: no tenant with
   slug 'X'` is more actionable than
   `retention: no tenant with slug 'X'`.

7. **Add a `--tenant-slug <slug>` separate flag**
   so operators don't have to remember the
   discriminator — duplicates the housekeeping
   surface unnecessarily. Single `--tenant <uuid
   |slug>` matches the M4.14.o pattern.

## Implementation notes

The shared `resolveTenantFlagFor` helper lives in
`retention.ts` (not in `tenant-resolver.ts` because
it depends on the action-specific error prefix +
ctx for io). The lower-level `resolveTenantIdentifier`
from `tenant-resolver.ts` remains UUID-discriminator-
+ slug-lookup-only.

Tests use the existing `parsed(...)` helper from
`retention.test.ts` (constructs ParsedCommand from
varargs by wrapping `parseArgs(["node",
"crossengin", ...args])`). Initial draft used
`parseArgs` directly with varargs, which failed
because `parseArgs` expects a Node argv array.

## Tests

7 new tests in
`apps/architect-cli/src/retention.test.ts` under a
new `--tenant <uuid|slug> slug resolution across
list-policies / history / summary (M4.14.m)`
describe block:

- 2 list-policies tests: slug resolves + filters
  by RESOLVED UUID; unknown slug exits 2
- 2 history tests: slug resolves + threads UUID
  to adapter; unknown slug exits 2 BEFORE
  listOptOutHistory call
- 2 summary tests: slug resolves + threads UUID
  to adapter; unknown slug exits 2 BEFORE
  summarizeOptOutHistory call
- 1 cross-action test: UUID-shaped `--tenant`
  bypasses slug lookup on ALL three surfaces
  (verified via captured queries — no SELECT
  meta.tenants issued)

Workspace test count goes 9,668 → 9,675.

## Consequences

- Operators get consistent `--tenant <uuid|slug>`
  semantics across both housekeeping dashboards
  AND the three retention query actions.
- The UUID-only path preserves scripted-caller
  performance (no PG round-trip).
- Unknown slug errors are loud + actionable on
  every retention action that takes `--tenant`.
- The shared `resolveTenantFlagFor` helper can be
  extended to future retention actions that accept
  `--tenant` (e.g., if `retention diff` ever takes
  a tenant filter).
- The asymmetry with housekeeping (`--all-tenants`
  flag) is documented + intentional: housekeeping
  needs the explicit flag because it changes data
  shape; retention list/history/summary use the
  "omit --tenant" convention because they're
  filter-only.

## Future Qs

1. **`--tenant` on `retention diff` family** — the
   diff actions (diff, diff-history, diff-timeline)
   currently take tenant IDs as positional args.
   Slug acceptance there would require positional-
   to-UUID resolution + would change the action's
   positional-args contract. Defer until measured
   demand.
2. **Slug acceptance on `retention opt-out /
   opt-in / set / delete` mutation actions** —
   these take tenant ID as positional too. Same
   pattern as diff family. Defer.
3. **Auto-suggest similar slugs** on "no tenant
   with slug" — pairs with ADR-0273 Q6.
4. **Surface the resolved UUID in JSON output**
   alongside the slug input — operators chaining
   commands already get the resolved UUID echoed
   in `tenantFilter`/`tenantId` fields.
5. **`--all-tenants` flag added later** if
   operator demand emerges for symmetry with
   housekeeping — currently no-op so deferred.
6. **`crossengin tenants list / resolve`
   standalone subcommand** — operators wanting to
   enumerate or pre-resolve slugs without invoking
   any dashboard. Pairs with ADR-0273 Q3.
