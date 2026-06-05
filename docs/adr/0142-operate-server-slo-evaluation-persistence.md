# ADR-0142: operate-server SLO evaluation + enforcement-action persistence (Phase 3 P2.33)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0141 (operate-server SLO incidents via incident-response-pg), ADR-0061 (observability-runtime-pg — SLO enforcement persistence), ADR-0060 (observability-runtime — SLO loop), ADR-0087 (apps/operate-server), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.33).

## Context

P2.32 (ADR-0141) wired `OperateSloMonitor` to declare availability incidents
through `PostgresIncidentSink` — the incident half of the SLO audit trail
landed in `meta.incidents`. But the engine itself was the bare in-process
`SloEnforcementEngine` from `observability-runtime`, *not* the
`buildPersistentSloEnforcementEngine` wrapper from `observability-runtime-pg`
(M8.5), so `meta.slo_enforcement_actions` (every decision —
`breach_opened` / `breach_ongoing` / `recovered`) and `meta.slo_evaluations`
(every `breach_opened` verdict snapshot) stayed empty for the serving app.
The workflow worker has no `recordOutcome` stream, so until now those two
tables were live-table-only for the contract tests — no real producer in
either deployable app.

P2.33 closes that: operate-server's SLO engine, under `--slo-persist`, is
now the persistent wrapper, so every `recordOutcome→evaluate` cycle writes
through the M8.5 sink layer. The serving app becomes the **second consumer
of `observability-runtime-pg`** (the first being the contract test suite),
landing the full audit trail — incident + enforcement actions + breach
snapshots — under one durable flag.

## Decision

- **`apps/operate-server/src/slo-incidents.ts`.**
  - `BuildServingSloEngineOptions` gained `conn?: PgConnection`.
  - Extracted a pure `sloEnforcementOptions(opts)` helper that returns the
    shared `SloEnforcementEngineOptions` (alert policy, system actor, one
    availability registration, optional clock) — consumed by both paths.
  - `buildServingSloEngine(opts)` return type widened from
    `SloEnforcementEngine` to a structural `SloEngineLike`:
    - **No `conn`** → returns the in-process `new SloEnforcementEngine(...)`
      as today; sync `evaluate`.
    - **With `conn`** → returns `buildPersistentSloEnforcementEngine(conn,
      opts)` — every `evaluate()` writes an enforcement action per decision
      (`meta.slo_enforcement_actions`, `signal='availability'`) and an
      evaluation snapshot per `breach_opened` (`meta.slo_evaluations`).
  - `SloEngineLike.evaluate` typed as `readonly EnforcementDecision[] |
    Promise<...>`; `OperateSloMonitor.sweep` now `await`s the result (a
    plain array awaits to itself, so the offline real-engine path is
    unchanged).
- **`apps/operate-server/src/node.ts`.** `serve()` already opened an
  `incidentConn` under `--slo-persist` for the sink; it now also threads
  that same conn into `buildServingSloEngine({ conn })`, so engine + sink
  share one connection (no new flag). Without `--slo-persist` the engine
  stays in-process — no behavior change.
- **`apps/operate-server/package.json`.** Adds
  `@crossengin/observability-runtime-pg`.

## Cross-cutting invariants enforced (by tests)

- **Offline (`slo-incidents.test.ts`).** A new `buildServingSloEngine —
  persistence wrapping` block asserts (i) no `conn` returns the plain
  in-process engine (sync `evaluate`, no inserts), (ii) with a fake
  `PgConnection` that captures SQL, a real-engine 5xx burst yields ≥1
  `INSERT INTO meta.slo_enforcement_actions` + ≥1 `INSERT INTO
  meta.slo_evaluations`, (iii) a healthy stream still writes zero
  inserts, (iv) an `OperateSloMonitor` driving the persistent engine
  records both the incident (via the fake sink) **and** the action +
  snapshot rows.
- **Real-PG (gated, `slo-incidents.integration.test.ts`).** A second
  scenario bursts 5xx through `monitor.recordRequest` and `sweep`s,
  then counts rows in `meta.slo_enforcement_actions` /
  `meta.slo_evaluations` filtered by the test surface — both deltas
  ≥ 1. Gated on `CROSSENGIN_PG_TEST=1`; skipped offline.

## Alternatives considered

- **Separate `--slo-persist-actions` flag.**
  - **Decision.** No. `--slo-persist` already commits the deployment to a
    Postgres connection for the incident sink; the evaluation + action
    persistence is the same conn writing to two more append-only tables.
    A second flag would be a finer knob than the audit trail needs.
- **Open a second conn dedicated to the persistent engine.**
  - **Decision.** No. The volume is tiny (one row per decision, at most
    one decision per sweep interval), and sharing the conn keeps the
    shutdown path simple — one `incidentConn.close()` covers both.
- **Persist always (even without `--slo-persist`).**
  - **Decision.** No. The flag's purpose is "opt into Postgres
    persistence for the SLO loop"; honor that as the single gate. A
    memory deployment needs no Postgres.

## Consequences

- **62 packages + 3 apps, 124 meta-schema tables, 6,617 offline tests +
  30 gated real-Postgres integration tests** (17 worker + 13 serving;
  +4 offline, +1 integration; 0 new tables/columns/packages). The
  serving app is now the second real consumer of
  `observability-runtime-pg`, validating the M8.5 persistence layer
  beyond its own test suite — and giving operators a queryable trail
  of "every availability decision the serving app made, and which
  incident each one was tied to" via the existing
  `SloEnforcementReplayer`.
- **The SLO audit trail is now closed in operate-server**: serving
  traffic → burn-rate breach → declared incident in `meta.incidents` +
  enforcement action in `meta.slo_enforcement_actions` + verdict
  snapshot in `meta.slo_evaluations`, all under `--slo-persist`,
  joinable on `incident_id` / `surface` / `evaluated_at`.
