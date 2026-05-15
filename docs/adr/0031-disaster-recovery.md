# ADR-0031: Disaster recovery

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0009, ADR-0010, ADR-0012, ADR-0017, ADR-0020, ADR-0030, ADR-0037 |

## Context

CrossEngin operates regulated workloads. Tenants in healthcare expect their data to survive region failures, ransomware, and operator error. The platform needs documented Recovery Point Objectives (how much data can be lost) and Recovery Time Objectives (how long to recover) per workload class.

A single RPO/RTO doesn't fit everything. The audit log can tolerate seconds of data loss; the patient-record EHR cannot. The dev/test environment can tolerate a half-day RTO; production cannot. We need **tiered DR** — different workload classes get different replication, backup, drill, and runbook commitments.

Five operational concerns:

1. **Tiered targets.** RPO/RTO by tier, not by app. Apps inherit tier from data classification.
2. **Replication topology.** Sync replication for the most critical tier; async for important; snapshot for recoverable; none for best-effort. Cross-region required for tier_0 and tier_1.
3. **Backup policy.** Frequency, retention, cross-region copy, verification cadence. Every backup must be verified by actually restoring it periodically.
4. **Failover audit.** Every failover (planned drill or unplanned outage) recorded with actual RPO + actual RTO measured. Compare to target.
5. **Drills.** Tier-mandated cadence. Failed drills generate findings → action items. Tier_0 drills every 30 days. Tier_4 every 365 days.

A sixth concern — **runbooks** — addresses the procedures themselves. Failover, restore, regional evacuation, key rotation emergency. Tier-0 runbooks require four-eyes approval and ≥2 named approvers; runbooks not tested in N days are flagged stale.

## Decision

DR contract has **six modules** in `@crossengin/dr`:

1. **`tiers.ts`.** Five tiers with explicit RPO/RTO + replication + retention + drill cadence:
   - tier_0 (mission_critical): RPO 0s, RTO 60s, sync replication, 7-year retention, 30-day drill cadence
   - tier_1 (business_critical): RPO 60s, RTO 15m, async, 365 days, 90 days
   - tier_2 (important): RPO 15m, RTO 1h, async, 90 days, 180 days
   - tier_3 (recoverable): RPO 1h, RTO 4h, snapshot, 30 days, 365 days
   - tier_4 (best_effort): RPO 24h, RTO 24h, none, 7 days, 365 days
   `DATA_CLASS_TIER` maps PHI/regulated → tier_0, PII/commercial_sensitive → tier_1, internal → tier_2, public → tier_3. `tierForDataClass()` resolves the spec.

2. **`replication.ts`.** Five ReplicaRoles × 4 ReplicationKinds (sync, async, snapshot, none). `ReplicationTopology` enforces no bidirectional sync/async (write loops), no self-replication, sync↔standby_sync, snapshot↔snapshot_only. `ReplicationLagRecord` (4 statuses) tracks lag bytes + seconds; `isLagAcceptable()` checks against the edge's `laggingThresholdSeconds`.

3. **`backups.ts`.** Five BackupKinds (full, incremental, wal_archive, logical_dump, object_snapshot) × 6 statuses with state machine. `BackupPolicy` enforces no-self-copy in `crossRegionCopyTo` + valid 5-field cron. `BackupRecord` enforces verified status needs verifiedAt + verifiedBy; failed status needs errorMessage; expiresAt > startedAt. `backupSatisfiesTier()` validates policy against tier requirements.

4. **`failover.ts`.** Five triggers (planned_drill, primary_outage, regional_failure, maintenance_window, manual_promotion) × 6 statuses (queued → in_progress → succeeded / failed / aborted / reverted). `FailoverRecord` enforces from-region ≠ to-region + succeeded needs completedAt + actualRpoSeconds + actualRtoSeconds + reverted needs revertedToFailoverId. primary_outage / regional_failure require `incidentTicketId`.

5. **`drills.ts`.** Five drill kinds (tabletop, restore_test, failover_test, full_regional, chaos_injection) × 5 outcomes. failover_test / restore_test / full_regional drills must record measuredRpoSeconds + measuredRtoSeconds when executed. passed_with_findings requires ≥1 finding; failed requires ≥1 finding. `drillCadenceMet()` checks nextDrillDueAt against tier's `requiresDrillCadenceDays`.

