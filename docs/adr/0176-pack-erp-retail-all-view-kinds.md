# ADR-0176: pack-erp-retail authors all 8 view kinds + reports/dashboards (Phase 3 P3.21)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0075 (pack-erp-retail), ADR-0162–0175 (operate-web view kinds + report exec), ADR-0080 (Phase 3 P3 plan); `@crossengin/reporting`, `@crossengin/views` |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.21).

## Context

The operate-web compiler reached all 8 view kinds (P3.6–P3.20), but every kind
beyond list/record/form was only ever exercised against *test-injected* views —
no shipped vertical pack declared a kanban / calendar / map / dashboard / pivot
view, a report, or a dashboard. P3.21 enriches `pack-erp-retail` so a real
pack authors them, validating the kernel manifest's view/report/dashboard
cross-validation and the operate-web compiler against authored (not synthetic)
declarations.

## Decision

- **`pack-erp-retail`** gained a `@crossengin/reporting` dep and authors, via the
  views/reports schemas (parsed for defaults + validity):
  - **Views** (`views.ts`): a SalesOrder **kanban** (lifecycle board with the
    `place`/`fulfill`/`cancel`/`mark_returned` transitions), a SalesOrder
    **calendar** (placed_at × order_number, colored by state), a Store **map**
    (region + code + status), a Store **dashboard** (→ `retailOverview`), and a
    Product **pivot** (→ `productByCategoryStatus`) — alongside the existing two
    list views.
  - **Reports** (`reports.ts`): `salesRevenue` (kpi sum of total),
    `ordersByState` (tabular group-by), `productByCategoryStatus` (pivot
    category × status, count + avg price).
  - **Dashboards** (`dashboards.ts`): `retailOverview` — a markdown header + the
    revenue KPI + the orders-by-state table on the 12-column grid.
  - `pack.ts` wires `reports` + `dashboards` into the manifest; the index
    re-exports them.
- The existing `buildErpRetailPack` cross-validation test (and the grocery pack
  that extends retail) pass unchanged — the kernel validates the new
  view→dashboard→report reference chain. A new operate-web test compiles the
  pack's **authored** views (kanban transitions resolve, the dashboard's widgets
  + the pivot's report resolve, the nav exposes every kind).

## Cross-cutting invariants enforced

- **Authored, not injected.** The compiler is now proven against a real pack's
  view/report/dashboard declarations — the kanban resolves its lifecycle
  transitions, the dashboard its widget reports, the pivot its report, gated by
  RBAC exactly as the synthetic tests showed.
- **Validation holds end-to-end.** `tryValidateManifest` accepts the enriched
  manifest (every view's entity, the dashboard view's `dashboardRef`, the
  dashboard widgets' report refs, the pivot's report ref all resolve), and the
  transitive grocery pack still validates.

## Alternatives considered

- **A brand-new pack (P4) instead of enriching retail.** Deferred to P4 — P3.21
  is the cheapest way to get a shipped pack exercising all 8 view kinds + reports
  without a whole new domain.
- **Author the views as plain objects.** No — parsing through the
  views/reporting zod schemas applies defaults + validates at pack-build time
  (the established pattern for the list views).

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 7,031 offline tests + 48 gated
  real-Postgres integration tests + five CI gates.** A real vertical pack
  (`pack-erp-retail`) now declares all 8 view kinds + 3 reports + a dashboard, so
  the operate-web stack serves an authored retail UI (boards, calendars, a store
  map, a KPI dashboard, a product pivot) end-to-end. No new META_ tables. The
  view-injection unit/integration tests were rebased on a list-only retail so
  they no longer collide with the pack's authored views.
