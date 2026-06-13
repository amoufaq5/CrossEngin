# ADR-0224: persisting replication engine (Phase 3 P6.6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0222 (active-active-runtime-pg stores), ADR-0083 (replication runtime), ADR-0061 (persisting SLO engine) |

## Context

P6.4 gave the replication runtime persistence *stores*, but a caller still had to drain an
engine's `events()` / `concurrentResolutions()` into them by hand. The deferred "recurring
writer" is, in clean form, the same wrapper pattern `observability-runtime-pg` uses
(`buildPersistentSloEnforcementEngine`): a decorator that persists as the engine runs, so
no separate worker is needed.

## Decision

A `PersistingReplicationEngine` + `buildPersistentReplicationEngine` in
`@crossengin/active-active-runtime-pg`:

- Wraps a `ReplicationEngine` + the two stores. `localWrite(key, crdt)` and
  `receive(message)` delegate to the engine, then **flush the delta** — every event +
  concurrent-resolution the engine newly appended since the last op — to
  `meta.replication_events` / `meta.replication_conflicts`. Because the engine's logs are
  append-only, the wrapper tracks a flushed-count high-water mark per log, so re-flushing
  is a no-op and a long-lived engine never re-persists its whole history per call. Reads
  (`value` / `snapshot` / `events` / `region`) delegate straight through.
- The `Crdt` payload type is derived from the engine's own `localWrite` signature
  (`Parameters<…>[1]`), so the package needs no direct `@crossengin/active-active` dep.
- `buildPersistentReplicationEngine(options, {eventStore, conflictStore})` is the one-call
  factory (fresh engine + wrapper).

## Consequences

- **71 packages + 4 apps, 128 meta-schema tables, ~7,416 offline tests + 59 gated
  real-Postgres integration tests + seven CI gates.** No new META_ tables (reuses P6.4's).
  New tests: `persisting-engine.test.ts` (3 — a local write persists its event; a
  concurrent receive persists the remote event + its resolution; three ops persist exactly
  three events with no history re-persist) + a gated `integration.test.ts` case (a live
  `buildPersistentReplicationEngine` auto-persists a concurrent two-region write's events +
  resolution with no by-hand `record`, and the persisted ledger `verify`s clean — ran green
  against live Postgres 16).
- A live replication engine now persists its trail as it runs — closing the last deferred
  P6 follow-up. **P6 is complete** (CRDT replication + split-brain, edge routing + latency
  budgets, data + AI residency enforcement, persistence, an operable + self-policing
  ledger, and now auto-persistence).
