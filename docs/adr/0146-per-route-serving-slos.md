# ADR-0146: per-route SLOs in operate-server (Phase 3 P2.37)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0141 (operate-server SLO incidents), ADR-0060 (observability-runtime SLO loop), ADR-0087 (apps/operate-server), ADR-0078 (operate-runtime — manifest → routes), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.37).

## Context

P2.32 (ADR-0141) registered **one aggregate availability SLO** covering the
whole serving surface (`operate-server` by default) — so a 5xx burst on
`POST /v1/orders` and a 5xx burst on `GET /v1/products` would both burn the
same error budget, and a slow path could mask a healthy one (or vice versa).
ADR-0141's "alternatives considered" flagged per-(method, surface) registrations
as the natural follow-up — the underlying `SloEnforcementEngine` already supports
a list of registrations, evaluated independently per (registration, surface).

P2.37 derives **one availability SLO per (method, operationId)** the compiled
manifest exposes, so a burst on `POST /v1/orders` (`salesOrder.create`) declares
its own incident rather than diluting a global one.

## Decision

- **`routesForManifest(manifest): readonly {method, surface}[]`** in
  `slo-incidents.ts`. Wraps `manifestRouteSpecs` from `@crossengin/operate-runtime`
  (the same source-of-truth the gateway uses to register routes), mapping each
  `RouteSpec` to `{method, surface: operationId}`. The operationId
  (`product.list` / `salesOrder.create` / …) is the stable identifier the gateway
  also stamps onto every `PipelineExecution.routeOperationId`, so the listener
  and the engine agree on the same surface key.
- **`buildServingSloEngineForManifest({manifest, ...opts})`** constructs the
  engine with **N registrations** — one availability SLO (default 99% / 30d) per
  route. Each SLO's id is `<method>-<surface>-availability` (e.g.
  `GET-product.list-availability`); the SLO's `surface` field is the operationId
  alone, which is what `recordOutcome({surface, ...})` matches. The single-surface
  `buildServingSloEngine` stays for back-compat (and the gated integration test
  still uses it).
- **`OperateSloMonitor.recordRequest(status, latencyMs, surface?)`** now takes
  an optional per-route `surface`, defaulting to the previous aggregate
  fallback when no route matched.
- **`OperateHttpServer.dispatchWithMatch(raw, body)`** returns
  `{response, matchedOperationId: string | null}` — `dispatch` (unchanged
  signature) delegates to it for the response. The Node listener calls
  `dispatchWithMatch` and threads the matched operationId into the existing
  `onRequest(status, latencyMs, surface)` hook (timed in a `finally` so even a
  500 is recorded).
- **`serve()` wiring.** When `--slo` is enabled, builds a per-manifest engine
  (`buildServingSloEngineForManifest`), so each route is its own SLO. The
  listener forwards the matched surface to `monitor.recordRequest`; an unmatched
  request (404 / 405) accumulates against the aggregate fallback surface, which
  isn't registered — so it can't trigger a breach. No new CLI flags.

## Cross-cutting invariants enforced (by tests)

- **`routesForManifest` over the retail pack** yields one entry per (method,
  operationId): the 5 CRUD verbs per entity plus one per `entityLifecycle`
  transition (e.g. SalesOrder's `place` / `fulfill` / `return` …). Surfaces are
  camelCase `<entity>.<action>` ids.
- **Per-route engine isolates breaches.** A 5xx burst on `product.list`
  declares **one** `breach_opened` decision with `sloId =
  GET-product.list-availability` and `surface = product.list`; a parallel
  healthy 200 stream on `product.read` stays out of the persisted incident set
  (one incident total, on the failing route).
- **`recordRequest` defaults to the aggregate** when no surface is passed
  — back-compat with the P2.32 fallback path and for tests that don't drive
  the listener.

## Alternatives considered

- **Use `<method>-<operationId>` as the engine's `surface` field.**
  - **Decision.** No — operationIds already encode the action (`product.list`
    is GET-only; `product.create` is POST-only), so using operationId alone as
    the surface keeps `recordOutcome({surface: operationId})` calls trivial.
    The id still encodes method (`GET-product.list-availability`) for
    operator clarity.
- **Derive the surface from `req.method + url.pathname` in the listener.**
  - **Decision.** No — the gateway already match-resolves the route to an
    operationId (it's on every `PipelineExecution.routeOperationId`), so
    surfacing it through `dispatchWithMatch` reuses the canonical match and
    handles path-param substitution for free.
- **Register every route under one merged-surface SLO (an "any route" sum).**
  - **Decision.** No — that's the aggregate the per-route shape is replacing.
- **Add a `--slo-route-mode aggregate|per-route` toggle.**
  - **Decision.** No — per-route is the only correct default once the engine
    supports N registrations; the aggregate `buildServingSloEngine` builder
    stays for embedded / library callers.

## Limitations / not yet

- **Only routes the gateway actually serves.** A 404 (unknown path) or 405
  (unknown method) carries `matchedOperationId = null`, so its outcome falls
  through to the aggregate-fallback surface, which the per-manifest engine
  doesn't register — it's silently dropped. That's correct for availability
  SLOs (we don't budget for traffic to non-existent endpoints), but it means
  a probing attack on unmatched paths won't burn any budget.
- **One target per route.** Each registration carries one availability target
  (default 99% / 30d). Per-route latency SLOs ride the parallel `LatencySloEngine`
  path; a future follow-up can derive `LatencyRegistration[]` from the same
  manifest routes.
- **Alert routing is policy-wide.** Every per-route breach pages through the
  same `AlertPolicy` (the default operate-server P1 route). Per-route paging
  customization (e.g. critical routes go to a different rotation) is a future
  follow-up.

## Consequences

- **62 packages + 3 apps, 124 meta-schema tables, +6 offline tests in
  `@crossengin/operate-server`** (81 → 87; 0 new gated tests, 0 new tables /
  columns / packages). A 5xx burst on one route now declares one **per-route**
  availability incident (`<method>-<operationId>-availability`) instead of
  diluting a global one — sharpening the burn-rate signal end-to-end through
  the same M8 `SloEnforcementEngine` and the same `incident-response-pg`
  persistence path.
