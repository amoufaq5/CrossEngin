# ADR-0179: SQL-pushdown report aggregation over the column store (Phase 3 P3.24)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0177 (report aggregation engine + JSONB SQL pushdown), ADR-0178 (gated SQL-pushdown report integration test), ADR-0090 (column-mapped entity store), ADR-0173 (report-data execution), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.22 (ADR-0177) added SQL-pushdown report execution for the JSONB document
store (`PostgresReportExecutor` over `operate_entity_records`) and the
`reportExecutor` seam on `apps/operate-web`, so dashboard/pivot reports aggregate
the **full** dataset in Postgres rather than the bounded in-memory page. But that
covered only the `--store pg` (JSONB) path: the `--store pg-columns`
(`ColumnMappedEntityStore`, typed per-entity tables) path still fell back to the
in-memory engine — it read at most a 500-row page and aggregated in JS, so its
counts/sums were silently capped on a large table.

The column store keeps each entity in its own tenant-scoped table with **typed
native columns** (`columnNameForField` → `"unit_price"`, `"category"`, …), not a
JSONB document, so its report SQL is a different shape: a `GROUP BY` over real
columns, no `entity = $2` predicate (the table *is* the entity), and no `->>`
extraction.

## Decision

Added the column-store sibling of the JSONB executor, in the same
`packages/operate-runtime-pg/src/report-sql.ts` module so it reuses the private
`rowsToTabular` / `rowsToPivot` / `toNum` mappers verbatim:

- **`buildColumnReportSql(report, plan: EntityTablePlan): BuiltReportSql | null`**
  — maps each dimension/measure field to its typed column via `columnIndex(plan)`
  and emits a `GROUP BY` over `<schema>.<entity_table>`:
  - dimensions select the native column aliased to the **field** name
    (`"unit_price" AS "unitPrice"`), so the shared row→data mappers read it
    unchanged;
  - measures aggregate the native column — `count(*)`, `count(distinct "col")`,
    `sum(("col")::numeric)`, `avg`/`min`/`max` likewise, and
    `percentile_cont(0.5|0.95) within group (order by ("col")::numeric)` for
    median/p95 — all `::float8`-cast and aliased;
  - `tenantId` is the only bound parameter (`$1`); there is no `entity`
    predicate, since each entity has its own table.
- **Fail-closed** on the same three conditions the JSONB builder uses, plus one
  the column store needs: a referenced field that is **missing from the plan**,
  has a **non-identifier name**, or is an **encrypted `BYTEA` column**
  (`encryptAtRest`) withholds the whole report (`null`) — you can't group or
  aggregate ciphertext. Unsupported kind / no aggregations → `null`.
- **`PostgresColumnReportExecutor`** — `(conn, manifest, {schema?})`; builds the
  per-entity `columnPlansForManifest` (default schema `public`, matching
  `ColumnMappedEntityStore`), gates fields via `reportReferencedFields` + the
  caller's `canRead`, resolves the entity's plan, builds + runs the SQL in
  `withTenantContext`, and maps rows to the identical `ReportData` shape (reusing
  the JSONB executor's mappers). Same `(report, tenantId, canRead) → ReportData |
  null` contract as `PostgresReportExecutor`, so it drops into the
  `reportExecutor` seam.
- **`apps/operate-web` `serve()`** now picks the executor by `--store`: a
  `PostgresColumnReportExecutor(manifest)` for `pg-columns`, the JSONB
  `PostgresReportExecutor` for `pg`, none for `memory`. Threaded through a small
  structural `ReportExecutorLike` so the same `(r,t,c) => executor.execute(…)`
  closure feeds the server.

## Cross-cutting invariants enforced

- **Same aggregates, full dataset, both stores.** The column store now computes
  dashboard/pivot reports in Postgres over every row, not the in-memory ceiling —
  parity with the JSONB path.
- **Redaction stays fail-closed.** Field-level `canRead` gating is unchanged; an
  unreadable field withholds the report.
- **No SQL-injection surface.** Field names are identifier-validated
  (`FIELD_RE`) and resolved through `quoteIdent`; only `tenantId` is bound.
- **Ciphertext is never aggregated.** An `encryptAtRest` (`phi`/`regulated`)
  column withholds the report rather than grouping over a `BYTEA`.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 7,048 offline tests + 50 gated
  real-Postgres integration tests** (17 worker + 22 operate-server + **11
  operate-web**) **+ five CI gates**. `buildColumnReportSql` has offline unit
  tests (column-name mapping, kpi/pivot shape, encrypted-field → null, missing
  field → null, injection-safety) and a gated case seeds 5 Products in a typed
  per-entity table and asserts the dashboard kpi (`5`) + the category × status
  pivot cells (`2`/`1`/`2`) compute via native-column SQL. No new META_ tables —
  pure read-side aggregation.
- The `map` / SSR `dashboard` / `pivot` pages already work over `pg-columns`
  (they read through the store); only the report *aggregation* was in-memory, and
  that gap is now closed for both Postgres stores.
