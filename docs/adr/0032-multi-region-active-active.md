# ADR-0032: Multi-region active-active

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0009, ADR-0010, ADR-0017, ADR-0030, ADR-0031, ADR-0035, ADR-0037 |

## Context

ADR-0010 defined multi-region with **active-passive** as the baseline: writes go to one primary region, asynchronous replication to standby regions. ADR-0031 (DR) made this contractually explicit: tier_0 uses sync replication, tier_1+ uses async.

Active-passive has hard limits. Buyer requirements push us toward active-active:

1. **Latency.** A tenant in Singapore writes through the EU primary at 200ms round-trip. Active-active with a regional Singapore primary cuts that to 5ms.
2. **Sovereign isolation.** Some regulated tenants need their data to never traverse certain regions even transiently. Per-region writers cap the residency boundary.
3. **Survivability.** A region outage in active-passive forces failover and accepts the RTO. Active-active leaves other regions writing without interruption.
4. **Compliance partitioning.** A multi-master topology where each region writes its own partition (EU writes EU tenants, US writes US tenants) is the cleanest residency story.

Active-active introduces hard distributed-systems problems that active-passive avoids:

- **Conflicts.** Two regions accept conflicting writes to the same entity. Resolution becomes a first-class concern.
- **Causality.** Without a single primary, "what happened first" is ambiguous unless we track causality explicitly (vector clocks).
- **Split brain.** Network partition between regions can leave both sides accepting writes, generating divergent state.
- **Consistency tunables.** Different operations need different consistency guarantees (read-after-write for writers, eventual for analytics).

This ADR adds the **contract types** for multi-region active-active. The runtime implementation (replication topology operations, conflict resolution workers, vector-clock storage layer) is deferred to Phase 2+.

## Decision

Active-active contract has **six modules** in `@crossengin/active-active`:

1. **`topology.ts`.** Four `TopologyKind`s (single_primary, active_passive, active_active, multi_master_partitioned) × 5 `RegionRole`s (writer_primary, writer_secondary, reader_only, snapshot_only, isolated) × 5 partition strategies (tenant_hash, tenant_residency, entity_class, row_hash, geographic). `ActiveActiveTopology` enforces topology-kind invariants: single_primary has exactly one writer; active_active has ≥2 writers but ≤1 primary; multi_master_partitioned requires non-overlapping per-entity-class writers.

2. **`consistency.ts`.** Seven consistency levels (eventual, monotonic_read, read_your_writes, monotonic_writes, bounded_staleness, linearizable, session) × 7 operation kinds (read, read_index, write_insert, write_update, write_delete, transactional_multi, read_modify_write). `ConsistencyPolicy` enforces: bounded_staleness needs window; linearizable requires quorum; write operations cannot use eventual; read_modify_write needs read_your_writes minimum. `defaultPolicySet()` provides a sensible baseline.

3. **`vectors.ts`.** Vector clocks indexed by region. `VectorClockSchema` enforces sorted by region (deterministic serialization) + no duplicate regions. `compareVectorClocks()` returns one of four `CausalRelation`s (equal / before / after / concurrent). Pure functional helpers: `incrementVectorClock`, `mergeVectorClocks`, `happensBefore`, `dominates`, `isCausallyConcurrent`, `tickEvent`.

4. **`crdts.ts`.** Six CRDT kinds discriminated by `kind` literal: G-Counter (grow-only), PN-Counter (positive/negative), OR-Set (observed-remove set with tags), LWW-Register (last-writer-wins single value with origin tiebreak), LWW-Map (per-key LWW with tombstones), MV-Register (multi-value for unresolved concurrent writes). Per-CRDT merge functions are commutative + associative + idempotent (standard CRDT laws).

5. **`conflicts.ts`.** Six conflict kinds (concurrent_write, delete_update_race, constraint_violation_after_merge, ordering_ambiguity, schema_drift, tenant_residency_violation) × 7 resolution strategies × 5 statuses with state machine. `ConflictRecord` (CFL-YYYY-NNNN id) enforces concurrent_write kind requires causally concurrent clocks; resolved status needs cryptographic resolutionPayloadSha256; tenant_residency_violation cannot be auto-resolving (manual review only); manual_review resolutions need notes. Helpers: `detectConflictKind`, `preferredStrategyFor`, `isAutoResolvable`.

