# ADR-0149: Persist incident KPI snapshots for trend analysis (Phase 3 P2.40)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0139 (MTTP metric), ADR-0133 (ack/mitigate — MTTA/MTTM), ADR-0132 (incident metrics — MTTR), ADR-0140 (incident-response-pg extraction), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.40).

## Context

`@crossengin/incident-response-pg`'s `computeIncidentMetrics`
(P2.23/0132 + P2.30/0139) folds the `meta.incidents` timeline into
MTTP/MTTA/MTTM/MTTR + open/resolved/escalation gauges — but only **on
demand**. There is no historical record: an operator can ask "what is
MTTR over the last 30 days right now?" but cannot chart how MTTR has
moved week over week, because nothing persists the computed verdict. A
trend dashboard needs durable, time-stamped snapshots of the KPIs.
P2.40 adds the snapshot store.

## Decision

- **New meta-schema table `meta.incident_metric_snapshots`** (#125,
  platform-wide — no `tenant_id`, no RLS, mirroring
  `meta.worker_heartbeats`). A UUID `id` PK + an `ims_`-prefixed
  `snapshot_id` text business key (regex-checked `^ims_[a-z0-9]{8,40}$`,
  unique), `window_from` / `window_to` / `computed_at` (default `now()`)
  TIMESTAMPTZ, `total` / `open` / `resolved` / `escalations` INTEGER
  (non-negative checks), JSONB `by_severity` / `open_by_severity`, and a
  nullable JSONB column per MttrStats (`mttp` / `mtta` / `mttm` /
  `mttr` — null when no incident contributed that interval). Two indexes
  (`computed_at`, `(window_from, window_to)`).
- **`PostgresIncidentMetricsStore`** (new `metrics-store.ts` in
  `incident-response-pg`):
  - **`recordSnapshot(window, metrics)`** — INSERTs one row, the four
    MttrStats cast `::jsonb` and bound as a JSON string or **a real SQL
    NULL** (never the string `"null"`). Each call mints a fresh
    `snapshot_id`, so re-running the same window appends a new point (the
    trend is append-only); `computed_at` defaults to `now()`. Returns the
    written row (with the minted id).
  - **`listSnapshots({from, to, limit})`** — reads rows whose
    `computed_at` falls in `[from, to]`, newest-first
    (`ORDER BY computed_at DESC, snapshot_id DESC`), limit clamped to
    `[1, 1000]` (default 100), parsing string-or-Date timestamps + JSONB
    leniently back into the typed `StoredIncidentMetricsSnapshot`.
  - **`incidentMetricsSnapshotRow(window, metrics)`** — the pure
    projector folding a window + `IncidentMetrics` into the INSERT row,
    mirroring the package's other `xRecordFrom` projectors; an optional
    `snapshotId` overrides the minted one (deterministic tests).
- **`generateSnapshotId`** reuses the Crockford-base32-over-`randomBytes`
  pattern from `observability-runtime-pg`'s id generators (`ims_` + 24
  chars), matching the table's check regex.
- The store + projector re-export from the package index.

## Cross-cutting invariants enforced (by tests)

- **`generateSnapshotId`** always matches `^ims_[a-z0-9]{8,40}$` (the
  table's check), over 20 draws.
- **`incidentMetricsSnapshotRow`** projects every field, mints an id when
  none is supplied, honors a supplied id, and ISO-stringifies Date
  windows; a null MttrStat (e.g. `mttm`) stays null.
- **`recordSnapshot`** INSERTs into `meta.incident_metric_snapshots` with
  `$8…$13::jsonb` casts, binds severity maps as JSON strings, and binds a
  null MttrStat as SQL **null** (not the string `"null"`). Honors a
  custom schema; rejects an injection-shaped schema (`x; DROP`).
- **`listSnapshots`** reads newest-first with a clamped/default limit and
  coerces driver-returned integer-as-string + string-encoded JSONB +
  Date timestamps back to typed values.
- **Gated real-Postgres (CROSSENGIN_PG_TEST=1, in `apps/operate-server`).**
  A 5xx burst declares a serving-availability incident; the test computes
  `computeIncidentMetrics` over a window via the shared
  `PostgresIncidentReplayer`, persists a snapshot via `recordSnapshot`,
  and reads it back via `listSnapshots` — total/open/resolved/by-severity
  + window round-trip intact.

## Alternatives considered

- **Compute the trend at read time over the live `meta.incidents` table
  (windowed aggregation, no snapshot table).**
  - **Decision.** No — the timeline-derived KPIs are expensive to recompute
    over wide windows on every dashboard refresh, and (more importantly) a
    *historical* MTTR for a past window changes as incidents from that
    window are later resolved/edited. A snapshot freezes the verdict at
    `computed_at`, which is what a trend chart needs.
- **One row per `(window_from, window_to)` with `ON CONFLICT DO UPDATE`
  (idempotent upsert).**
  - **Decision.** No — append-only is the right shape for a trend: two runs
    of the same window at different times are two distinct data points
    (the second reflects incidents resolved in between). A consumer that
    wants the latest per window can `DISTINCT ON` at read time.
- **Store the MttrStats as flat columns instead of JSONB.**
  - **Decision.** No — four stats × five fields = 20 columns plus the two
    severity maps; JSONB keeps the row compact, matches `IncidentMetrics`'s
    shape 1:1, and lets a nullable stat be a clean SQL NULL.

## Consequences

- **62 packages + 3 apps, 125 meta-schema tables, +11 offline tests
  (`metrics-store.test.ts`) + 1 gated real-Postgres integration test**
  (1 new table, 1 new module, 0 new packages). The schema-drift gate
  (`crossengin-pg drift`) and `emit-bootstrap.mjs` pick the new table up
  automatically from `META_TABLES` — no manual DDL edit.
- **Incident KPIs now have a durable trend.** A dashboard can chart
  MTTP/MTTA/MTTM/MTTR + open/resolved over time by reading
  `meta.incident_metric_snapshots`, with a periodic job (a future
  scheduled writer) calling `recordSnapshot` over a rolling window.
- **The snapshot writer is deferred wiring.** This increment ships the
  table + store + projector; scheduling a recurring snapshot (e.g. a
  worker mode or CLI subcommand) is the natural follow-on.
