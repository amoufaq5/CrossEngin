# ADR-0141: operate-server SLO incidents via incident-response-pg (Phase 3 P2.32)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0140 (incident-response-pg package), ADR-0060 (observability-runtime SLO loop), ADR-0087 (apps/operate-server), ADR-0123 (incident persistence sink), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.32).

## Context

P2.31 (ADR-0140) extracted the incident persistence + ops layer into
`@crossengin/incident-response-pg` so any `meta.incidents` producer could reuse
it — but the only consumer was still the workflow worker. P2.32 makes
`apps/operate-server` the **second consumer**, validating the extraction: the
serving app now runs the M8 `observability-runtime` SLO enforcement loop over its
own request stream and persists declared availability incidents through the same
shared sink the worker uses, read back through the same shared replayer.

## Decision

- **`slo-incidents.ts` in `apps/operate-server`.**
  - **`buildServingSloEngine(opts)`** — constructs an availability
    `SloEnforcementEngine` (from `observability-runtime`) for one aggregate
    serving surface (default `operate-server`, 99% / 30d, a P1 page route). The
    declarer defaults to a UUID system actor so the declared incident's
    `declared_by` satisfies the `meta.users` FK on persist.
  - **`OperateSloMonitor`** — `recordRequest(status, latencyMs)` feeds the engine
    (a 5xx → `error`, else `ok`); `sweep(now)` runs `engine.evaluate()` and, for
    each `breach_opened` decision, persists `plan.incident` via a structural
    `IncidentPersistSink` (which `PostgresIncidentSink` satisfies), and for each
    `recovered` decision calls `sink.resolve` — log-only when no sink is wired.
    `start/stop` poll `sweep` on an injectable unref'd interval, `onError`-routed.
    The engine is a structural `SloEngineLike` so the persist/resolve logic is
    fake-tested without the burn-rate math.
- **`node.ts` wiring.** `createNodeRequestListener` gained an optional
  `onRequest(status, latencyMs)` hook (timed in a `finally`, so even a 500 is
  recorded). `serve()` builds the monitor under `--slo`, wires
  `monitor.recordRequest` as the hook, sweeps on `--slo-interval-ms` (default
  30s), and — under `--slo-persist` — opens a `PgConnection` and persists via
  `PostgresIncidentSink`; shutdown stops the monitor and closes the connection.
- **CLI.** `--slo` / `--slo-persist` / `--slo-actor <uuid>` / `--slo-interval-ms
  <n>`, all opt-in; default serving behavior is unchanged.

## Cross-cutting invariants enforced (by tests)

- **Mapping + lifecycle (offline).** `recordRequest` maps 5xx→error, else ok; a
  real-engine 25×503 burst `sweep`s into exactly one persisted `declared` /
  `availability` incident, with a second sweep `breach_ongoing` (no re-persist);
  a healthy stream persists nothing; a `recovered` decision calls `sink.resolve`;
  `start/stop` sweeps per tick, routes errors, and clears.
- **Real-PG (gated).** operate-server bursts 5xx through `recordRequest`, sweeps,
  and the declared incident lands in `meta.incidents` via the shared
  `PostgresIncidentSink`; it's read back via the shared `PostgresIncidentReplayer`
  (`declared` / `availability` / clean timeline) and appears in `listOpen` —
  proving the serving app consumes **both** sink + replayer from
  `incident-response-pg`.

## Alternatives considered

- **Per-route SLOs instead of one aggregate serving surface.**
  - **Decision.** Not yet — a single serving-availability SLO is the right
    coarse-grained start; per-(method, path) registrations are a config-driven
    follow-up the engine already supports.
- **Reuse the entity-store's `PgConnection` for the sink.**
  - **Decision.** No — the store may be in-memory (`--store memory`) while
    `--slo-persist` still wants Postgres; a dedicated incident connection keeps
    the two concerns independent.
- **Persist always (no `--slo-persist`).**
  - **Decision.** No — keep the loop opt-in and log-only by default so a memory
    deployment needs no Postgres; `--slo-persist` is the explicit durable path.

## Consequences

- **62 packages + 3 apps, 124 meta-schema tables, 6,613 offline tests + 29 gated
  real-Postgres integration tests** (17 worker + 12 serving; +7 offline, +1
  integration; 0 new tables/columns/packages). `incident-response-pg` now has its
  **second consumer** — the serving app declares + persists its own
  availability-SLO incidents through the same sink/replayer the worker uses,
  validating the P2.31 extraction's reuse value.
- **The SLO enforcement loop (M8) is now wired into a real serving path** —
  serving traffic → burn-rate breach → declared incident in `meta.incidents`,
  queryable/auditable by the same `incidents` tooling.
