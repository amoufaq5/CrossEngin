# ADR-0083: multi-region active-active runtime (Phase 3 P6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (Phase 3 plan), ADR-0032 (active-active topology), ADR-0010 (multi-region + residency) |

## Context

P1–P5 built a single-region serving product. P6 gives the `active-active` / `edge` /
`residency` **contracts** a runtime (ADR-0077). The contracts already carry the pure
CRDT math (`crdts.ts` per-kind merges), vector clocks (`vectors.ts`), conflict
vocabulary (`conflicts.ts`), and the split-brain lifecycle (`split-brain.ts`) — but
nothing *applies* them to replicated records across regions. The first, most
self-contained slice (mirroring how M8's `observability-runtime` opened the SLO arc) is
a pure replication engine; residency-pinned data + AI routing and an edge region-router
follow as later increments.

## Decision

A new pure package `@crossengin/active-active-runtime` (the **69th**) that orchestrates
the contracts into a stateful per-region replication engine. Three modules:

- **`replicated-value.ts`** — a `ReplicatedValue` = `{ key, crdt, clock, lastWriter,
  updatedAt }` (the conflict-free CRDT payload carried with the vector clock that
  stamps its causal history). `mergeCrdt(a, b)` dispatches to the contract's per-kind
  merge (throws `CrdtKindMismatchError` if the kinds differ — a key can't change CRDT
  type). `mergeReplicatedValues(existing, incoming)` merges the CRDT payloads + the
  vector clocks (least-upper-bound) and reports the incoming clock's `relation`
  (`after` / `before` / `equal` / `concurrent`).
- **`engine.ts`** — `ReplicationEngine` for one region: `localWrite(key, crdt)` merges a
  (possibly delta) CRDT into the current value, bumps **this region's** clock counter,
  and returns the broadcastable `ReplicationMessage`; `receive(message)` merges a remote
  value and classifies it — `remote_applied` (causally newer / first-seen),
  `stale_ignored` (causally older-or-equal; the idempotent merge is still safe), or
  `concurrent_merged` (concurrent clocks → conflict-free CRDT merge, logged as a
  `ConcurrentResolution` whose `kind`/`strategy`/`autoResolved` come from the
  `conflicts` contracts — `concurrent_write` → `vector_clock_merge`, always auto). An
  event log + the resolution log are exposed for observability.
- **`partition.ts`** — `reconcileEngines(engines)` exchanges every engine's snapshot
  with every peer so all converge (order-free + idempotent). `PartitionMonitor` drives
  the split-brain lifecycle over connectivity observations: a multi-group observation
  opens a `detected` incident, names the strict-majority `quorum` group (the side that
  may keep accepting writes) + the `minorities` to freeze (`prefer_quorum_side`, or
  `freeze_and_audit` when no majority); restored connectivity advances `detected →
  healing → healed` (each step guarded by `canTransitionSplitBrain`), then re-arms.

## Consequences

- **69 packages + 4 apps, 126 meta-schema tables, ~7,358 offline tests.** No new META_
  tables — like `observability-runtime`, this is a pure in-process runtime that emits
  records typed by existing contracts; a Postgres persistence sibling (a replication log
  + conflict audit) is the natural follow-up. New tests: 17 across the three modules
  (CRDT-merge dispatch + kind mismatch; concurrent two-region PN-counter converging to
  the summed value with a logged resolution; stale re-delivery ignored; split-brain
  detect → heal lifecycle with quorum/minority; `reconcileEngines` convergence +
  idempotence).
- **The P6 CRDT exit criterion runs end-to-end in tests** — a concurrent two-region
  counter write resolves via the PN-counter CRDT, and a simulated split-brain detects +
  heals. Residency enforcement (pinning a tenant's data + AI provider to its region, via
  the router's already-built residency filter) and an `edge-runtime` region-router +
  latency-budget enforcer are the remaining P6 increments.
