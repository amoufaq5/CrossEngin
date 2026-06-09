# ADR-0178: gated SQL-pushdown report integration test (Phase 3 P3.23)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0177 (report aggregation engine + SQL pushdown), ADR-0163 (operate-web gated integration test), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.22 (ADR-0177) added the SQL-pushdown report executor + the `reportExecutor`
seam, with offline unit tests over `buildReportSql` (the query shape) and the
in-memory engine. P3.23 adds a gated real-Postgres test proving the executor
runs correct **full-dataset** aggregates through the dashboard/pivot routes.

## Decision

- Extended `apps/operate-web`'s gated `integration.test.ts` (now 10 cases): a
  `sqlServer` is built over the `withBoard` manifest with `reportExecutor =
  PostgresReportExecutor(conn).execute`, so dashboard/pivot reports aggregate via
  SQL `GROUP BY` rather than the bounded in-memory page.
- A new gated case seeds a fresh tenant with 5 Products (grocery/active ×2,
  grocery/discontinued ×1, home/active ×2) and asserts, over real Postgres:
  - `/ui/Product/dashboard` → `widgetData[0].value === 5` (the kpi count over all
    rows),
  - `/ui/Product/pivot` → the category × status cells compute exactly
    (`grocery/active = 2`, `grocery/discontinued = 1`, `home/active = 2`).

## Cross-cutting invariants enforced

- **The SQL path computes the same aggregates, over the full dataset.** Exact
  counts (5; 2/1/2) verified against a live database — not the ≤500-row in-memory
  ceiling — through the same routes a UI hits.
- **Tests-only.** No source change; the P3.22 executor + seam are exercised over
  PG.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 7,040 offline tests + 49 gated
  real-Postgres integration tests** (17 worker + 22 operate-server + **10
  operate-web**) **+ five CI gates**. The SQL-pushdown report path is now verified
  end-to-end against a live Postgres. No new META_ tables.
