# ADR-0150: per-route serving latency SLOs in operate-server (Phase 3 P2.41)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0147 (aggregate serving latency SLO), ADR-0146 (per-route availability SLOs), ADR-0141 (operate-server SLO incidents), ADR-0062 (latency-target SLO enforcement), ADR-0063 (latency enforcement persistence), ADR-0087 (apps/operate-server), ADR-0078 (operate-runtime — manifest → routes), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.41).

## Context

P2.37 (ADR-0146) split the single **aggregate availability SLO** into **one
availability SLO per (method, operationId)** the compiled manifest exposes —
so a 5xx burst on `POST /v1/orders` declares its own incident rather than
diluting a global error budget. P2.38 (ADR-0147) added the **latency sibling**,
but only as a *single aggregate* latency SLO (`buildServingLatencyEngine`,
default p95 ≤ 300ms / 30d). A slow `POST /v1/orders` therefore still diluted a
global p95: a healthy fast route could mask a slow one (or a slow one could
inflate the whole-surface percentile and over-page).

P2.41 mirrors P2.37 for latency: **one latency SLO per route**, so a slow route
declares its own `performance` incident on its own SLO id rather than burning a
shared p95. The underlying `LatencySloEngine` already supports a list of
`LatencyRegistration`s, evaluated independently per (registration, surface) over
the rolling latency window — the same shape `SloEnforcementEngine` already
exposed for availability.

## Decision

- **`perRouteLatencySloId(method, surface): string`** in `slo-incidents.ts` —
  composes `<method>-<surface>-latency` (e.g. `GET-product.list-latency`), the
  latency counterpart of `perRouteSloId`'s `…-availability`.
- **`buildServingLatencyEngineForManifest({manifest, p95Budget?, systemActorUserId?, alertPolicy?, clock?, conn?})`**
  constructs a `LatencySloEngine` with **N registrations** — one latency SLO per
  route from `routesForManifest` (the same source-of-truth the per-route
  availability builder and the gateway use). Each registration carries
  `{ slo: { id, surface, targets: [{ kind: "latency", p95: budget, window: "30d" }] }, category: "performance" }`.
  The budget defaults to `DEFAULT_SERVING_LATENCY_BUDGET` (`"300ms"`) and is
  validated up front via `parseLatencyBudgetMs` (so `"5s"` works, `"fast"`
  throws). The declarer is the same UUID system actor so the persisted
  incident's `declared_by` satisfies the `meta.users` FK.
- **Persistence via `conn` (M8.7).** When `conn` is set, the engine is wrapped
  by `buildPersistentLatencySloEngine` (from
  `@crossengin/observability-runtime-pg`) — the persistent latency wrapper
  **already exists** (M8.7 / ADR-0063), so no in-process-only fallback was
  needed. Every `evaluate()` then writes a latency-signal enforcement action per
  decision to `meta.slo_enforcement_actions` and a latency evaluation snapshot
  per `breach_opened` to `meta.slo_latency_evaluations`, applied across every
  per-route registration. With no `conn`, returns the in-process
  `LatencySloEngine`.
- **`LatencyEngineLike` widened to allow an async `evaluate`.** The persistent
  latency wrapper's `evaluate` is `Promise<readonly LatencyEnforcementDecision[]>`
  (it awaits the per-decision writes), so the monitor's structural latency-engine
  slice now matches `SloEngineLike`: `evaluate` may be sync or async.
  `OperateSloMonitor.sweep` `await`s the latency `evaluate` (it already awaited
  the availability one). Both `LatencySloEngine` (sync) and the persistent
  wrapper (async) satisfy the interface.
- **`serve()` wiring.** When `--slo` is enabled, the latency engine switches from
  the aggregate `buildServingLatencyEngine` to
  `buildServingLatencyEngineForManifest({manifest, ...})`, so latency is now
  per-route too — and under `--slo-persist` the same `incidentConn` threads in,
  making the per-route latency audit trail durable under the one flag. The
  `recordRequest(status, latencyMs, surface)` call (already passing the matched
  route surface from `dispatchWithMatch`, P2.37) feeds **both** engines through
  the monitor, so a single matched request drives both the availability and the
  per-route latency SLO for its route. `--slo-latency-budget` is unchanged (the
  per-route budget knob); no new flags.
- **`buildServingLatencyEngine` (aggregate) stays** for back-compat / direct
  library use — unchanged.

## Cross-cutting invariants enforced (by tests)

- **One latency SLO per route.** Driving a slow-but-ok stream across **every**
  route the retail pack exposes (samples interleaved so none age out of the
  rolling latency window) yields exactly one `breach_opened` per route, whose
  `sloId` set equals `{perRouteLatencySloId(method, surface)}` over all routes.
- **Per-route isolation.** A 2000ms burst on `product.list` against a 300ms
  budget declares **one** `performance` incident on `GET-product.list-latency`;
  a parallel fast (20ms) `product.read` stream stays clean — one incident total,
  on the slow route.
- **Availability + per-route latency compose in one monitor.** With both
  per-route engines wired, a slow-but-ok `product.list` declares a
  `performance` incident on `GET-product.list-latency` and an erroring
  `product.create` declares an `availability` incident on
  `POST-product.create-availability` — two incidents, distinct signals,
  distinct route ids, side-by-side through the shared `PostgresIncidentSink`.
- **Invalid budget rejected at build.** `buildServingLatencyEngineForManifest({…, p95Budget: "fast"})`
  throws (via `parseLatencyBudgetMs`), matching the aggregate builder.

## Alternatives considered

- **Keep the aggregate latency SLO; per-route only for availability.**
  - **Decision.** No — ADR-0147 explicitly flagged per-route latency as the
    follow-up, and a slow route diluting a global p95 is the exact failure mode
    per-route availability already fixed.
- **Add a `--slo-latency-mode aggregate|per-route` toggle.**
  - **Decision.** No — per-route is the only correct default once the engine
    supports N registrations; the aggregate `buildServingLatencyEngine` builder
    stays for embedded callers that want a single whole-surface p95.
- **Per-route budgets (a different p95 per route).**
  - **Decision.** Not yet — every route shares one `--slo-latency-budget`. A
    manifest-declared per-route latency target is a future follow-up.

## Limitations / not yet

- **Only manifest-derived routes are covered.** `routesForManifest` enumerates
  the CRUD verbs + `entityLifecycle` transitions `manifestRouteSpecs` produces.
  A 404 (unknown path) or 405 (unknown method) carries
  `matchedOperationId = null`, so its latency falls through to the aggregate
  fallback surface, which the per-manifest engine doesn't register — silently
  dropped (correct: we don't budget latency for non-existent endpoints).
- **One latency target per route.** Each registration carries one p95 target
  (default 300ms / 30d). Per-route p50/p99 targets, or per-route budgets, are
  future follow-ups.
- **Alert routing is policy-wide.** Every per-route latency breach pages through
  the same `AlertPolicy` (the default operate-server P1 route).

## Consequences

- **62 packages + 3 apps, 124 meta-schema tables, +5 offline tests in
  `@crossengin/operate-server`** (115 → 120; 0 new gated tests, 0 new tables /
  columns / packages). A slow route now declares its own **per-route**
  `performance` incident (`<method>-<operationId>-latency`) instead of diluting
  a global p95 — sharpening the latency signal end-to-end through the same M8.6
  `LatencySloEngine`, the M8.7 persistent latency wrapper, and the same
  `incident-response-pg` persistence path that already serves the per-route
  availability SLOs.
