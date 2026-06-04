# ADR-0121: live stale-worker monitor in the worker binary (Phase 3 P2.15)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0116 (stale-worker → incident bridge), ADR-0114 (stale detection), ADR-0110 (heartbeats), ADR-0106 (apps/workflow-worker), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.15).

## Context

P2.13 (ADR-0116) built `StaleWorkerMonitor` + `planStaleWorkerEnforcement` as a
library: detection → incident plan. But nothing *ran* it — `run()` started the
workers + heartbeat reporter, never the monitor, so a dead worker still only
surfaced if something queried `listStale` by hand. P2.15 wires the monitor into
the binary so it runs live: poll heartbeats, declare an incident for stale
workers, hand it to a sink.

## Decision

- **`apps/workflow-worker` cli** — a new `--monitor` flag (off by default) +
  tuning: `--monitor-interval-ms` (default 30000), `--stale-after-ms`
  (default 60000), `--monitor-declared-by` (a UUID actor id, default
  `DEFAULT_MONITOR_DECLARED_BY`).
- **`node.ts` `run()`** — when `--monitor` is set, constructs a
  `StaleWorkerMonitor` over a `PostgresWorkerHeartbeatStore` (the same heartbeat
  table the reporters write), with `nextIncidentId = formatIncidentId(year,
  seq++)` and an `onIncident` sink that **logs** a structured line
  (`[workflow-worker] STALE WORKERS — INC-… sev2: N workflow worker(s) stale (P
  page directive(s))`). Started on `--monitor-interval-ms`, stopped in the
  `close()` handle alongside the workers + reporter.

The sink **logs** rather than pages: a real paging transport / incident
persistence is a deployment concern (the monitor produces the schema-valid
`IncidentRecord` + `PageDirective`s; the operator wires delivery). Logging makes
the loop observable today without baking a transport into the binary.

## Cross-cutting invariants enforced (by tests)

- **CLI.** `--monitor` enables the monitor; `--monitor-interval-ms` /
  `--stale-after-ms` / `--monitor-declared-by` parse; default is off.
- **Live composition (real PG, gated).** A `StaleWorkerMonitor` wired exactly as
  `run()` wires it — `source = PostgresWorkerHeartbeatStore`, `nextIncidentId =
  formatIncidentId`, an `onIncident` sink — over a seeded stale heartbeat
  produces a `declared` incident with a valid `INC-2026-NNNN` id.

## Alternatives considered

- **Page directly (a transport in the binary).**
  - **Decision.** No — the worker has no business owning a PagerDuty/Slack
    client. It produces the records; the deployment routes them. A logging sink
    is the observable default; `onIncident` is the seam to swap in real delivery.
- **Persist the incident to `meta.incidents`.**
  - **Decision.** Deferred — that needs the incident-response persistence store
    wired into the worker app. The structural `IncidentRecord` the monitor emits
    is ready for it; persistence is a follow-up sink.
- **On by default.**
  - **Decision.** No — most deployments run a dedicated monitor process (or
    surface staleness via metrics), and `--monitor` adds heartbeat reads + an
    alerting policy choice. Opt-in keeps the default worker lean.
- **One monitor per worker vs a singleton.**
  - **Decision.** Out of scope — running `--monitor` on N workers declares
    duplicate incidents; a real deployment runs it on one (or dedups in the
    sink). The per-check single-incident dedup (P2.13) limits the blast radius;
    cross-process dedup is the sink's job.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,521 offline tests + 20 gated
  real-Postgres integration tests** (11 worker + 9 serving; +1 offline, +1
  integration; 0 new tables/columns/packages). The heartbeat loop now runs
  **live end-to-end**: write (P2.7) → detect (P2.11) → plan (P2.13) → **run
  (P2.15)**. `workflow-worker --monitor` watches the pool and declares incidents
  for dead workers on an interval.
- **Real page delivery + incident persistence** remain the operator-side sinks
  the `onIncident` seam is ready for.
