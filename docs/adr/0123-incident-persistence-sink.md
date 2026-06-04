# ADR-0123: stale-worker incident persistence sink (Phase 3 P2.16)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0121 (live monitor), ADR-0116 (incident bridge), ADR-0017/incident-response (META_INCIDENTS), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.16).

## Context

P2.15 (ADR-0121) made the stale-worker monitor run live, but its `onIncident`
sink only **logged** the declared `IncidentRecord` — the incident vanished when
the line scrolled. The monitor already produces a schema-valid `IncidentRecord`;
the missing piece is a **durable** sink that writes it to `meta.incidents` (the
incident-response table) so a dead worker leaves a queryable, auditable record.
P2.16 adds that sink.

## Decision

- **`apps/workflow-worker` — `incident-sink.ts`.** `PostgresIncidentSink.record(
  incident)` INSERTs an `IncidentRecord` into `meta.incidents` (`incident_id`,
  `title`, `severity`, `category`, `status`, `affected_tenant_ids`,
  `declared_at`, `declared_by`, `timeline`), keyed on `incident_id` with
  **`ON CONFLICT DO NOTHING`** — so the monitor's per-check dedup (one incident
  id per detection) is idempotent. `declared_by` references `meta.users`, so a
  system actor row must exist.
- **`node.ts` `run()`** — a new **`--persist-incidents`** flag (requires
  `--monitor`): when set, `onIncident` writes the incident via
  `PostgresIncidentSink` (and still logs); without it, the P2.15 log-only
  behavior is unchanged. The sink shares the worker's connection + schema.

## Cross-cutting invariants enforced (by tests)

- **Insert shape.** `record` emits `INSERT INTO meta.incidents … ON CONFLICT
  (incident_id) DO NOTHING`, binding `incident_id`/`title`/`severity`/`category`/
  `status` + `declared_by` + the `timeline` JSONB; a custom schema is honored, an
  invalid one rejected.
- **CLI.** `--persist-incidents` flips the flag (default off).
- **Real-PG (gated).** With a seeded system user, the monitor's `onIncident` →
  `PostgresIncidentSink` writes a `declared` row to `meta.incidents` with the
  scaled severity and the declaring actor — queryable after the fact.

## Alternatives considered

- **Build a full incident-response Postgres store (record + transitions).**
  - **Decision.** Deferred — the worker only needs to *declare* a stale-worker
    incident; the full incident lifecycle (ack / mitigate / resolve, runbooks,
    postmortems) belongs to the incident-response surface, not the worker. A
    focused declare-only `record` is the minimal durable sink; a richer store is
    a separate package if/when needed.
- **Persist by default (no flag).**
  - **Decision.** No — persistence needs a `declared_by` system user + write
    access to `meta.incidents`, and many deployments route worker liveness
    through metrics/alerting instead. Opt-in `--persist-incidents` keeps the
    default sink (log) zero-dependency.
- **Insert every column the schema has.**
  - **Decision.** No — the NOT-NULL-without-default columns (`incident_id`,
    `title`, `severity`, `category`, `status`, `declared_by`, `timeline`) plus
    `affected_tenant_ids` / `declared_at` are the meaningful set; the rest take
    their defaults (`status`-driven timestamps null, empty arrays), keeping the
    INSERT faithful to the declared record without inventing values.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,524 offline tests + 23 gated
  real-Postgres integration tests** (12 worker + 11 serving; +3 offline, +1
  integration; 0 new tables/columns/packages). The heartbeat loop now ends in a
  **durable** record: write (P2.7) → detect (P2.11) → plan (P2.13) → run (P2.15)
  → **persist (P2.16)**. `workflow-worker --monitor --persist-incidents` leaves a
  `meta.incidents` row per stale-worker detection.
- **Real page delivery** (a transport on the `pages` directives) remains the last
  operator-side sink the monitor is wired for; incidents are now durable and
  auditable.
