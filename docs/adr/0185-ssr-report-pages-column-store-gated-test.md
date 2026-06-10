# ADR-0185: gated SSR report-page test over the column store (Phase 3 P3.30)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0179 (column-store SQL pushdown), ADR-0175 (SSR pages render report data), ADR-0172 (SSR map/dashboard/pivot pages), ADR-0163 (operate-web gated integration test), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.24 (ADR-0179) proved the column-store SQL report executor over the **JSON**
`/ui/:entity/dashboard` + `/ui/:entity/pivot` routes; P3.20 (ADR-0175) made the
**SSR HTML** `/app/:entity/dashboard` + `/app/:entity/pivot` pages render executed
report data (via `runReport` → the same `reportExecutor` seam → `DashboardView` /
`PivotView`). But no gated test exercised the SSR HTML pages end-to-end over
`--store pg-columns` — i.e. that a server-rendered page carries the
**SQL-aggregated** values from a typed per-entity table.

## Decision

Added a gated (`CROSSENGIN_PG_TEST=1`) case to `apps/operate-web`'s
`integration.test.ts` (now 12 cases): over a fresh schema + tenant, a
`ColumnMappedEntityStore` + a `PostgresColumnReportExecutor` back an
`OperateWebServer`; 4 Products are seeded (grocery/active ×2, grocery/discontinued
×1, home/active ×1) and the **SSR HTML** routes are driven:

- `GET /app/Product/dashboard` → `200 text/html`, a `<!doctype html>` document
  whose kpi widget carries the SQL `count` over all rows — asserted via the
  rendered `ce-kpi-value">4</span>` markup.
- `GET /app/Product/pivot` → `200 text/html` containing the `ce-report-pivot`
  table with the SQL-computed category × status cells (`grocery`, `n=2`, `n=1`).

## Cross-cutting invariants enforced

- **SSR pages render real SQL aggregates over the typed store.** The server-
  rendered HTML — not just the JSON API — carries the full-dataset
  column-store `GROUP BY` results, through the same `runReport` → executor seam
  the JSON routes use.
- **Tests-only.** No source change; the P3.20 SSR render + the P3.24/P3.29 column
  executor are exercised together over a live Postgres.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,088 offline tests + 52 gated
  real-Postgres integration tests** (17 worker + 23 operate-server + **12
  operate-web**) **+ five CI gates**. The SSR report-page + column-store-pushdown
  path is now verified end-to-end against a live database. No new META_ tables.