6. **`split-brain.ts`.** Five kinds (network_partition, asymmetric_partition, membership_disagreement, clock_skew, replication_lag_critical) × 5 statuses with state machine × 5 healing strategies. `SplitBrainEvent` (SB-YYYY-NNNN id) enforces: at most one quorum group (otherwise it's true split-brain, not a partition); regions cannot appear in multiple partition groups; minority partitions accepting writes during a network_partition must produce conflict records during healing; active events with requiresIncidentResponse=true must reference an incident. Helper: `meanTimeToHealSeconds` for ops dashboards.

Three meta-schema tables: `META_AA_TOPOLOGY` (platform-wide, audit history of activated topologies), `META_AA_CONFLICTS` (RLS, tenant-scoped), `META_AA_SPLIT_BRAIN_EVENTS` (platform-wide).

## Alternatives considered

- **Option A:** Stick with active-passive forever.
  - **Pros:** Conceptually simpler; no conflict resolution.
  - **Cons:** Latency penalty for non-primary regions; outage RTO includes failover; residency story weaker.
  - **Why not:** Buyer requirements (regulated sovereignty, low-latency global) make active-active necessary for at least multi-master-partitioned topologies.

- **Option B:** Single global primary with regional read replicas only.
  - **Pros:** No write conflicts (only one writer).
  - **Cons:** Write latency for non-primary regions; primary outage is total write outage; doesn't satisfy regulated tenants who need writes to stay in-region.
  - **Why not:** Same as Option A — addresses reads but not writes.

- **Option C:** Use Spanner/CockroachDB consensus underneath; skip CRDTs and vector clocks at app layer.
  - **Pros:** Strong consistency primitives for free.
  - **Cons:** Operationally complex; vendor lock-in; doesn't help with cross-region edge cases (manifest validation, residency enforcement) that live at the application layer.
  - **Why not:** We may use Spanner/CockroachDB for specific tables; this ADR is the application-layer contract regardless.

- **Option D:** Last-writer-wins for everything; skip CRDTs and vector clocks.
  - **Pros:** Simplest conflict resolution.
  - **Cons:** Silent data loss (concurrent writes lose work). Unacceptable for billing, inventory, audit.
  - **Why not:** Per-operation strategy selection is necessary; CRDTs let us merge correctly for counters, sets, registers.

- **Option E:** Vector clocks with strict total order only (Lamport timestamps).
  - **Pros:** Simpler.
  - **Cons:** Lamport timestamps over-order concurrent events; we can't detect concurrent writes as conflicts. Vector clocks do that.
  - **Why not:** Distinguishing concurrent from causally-ordered is the whole point.

## Consequences

- **Positive.** Buyer requirements (sovereign isolation, regional low-latency writes) become buildable. Conflict resolution is explicit and recorded. CRDTs allow some classes of merges to be automatic without human review. Split-brain events have a defined lifecycle.
- **Negative.** Significant distributed-systems surface area. Each application entity needs to decide which CRDT shape (if any) applies, or accept conflict records. Manual review of conflicts is operational cost.
- **Neutral.** Topology choices are per-deployment; we can run single_primary for some workloads and active_active for others within the same platform.
- **Reversibility.** Moving from active-passive to active-active is feasible (data hasn't diverged yet). Moving back from active-active to active-passive requires reconciling any extant conflicts and is meaningfully harder.

## Implementation notes

- **Topology activation.** `META_AA_TOPOLOGY` records the activated-at + activated-by audit trail; `superseded_at` lets us trace topology evolution.
- **Conflict id format.** CFL-YYYY-NNNN, distinct from incident (INC-), evidence (EV-), legal-hold (LH-), postmortem (PM-), split-brain (SB-) id namespaces.
- **CRDT discriminator.** `CrdtSchema` is a discriminated union on `kind`. The set is curated (six kinds today); adding requires a schema change.
- **Vector clock storage.** Stored as sorted arrays, not maps, for deterministic JSON serialization (test stability, hash stability).
- **Causal relation.** `compareVectorClocks` walks both clocks' regions in a single pass, recording aHasGreater + bHasGreater. Both true → concurrent. Equivalent to the standard partial-order algorithm.
- **Split-brain quorum.** At most one partition group can claim quorum. Two-quorum is a contradiction (both sides should have proceeded); the schema rejects it as a data-integrity error rather than letting bad data flow downstream.
- **Tenant residency violation.** Cannot auto-resolve. Always requires `requiresAudit=true` + manual review + reason recording. Goes through compliance review path.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Per-entity-class CRDT mapping — how do we declare in manifests which entities are CRDT-merged vs not | _pending_ | Phase 2 |
| Hybrid logical clocks (HLC) — replace bare vector clocks or layer on top | _pending_ | Phase 3 |
| Quorum sizing per topology — fixed 2/3 or per-tier-tunable | _pending_ | Phase 2 |
| Conflict auto-escalation thresholds — at what unresolved count do we page on-call | _pending_ | Phase 2 |
| Application_merge strategy — function signature + sandboxing for tenant-provided merge logic | _pending_ | Phase 3 |

## References

- ADR-0010 (multi-region and data residency) — the baseline topology this extends.
- ADR-0031 (disaster recovery) — replication topology and DR tiers feed into active-active topology choices.
- ADR-0035 (audit and forensics) — conflict records that affect regulated data go to the forensic audit log.
- ADR-0037 (incident response) — split-brain events reference incident records.
- Shapiro et al., "A comprehensive study of Convergent and Commutative Replicated Data Types" (2011) — foundational CRDT theory.
- Lamport, "Time, Clocks, and the Ordering of Events in a Distributed System" (1978) — and the follow-on vector clock work by Fidge / Mattern.
- `packages/active-active/src/` for the zod schemas and helpers.
