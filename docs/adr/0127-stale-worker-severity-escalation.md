# ADR-0127: stale-worker incident severity escalation (Phase 3 P2.18)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0124 (incident lifecycle), ADR-0123 (incident persistence), ADR-0116 (incident bridge), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.18).

## Context

P2.17 (ADR-0124) made the stale-worker monitor declare one incident per stale
period and resolve it on recovery, but the **severity was frozen at declaration
time**. If staleness opened with one dead worker (`sev3`) and three more then
died (`sev2` territory), the open incident stayed `sev3` — under-paging a
worsening outage. P2.18 lets the monitor **escalate** an open incident's
severity when more workers go stale.

## Decision

- **`StaleWorkerMonitor` tracks `openSeverity`** alongside `openIncidentId`. On an
  ongoing check (staleness still present, incident open), it recomputes
  `staleWorkerSeverity(report.stale)`; if that is **strictly more severe** than
  the open severity (`isMoreSevere`, by the `SEVERITIES` order where `sev1` is
  most severe), it fires `onEscalate(incidentId, severity)` and raises
  `openSeverity`. It **only escalates (raises), never de-escalates** — a transient
  drop in stale count doesn't lower a live incident; full recovery (→ 0) resolves
  it (P2.17).
- **`onEscalate?: (incidentId, severity) => …`** is a new optional monitor
  callback.
- **`PostgresIncidentSink.escalate(incidentId, severity)`** — `UPDATE
  meta.incidents SET severity = $2 WHERE incident_id = $1 AND status <>
  'resolved'` (no-op for a resolved incident).
- **`node.ts` `run()`** wires `onEscalate` with the resolve/incident sinks: logs
  the escalation and, under `--persist-incidents`, calls `sink.escalate`.

## Cross-cutting invariants enforced (by tests)

- **Escalate once, never re-declare or de-escalate.** Open at `sev3` (1 stale);
  when 3 are stale the open incident escalates to `sev2` exactly once (a third
  check at 3 stale does nothing); the incident is never re-declared.
- **`isMoreSevere`** orders by `SEVERITIES` (`sev2` more severe than `sev3`).
- **Sink.** `escalate` emits `UPDATE … SET severity = $2 WHERE incident_id = $1
  AND status <> 'resolved'`.
- **Real-PG (gated).** A persisted incident declared `sev3` for one stale worker
  is updated to `sev2` in `meta.incidents` once three workers are stale.

## Alternatives considered

- **Re-declare a new incident at the higher severity.**
  - **Decision.** No — that breaks the one-incident-per-period dedup (P2.17) and
    fragments the record. Updating the open incident's severity keeps a single
    auditable row for the outage.
- **De-escalate when stale count drops (sev2 → sev3) before full recovery.**
  - **Decision.** No — lowering a live incident's severity mid-outage is
    surprising and risks under-paging during a flapping recovery; only the full
    clear (→ 0) closes the incident.
- **Append a timeline entry on escalation.**
  - **Decision.** Deferred — the severity bump is the actionable signal;
    appending to the JSONB `timeline` (and re-paging) is a richer follow-up the
    `onEscalate` seam supports.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,530 offline tests + 25 gated
  real-Postgres integration tests** (14 worker + 11 serving; +2 offline, +1
  integration; 0 new tables/columns/packages). The stale-worker incident now has
  a full **open → escalate → resolve** lifecycle: a worsening outage raises the
  incident's severity (and, with a paging transport on the `pages`, would re-page
  on-call at the higher urgency).
- **The heartbeat → incident loop is complete and adaptive** — write → detect →
  plan → run → persist → escalate → resolve.
