# ADR-0128: stale-worker incident timeline entries (Phase 3 P2.19)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0127 (severity escalation), ADR-0124 (incident lifecycle), ADR-0123 (incident persistence), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.19).

## Context

P2.17 (ADR-0124) gave the stale-worker incident a durable `open → resolve`
lifecycle and P2.18 (ADR-0127) added `escalate` (raise the open incident's
severity when more workers go stale). Both transitions updated
`meta.incidents` in place — `status`/`resolved_at` on resolve, `severity` on
escalate — but **left the JSONB `timeline` frozen at its declaration entry**.
An operator reading the incident row could see the *current* severity/status
but not *when* it escalated or recovered, or *who* drove it. ADR-0127 itself
flagged appending a timeline entry as the deferred richer follow-up the
`onEscalate` seam supports. P2.19 closes that: each lifecycle transition now
appends a typed `TimelineEntry` to the incident's `timeline`, building a
self-contained incident audit trail.

## Decision

- **`PostgresIncidentSink.resolve` and `.escalate` now take an `actorUserId`**
  (the system actor that drove the transition) and **append a `TimelineEntry`**
  to the existing JSONB `timeline` via Postgres array concatenation
  (`timeline = timeline || $N::jsonb`):
  - `resolve(incidentId, actorUserId)` →
    `UPDATE … SET status = 'resolved', resolved_at = now(), timeline = timeline
    || $2::jsonb WHERE incident_id = $1 AND status <> 'resolved'`, appending a
    `kind: "resolved"` entry (`message: "stale workers recovered"`).
  - `escalate(incidentId, severity, actorUserId)` →
    `UPDATE … SET severity = $2, timeline = timeline || $3::jsonb WHERE
    incident_id = $1 AND status <> 'resolved'`, appending a
    `kind: "severity_changed"` entry (`message: "severity raised to <sev>"`,
    `metadata: { severity }`).
- **The entry shape matches the incident-response `TimelineEntry`** —
  `{ occurredAt: <ISO now>, actorUserId, kind, message, metadata }` — built by
  a private `timelineEntry` helper, so the append is the same record kind the
  declaration entry already carries.
- **The append rides the same single `UPDATE`** that does the
  status/severity change, so the transition and its audit entry are atomic; the
  `status <> 'resolved'` guard keeps both idempotent (a re-resolve appends
  nothing because the row no longer matches).
- **`node.ts` `run()`** passes `options.monitorDeclaredBy` (the configured
  system actor, `--monitor-declared-by`) as the `actorUserId` to both
  `incidentSink.resolve` and `incidentSink.escalate`.

## Cross-cutting invariants enforced (by tests)

- **Resolve appends a `resolved` entry.** The `resolve` UPDATE sets
  `status='resolved', resolved_at=now(), timeline = timeline || $2::jsonb`; the
  appended entry has `kind: "resolved"` and the passed `actorUserId`.
- **Escalate appends a `severity_changed` entry.** The `escalate` UPDATE sets
  `severity = $2, timeline = timeline || $3::jsonb`; the appended entry has
  `kind: "severity_changed"`, `metadata: { severity }`, and the passed
  `actorUserId`.
- **Atomic + idempotent.** Both transitions still guard on `status <>
  'resolved'`, so a re-resolve is a no-op (no duplicate entry).
- **Real-PG (gated).** After a persisted incident is resolved, its
  `meta.incidents.timeline` contains a `resolved` entry alongside the original
  `declared` one; after an escalation, it contains a `severity_changed` entry
  carrying the new severity in `metadata`.

## Alternatives considered

- **A separate `meta.incident_timeline` child table.**
  - **Decision.** No — the `IncidentRecord` already models `timeline` as an
    embedded JSONB array (declaration writes the first entry), and the monitor
    transitions one row at a time. Appending to the embedded array keeps the
    whole incident audit in one row/one read; a child table is the right move
    only once timelines are independently queried/paged, which they aren't here.
- **Append in a second statement after the status/severity UPDATE.**
  - **Decision.** No — folding the `timeline || $N::jsonb` into the same UPDATE
    keeps the transition and its audit entry atomic and saves a round trip.
- **Default the `actorUserId` inside the sink.**
  - **Decision.** No — the sink shouldn't invent an actor; threading
    `--monitor-declared-by` from `run()` keeps the system actor configurable and
    consistent with the declaration's `declared_by`.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,530 offline tests + 25
  gated real-Postgres integration tests** (14 worker + 11 serving; 0 new
  tests/tables/columns/packages — the existing resolve/escalate unit +
  integration tests gained timeline assertions). A stale-worker incident now
  carries a **full self-describing audit trail in its `timeline`**: declared →
  severity_changed (per escalation) → resolved, each stamped with the actor and
  a timestamp.
- **The heartbeat → incident loop is complete, adaptive, and auditable** —
  write → detect → plan → run → persist → escalate → resolve, with every
  lifecycle transition recorded in the incident's own timeline.
