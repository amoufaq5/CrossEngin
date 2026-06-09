# ADR-0171: operate-web pivot view models — the compiler reaches 8/8 (Phase 3 P3.15)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0170 (dashboard), ADR-0167 (map), ADR-0162 (kanban/calendar), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.15).

## Context

The operate-web compiler covered 7 of the manifest's 8 view kinds
(table/detail/form/kanban/calendar/map/dashboard). The last one — `pivot`, a
`PivotView` carrying a `reportRef` into `manifest.reports` + an `allowReshape`
flag — completes the set. Like the dashboard, the redaction hook is the
referenced report's optional RBAC `permissions` grant (report-data execution is
out of scope; this ships the report reference + reshape flag).

## Decision

- **`@crossengin/operate-web`** gained `PivotModel` (`entity`, `title`,
  `reportRef`, `allowReshape`, optional `reportLabel`) and
  `compilePivotModel(manifest, entity, viewer)`, mirroring the other view
  compilers: `null` when the entity declares no `pivot` view or the referenced
  report is missing; throws only on an unknown entity. **Fail-closed**: a pivot
  whose report's `permissions` the viewer doesn't satisfy (via the P3.14
  `viewerSatisfiesGrant`) is withheld (`null`). `EntityNav.views` widened to
  include `"pivot"`; `compileWebApp`'s nav lists it only when it compiles.
- **`apps/operate-web`** added `GET /ui/:entity/pivot` (`servePivot`) →
  `{ pivot }`, 404 when none. Like the dashboard route it fetches no entity rows
  (a pivot reads a report); it returns the redacted report reference + reshape
  flag. `"pivot"` joined the reserved `UI_SUBROUTES`.

## Cross-cutting invariants enforced

- **The report grant gates the pivot.** A pivot over a `retail_admin`-only report
  is `null` for a `store_manager` (and absent from their nav), non-null for a
  `retail_admin` — proven in the compiler tests. A pivot whose report is missing
  is `null` (no dangling reference reaches a frontend).
- **Layout-only, honest scope.** The route serves the report ref + reshape flag;
  no report data is executed — consistent with the dashboard route.

## Alternatives considered

- **Execute the report + return pivoted data.** Deferred (no reporting engine in
  operate-web) — same rationale as the dashboard (ADR-0170).
- **Merge pivot into the dashboard compiler.** No — a `pivot` is a distinct view
  kind (a single reshapeable report, not a widget grid); it gets its own model +
  route, parallel to the others.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 6,999 offline tests + 46 gated
  real-Postgres integration tests + five CI gates.** **The operate-web compiler
  now covers all 8 manifest view kinds** (table/detail/form/kanban/calendar/map/
  dashboard/pivot) — every view a pack can declare has a redaction-aware
  view-model + a `/ui/...` route. No new META_ tables. Report-data execution (for
  dashboard + pivot) + SSR HTML pages for map/dashboard/pivot stay the
  follow-ups.
