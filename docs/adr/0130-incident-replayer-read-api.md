# ADR-0130: incident replayer — typed read API over meta.incidents (Phase 3 P2.21)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0128 (incident timeline entries), ADR-0123 (incident persistence sink), ADR-0116 (incident bridge), ADR-0061 (SLO enforcement replayer), ADR-0046 (gateway replayer pattern), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.21).

## Context

P2.16–P2.19 built the **write** side of the stale-worker incident lifecycle —
`PostgresIncidentSink` declares (ADR-0123), resolves/escalates (ADR-0124/0127),
and appends timeline entries (ADR-0128) to `meta.incidents`. But there was no
**read** side: answering "which incidents are open right now?" or "every
incident in last week's window and its full timeline" meant hand-rolling SQL,
and nothing verified that the persisted timelines were well-formed (opened with
a `declared` entry, monotonic, with `resolved` status / `resolved_at` /
timeline entry all in agreement). Every other persistence package pairs its
writer with a replayer — `GatewayReplayer` (ADR-0046),
`SloEnforcementReplayer` (ADR-0061) — that gives a typed query + drift-verify
surface for audit sweeps. P2.21 adds that for incidents.

## Decision

A new `incident-replayer.ts` in `apps/workflow-worker` (the app that owns the
incident persistence), read-only over `meta.incidents`:

- **`IncidentSummary`** — the read projection (incidentId, title, severity,
  category, status, declaredAt, declaredBy, resolvedAt, timeline) +
  `invalidTimelineEntries`. `rowToIncidentSummary` coerces TIMESTAMPTZ `Date`s
  (node-postgres) to ISO strings and parses the JSONB `timeline` **leniently** —
  each entry is `TimelineEntrySchema.safeParse`d, valid ones land in `timeline`,
  malformed ones are *counted* (`invalidTimelineEntries`) rather than thrown, so
  the read never fails on bad data and the verifier can flag it.
- **`verifyTimelineShape(summary)`** — pure drift check returning typed
  `IncidentTimelineIssue[]` (`empty_timeline`, `first_entry_not_declared`,
  `non_monotonic_timeline`, `invalid_timeline_entry`,
  `resolved_status_without_resolved_at`, `resolved_at_without_resolved_status`,
  `resolved_status_without_timeline_entry`, `timeline_resolved_but_status_open`)
  — every incident should open with a `declared` entry, carry
  monotonically-timestamped entries, and have its `resolved` status / stamp /
  timeline entry agree. `summarizeIncidentIssues(issues, verifiedCount)` folds
  to per-kind counts + clean/with-issues incident counts.
- **`PostgresIncidentReplayer`** — `getByIncidentId`, `listOpen` (status not in
  the terminal set `resolved | closed | cancelled`, newest-first),
  `listForPeriod({from, to})` (declared within the window, oldest-first),
  `verifyByIncidentId` (shape check over a stored row, `null` if absent), and
  `bulkVerify({from, to})` (flatten issues across the window). Schema name is
  identifier-validated (the only interpolated identifier); all values bound;
  terminal statuses bound as `$N` params; limits clamped to `[1, 1000]`.
- **`INCIDENT_TERMINAL_STATUSES` + `isOpenIncidentStatus`** — the open/terminal
  partition the monitor's `declared`/`resolved` transitions ride on.

## Cross-cutting invariants enforced (by tests)

- **`verifyTimelineShape`** is clean for a declared incident and a
  declared → resolved (resolved_at set) incident; flags each of the eight drift
  kinds on the corresponding malformed input.
- **Lenient parse.** `rowToIncidentSummary` keeps the valid entries and counts
  the malformed ones (`{kind:"bogus"}`, `{not:"an entry"}`) without throwing.
- **SQL.** `listOpen` emits `status NOT IN ($1, $2, $3)` binding
  `["resolved","closed","cancelled"]`; `listForPeriod` binds the window and
  orders oldest-first; `getByIncidentId` returns `null` when absent.
- **Real-PG (gated).** The replayer reads a just-declared incident out of
  `listOpen` with its `["declared"]` timeline, verifies it clean, then — after
  the monitor resolves it — sees it leave the open set, reads back its
  `["declared","resolved"]` timeline + `resolved_at`, verifies it clean, and
  finds it in a `listForPeriod` window.

## Alternatives considered

- **Put the replayer in a `-pg` package (like the gateway/SLO replayers).**
  - **Decision.** No — `meta.incidents` is written by the workflow-worker app's
    sink (ADR-0123), so the read side lives beside it in the same app. If a
    second producer of `meta.incidents` emerges, promoting both sink + replayer
    to a shared `incident-response-pg` package is the clean refactor.
- **Strict-parse the timeline (throw on a bad entry).**
  - **Decision.** No — a verifier that throws on the very drift it exists to
    report is useless; lenient parse + an `invalid_timeline_entry` issue keeps
    the read total and surfaces the problem.
- **Reconstruct a full `IncidentRecord` on read.**
  - **Decision.** No — the sink only writes a subset of the rich
    `IncidentRecord`; a focused `IncidentSummary` over the persisted columns is
    honest about what's stored and avoids fabricating absent fields.

## Consequences

- **61 packages + 3 apps, 124 meta-schema tables, 6,558 offline tests + 26 gated
  real-Postgres integration tests** (15 worker + 11 serving; +20 offline, +1
  integration; 0 new tables/columns/packages). "Which incidents are open?" and
  "every incident last week and its full timeline" are now one typed query, and
  a periodic `bulkVerify` sweep flags any incident whose persisted timeline
  drifted from the declared → (escalated)* → resolved shape.
- **The stale-worker incident loop now has a symmetric read side** — write
  (sink) ↔ read + verify (replayer) — matching the gateway and SLO persistence
  packages.
