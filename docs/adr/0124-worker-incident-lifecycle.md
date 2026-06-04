# ADR-0124: worker incident lifecycle — open/resolve dedup (Phase 3 P2.17)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0123 (incident persistence), ADR-0121 (live monitor), ADR-0116 (incident bridge), ADR-0060 (SLO enforcement dedup), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.17).

## Context

P2.13–P2.16 made the stale-worker monitor declare + persist an incident. But the
loop was open-ended in two ways: (1) `checkOnce` declared a **new** incident on
*every* poll while workers stayed stale (minting a fresh id each time → an
incident storm in `meta.incidents`), and (2) when the workers **recovered**,
nothing closed the incident — it sat `declared` forever. P2.17 makes the monitor
track an **ongoing** incident: one per stale period, resolved when staleness
clears.

## Decision

- **`StaleWorkerMonitor` is now stateful** (`openIncidentId: string | null`),
  mirroring the SLO engine's breach_opened / ongoing / recovered (ADR-0060):
  - staleness **opens** (0 → >0, `openIncidentId === null`): declare via
    `onIncident`, remember the id.
  - staleness **ongoing** (>0, an incident already open): no-op — no re-declare.
  - staleness **clears** (>0 → 0, an incident open): `onResolve(incidentId)`,
    clear the state. A later staleness opens a *new* incident.
- **`onResolve?: (incidentId) => …`** is a new optional monitor callback (the
  recovery side of `onIncident`).
- **`PostgresIncidentSink.resolve(incidentId)`** — `UPDATE meta.incidents SET
  status = 'resolved', resolved_at = now() WHERE incident_id = $1 AND status <>
  'resolved'` (idempotent).
- **`node.ts` `run()`** wires `onResolve` symmetrically with `onIncident`: it
  logs the resolve and, under `--persist-incidents`, calls `sink.resolve`.

This is backward-compatible — a single `checkOnce` with stale workers still
declares exactly one incident (the existing P2.15/P2.16 tests pass unchanged);
the new behavior is dedup across repeated checks + the resolve transition.

## Cross-cutting invariants enforced (by tests)

- **Dedup + resolve (pure).** Over checks `[stale, stale, healthy, stale]` the
  monitor declares `INC-…0001` once (no re-declare while ongoing), resolves it on
  recovery, then opens a *new* `INC-…0002` for the next staleness.
- **Sink resolve.** `resolve` emits the `UPDATE … SET status='resolved',
  resolved_at=now() WHERE incident_id=$1 AND status<>'resolved'` with the bound
  id.
- **Real-PG (gated).** A stale worker declares + persists an incident; once the
  worker beats fresh again, the next `checkOnce` resolves it — the
  `meta.incidents` row is `resolved` with a `resolved_at`.

## Alternatives considered

- **One incident per stale worker (vs one per stale period).**
  - **Decision.** No — per-period (titled with the count) avoids an incident per
    worker when a whole host dies, and the resolve condition (stale → 0) is
    simple. Per-worker correlation would need a worker→incident map and partial
    resolves; the count model is the SLO-engine precedent.
- **Re-declare (update) the open incident each check with the current count.**
  - **Decision.** No — that's churn for little value; the open incident's detail
    listed the stale workers at declaration. Severity escalation on a growing
    stale count is a possible refinement, not re-declaration.
- **Resolve only on a clean stop (status='stopped'), not on recovery.**
  - **Decision.** No — `summarizeWorkerHealth` already treats a recovered worker
    (fresh heartbeat) as healthy and a clean stop as stopped; either drops
    `stale` to 0, which is the right resolve trigger.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,526 offline tests + 24 gated
  real-Postgres integration tests** (13 worker + 11 serving; +2 offline, +1
  integration; 0 new tables/columns/packages). The heartbeat → incident loop is
  now **closed**: one durable incident per stale period, opened when workers go
  dark and **resolved** when they recover — write → detect → plan → run →
  persist → **resolve**.
- **No incident storm** — the dedup means a long outage is one incident, not one
  per poll.
- **Real page delivery** (a transport on the `pages`) remains the last
  operator-side sink; the incident record now has a full open→resolve lifecycle.
