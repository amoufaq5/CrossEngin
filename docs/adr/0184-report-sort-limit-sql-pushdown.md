# ADR-0184: report sort + limit SQL pushdown (Phase 3 P3.29)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0177 (report aggregation engine + JSONB SQL pushdown), ADR-0179 (column-store SQL pushdown), ADR-0173 (report-data execution), ADR-0080 (Phase 3 P3 plan) |

## Context

The SQL-pushdown report executors (`buildReportSql` over the JSONB store,
`buildColumnReportSql` over the typed per-entity tables) emitted a `GROUP BY`
with **no `ORDER BY` / `LIMIT`** — so a tabular report's `sort` + `limit` (which
the pure in-memory `executeReport` honors) were silently dropped on the Postgres
path: the SQL returned every group, unordered. A "top 5 by revenue" report
aggregated correctly but came back unsorted and uncapped.

## Decision

Push a tabular report's `sort` + `limit` into the SQL, shared by both PG builders:

- A `tabularOrderLimit(report)` helper appends ` ORDER BY … LIMIT n` for
  `kind: "tabular"` reports (empty for `kpi` — one value — and `pivot` — its spec
  carries no sort/limit). Sort entries reference the **output aliases**: a
  group-by dimension (aliased to its field name) or an aggregation (aliased to its
  name) — both stores use those same aliases, so one helper serves both.
  `direction` maps to `ASC`/`DESC` (default `ASC`).
- **Fail-safe + injection-safe:** a sort field that isn't a known dimension /
  aggregation name (or isn't a safe `FIELD_RE` identifier) is skipped; a
  non-integer or negative `limit` is ignored. Only validated identifiers are
  embedded; `tenantId` (+ `entity` for the JSONB store) remain the only bound
  parameters.
- Both `buildReportSql` and `buildColumnReportSql` append the clause after their
  `GROUP BY`; `rowsToTabular` preserves the SQL row order.

## Cross-cutting invariants enforced

- **SQL parity with the in-memory engine.** A tabular report now returns the same
  ordered, capped rows whether aggregated in-memory or pushed to Postgres —
  ordering + the row cap apply to the *full* dataset, not a page.
- **No injection surface.** Sort fields are validated against the report's own
  dimension/aggregation names and `FIELD_RE`; the limit is an integer literal.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,088 offline tests + 51 gated
  real-Postgres integration tests + five CI gates.** New tests: `report-sql.test.ts`
  ORDER BY/LIMIT cases for both builders (the clause shape, skipping an unknown
  sort field + a bad limit, no clause on a kpi report) + a strengthened gated
  operate-server case asserting `ordersByState` rows come back ordered by revenue
  desc (`placed` 160 before `cart` 25) over real Postgres. No new META_ tables.
- The pivot spec gaining its own sort/limit (e.g. top-N columns) is a possible
  follow-up; today only tabular reports declare them.
