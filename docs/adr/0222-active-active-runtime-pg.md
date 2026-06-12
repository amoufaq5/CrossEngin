# ADR-0222: replication persistence — active-active-runtime-pg (Phase 3 P6.4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0083 (active-active runtime), ADR-0061 (observability-runtime-pg pattern) |

## Context

P6 (ADR-0083) shipped `active-active-runtime` as a pure, in-process replication engine
that emits a `ReplicationEvent` log + a `ConcurrentResolution` audit but persists nothing.
Following the established "every pure runtime gets a Postgres sibling" pattern
(`observability-runtime` → `observability-runtime-pg`), the runtime needs a durable,
queryable trail: "which region applied what to which key, and was it concurrent" + "what
diverged between which regions and how it resolved".

## Decision

A new package `@crossengin/active-active-runtime-pg` (the **71st**) over **two new
platform-wide META tables** (no `tenant_id` → no RLS, like `worker_heartbeats` /
`sdk_compatibility_entries`; a replication key is region/entity-addressed, not
tenant-scoped):

- **`meta.replication_events`** — the event log: `event_kind` (local_write /
  remote_applied / concurrent_merged / stale_ignored), `record_key`, `region`,
  `from_region`, `causal_relation` (equal / before / after / concurrent), `occurred_at`,
  `recorded_at`; indexed by key / region / occurred_at.
- **`meta.replication_conflicts`** — the concurrent-resolution audit: `record_key`,
  `conflict_kind`, `resolution_strategy`, `auto_resolved`, `region_a` / `region_b`, the
  merged `resolved_value` (JSONB), `occurred_at`, `recorded_at`.

Three modules: `records.ts` (read-projection records + `rowTo*` mappers + pure
`replicationEventInsertParams` / `replicationConflictInsertParams` projectors from the
runtime's `ReplicationEvent` / `ConcurrentResolution`), `event-store.ts`
(`PostgresReplicationEventStore` — `record` / `recordMany` / `listForKey` / `listSince`,
append-only, schema-name-validated), `conflict-store.ts`
(`PostgresReplicationConflictStore` — `record` [`$N::jsonb` for the resolved value] /
`listForKey` / `listRecent`).

## Consequences

- **71 packages + 4 apps, 128 meta-schema tables, ~7,400 offline tests + 58 gated
  real-Postgres integration tests.** The meta-schema is now **128** tables; the
  schema-drift gate picks the two new tables up from `META_TABLES` automatically (verified:
  `crossengin-pg drift` → `(no drift)` against the freshly-provisioned schema). New tests:
  `store.test.ts` (8 — insert-param projection, INSERT shape, `listForKey` / `listRecent`
  row mapping incl. a JSON-string vs already-parsed `resolved_value`, schema-name
  rejection) + a gated `integration.test.ts` (drive a concurrent two-region write through
  real `ReplicationEngine`s, persist the events + resolution, read them back — ran green
  against live Postgres 16). `meta-schema.test.ts` (126 → 128 + the two names) +
  `architect-cli` `apply.test.ts` (126 → 128) updated.
- The replication runtime now has a durable audit trail. A recurring writer (a worker mode
  / CLI that drains an engine's events into the stores) + a verify/replay read CLI are the
  natural follow-ups, mirroring the incident / SLO / gateway ledgers.
