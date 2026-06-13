# ADR-0223: replication ledger read + verify CLI (Phase 3 P6.5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0222 (active-active-runtime-pg), ADR-0204 (sdk-ledger gate), ADR-0160 (slo gate) |

## Context

P6.4 persisted the replication event log + concurrent-resolution audit to
`meta.replication_events` / `meta.replication_conflicts`, but — unlike the incident / SLO /
gateway / SDK ledgers — gave them no operator read surface and no self-policing CI gate.

## Decision

A `query.ts` + a `crossengin-replication` bin in `@crossengin/active-active-runtime-pg`,
mirroring the other ledgers' read+verify pattern, plus a **seventh CI gate**.

- **`query.ts`** — `parseReplicationArgs` + `runReplicationQuery` over a structural
  `ReplicationQuerySource` (the two stores satisfy it via a bin-side adapter): `events`
  lists the windowed event log, `conflicts` lists the resolutions, `verify` runs the pure
  `verifyReplicationLedger` cross-table sweep and **exits 1 on drift** (the CI-gate
  contract). The sweep flags what neither table enforces per-row: a `concurrent_merged`
  event must carry the `concurrent` relation and have a matching conflict row
  (`concurrent_event_without_conflict` / `_wrong_relation`); a conflict must be between two
  distinct regions (`conflict_same_region`), be `auto_resolved` (a CRDT concurrent write
  always is — `conflict_not_auto_resolved`), and map back to a concurrent event
  (`conflict_without_concurrent_event`).
- **`bin/crossengin-replication.ts`** — `replication events|conflicts|verify [--key]
  [--since] [--limit] [--format]`; opens a PG conn, adapts the stores to the source, runs,
  exits the code. The package shifted `rootDir` to `.` (`dist/src` + `dist/bin`), mirroring
  `crossengin-slo` / `crossengin-gateway-pg`.
- **CI** — a `Replication ledger drift gate` step runs `crossengin-replication verify
  --since 2000-01-01` after the gated suites (the `active-active-runtime-pg` gated suite is
  added to the gated-integration run, so the gate audits the real persisted rows, not an
  empty table).

## Consequences

- **71 packages + 4 apps, 128 meta-schema tables, ~7,413 offline tests + 58 gated
  real-Postgres integration tests + seven CI gates** (schema-drift + incident-drift +
  PHI-encryption + gateway-execution + slo-enforcement-drift + sdk-ledger-drift +
  **replication-drift**). New tests: `query.test.ts` (9 — the sweep's five drift kinds +
  clean ledger, arg parsing, run exit codes) + a verify assertion in the gated
  `integration.test.ts`. Verified end-to-end: `crossengin-replication verify` →
  `replication ledger: no drift` (exit 0) against the live persisted rows, and `conflicts`
  lists them. No new META_ tables.
- The replication ledger is now operable from a shell and self-policing in CI — the
  read+verify symmetry holds for all five audit ledgers (incidents, gateway executions,
  SLO tables, SDK ledger, replication). A recurring writer (a worker mode draining an
  engine's events into the stores) stays the follow-up.
