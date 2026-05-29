# ADR-0276: Cross-dashboard `crossengin tenant housekeeping` combined view

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0270 Q7 (closes), ADR-0273 Q3 + ADR-0275 future Q6 (related tenants standalone), ADR-0263 / 0264 (host housekeeping dashboards), ADR-0269 / 0270 / 0271 (tenant filter pattern), ADR-0274 (composes with threshold-alert) |

## Context

ADR-0263 (M4.14) shipped `crossengin gateway
housekeeping` as the operator-domain dashboard;
ADR-0264 (M4.14.x) shipped `crossengin retention
housekeeping` as the substrate-centric companion.
The two dashboards cover different but overlapping
operator workflows:

- **Gateway housekeeping** = "operator-domain" view
  scoped to 3 tables (gateway_pipeline_executions,
  gateway_idempotency_records, rate_limit_decisions).
  The natural surface for SRE/gateway-ops audits.
- **Retention housekeeping** = "substrate-centric"
  view scoped to all 6 PRUNABLE_TABLES (the 3 gateway
  tables PLUS workflow_traces, llm_call_traces,
  llm_latency_samples, tenant_retention_opt_out_history).
  The natural surface for compliance/retention audits.

Operators running per-tenant compliance audits today
chain two commands:

```
crossengin gateway housekeeping --tenant acme-prod
crossengin retention housekeeping --tenant acme-prod
```

…and mentally stitch the outputs. The drill-down
filter pattern from M4.14.u/v + slug resolution from
M4.14.o/m makes this less painful (one slug per
command instead of one UUID per command), but the
operator still runs two commands.

ADR-0270 Q7 carved out the combined view explicitly:

> "Cross-dashboard tenant view — single command
> `crossengin tenant housekeeping <uuid>` that runs
> both gateway + retention housekeeping under the
> tenant filter and concatenates the output."

The natural place for this is a new top-level
`crossengin tenant` subcommand reserved for cross-
dashboard tenant-scoped operations.

## Decision

Add a new top-level `crossengin tenant` subcommand
with the first action `housekeeping`. The combined
view:

1. **Single PG conn** — both dashboards share one
   connection; no double-resolution.
2. **Single `--tenant` resolution** — slug→UUID
   happens once via `resolveTenantIdentifier`, then
   the resolved UUID flows to both dashboards.
3. **Mutual exclusivity** with `--all-tenants`
   preserved verbatim from M4.14.q (the two flags
   answer different operator questions).
4. **`--threshold-alert` evaluates across the UNION
   of all tables** from both dashboards — an alert
   tripping on EITHER side trips exit 3. The
   combined alertable-field registry includes every
   field both dashboards expose
   (perTenantPolicyCount is retention-only;
   pruneSemantic is gateway-only and not alertable;
   others are shared).
5. **Output**: human format prints two clearly-
   separated sections with `=== Gateway housekeeping
   ===` / `=== Retention housekeeping ===`
   delimiters; JSON envelope merges both dashboards
   under one shape `{action: "tenant.housekeeping",
   asOf, tenantId?, allTenants?, gateway:
   <HousekeepingReport>, retention:
   <RetentionHousekeepingReport>, alerts:
   TrippedAlert[]}`.
6. **`--watch` / `--watch-keep-going` deferred** —
   combining two watch loops has subtle ordering
   concerns (interleaving renders from two
   independent loops would garble the per-section
   layout). Compliance audits typically run as one-
   shot commands so the v1 scope is one-shot only.
   Documented as future Q.

Implementation reuses the pure `gather*Report` exports
from `gateway-housekeeping.ts` +
`retention-housekeeping.ts` directly — no
re-implementation of the per-dashboard logic.
Threshold-alert evaluation has its own combined
helper (`evaluateAlertsAcrossDashboards`) that
iterates the union of tables; the per-clause
evaluator from M4.14.n is reused.

`tenant` becomes the 11th top-level subcommand
(SUBCOMMANDS grows from 13 → 14 with help/version
included). The action surface inside `tenant` starts
with just `housekeeping`; reserving the namespace
for future operator actions (`tenant lifecycle
<uuid>` for cohort lifecycle management,
`tenant policies <uuid>` for full per-tenant policy
summary, etc.).

CLI surface:

```
crossengin tenant housekeeping [--tenant <uuid|slug> | --all-tenants]
                               [--threshold-alert '<clause>[ AND <clause>...]' ...]
                               [--format human|json]
```

Help text describes the combined-view purpose +
points at the individual dashboards for `--watch`
support.

## Rejected alternatives

1. **Inline the combined view into one of the
   existing dashboards** — would force operators to
   discover the cross-dashboard mode by reading
   help text on a dashboard they may not be using.
   Top-level `tenant` subcommand is discoverable
   via `crossengin help` directly.

2. **Make it `crossengin housekeeping
   --combine-tenant-dashboards`** — verbose flag,
   buries the discoverability behind a flag on a
   non-existent top-level `housekeeping` command.

3. **Support `--watch` in v1** — combining two
   independent watch loops requires either (a)
   interleaving renders which garbles the per-
   section layout, (b) running them sequentially
   per tick which doubles tick latency, or (c)
   adopting a unified async stream which requires
   refactoring both dashboards. Deferred to future
   Q until measured operator demand justifies the
   complexity.

4. **Per-dashboard threshold-alert flags
   (`--gateway-threshold-alert` /
   `--retention-threshold-alert`)** — multiplies
   flag count. The shared alertable field registry
   covers all numeric + timestamp fields from both
   dashboards; alerts that target a retention-only
   field (perTenantPolicyCount) naturally evaluate
   against retention rows only.

