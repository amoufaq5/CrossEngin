# ADR-0230: `@crossengin/dr-runtime-pg` — DR execution persistence (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0228 (dr-runtime), ADR-0061 (observability-runtime-pg — the persistence template), ADR-0077 (P3 plan — P8) |

## Context

`@crossengin/dr-runtime` (ADR-0228) executes failovers + drills and computes readiness in-process, but
the results evaporated at process exit. Following the established pure-runtime → `-pg` sibling pattern
(most directly `observability-runtime-pg`), this adds durable persistence so a DR execution history and
readiness audit trail survive restarts and is queryable per tenant.

## Decision

- **Three new META tables** (added to the kernel meta-schema, count 129 → 132), purpose-built with TEXT
  natural ids (the runtime emits `fov_`/`drl_` ids, mismatched with the existing UUID-keyed
  `failover_records`/`dr_drills` contract tables — so, as `observability-runtime-pg` did, the sibling
  owns its own execution/audit tables rather than reusing the contract tables via id resolvers):
  - `meta.dr_failover_executions` — a projected FailoverRecord row (`execution_id fov_…`, tier, trigger,
    status, regions, actual RPO/RTO, `rpo_breached`/`rto_breached` verdict, full `record` JSONB) under
    platform-or-tenant RLS.
  - `meta.dr_drill_executions` — a projected DrillRecord row (`execution_id drl_…`, kind, tier, outcome,
    passing, RPO/RTO breach flags, `record` JSONB) under the same RLS.
  - `meta.dr_readiness_snapshots` — a DrReadinessReport snapshot (`snapshot_id drr_…`, `ready`, the eight
    issue counts as columns, full `report` JSONB) under the same RLS.
- **`@crossengin/dr-runtime-pg`** — `records.ts` (record schemas + a `drr_` snapshot-id generator +
  pure `failoverExecutionRecordFrom` / `drillExecutionRecordFrom` / `readinessSnapshotRecordFrom`
  projectors, folding the tier verdict into the breach columns), three append-only stores
  (`INSERT … ON CONFLICT (<natural_id>) DO NOTHING` + `listRecent`/`countSince` queries), a
  `buildPersistentDrRuntime` wrapper that persists on failover completion / drill result / readiness
  assessment, and a pure `replayer` (shape verifiers + `bulkVerify`). All bound-param SQL; schema/table
  names are literals.

## Consequences

- DR execution is now durable + auditable: "every failover last quarter and whether it met its tier's
  RPO/RTO", "readiness snapshots where `ready = false`" are single queries, tenant-scoped by RLS.
- The purpose-built-tables choice (vs. reusing `failover_records`/`dr_drills`) avoids a UUID↔TEXT id
  resolver and keeps the execution log's id space identical to the runtime's — the same call
  `observability-runtime-pg` made.
- Stores are append-only + idempotent (`ON CONFLICT DO NOTHING`), so a re-persisted execution is a
  no-op; the runtime stays the source of truth, the tables a queryable projection.
- Pure projectors + fake-`PgConnection` tests keep it offline-testable; the live-Postgres path is
  exercised only in integration, like the other `-pg` siblings.
- Follow-up (open): wiring `buildPersistentDrRuntime` + the `DrReadinessScheduler` into
  `operate-server`'s process lifecycle so a deployment records readiness on a cadence.
