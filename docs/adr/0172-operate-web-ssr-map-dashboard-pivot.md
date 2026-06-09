# ADR-0172: operate-web SSR pages for map / dashboard / pivot (Phase 3 P3.17)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0166 (SSR kanban/calendar), ADR-0167 (map), ADR-0170 (dashboard), ADR-0171 (pivot), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.17).

## Context

After P3.15 the compiler covered all 8 view kinds and every kind had a JSON
`/ui/...` route, but only 5 had a server-rendered `/app/*` HTML page
(table/detail/form via P3.3, kanban/calendar via P3.10). `map` / `dashboard` /
`pivot` were JSON-only. P3.17 adds their React components + SSR HTML routes, so
all 8 view kinds are visible in the server-rendered UI — not just as JSON.

## Decision

- **`@crossengin/operate-web-react`** gained three presentational components
  (typed by the operate-web models, pure SSR):
  - **`MapView`** ({model, rows, basePath}) — the layers + a marker **list** (one
    entry per record: its geo value, optional label / color swatch, linked to
    detail). A tiled map needs a client renderer (Leaflet/MapLibre); the
    accessible list is the framework-neutral SSR baseline + the hook a client map
    enhances.
  - **`DashboardView`** ({model}) — a 12-column CSS grid of widget placeholders,
    each positioned from its `x/y/w/h`. A report-backed widget shows its kind +
    report id (data isn't executed server-side — deferred), markdown its body,
    divider its label. Only the cells the viewer may see are present (the compiler
    dropped the rest).
  - **`PivotView`** ({model}) — a placeholder showing the report reference +
    reshape flag (the pivot aggregation isn't executed server-side).
  - `WebPageState` gained `map` / `dashboard` / `pivot` variants; `PageRoot`
    renders them in the app shell (static, like detail — no client interactivity
    yet).
- **`apps/operate-web`** added `renderMapPage` / `renderDashboardPage` /
  `renderPivotPage` (`html.ts`, each `stateOnly`-aware for SPA `?__state=1`) +
  `serveMapHtml` / `serveDashboardHtml` / `servePivotHtml` (`server.ts`), routed
  `GET /app/:entity/{map,dashboard,pivot}` in `dispatchApp` (before the `/:id`
  detail catch), reusing the same compile + redaction + store read as the JSON
  routes; `404` when the entity declares no such view.

## Cross-cutting invariants enforced

- **Redaction carries to the HTML.** The map marker list omits a marker
  color/label field the viewer can't read; a dashboard cell whose report the
  viewer can't access is absent (the compiler dropped it); a pivot over a
  forbidden report is `null` → `404`. Same compile + `redactRecord` as the JSON
  routes.
- **SPA-aware.** The new pages honor `?__state=1` (return the `WebPageState` as
  JSON) so client-side navigation to a map/dashboard/pivot works through the P3.13
  router.
- **Honest scope.** Map is a marker list (no tiles); dashboard/pivot show widget
  *placeholders* (no report data) — consistent with the JSON routes' layout-only
  contract.

## Alternatives considered

- **Bundle a tile-map library for the map page.** No — that pulls a heavy client
  dep into the bundle; the SSR marker list is the framework-neutral baseline, and
  a tile renderer can progressively enhance it client-side later.
- **Execute reports to fill dashboard/pivot widgets.** Deferred — needs a
  reporting engine (the standing dashboard/pivot follow-up); the SSR pages render
  the layout + descriptors.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 7,006 offline tests + 46 gated
  real-Postgres integration tests + five CI gates.** All 8 manifest view kinds
  now have **both** a JSON `/ui/...` route and a server-rendered `/app/*` HTML
  page. No new META_ tables. Report-data execution + a client tile-map / pivot
  table (progressive enhancement of these SSR baselines) stay the follow-ups.
