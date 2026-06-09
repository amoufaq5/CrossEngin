# ADR-0177: report aggregation engine + SQL pushdown (Phase 3 P3.22)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0162 (operate-web view models), ADR-0086 (PostgresEntityStore), ADR-0080 (Phase 3 P3 plan); `@crossengin/reporting` |

## Context

The manifest's `dashboard` widgets + `pivot` views reference reports, but nothing
executed them — the data layer had no aggregation. P3.22 adds (a) a pure,
in-memory report-execution engine in `@crossengin/operate-web` and (b) a
SQL-pushdown executor in `@crossengin/operate-runtime-pg` that aggregates the
*full* dataset in Postgres rather than a bounded in-memory page. Both return the
same `ReportData` shape, so a consumer can pick the in-memory engine (small /
non-PG stores) or the SQL executor (the JSONB document store) interchangeably.

## Decision

- **`@crossengin/operate-web` `report-exec.ts`** — a pure engine over the eight
  aggregation kinds (count / count_distinct / sum / avg / min / max / median /
  p95). `computeAggregation(agg, records)` does the per-aggregation math
  (numeric coercion; non-numeric/null skipped; `null` when no contributing
  values). `executeReport(report, records, canRead)` dispatches on `report.kind`
  — `tabular` (group-by + aggregations + sort + limit), `kpi` (single measure →
  scalar), `pivot` (rows × columns × measures → cells); timeseries/funnel/cohort/
  custom return `null`. Fail-closed: `reportReferencedFields` gates every
  dimension/measure field and the whole report is withheld (`null`) if any is
  unreadable (`count` has no field → always allowed). Results are zod-typed
  (`TabularData` / `KpiData` / `PivotData`).
- **`@crossengin/operate-runtime-pg` `report-sql.ts`** — `buildReportSql(report,
  schema)` turns a report into a `GROUP BY` over `<schema>.operate_entity_records`
  (`document ->> 'field'` dimensions, `count(*)` / `sum((…)::numeric)` /
  `percentile_cont` measures), and `PostgresReportExecutor.execute(report,
  tenantId, canRead)` runs it inside `withTenantContext` and maps the rows to the
  same `ReportData`. Field names are identifier-validated and embedded; only
  `tenantId` + `entity` are bound parameters — a non-identifier field (or invalid
  schema) returns `null`, so there is no injection surface. Same fail-closed
  readability gate as the engine.

## Cross-cutting invariants enforced

- **Two executors, one contract.** The SQL executor and the in-memory engine
  return identical `ReportData`; a consumer swaps them without changing its
  rendering.
- **Redaction is fail-closed in both.** A report referencing a field the viewer
  can't read is withheld (`null`) — not zeroed — in the engine and the SQL path.
- **No injection.** Dimension/measure field names must match
  `^[A-Za-z_][A-Za-z0-9_]*$` and the schema `^[a-z_][a-z0-9_]*$`; only values are
  bound. Proven by a test that a `region; drop table x` field → `null`.

## Alternatives considered

- **SQL only (no in-memory engine).** No — small/in-memory stores + the
  fail-closed gate logic want a pure engine; the SQL path is the scale option for
  the JSONB store.
- **Support all 7 report kinds.** No — timeseries/funnel/cohort/custom need time
  bucketing / cohort math / SQL templates; the three view-relevant kinds
  (tabular/kpi/pivot) are the dashboard/pivot data path.

## Consequences

- A report can be aggregated either in-memory (`executeReport`, bounded to the
  caller-supplied records) or pushed to Postgres (`PostgresReportExecutor`,
  full-dataset over the JSONB store), both redaction-gated. The
  `apps/operate-web` dashboard/pivot route wiring (choosing the executor by store
  kind) is the integration follow-up. No new META_ tables.

> **Environment note.** This increment was authored against an unstable session
> whose container/remote repeatedly reverted to an earlier snapshot; it is
> committed as a self-contained pair of library modules so it can be re-applied
> cleanly if the substrate loses it.
