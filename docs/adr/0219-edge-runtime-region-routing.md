# ADR-0219: edge runtime — residency-aware routing + latency budgets (Phase 3 P6.1)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0083 (active-active runtime), ADR-0077 (Phase 3 plan), ADR-0030 (edge + latency SLO), ADR-0010 (residency) |

## Context

ADR-0083 opened P6 with the `active-active-runtime` (CRDT replication). The second
package ADR-0077 calls for in P6 is `edge-runtime` — region routing + latency-budget
enforcement over the `@crossengin/edge` contracts. The `edge` package carries routing
tables (`rulesForCountry` / `pickRegion`) + latency budgets (`evaluateBudget`); the
`residency` package carries a tenant's permitted regions (`isRegionAllowed` /
`selectPrimaryRegion`). Nothing composes them into a request-time region decision or a
running latency-budget monitor.

## Decision

A new pure package `@crossengin/edge-runtime` (the **70th**), deps `edge` + `residency`.
Two modules:

- **`router.ts`** — `RegionRouter.resolve(request)` maps a request `{ country, profile?,
  affinityRegion? }` to a `RouteResult { region, decision, strategy, reason,
  residencyEnforced }`, in order: (1) a residency-allowed sticky **affinity** wins; (2)
  the geo **routing table** (`rulesForCountry` → `pickRegion`); (3) **residency is
  authoritative** — a sticky/geo pick outside the profile's allowed regions is overridden
  to the profile's primary (`residency_override`), a residency-bound request with no
  matching rule still serves the primary (`residency_primary`) rather than dropping, and
  an affinity the profile forbids is ignored. A `blackhole` rule (or no rule + no
  residency) yields `region: null` (dropped). A residency-bound result's region is
  guaranteed `isRegionAllowed`.
- **`budget.ts`** — `LatencyBudgetMonitor.record(routeId, latencyMs)` feeds a bounded
  per-route rolling window; `evaluate(budget)` computes the window's p50/p95/p99
  (`percentile`, nearest-rank) and runs the `edge` `evaluateBudget` contract, emitting a
  lightweight `BudgetBreach` per breached percentile (and calling `onBreach`). The
  monitor holds no transport — the `onBreach` seam bridges a breach to paging / incident
  declaration (e.g. `observability-runtime`'s latency engine declaring a `performance`
  incident), keeping `edge-runtime` off the incident packages. `toBudgetBreachRecord`
  promotes a breach to the schema-valid `edge` `BudgetBreachRecord` audit shape.

## Consequences

- **70 packages + 4 apps, 126 meta-schema tables, ~7,371 offline tests.** No new META_
  tables (pure runtime). New tests: 13 — geo routing, residency override / primary
  fallback / affinity gating / blackhole drop; percentile math, in/over-budget
  evaluation, window bounding, and the audit-record promotion.
- **Residency enforcement at the request edge is now real** — a residency-bound tenant is
  never routed outside its allowed regions (the data-residency half of the P6 exit
  criterion); the AI-provider half (`isLlmProviderAllowed`, already in `residency`) wires
  into the router's chosen region next. Wiring the router + budget monitor into
  `apps/operate-server` (a region header + per-route latency recording feeding the
  `onBreach → observability-runtime` bridge) and a multi-region serving topology are the
  remaining P6 increments.
