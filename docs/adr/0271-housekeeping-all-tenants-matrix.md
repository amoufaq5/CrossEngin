# ADR-0271: Housekeeping `--all-tenants` matrix mode

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0269 Q2 (closes), ADR-0270 Q2 (closes), ADR-0263 (gateway housekeeping host), ADR-0264 (retention housekeeping host), ADR-0265 / 0266 / 0267 / 0268 (composes with cross-cutting watch + alert features) |

## Context

ADR-0269 (M4.14.u) added `--tenant <uuid>` single-tenant
drill-down to `crossengin retention housekeeping`, and
ADR-0270 (M4.14.v) mirrored the same on `crossengin
gateway housekeeping`. Both ADRs explicitly carved out
Q2 as future work: `--all-tenants` matrix mode emitting
the per-tenant overrides for EVERY tenant on each table,
not just the one named in `--tenant`.

The single-tenant flag answers "what does THIS tenant
look like?" The matrix flag answers "across all my
tenants, who has overrides on what tables?" — the
canonical compliance audit workflow that previously
required:

1. `crossengin retention list-policies --format json | jq`
2. Manual grouping by tableName
3. Cross-referencing with `crossengin retention housekeeping`
   output for the aggregate context

Three commands + manual JSON stitching for what should be
a single command. ADR-0269 Q2 and ADR-0270 Q2 paired
these up as the natural follow-up to the single-tenant
drill-down once that pattern proved itself.

The shape decision (raised but deferred in both Q2 notes)
was the load-bearing choice — **wide-format** (rows =
tenants, columns = tables, one row per tenant) vs
**long-format** (rows = tenant×table cells, one row per
override). Wide-format is what spreadsheet users
intuitively picture; long-format matches the existing
per-table report structure where each table is its own
section.

## Decision

Add `--all-tenants` boolean flag to BOTH housekeeping
dashboards (`gateway housekeeping` + `retention
housekeeping`). Under the flag, each existing per-table
`TableReport` gains an optional `tenantOverrides:
ReadonlyArray<TenantRetentionPolicyRow>` field listing
every per-tenant override on that table, **sorted by
tenantId for stable output** (compliance audit JSON
exports need diff-able output across runs).

Mutually exclusive with `--tenant <uuid>` at the CLI
boundary — the two flags answer different operator
questions and combining is ambiguous (`exit 2` with
`mutually exclusive` error on both set).

Chose **long-format per-table grouping** over wide-format
matrix for three reasons:

1. **Existing structure additive**: each `TableReport`
   already had `tenantPolicy?: TenantRetentionPolicyRow
   | null` from ADR-0269/0270 under `--tenant`. Adding
   `tenantOverrides?: ReadonlyArray<...>` extends the
   same per-table shape. Wide-format would have added a
   top-level `tenantMatrix: Array<{tenantId, tables:
   Array<{tableName, override?}>}>` field structurally
   separate from `tables[]`, doubling the per-call shape
   variance.
2. **Sparse-by-default**: most tenants have overrides on
   ZERO tables (they inherit the platform default).
   Long-format only emits rows for actual overrides;
   wide-format would emit one row per tenant with mostly-
   null columns. At realistic 10K-tenant scale the
   sparse representation is 10–100× smaller.
3. **Operator workflow match**: "show me every tenant
   with overrides on `rate_limit_decisions`" is trivial
   under long-format (look up the table, iterate
   `tenantOverrides`). The wide-format equivalent
   requires iterating all tenants and filtering — same
   information, more code.

Aggregates (`totalRowCount`, `oldestAt`, `wouldPruneCount`,
`retentionDays`, `lastPrunedAt`, `perTenantPolicyCount`
on retention housekeeping) **stay cross-tenant**, same
Option B drill-down semantic as ADR-0269/0270.
`--all-tenants` is about surfacing overrides for the
matrix view, not scoping the dashboard's aggregate
metrics.

Mirroring on both dashboards is symmetric except for the
gateway dashboard's third table — `gateway_idempotency_records`
is expires_at-managed and per-tenant overrides are
structurally impossible (TTL is per-row not per-policy).
Under `--all-tenants`, that table's `tenantOverrides`
is always `[]` and the human renderer surfaces
`(not applicable — expires_at-managed)`, matching the
distinction ADR-0270 established under `--tenant`.

CLI surface (both dashboards):

