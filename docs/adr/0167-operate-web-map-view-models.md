# ADR-0167: operate-web map view models (Phase 3 P3.11)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0162 (kanban/calendar view models), ADR-0166 (SSR kanban/calendar pages), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.11).

## Context

The operate-web compiler covered 5 of the manifest's 8 view kinds
(list/record/form → table/detail/form, kanban, calendar). The `map` view —
declared in `@crossengin/views` with a `geoField`, optional marker color/label
fields, `defaultZoom`, layers (markers/heatmap/polygons/cluster), and optional
bounds — was still ignored. P3.11 compiles it, mirroring the kanban/calendar
increment exactly: a redaction-aware, fail-closed `MapModel` + a
`/ui/:entity/map` JSON route.

## Decision

- **`@crossengin/operate-web`** gained `MapModel` (`model.ts`: `geoField`,
  `markerColorField?`, `markerLabelField?`, `defaultZoom`, `layers:
  MapLayerModel[]` over `MAP_LAYER_KINDS`, optional `bounds`) and
  `compileMapModel(manifest, entity, viewer, options?) → MapModel | null`
  (`compile.ts`), with the same contract as `compileKanbanModel` /
  `compileCalendarModel`:
  - `null` when the entity declares no `map` view (no fallback — a map needs an
    authored geo field); throws only on an unknown entity.
  - **Fail-closed**: if the `geoField` is unreadable the whole map is withheld
    (`null`) — the marker *position* would otherwise leak. An unreadable
    `markerColorField` / `markerLabelField` is omitted; `defaultZoom` / `layers`
    (labels humanized) / `bounds` are carried through.
  - `EntityNav.views` widened to include `"map"`; `compileWebApp`'s nav lists
    `map` only when a map compiles non-null for the caller.
- **`apps/operate-web`** added a `GET /ui/:entity/map` JSON route (`serveMap`) →
  `{ map, page: { data, nextCursor } }`, reusing the same per-caller
  `compileMapModel` + `redactRecord` + store `listPage` as the other view routes,
  `404` when no map view. `"map"` joined the reserved `UI_SUBROUTES` so a
  PATCH/DELETE on `/ui/:entity/map` isn't read as a record id.

## Cross-cutting invariants enforced

- **The marker axis can't leak.** A map whose `geoField` is a
  `commercial_sensitive` field is withheld (`null`) for a viewer who can't read
  it; a sensitive `markerColorField` is dropped from the model — proven in the
  compiler tests and over HTTP (a cashier's Product map omits the `unit_cost`
  color field + the data row's value).
- **Same compile + redaction as every other view route.** No new auth/redaction
  path; `serveMap` is the parity sibling of `serveKanban` / `serveCalendar`.

## Alternatives considered

- **An SSR HTML map page (`/app/:entity/map`).** Deferred — a rendered map needs
  a client JS mapping library (Leaflet/MapLibre); the framework-neutral SSR
  baseline (table/detail/form/kanban/calendar) doesn't fit a tile map. P3.11
  ships the JSON view-model + route; the interactive map page is a follow-up.
- **Carry layer `filters` into the model.** No — the layer filters are a query
  concern; the model carries the layer's id/label/kind (the render intent), and
  the data page is the redacted records.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,963 offline tests + 45 gated
  real-Postgres integration tests + five CI gates.** The operate-web compiler now
  covers **6 of 8** manifest view kinds (table/detail/form/kanban/calendar/map);
  `dashboard`/`pivot` (which reference a reporting substrate) remain. No new
  META_ tables. The SSR HTML map page + an interactive tile map stay the
  follow-ups.
