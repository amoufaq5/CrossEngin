# ADR-0270: Gateway housekeeping `--tenant <uuid>` drill-down filter

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0263 Q1 (closes), ADR-0269 (retention companion), ADR-0266 (composes with threshold-alert), ADR-0265 (composes with --watch), ADR-0267 (composes with --watch-keep-going), ADR-0268 (composes with SIGINT bridge) |

## Context

ADR-0263 shipped `crossengin gateway housekeeping` as the
operator-domain dashboard across the three gateway
housekeeping tables (`gateway_pipeline_executions`,
`gateway_idempotency_records`, `rate_limit_decisions`).
ADR-0269 then shipped the retention-companion `--tenant
<uuid>` drill-down on the substrate-centric retention
dashboard, surfacing per-tenant overrides per table.

The operator-domain gateway dashboard was the symmetric
gap. Compliance audits investigating "is this tenant
configured the way I expect across gateway tables?" had
to either (a) chain `gateway housekeeping --format json
| jq` then `retention effective <tenant>
gateway_pipeline_executions` + `retention effective
<tenant> rate_limit_decisions` (two extra commands per
audit, fragile spreadsheet stitching) or (b) drop into
the substrate-centric `retention housekeeping --tenant`
view and mentally filter out the 4 non-gateway tables.
Both paths exist but neither answers the natural
question "show me the gateway housekeeping state from
THIS tenant's perspective" in a single command.

ADR-0263 future Q1 explicitly carved this out: "--tenant
flag for per-tenant drill-down on gateway housekeeping —
mirror ADR-0269's pattern on the gateway dashboard."
This milestone closes that gap.

The structural twist vs ADR-0269 is the third table.
ADR-0269 covered 6 PRUNABLE_TABLES uniformly — every
retention-substrate table supports per-tenant override
via `meta.tenant_retention_policies`, so the drill-down
applies symmetrically. Gateway housekeeping covers TWO
retention-substrate tables (`gateway_pipeline_executions`,
`rate_limit_decisions`) PLUS one expires_at-managed table
(`gateway_idempotency_records`) where per-tenant override
is structurally impossible — the TTL is per-row not
per-policy. The dashboard needs to surface this asymmetry
to operators rather than hide it.

## Decision

Add `--tenant <uuid>` filter to `crossengin gateway
housekeeping`. Under the flag, each table report gains a
`tenantPolicy?: TenantRetentionPolicyRow | null` field
exposing the tenant's override OR a sentinel `null`:

- **Retention-substrate tables** (`gateway_pipeline_executions`
  + `rate_limit_decisions`): `tenantPolicy` is the
  matched `TenantRetentionPolicyRow` when one exists,
  else `null` — the tenant inherits the platform
  default for this table. Human renderer prints
  `(no override — inherits platform default)`.
- **Expires_at-managed table** (`gateway_idempotency_records`):
  `tenantPolicy` is always `null`. Human renderer prints
  `(not applicable — expires_at-managed)`. Operators
  reading this immediately understand that per-tenant
  overrides don't exist on the TTL surface, vs the
  retention surfaces where `null` means "no override".

The aggregates (`totalRowCount`, `oldestAt`,
`wouldPruneCount`, `retentionDays`, `lastPrunedAt`) stay
**cross-tenant** — this is the Option B drill-down vs
Option A full-scoping choice ADR-0269 made, applied
verbatim to the gateway surface. Three reasons:

1. **Mental-model continuity**: operators running
   `gateway housekeeping` already see the cross-tenant
   aggregates; the new flag adds context without
   changing what existing fields mean.
2. **Zero new substrate queries**: the existing
   `listTenantPolicies()` call already returns all
   per-tenant rows; the CLI filters by `tenantId`
   in-process. Option A would have required tenant-
   scoped `COUNT(*)` and `MIN(time_col)` queries per
   table doubling the round-trip count.
3. **Dual-axis context**: the question "what's this
   tenant's override + how big is the platform-wide
   table?" is the common compliance and tenant-
   offboarding workflow. The single-axis "how big is
   this tenant's slice?" is rarer and is already
   answered by per-row `COUNT` joins in operator SQL.

Option A is documented as a future Q if operator demand
emerges, exactly as ADR-0269 deferred it.

CLI surface:

```
crossengin gateway housekeeping [--tenant <uuid>] \
  [--watch [--watch-interval N] [--watch-keep-going]] \
  [--threshold-alert <field>:<op><value> ...]
```

