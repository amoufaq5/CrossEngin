# ADR-0133: incident ack/mitigate milestones — MTTA + MTTM (Phase 3 P2.24)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0132 (incident metrics / MTTR), ADR-0128 (timeline entries), ADR-0123 (incident persistence sink), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.24).

## Context

P2.23 (ADR-0132) computed MTTR (mean time to resolve) from the
declared→resolved timeline delta, but the incident lifecycle only recorded two
milestones — `declared` and `resolved`. The two other standard incident KPIs,
**MTTA** (mean time to acknowledge) and **MTTM** (mean time to mitigate), had no
data: nothing ever transitioned an incident to `triaged` or `mitigated` or
recorded the corresponding timestamp. The `meta.incidents` table already has the
`acked_at` / `mitigated_at` columns and the `triaged` / `mitigated` statuses, and
the `TimelineEntry` schema already has a `status_changed` kind — they were just
unused. P2.24 records the ack/mitigate milestones and extends the metrics to
compute MTTA + MTTM alongside MTTR.

## Decision

- **`PostgresIncidentSink.acknowledge(incidentId, actorUserId)`** — transitions a
  just-declared incident to `triaged`, stamps `acked_at` (first ack wins, via
  `COALESCE(acked_at, now())`), and appends a `status_changed` timeline entry
  (`{ status: "triaged" }`) in the same UPDATE. Guarded to `status = 'declared'`
  so only the first ack records (MTTA = declared → this entry); a re-ack is a
  no-op.
- **`PostgresIncidentSink.mitigate(incidentId, actorUserId)`** — transitions a
  non-settled incident to `mitigated`, stamps `mitigated_at` (first wins, via
  COALESCE), and appends a `status_changed` (`{ status: "mitigated" }`) entry.
  Guarded to `status IN ('declared','triaged','mitigating')` so a resolved /
  re-mitigated incident is a no-op (MTTM = declared → this entry).
- **Metrics (`incident-metrics.ts`).** `incidentMilestoneMs(summary,
  targetStatus)` computes declared → the **first** `status_changed` entry whose
  `metadata.status === targetStatus` (null when absent / negative). A shared
  `statsFrom(durations)` builds the `MttrStats` (mean/p50/p95/max), and
  `computeIncidentMetrics` now returns `mtta` (target `triaged`) + `mttm` (target
  `mitigated`) + `mttr` (resolved), each null when no incident reached that
  milestone. `formatIncidentMetrics` prints an `MTTA` / `MTTM` / `MTTR` line
  apiece (a `statsLine` helper), `n/a` for the ones nothing reached.
- **The sink, not the monitor, records ack/mitigate.** The `StaleWorkerMonitor`
  is fully automated (declare → escalate → resolve); acknowledgement and
  mitigation are remediation actions performed by an operator or an automated
  remediation, so they live on the sink (the same object the monitor's
  resolve/escalate use), callable by whoever performs them.

## Cross-cutting invariants enforced (by tests)

- **Sink.** `acknowledge` emits `SET status = 'triaged', acked_at =
  COALESCE(acked_at, now()), timeline = timeline || $2::jsonb WHERE incident_id =
  $1 AND status = 'declared'` with a `status_changed`/`{status:"triaged"}` entry;
  `mitigate` the `mitigated` analogue guarded to the pre-mitigated open states.
- **Metrics.** `incidentMilestoneMs` computes declared → first matching
  `status_changed` (null when absent; takes the first, ignoring a re-stamp);
  `computeIncidentMetrics` yields MTTA/MTTM/MTTR over a milestoned incident and
  null for the milestones nothing reached; `formatIncidentMetrics` renders all
  three lines (with `n/a`).
- **Real-PG (gated).** A hand-declared incident driven through
  `acknowledge` → `mitigate` → `resolve` lands a `declared → status_changed
  (triaged) → status_changed (mitigated) → resolved` timeline, stamps
  `acked_at` / `mitigated_at` / `resolved_at`, verifies clean, and
  `computeIncidentMetrics` computes all three milestone durations.

## Alternatives considered

- **A new `acked` / `mitigated` `TimelineEntry` kind.**
  - **Decision.** No — the schema already models intermediate transitions as
    `status_changed` with the target in `metadata.status`; reusing it keeps the
    `verifyTimelineShape` checks and the entry shape uniform (escalation already
    uses `severity_changed` the same way).
- **Have the monitor auto-ack / auto-mitigate.**
  - **Decision.** No — acknowledgement and mitigation are deliberate remediation
    signals, not something the detector should fabricate; the sink exposes them
    for an operator/automation to call (a CLI `ack`/`mitigate` write command is
    the natural follow-up).
- **MTTM from a `mitigating` (in-progress) status.**
  - **Decision.** No — MTTM is declared → `mitigated` (the milestone reached);
    `mitigating` is allowed as a pre-state in the guard but isn't the metric
    target.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,595 offline tests + 27 gated
  real-Postgres integration tests** (16 worker + 11 serving; +6 offline, +1
  integration; 0 new tables/columns/packages — `acked_at`/`mitigated_at`/the
  `triaged`/`mitigated` statuses already existed). The incident timeline now
  yields the full incident-KPI set — **MTTA · MTTM · MTTR** — from
  `workflow-worker incidents metrics`.
- **The incident lifecycle is now fully measurable** — declared → acknowledged →
  mitigated → resolved, each milestone stamped + timestamped, each interval a
  metric.
