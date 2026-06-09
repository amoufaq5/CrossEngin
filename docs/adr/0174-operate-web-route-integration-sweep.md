# ADR-0174: operate-web route integration sweep over real Postgres (Phase 3 P3.19)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0163 (operate-web PG store + first integration test), ADR-0172 (SSR pages), ADR-0173 (report execution), ADR-0080 (Phase 3 P3 plan) |

> **Numbering.** ADRs 0081–0085 remain reserved for Phase 3 P4–P8 (per
> ADR-0077). This is a P3 follow-on increment (P3.19).

## Context

The gated real-Postgres integration test (ADR-0163, extended through P3.8/P3.12)
covered the table / detail / form / kanban routes + the write path + transitions
over a `PostgresEntityStore`, but the view kinds added since — map, dashboard,
pivot (incl. P3.18 report execution) — and the SSR `/app` + `?__state` SPA paths
were only proven offline (in-memory). P3.19 extends the gated suite so the whole
operate-web surface is exercised against a live database.

## Decision

- Extended `apps/operate-web/src/integration.test.ts`'s `withBoard` manifest with
  a `map` view, a `dashboard` view + dashboard (a `kpi` widget) + reports
  (`productKpi` count, `productPivot` category × status count), and a `pivot`
  view — all over the seeded `Product` entity.
- Added two gated cases over the `PostgresEntityStore`:
  1. **map / dashboard / pivot + report execution** — `/ui/Product/map` returns
     markers + layers over the persisted rows; `/ui/Product/dashboard`'s
     `widgetData[0]` is the executed `kpi` (count > 0 over the persisted Products);
     `/ui/Product/pivot`'s `data` has the `grocery × active` cell computed from PG.
  2. **SSR + SPA** — `/app/Product` returns a `text/html` `<!doctype html>`
     document; `/app/Product?__state=1` returns the table `WebPageState` JSON.
- CI already runs the operate-web gated suite (ADR-0163 wired it into the
  `integration` job), so the new cases gate automatically.

## Cross-cutting invariants enforced

- **Every operate-web route is now proven against real Postgres**, not just the
  in-memory store: the report-execution path (P3.18) aggregates persisted rows,
  and the SSR/SPA paths serve them — closing the gap between the offline suite and
  a live database.
- **Tests-only increment.** No source change; the existing routes + engine are
  exercised over PG.

## Alternatives considered

- **A separate integration file per route group.** No — the existing
  `integration.test.ts` already owns the operate-web gated suite + the seeded
  tenant/store fixtures; extending it keeps one place to provision + assert.
- **Assert exact aggregate values.** Kept loose (`count > 0`, a specific cell
  `>= 1`) because the suite shares a store across cases (rows accumulate); the
  point is end-to-end execution over PG, not a fixed count.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, 7,024 offline tests + 48 gated
  real-Postgres integration tests** (17 worker + 22 operate-server + **9
  operate-web**) **+ five CI gates**. The offline count is unchanged (the 2 new
  tests are gated). The full operate-web surface — all 8 view kinds, report
  execution, the write path + transitions, SSR + SPA — is verified end-to-end
  against a live Postgres. No new META_ tables.