Validation: `UUID_REGEX` at the CLI boundary — invalid
syntax exits 2 with a clear `must be a UUID` error
before any PG resolution. Same fail-fast discipline as
ADR-0265 (`--watch`), ADR-0266 (`--threshold-alert`),
ADR-0267 (`--watch-keep-going`), ADR-0268 (SIGINT
bridge).

JSON envelope under `--tenant`:

```json
{
  "action": "gateway.housekeeping",
  "asOf": "<ISO>",
  "tenantId": "<uuid>",
  "tables": [
    {
      "tableName": "gateway_pipeline_executions",
      "pruneSemantic": "retention_days",
      "totalRowCount": 50000,
      "oldestAt": "<ISO>|null",
      "wouldPruneCount": 1042,
      "retentionDays": 30,
      "lastPrunedAt": "<ISO>|null",
      "tenantPolicy": { "retentionDays": 365, ... } | null
    },
    {
      "tableName": "gateway_idempotency_records",
      "pruneSemantic": "expires_at",
      ...,
      "tenantPolicy": null
    },
    { ..., "tenantPolicy": ... }
  ]
}
```

Human format gains a `filtered to tenant <uuid>` suffix
on the dashboard header and a per-table `tenant policy:`
block after the existing `would prune` / `retention` /
`last pruned` lines. The `(no override — inherits
platform default)` vs `(not applicable — expires_at-
managed)` placeholders surface the structural asymmetry
between the three tables without operators having to
remember which table is which semantic.

Composition with all four watch + alert features is
transparent — the gather closure threads `tenantId`
through, and all four cross-cutting features dispatch
through the same `renderTick` closure + shared watch
loop. No per-feature wiring needed.

Backward compat verbatim: omitting `--tenant` preserves
existing behavior with no envelope-shape change
(`tenantId` absent at the top level, `tenantPolicy`
absent from each table report).

## Rejected alternatives

1. **Option A full per-tenant scoping** — scope
   `totalRowCount`, `oldestAt`, `wouldPruneCount` to
   "rows for THIS tenant only" via `WHERE tenant_id = $1`
   clauses on the table-stats `SELECT`s. Doubles
   round-trips, requires 6 new tenant-scoped queries (3
   `COUNT` + 3 `MIN`), and operators lose the cross-
   tenant aggregate context that's already useful.
   Documented as future Q (`--scope-rows-to-tenant`),
   not the default. Same rationale as ADR-0269.

2. **Surface `tenantPolicy` only on the 2 retention-
   substrate tables, omit it entirely from
   `gateway_idempotency_records`** — operators reading
   JSON have to discriminate the table type before
   checking for the field; absent vs `null` ambiguity.
   Always-emitting `null` + the explicit "(not
   applicable — expires_at-managed)" placeholder is
   honest about the semantic asymmetry.

3. **Validate tenant exists via `meta.tenants` SELECT
   before the gather** — adds a round-trip + couples
   the housekeeping dashboard to the tenant substrate;
   an unknown UUID surfaces as `null tenantPolicy` on
   every table which is already self-documenting.

4. **Discoverable `--tenant` list helper** — operators
   wanting to enumerate eligible tenants use `crossengin
   retention list-policies --table gateway_pipeline_executions`
   or `--table rate_limit_decisions` directly. The
   housekeeping dashboard doesn't need to duplicate
   discovery surface.

5. **Different sentinel text** ("(no override —
   inherits platform default)" vs "(no policy)") — the
   ADR-0269 wording carries forward to maintain
   semantic continuity for operators reading both
   dashboards.

6. **Embed `tenant_display_name` from `meta.users` /
   `meta.tenants`** — adds a JOIN cost on every render
   and couples the dashboard to two substrates. Future
   Q if operator demand emerges.