5. **Run the two dashboards in parallel
   subprocesses and concatenate stdout** —
   complicates error handling + loses the unified
   alert evaluation + would duplicate the PG conn
   setup. Single in-process call is cleaner.

6. **Output as a single flat table merging both
   dashboards' rows** — would require adding a
   "dashboard source" column to every row.
   Operators reading per-section blocks already
   know which dashboard they're looking at; the
   section delimiters do the disambiguation.

7. **Skip the new top-level subcommand and add the
   combined view as `crossengin gateway
   housekeeping --include-retention`** — same
   discoverability problem as alternative 2.

8. **Use a sibling dispatch (sub-action inside
   gateway OR retention)** — would commit to one
   dashboard "owning" the combined view. Top-level
   tenant subcommand is owner-neutral.

## Implementation notes

The new `tenant.ts` file imports the pure
`gather*Report` exports from both housekeeping
files; the per-dashboard renderers were duplicated
(in slightly simplified form — no tenantPolicy /
tenantOverrides matrix detail since the combined
view is one-shot and operators wanting that depth
use the individual dashboards). This is a
deliberate scoping decision for v1.

`TenantContext` extends `RunContext` with the four
override fields tests need
(`pgConnectionOverride`, `retentionOverride`,
`idempotencyStoreOverride`, `clockOverride`).
Production callers populate none of these; tests
populate all four.

The `COMBINED_ALERTABLE_FIELDS` registry combines
both dashboards' fields. Fields that appear on
only one dashboard (`perTenantPolicyCount`) are
still alertable globally — alerts targeting them
just evaluate against retention rows. The dispatcher
doesn't need to know which dashboard owns which
field.

`evaluateAlertsAcrossDashboards` iterates gateway
tables first, then retention tables. Each (table,
alert) pair is evaluated independently; the
combined result is a flat `TrippedAlert[]` that
the renderer/JSON serializer handles uniformly.

The UUID regex is duplicated (also lives in
tenant-resolver.ts + housekeeping files); future
consolidation could lift it to a shared constants
module. Defer until the duplication count justifies
the module split.

## Tests

10 new tests in
`apps/architect-cli/src/tenant.test.ts`:

- 2 `runTenant` dispatcher tests:
  - missing action exits 2 with usage error
  - unknown action exits 2 with usage error
- 8 `runTenant housekeeping` tests:
  - renders both dashboard sections in human format
    under --tenant <uuid> (verifies section
    delimiters + table names from both dashboards)
  - JSON envelope merges both dashboards under one
    shape (verifies action discriminator + 3-table
    gateway + 6-table retention shapes + empty
    alerts)
  - --tenant <slug> resolves via meta.tenants once
    and applies to BOTH dashboards (verifies
    tenantId echoed at top level AND inside each
    dashboard's report)
  - unknown slug exits 2 BEFORE either dashboard
    gather runs
  - --tenant + --all-tenants mutual exclusivity
    exits 2 BEFORE PG
  - --all-tenants matrix mode applies to BOTH
    dashboards (verifies allTenants:true at all
    three levels + tenantOverrides[] arrays on
    every table)
  - --threshold-alert evaluates across the union of
    tables from both dashboards (alert on
    workflow_traces — retention-only table — trips
    exit 3)
  - backward-compat envelope shape preserved when
    no --tenant / --all-tenants set (no tenantId
    fields anywhere)

Plus 1 modified test in `cli.test.ts` (SUBCOMMANDS
expected-list extended with "tenant").

Workspace test count goes 9,675 → 9,685.

## Consequences

- Compliance audits spanning both operator-domain
  and substrate-centric views now run as one
  command.
- The combined-alert evaluation across both
  dashboards' tables means operators can write a
  single `--threshold-alert` flag and have it
  catch issues from either side.
- The `tenant` top-level subcommand namespace is
  reserved for future cross-dashboard
  tenant-scoped operations (lifecycle, policies,
  etc.).
- v1 doesn't support `--watch` — operators wanting
  live monitoring use the individual dashboards.
  Documented in the help text + ADR future Q.
- The shared alertable field registry across both
  dashboards is a foundation for future
  cross-dashboard query surfaces.
- The duplicated UUID regex + per-dashboard
  renderers (in simplified form) are documented
  scope tradeoffs; consolidation deferred until
  duplication count grows.

## Future Qs

1. **`--watch` / `--watch-keep-going` support** —
   combining two watch loops requires a unified
   render approach. Defer until measured operator
   demand.
2. **`crossengin tenant lifecycle <uuid|slug>`** —
   cohort lifecycle management (suspend / activate
   / archive / delete) as a sibling action under
   the same `tenant` subcommand. Future milestone.
3. **`crossengin tenant policies <uuid|slug>`** —
   full per-tenant policy summary (retention +
   opt-outs + cost ceilings + rate-limit overrides
   + ...) under one command. Future milestone.
4. **Per-dashboard threshold-alert flags** if
   operator demand emerges for "alert only when
   gateway side trips" (`--gateway-threshold-alert`
   etc.).
5. **Cross-dashboard JSON unified schema** —
   merge gateway + retention reports into a single
   flat tables[] array with a "dashboard" field
   on each row. Defer — operators reading sections
   prefer the grouped shape.
6. **Pretty-printed JSON output by default** for
   combined view since it's longer than individual
   dashboards. Operators pipe through `jq -C` for
   coloring today.
7. **HTML / Markdown output** for combined view
   targeting compliance report exports. Defer until
   demand.
8. **Auto-suggest similar slugs on "no tenant with
   slug" error** — pairs with ADR-0273 Q6 +
   ADR-0275 Q3.
