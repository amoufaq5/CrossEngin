# ADR-0138: page-delivery comms_sent timeline audit (Phase 3 P2.29)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0137 (webhook page transport), ADR-0129 (re-page on escalation), ADR-0128 (timeline entries), ADR-0132/0133 (metrics / milestones), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.29).

## Context

P2.28 (ADR-0137) made pages actually leave the process (the webhook transport),
and P2.19/P2.27 made every other lifecycle transition (declared, severity_changed,
acked, mitigated, resolved) a timeline entry — but **paging left no trace on the
incident**. An auditor reading a resolved incident could see it was declared,
escalated, and resolved, but not *that on-call was paged* or *when*. The
`TimelineEntry` schema already has a `comms_sent` kind (and the verifier +
metrics already accept it); it was just never written. P2.29 records it.

## Decision

- **`PostgresIncidentSink.recordCommsSent(incidentId, actorUserId, { reason,
  pageCount })`** — appends a `comms_sent` timeline entry (`message: "paged
  on-call (N directive(s), <reason>)"`, `metadata: { reason, pageCount }`)
  **without** changing status or severity, in a single
  `UPDATE … SET timeline = timeline || $2::jsonb WHERE incident_id = $1 AND status
  <> 'resolved'`. The audit half of the paging path.
- **`run()` records it after a successful delivery.** In both the declaration and
  escalation callbacks, *after* `deliverPages` succeeds and only when
  `--persist-incidents` is on and the directive list is non-empty, it calls
  `recordCommsSent` with the reason (`declared` / `escalated`) and the page count.
  Recording *after* delivery means a webhook that throws (non-2xx) is **not**
  recorded as sent — `comms_sent` reflects a page that actually went out.
- **No verifier / metrics change.** A `comms_sent` entry sits between `declared`
  and the terminal entries — monotonic, not first, not resolution-related — so
  `verifyTimelineShape` treats it as clean, and the metrics already tolerate it.

## Cross-cutting invariants enforced (by tests)

- **Sink.** `recordCommsSent` emits `SET timeline = timeline || $2::jsonb` (no
  `status =`/`severity =`) guarded to `status <> 'resolved'`, with a
  `comms_sent` entry carrying `{ reason, pageCount }` and the formatted message.
- **Real-PG (gated).** A declared incident with a `recordCommsSent` reads back a
  `["declared", "comms_sent"]` timeline (metadata `{ reason: declared,
  pageCount: 2 }`), and `verifyByIncidentId` returns clean — a `comms_sent` entry
  on an open incident is not drift.

## Alternatives considered

- **Record `comms_sent` before delivery (intent), not after (confirmation).**
  - **Decision.** No — recording after a successful `deliverPages` means the entry
    reflects a page that *left the process*; a failed webhook (which throws and is
    routed to `onError`) doesn't falsely claim on-call was reached.
- **Record even when the transport is the Logging default.**
  - **Decision.** Yes — `run()` records whenever pages were delivered and
    persistence is on, regardless of transport; the entry documents that the
    system emitted/delivered page directives. (With logging, "delivery" is to the
    operator's logs.)
- **A new `paged` TimelineEntry kind.**
  - **Decision.** No — `comms_sent` is the schema's existing kind for outbound
    communication; reusing it keeps the verifier/metrics uniform (as
    `status_changed`/`severity_changed` already do).

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,605 offline tests + 28 gated
  real-Postgres integration tests** (17 worker + 11 serving; +1 offline, +1
  integration; 0 new tables/columns/packages). A paged incident now carries the
  page in its own timeline (`declared → comms_sent → severity_changed →
  comms_sent → resolved`), so `incidents period` / a replay shows *when on-call
  was reached*, and the audit trail is complete across every lifecycle event.
- **The paging path is now fully auditable** — POST the page (P2.28) **and**
  record it on the timeline (P2.29).