7. **Render `tenantPolicy` inline in the per-table
   title** ("`gateway_pipeline_executions (tenant
   override: 365d)`") — visual noise + truncation
   concerns at narrow widths; explicit per-field block
   reads clearer.

8. **Separate `gateway housekeeping-tenant` action** —
   would diverge two near-identical command shapes;
   flag-on-existing matches ADR-0269's choice + the
   broader pattern (M4.14.x's `crossengin retention
   housekeeping` stays a single action even though it
   nominally covers 6 tables).

9. **`--all-tenants` matrix mode in this milestone** —
   the matrix output format (wide vs long table)
   deserves its own design + spec. Deferred as future Q
   pairing with ADR-0269 Q2 (both surfaces would adopt
   the same shape).

10. **Render `tenantPolicy` JSON inline in human output
    instead of a structured block** — operators reading
    human format want narrative, not JSON. The
    structured `tenant policy:` block with `retention:`,
    `opt-out:`, `last pruned:` indented lines reads
    naturally.

## Implementation notes

`gather` in `gathering` already had a `tenantPolicyByTable`
shape on the retention side from ADR-0269 — same pattern
applied here, with the special-case for the
expires_at table forcing `tenantPolicy: null` regardless
of what `listTenantPolicies` returns. The
`renderTenantPolicyHuman` helper takes a third
parameter (`semantic: PruneSemantic`) so it can choose
between the two `null` placeholders, vs ADR-0269's
binary (override vs no-override) helper.

CLI parsing of `--tenant` uses the same `getStringFlag`
+ `UUID_REGEX` validation as ADR-0269.

Composition with `--threshold-alert`: the alert grammar
is unchanged. Alerts fire against the cross-tenant
aggregates (`totalRowCount`, etc.) — which is the
right semantic since aggregates stay cross-tenant under
the Option B drill-down design. Alerts against
`tenantPolicy.retentionDays` are NOT in the field
registry (the registry exposes report-level scalars,
not nested objects); future Q if operator demand
emerges.

## Tests

6 new tests in `apps/architect-cli/src/gateway.test.ts`
under a new `runGateway housekeeping --tenant (M4.14.v)`
describe block:

1. invalid `--tenant` value exits 2 BEFORE PG
   resolution (no adapter calls observed)
2. valid `--tenant` surfaces per-table `tenantPolicy`
   in human output covering all three placeholders
   (matched override, no-override on retention table,
   not-applicable on expires_at table)
3. filter discriminates between tenants — TENANT_A
   sees their 365d override on
   `gateway_pipeline_executions` and `null` on
   `rate_limit_decisions`; TENANT_B sees `null` on
   `gateway_pipeline_executions` and their opt-out on
   `rate_limit_decisions`
4. JSON envelope includes `tenantFilter` + every table
   has `tenantPolicy` field (with `null` for the
   expires_at table verified)
5. omitting `--tenant` preserves backward-compat
   envelope shape verbatim (no `tenantId`, no
   `tenantPolicy` on any table)
6. composes with `--threshold-alert` — drill-down
   preserves CI-gate semantic (`totalRowCount:>500000`
   trips on `rate_limit_decisions`'s 987,654 row
   count, exits 3, and the human output includes both
   the threshold-alerts section AND the
   `filtered to tenant` header)

Workspace test count goes 9,617 → 9,623.

## Consequences

- Operators running compliance audits on a specific
  tenant see the gateway housekeeping state from that
  tenant's perspective in one command.
- The 3-table-2-semantic asymmetry (`retention_days` on
  2, `expires_at` on 1) surfaces visually in the
  per-table `tenantPolicy` block via distinct
  placeholders, teaching operators the structural
  difference without requiring substrate docs.
- The two operator-facing dashboards (gateway from
  ADR-0263 + retention from ADR-0264) now both support
  the drill-down filter — a tenant under audit can be
  inspected through both lenses with the same flag
  semantic.
- Pure additive — pre-existing behavior preserved
  verbatim; the only schema-shape change to the JSON
  envelope is conditional fields under the flag.
- Zero new substrate queries — `listTenantPolicies`
  was already called once per render.
- Composes transparently with `--watch`,
  `--watch-keep-going`, `--threshold-alert`, and the
  SIGINT bridge via the shared watch loop.

## Future Qs

1. **Option A full per-tenant scoping via
   `--scope-rows-to-tenant`** — scope aggregates to
   the tenant's rows. Pair with ADR-0269 Q1 — both
   surfaces would adopt the same shape.
2. **`--all-tenants` matrix output** — emit N tenants
   × 3 tables matrix of override states. Pairs with
   ADR-0269 Q2.
3. **`--tenant <slug>` via `meta.tenants` lookup** —
   accept human-readable slug, resolve to UUID. Pairs
   with ADR-0269 Q3.
4. **Surface `tenantPolicy.retentionDays` as an
   alertable field** — operators wanting "alert if
   tenant X's override goes below 30 days" need
   nested-field support in the threshold-alert grammar.
5. **`--tenant-set <file.csv>` cohort drill-down** —
   bulk per-tenant audit. Pairs with ADR-0269 Q7.
6. **Tenant display name in human output** — JOIN
   `meta.tenants` / `meta.users` for human-readable
   identity, accept the JOIN cost. Pairs with ADR-0269
   Q4.
7. **Cross-dashboard tenant view** — single command
   `crossengin tenant housekeeping <uuid>` that runs
   both gateway + retention housekeeping under the
   tenant filter and concatenates the output.
8. **SIGTERM bridge** under `--watch` to compose with
   ADR-0268 Q1 — Kubernetes / systemd graceful
   shutdown.