```
crossengin gateway housekeeping  [--tenant <uuid> | --all-tenants] ...
crossengin retention housekeeping [--tenant <uuid> | --all-tenants] ...
```

JSON envelope under `--all-tenants`:

```json
{
  "action": "gateway.housekeeping" | "retention.housekeeping",
  "asOf": "<ISO>",
  "allTenants": true,
  "tables": [
    {
      "tableName": "workflow_traces",
      ...,
      "tenantOverrides": [
        { "tenantId": "<uuid>", "retentionDays": 365, ... },
        { "tenantId": "<uuid>", "retentionDays": 60, ... }
      ]
    },
    ...
  ]
}
```

The top-level `allTenants: true` discriminator lets JSON
consumers branch on shape without probing per-table
fields. Backward compat verbatim — omitting
`--all-tenants` preserves existing behavior (`allTenants`
absent at top level, `tenantOverrides` absent from each
table).

Human format gains a `matrix mode — all tenants` suffix
on the dashboard header and a per-table `matrix (N):`
block listing each tenant's override on a separate line:

```
  rate_limit_decisions
    total rows:     987,654
    ...
    matrix (3):
      00000000-...-000a  retention=7d (disabled) opt-out=yes (until 2099-..., reason: legal_hold:case#42)
      00000000-...-000b  retention=14d (enabled)
      00000000-...-000c  retention=30d (enabled)
```

Empty arrays render explicitly:
- Retention-substrate tables with no overrides:
  `matrix: (no per-tenant overrides on this table)`
- Gateway's expires_at-managed idempotency table (always
  empty under `--all-tenants`): `matrix: (not applicable
  — expires_at-managed)` — mirrors ADR-0270's
  single-tenant placeholder.

Composition with all four cross-cutting features
(`--threshold-alert`, `--watch`, `--watch-keep-going`,
SIGINT bridge) is transparent — the gather closure
threads `allTenants` through, the render closure handles
the new array, and all four features dispatch through
the same `renderTick` closure + shared watch loop.

## Rejected alternatives

1. **Wide-format matrix** (rows = tenants, columns =
   tables) — see context above. Sparse-by-default
   storage savings + existing structure additive
   choice swung the design.

2. **Top-level `tenantMatrix: Array<{tenantId,
   tables: ...}>`** — structurally separate from
   `tables[]`. Forces JSON consumers to discriminate
   shape twice and breaks the per-table report
   continuity ADR-0269/0270 established.

