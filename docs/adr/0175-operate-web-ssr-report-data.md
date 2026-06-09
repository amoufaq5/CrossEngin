# ADR-0175: operate-web SSR pages render executed report data (Phase 3 P3.20)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0172 (SSR map/dashboard/pivot pages), ADR-0173 (report-data execution), ADR-0156 (hydration), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.20).

## Context

P3.17 gave map/dashboard/pivot SSR HTML pages, but the dashboard/pivot pages
rendered widget *placeholders* (kind + report id) — the report data wasn't shown,
even though P3.18 added the execution engine + JSON-route data. P3.20 threads the
executed data into the SSR pages so the server-rendered dashboard widgets + pivot
show real numbers (and the hydration state carries them).

## Decision

- **`@crossengin/operate-web-react`**: a shared `ReportDataView` renders a
  `ReportData` inline — `kpi` → the value, `tabular` → a `<table>` of
  columns × rows, `pivot` → a table of cells (rowKey | colKey | values).
  `DashboardView` gained an optional `widgetData` (aligned to `model.cells`) and
  renders each report-backed cell's data via `ReportDataView` when present (else
  the report-id placeholder); `PivotView` gained an optional `data` rendered as
  the pivot table. The `WebPageState` `dashboard` variant gained a required
  `widgetData`, the `pivot` variant a required `data`; `PageRoot` threads them.
- **`apps/operate-web`**: `renderDashboardPage` / `renderPivotPage` take the
  executed `widgetData` / `data`; `serveDashboardHtml` / `servePivotHtml` became
  async and compute it via the same `runReport(ref, viewer, viewerCtx)` helper the
  JSON routes use — so the SSR page and the JSON route return the **same**
  redaction-gated, executed data, and the embedded hydration state carries it (no
  client refetch needed on first paint).

## Cross-cutting invariants enforced

- **Same execution + redaction as the JSON route.** The SSR page computes report
  data through `runReport` (the bounded-page fetch + readability gate from P3.18),
  so a widget/pivot the viewer can't see is withheld identically server-rendered
  and over JSON.
- **The number is in the markup + the hydration state.** Proven: the
  `/app/Store/dashboard` HTML contains `ce-report-kpi` + the computed count, and a
  `DashboardView` with `widgetData` renders the kpi value while one without falls
  back to the placeholder.

## Alternatives considered

- **Let the client fetch the data after hydration.** No — the SSR page already
  computes it (the route is server-side); embedding it in the markup + hydration
  state means the numbers are visible on first paint with no client round-trip,
  and the JS-disabled page still shows them.
- **A bespoke chart per widget kind.** Deferred — `ReportDataView` renders the
  data as accessible tables / a value; rich charts (a client chart lib) are a
  progressive enhancement, like the tile-map.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 7,027 offline tests + 48 gated
  real-Postgres integration tests + five CI gates.** The SSR dashboard + pivot
  pages now render the executed report data (kpi values, tabular tables, pivot
  matrices), redaction-gated, in the markup + hydration state. No new META_
  tables. Rich client charts + a tile-map renderer stay the progressive-
  enhancement follow-ups.
