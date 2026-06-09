# ADR-0170: operate-web dashboard view models (Phase 3 P3.14)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0162 (kanban/calendar), ADR-0167 (map), ADR-0080 (Phase 3 P3 plan); `@crossengin/reporting` (dashboards/reports) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.14).

## Context

The operate-web compiler covered 6 of the manifest's 8 view kinds
(table/detail/form/kanban/calendar/map). The `dashboard` view — a
`DashboardView` carrying a `dashboardRef` into `manifest.dashboards`, whose
`DashboardDeclaration` is a 12-column grid of cells, each a widget (kpi /
tabular / pivot / timeseries / funnel / cohort / list — report-backed — or
markdown / divider) — was still ignored. P3.14 compiles its **layout** into a
redaction-aware `DashboardModel`. Crucially, dashboards *and* reports carry an
optional RBAC `permissions` grant, which is the redaction hook here (the widget
*data* — report execution — is out of scope; this increment ships the layout +
widget descriptors).

## Decision

- **`@crossengin/operate-web`** gained `DashboardModel` (`model.ts`: `entity`,
  `title`, `layout` (grid|stack), `refreshIntervalSeconds`, `cells:
  DashboardCellModel[]`), `DashboardCellModel` (`x/y/w/h` + `widget`), and
  `DashboardWidgetModel` (`kind` over the 9 `DASHBOARD_WIDGET_KINDS`, optional
  `report` / `title` / `body` / `label`). `EntityNav.views` widened to include
  `"dashboard"`.
- `compileDashboardModel(manifest, entity, viewer)` resolves the entity's
  `dashboard` view → `manifest.dashboards[dashboardRef]` and builds the model.
  No fallback: `null` when the entity declares no dashboard view or the
  referenced dashboard is missing; throws only on an unknown entity.
- **Grant-based, fail-closed redaction** via a new
  `viewer.ts` `viewerSatisfiesGrant(manifest, viewer, grant)` (resolves the
  viewer's *effective* roles — inheritance-aware — and intersects the grant's
  roles; an absent grant is open):
  - A dashboard whose `permissions` the viewer doesn't satisfy is **withheld
    entirely** (`null`).
  - A report-backed widget whose referenced report's `permissions` the viewer
    lacks is **dropped from the cell list**; markdown / divider widgets always
    render.
  - `compileWebApp`'s nav lists `dashboard` only when one compiles non-null for
    the caller.
- **`apps/operate-web`** added `GET /ui/:entity/dashboard` (`serveDashboard`) →
  `{ dashboard }`, 404 when none. Unlike the other view routes it fetches **no
  entity rows** (a dashboard is report-backed aggregates, not entity records);
  it returns the redacted layout + widget descriptors only. `"dashboard"` joined
  the reserved `UI_SUBROUTES`.

## Cross-cutting invariants enforced

- **A widget the viewer can't see never appears.** Proven: a `store_manager`'s
  Store dashboard drops the `retail_admin`-only `secretReport` widget (2 cells),
  a `retail_admin`'s keeps it (3 cells); a dashboard gated to `retail_admin` is
  `null` for a `store_manager` and absent from their nav.
- **Layout-only, honest scope.** The route serves the grid + widget refs; no
  report data is executed or returned, so there's no field-level data to redact
  here — the redaction is at the dashboard/report grant level. Report-data
  execution + field redaction are a later increment (needs a reporting engine).

## Alternatives considered

- **Execute the reports + return widget data.** Deferred — operate-web has no
  reporting/aggregation engine; the layout model is the honest unit. The
  frontend (or a future report-exec route) fetches widget data separately.
- **Depend on `@crossengin/reporting` for the dashboard/report types.** No — the
  compiler reads the dashboard/report shapes structurally (a `DashboardDeclLike`
  / `ReportLike` over `manifest.dashboards` / `manifest.reports`), keeping
  operate-web off the reporting package, consistent with how it reads views
  structurally.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,992 offline tests + 46 gated
  real-Postgres integration tests + five CI gates.** The operate-web compiler now
  covers **7 of 8** manifest view kinds (table/detail/form/kanban/calendar/map/
  dashboard); only `pivot` remains. No new META_ tables. Report-data execution +
  an SSR dashboard HTML page stay the follow-ups.