3. **Allow `--tenant` + `--all-tenants` to coexist with
   the single-tenant override highlighted in the
   matrix block** — semantically ambiguous (operator
   wanted ONE or ALL, not "all but draw attention to
   this one"). Mutual exclusion at the boundary is
   cleaner; operators chaining `crossengin retention
   list-policies --tenant $X` after the matrix view
   get the highlight for free.

4. **Omit `tenantOverrides` on the gateway expires_at
   table** vs always emitting `[]` — the always-emit
   path means JSON consumers can probe a single key
   uniformly across all tables under `--all-tenants`.
   Same rationale as ADR-0270's always-emit for
   `tenantPolicy: null`.

5. **Auto-sort by `lastPrunedAt`** or `retentionDays`
   instead of `tenantId` — sort by `tenantId` is the
   only stable choice (the field is required and
   distinct); `lastPrunedAt` can be null on many rows
   and ties break unpredictably; `retentionDays` ties
   even more.

6. **Render the matrix block BEFORE the per-table
   aggregates instead of after** — operators read top-
   down; the aggregate context ("how big is this
   table?") should establish first; the matrix ("who
   has overrides?") drills into the context.

7. **Top-level summary stats** (`tenantsWithOverrides`,
   `totalOverrideCount`, etc.) — the existing
   `perTenantPolicyCount` per table on retention
   housekeeping already covers per-table count;
   operators wanting global counts use `jq` on the
   JSON. Premature.

8. **CSV / TSV format support** for the matrix —
   different format = different milestone. Operators
   pipe to `jq -r ... | awk` for ad-hoc tabular
   processing.

9. **Discoverable `--list-tenants` helper** — operators
   wanting to enumerate eligible tenants already have
   `crossengin retention list-policies --format json |
   jq '.results | map(.tenantId) | unique'`. Housekeeping
   doesn't need to duplicate discovery surface.

10. **Pagination via `--matrix-limit N`** — at realistic
    scale (a few hundred overrides max per table), the
    full matrix renders cleanly. Premature optimization.
    Future Q if measured slow.

## Implementation notes

The gather function pivots the existing
`listTenantPolicies()` result into two lookup shapes
(`tenantPolicyByTable` for ADR-0269/0270 single-tenant,
`tenantOverridesByTable` for `--all-tenants` matrix)
populated under the appropriate flag. Mutual
exclusivity at the CLI boundary means only one is
populated per call. **Zero new substrate queries** —
both flags pivot the same fetch.

`tenantOverridesByTable` is sorted by `tenantId`
(`localeCompare`) within each table bucket for stable
output. Sort happens once during gather, not per-render
tick under `--watch`.

The renderer's `renderTenantOverridesHuman` helper takes
a `semantic: PruneSemantic` parameter on the gateway
side to discriminate the empty-array placeholder
("(not applicable — expires_at-managed)" vs "(no
per-tenant overrides on this table)") — same pattern as
ADR-0270's `renderTenantPolicyHuman` extension.

## Tests

5 new tests in `apps/architect-cli/src/retention-housekeeping.test.ts`
under `runRetention housekeeping --all-tenants (M4.14.q)`
describe block + 5 new tests in `apps/architect-cli/src/gateway.test.ts`
under `runGateway housekeeping --all-tenants (M4.14.q)`:

1. exits 2 when `--tenant` and `--all-tenants` are both
   set (mutual exclusivity)
2. renders per-table matrix block with overrides sorted
   by tenantId (verified via a regex spanning the
   table-A then table-B order)
3. JSON envelope includes `allTenants: true` + every
   table has `tenantOverrides[]` (with empty array on
   gateway idempotency / retention tables without
   overrides verified)
4. omitting `--all-tenants` preserves backward-compat
   envelope shape (no `allTenants`, no `tenantOverrides`
   field anywhere)
5. composes with `--threshold-alert` — drill-down
   preserves CI-gate semantic (alert trips on cross-
   tenant aggregate, exits 3, both threshold-alerts
   section and matrix-mode header present)

Workspace test count goes 9,623 → 9,633.

## Consequences

- Both operator-facing dashboards (gateway from ADR-0263
  + retention from ADR-0264) now support the
  cross-tenant matrix view via a single flag.
- The single-tenant `--tenant` from ADR-0269/0270 and
  the all-tenants `--all-tenants` from this milestone
  cover the full "one or all" operator question space
  for tenant-aware drill-down.
- Compliance cohort audits run in ONE command instead
  of chaining `retention list-policies` + manual
  grouping + cross-referencing.
- Zero new substrate queries — `listTenantPolicies` was
  already called once per render.
- Pure additive — pre-existing behavior preserved
  verbatim; the only schema-shape change to the JSON
  envelope is conditional fields under the flag.
- Composes transparently with `--threshold-alert`,
  `--watch`, `--watch-keep-going`, and the SIGINT
  bridge via the shared watch loop.
- Render cost at realistic scale (~100 overrides/table
  max) is bounded; pagination not required.

## Future Qs

1. **`--scope-rows-to-tenant`** Option A full per-tenant
   scoping on top of `--tenant` — pairs with ADR-0269
   Q1 + ADR-0270 Q1.
2. **`--matrix-format wide`** wide-format alternative
   for spreadsheet exports — operators wanting tenant
   rows × table columns can request the inverted shape.
3. **`--tenant <slug>` via `meta.tenants` lookup** —
   pairs with ADR-0269 Q3 + ADR-0270 Q3. Would extend
   to `--all-tenants-with-slugs` or similar to surface
   slugs alongside UUIDs in the matrix block.
4. **`--matrix-filter <predicate>`** (e.g., `optOut=true`)
   — operators wanting "show only opted-out tenants"
   can `jq`-filter the JSON for now. Future Q if
   measured friction.
5. **Summary stats at top level** (`totalOverrides`,
   `tenantsWithOverrides`) — premature; operators
   compute via `jq` for now.
6. **`--matrix-limit N`** pagination — defer until
   measured slow at realistic scale.
7. **Cross-dashboard matrix view** — single
   `crossengin tenant housekeeping --all-tenants`
   showing both gateway + retention matrices under
   one command, pairs with ADR-0270 Q7.
8. **CSV / TSV format support** for the matrix — defer
   to a focused format milestone covering both
   dashboards uniformly.