6. **`runbooks.ts`.** Six RunbookKinds (failover, restore_from_backup, partial_outage, data_loss_event, regional_evacuation, key_rotation_emergency) × 4 statuses (draft / approved / deprecated / broken). `RB-NNNN` id pattern. Failover / regional_evacuation / data_loss_event kinds require incident commander oversight. Tier_0 runbooks require ≥2 required approvers (four-eyes). `runbookFreshness()` flags stale runbooks past review + test windows.

Three meta-schema tables (platform-wide): `META_BACKUP_RECORDS`, `META_FAILOVER_RECORDS`, `META_DR_DRILLS`.

## Alternatives considered

- **Option A:** Single RPO/RTO target for the whole platform.
  - **Pros:** Simple to communicate.
  - **Cons:** Either over-engineers cheap workloads or under-protects critical ones. Cost/risk trade-off ignored.
  - **Why not:** Healthcare buyers will not accept the same RPO as the dev environment. Cost models will not accept tier_0 SLAs for caches.

- **Option B:** Continuous backup only; no tiered replication.
  - **Pros:** Cheaper.
  - **Cons:** RTO is bound by restore speed, not failover speed. Tier_0 RTO of 60s requires hot standby, not backup-and-restore.
  - **Why not:** RTO requirements force tiered replication.

- **Option C:** No drill mandate; trust that backups work.
  - **Pros:** Lower operational overhead.
  - **Cons:** Untested backups are statistically broken backups. Industry consensus: drills are non-negotiable.
  - **Why not:** Drills are a regulatory expectation (SOC 2, HIPAA, ISO 27001). Mandate it.

- **Option D:** No four-eyes on tier_0 runbooks.
  - **Pros:** Faster ops.
  - **Cons:** Solo execution of tier_0 procedures has caused real-world outages (e.g., 2017 S3 outage).
  - **Why not:** Tier_0 actions affect mission-critical systems; cost of ceremony is much less than cost of mistake.

## Consequences

- **Positive.** Operators have explicit, contractual RPO/RTO commitments. Drills run on cadence by mandate. Backup verification is a record, not an assumption. Runbooks have freshness checks. Audit trail for every failover.
- **Negative.** Significant ops burden — drill calendar, runbook reviews, backup verification, replication monitoring. Sync replication for tier_0 is expensive (storage + cross-region bandwidth).
- **Neutral.** Tier definitions are starting points; we may add tier_2.5 or split tier_1 as workloads accumulate.
- **Reversibility.** Tier definitions are tractable to change (additive). Replication topology changes are operational (move workloads across tiers); contract is stable.

## Implementation notes

- **RPO 0 implies sync.** `DrTierSpec` enforces: sync replication requires maxRpoSeconds=0. No async with zero RPO (impossible without sync).
- **Cross-region for tier_0/1.** `requiresCrossRegion=true` for tier_0 and tier_1. Replication with kind='none' is incompatible with requiresCrossRegion=true.
- **Retention covers RPO window.** retentionDays * 86400 must be ≥ maxRpoSeconds (you can't promise RPO if backups don't reach back that far).
- **Backup verification.** `BackupRecord.verifiedAt` is required for status='verified'. Operations should periodically restore + verify backups; the system records the verification, not the restore process itself.
- **Drill findings.** Each finding has 4 severity levels (info / minor / major / critical) and optional follow-up ticket. `passed_with_findings` outcome catches drills that didn't fail but uncovered issues.
- **Runbook tier_0 four-eyes.** `requiredApprovers.length >= 2` for any runbook with tier_0 in `appliesToTiers`. Distinct from the runtime four-eyes check (operator + approver at execution time).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Active-active multi-region for tier_0 — defer to ADR-0032 | _pending_ | Phase 3 |
| Backup encryption key rotation — how do we restore from backups encrypted with rotated keys | _pending_ | Phase 2 |
| Chaos engineering platform choice (Chaos Mesh, Gremlin, custom) | _pending_ | Phase 3 |
| RTO measurement methodology — start-of-recovery vs end-of-recovery clock | _pending_ | Phase 2 |

## References

- ADR-0010 (multi-region and data residency)
- ADR-0017 (observability and SLOs)
- ADR-0030 (edge and latency SLO)
- SOC 2, ISO 27001, HIPAA — common DR audit expectations.
- `packages/dr/src/` for the zod schemas and helpers.
