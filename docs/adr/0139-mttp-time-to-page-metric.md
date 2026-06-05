# ADR-0139: MTTP (time-to-page) metric (Phase 3 P2.30)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0138 (comms_sent timeline audit), ADR-0133 (ack/mitigate milestones — MTTA/MTTM), ADR-0132 (incident metrics — MTTR), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.30).

## Context

P2.29 (ADR-0138) recorded a `comms_sent` timeline entry whenever on-call was
paged, and P2.23/P2.24 (ADR-0132/0133) built MTTR/MTTA/MTTM from the timeline.
The paging entry was being written but not measured — there was no **MTTP**
(mean time to page: declared → on-call reached), the earliest and most
operationally telling incident-response interval. P2.30 computes it.

## Decision

- **`incidentTimeToPageMs(summary)`** — declared → the **first** `comms_sent`
  timeline entry, in ms (null when never paged or the delta isn't a non-negative
  finite number), reusing the shared `declaredAtOf` + `nonNegativeDeltaMs`
  helpers.
- **`IncidentMetrics.mttp`** — `computeIncidentMetrics` now collects the page
  durations and reports `mttp` (mean/p50/p95/max via the shared `statsFrom`;
  null when no incident was paged) alongside `mtta`/`mttm`/`mttr`.
- **`formatIncidentMetrics`** prints an `MTTP (N paged)` line **first** among the
  duration metrics (lifecycle order: declared → paged → acknowledged → mitigated
  → resolved), `n/a` when nothing was paged. The `incidents metrics --format
  json` output carries the new `mttp` field.

## Cross-cutting invariants enforced (by tests)

- **`incidentTimeToPageMs`** computes declared → first `comms_sent`; null when the
  incident was never paged.
- **`computeIncidentMetrics`** reports `mttp` (mean/p50/p95/max) over a
  paged+milestoned incident and null when nothing was paged; the empty list yields
  null.
- **`formatIncidentMetrics`** renders `MTTP (1 paged): mean 30s` (and `MTTP: n/a`
  when unreached) ahead of the MTTA/MTTM/MTTR lines.
- **End-to-end (manual smoke).** `incidents metrics` over a wide window reported
  `MTTP (5 paged): mean …` beside the other three KPIs.

## Alternatives considered

- **MTTP from the *last* `comms_sent` entry (or re-pages).**
  - **Decision.** No — MTTP is *time to first page* (how fast on-call was
    reached); a re-page on escalation is a separate event. The first `comms_sent`
    is the right anchor, consistent with MTTA/MTTM taking the first milestone.
- **Count pages as a gauge instead of a duration.**
  - **Decision.** A page count is derivable (`comms_sent` entries), but the
    operationally useful number is the *latency* to first page; the gauge can be
    added later if needed.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,607 offline tests + 28 gated
  real-Postgres integration tests** (17 worker + 11 serving; +2 offline; 0 new
  tables/columns/packages). `incidents metrics` now reports the **full
  incident-response KPI set — MTTP · MTTA · MTTM · MTTR** — the four
  declared-anchored intervals of the lifecycle (paged → acknowledged → mitigated
  → resolved), each from the incident's own timeline.
- **The incident lifecycle is measured end to end** — every milestone the
  timeline records is now a metric.
