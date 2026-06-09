# ADR-0173: operate-web report-data execution for dashboard + pivot (Phase 3 P3.18)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0170 (dashboard view models), ADR-0171 (pivot view models), ADR-0172 (SSR pages); `@crossengin/reporting` (report declarations) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.18).

## Context

P3.14/P3.15 compiled the dashboard + pivot *layouts* (widget descriptors / report
ref + reshape flag), but the routes returned no computed data — the report
aggregations weren't executed. P3.18 adds a minimal, pure aggregation engine that
runs a manifest report over the entity records and wires it into the dashboard +
pivot routes, so widgets + pivots return real computed data.

## Decision

- **A pure report-execution engine** (`@crossengin/operate-web`'s
  `report-exec.ts`) covering the three entity-data-computable report kinds over
  the eight aggregation kinds (count / count_distinct / sum / avg / min / max /
  median / p95):
  - `computeAggregation(agg, records)` — the per-aggregation math (numeric
    coercion; non-numeric/null skipped; `null` when no contributing values).
  - `executeReport(report, records, canRead)` — dispatches on `report.kind`:
    `tabular` (group-by + aggregations + sort + limit), `kpi` (a single measure →
    a scalar), `pivot` (rows × columns × measures → cells). `timeseries` /
    `funnel` / `cohort` / `custom` (time-bucketing / SQL) return `null`.
  - **Fail-closed redaction**: `reportReferencedFields` collects every
    dimension/measure field, and `executeReport` withholds the whole report
    (`null`) if **any** is unreadable to the viewer — an aggregate they can't see
    in detail isn't recomputed for them. `count` (no field) is always allowed.
  All results are zod-typed (`TabularData` / `KpiData` / `PivotData`).
- **`apps/operate-web`** wires it via a `runReport(ref, viewer, viewerCtx)` helper
  on `OperateWebServer`: resolves `manifest.reports[ref]` (structurally), fetches
  a bounded page (≤500) of the report's entity records, builds the readability
  gate from that entity's per-caller access, and runs `executeReport`. The routes
  now return data:
  - `GET /ui/:entity/pivot` → `{ pivot, data }` (`data` = the executed pivot, or
    `null` for an unsupported kind / unreadable field).
  - `GET /ui/:entity/dashboard` → `{ dashboard, widgetData }` (`widgetData` aligned
    to `dashboard.cells`: the executed report per report-backed widget, `null` for
    markdown / divider / unsupported / unreadable).

## Cross-cutting invariants enforced

- **Redaction reaches the aggregate.** A pivot/widget whose report references a
  field the viewer can't read is withheld (`null`) — not silently zeroed. Proven
  in the engine tests (a strict reader → `null`; a count-only report → allowed)
  and over HTTP (the kpi widget counts the seeded Product; the pivot's
  category × status cell = 1).
- **Pure + deterministic core.** The engine is records-in/result-out with an
  injected `canRead`; 16 unit tests cover every aggregation kind + tabular/kpi/
  pivot + the redaction gate + unsupported-kind null.

## Alternatives considered

- **SQL pushdown (aggregate in the database).** The honest end state, but it
  needs a query compiler per store; the in-memory engine over a bounded page is
  the framework-neutral first cut (the bounded fetch is documented).
- **Support all 7 report kinds now.** No — timeseries/funnel/cohort need time
  bucketing + cohort math, custom needs SQL; the three view-relevant kinds
  (tabular/kpi/pivot) are the dashboard/pivot data path. The others return `null`.
- **Aggregate over redacted records (zeroing unreadable fields).** No — that
  yields misleading totals; withholding the whole report is the fail-closed,
  honest choice (consistent with the dashboard widget / pivot gating).

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 7,024 offline tests + 46 gated
  real-Postgres integration tests + five CI gates.** Dashboard widgets + pivots
  now return computed data, redaction-gated. No new META_ tables. **Bounded to a
  ≤500-record page** (the in-memory/demo ceiling) — full-dataset aggregation via
  SQL pushdown, the remaining report kinds, and a client tile-map / pivot-table
  renderer stay the follow-ups.
