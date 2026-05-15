# ADR-0036: Tenant lifecycle

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0009, ADR-0012, ADR-0021, ADR-0028, ADR-0035 |

## Context

ADR-0028 defined onboarding — how tenants enter the platform. This ADR defines the inverse: how they leave (suspend, archive, delete) and how the platform handles **GDPR Article 17 right to erasure**, data exports under Article 20, and the cryptographic proof-of-deletion trail that regulators expect.

Three categories of exit are distinct:

1. **Reversible.** Suspended for billing issues; restored when the tenant pays. Archived for low activity; restored when the tenant returns. These keep data intact under read-only access.
2. **Pending deletion.** A 30-day grace window (configurable) during which the tenant can change their mind. Data is read-only but exportable. Restoration is possible.
3. **Deleted.** Past grace period. Data physically purged from primary storage, search indexes, cache. Backups follow tier-specific retention before final destruction. A **tombstone** record persists permanently as cryptographic proof of deletion.

Two further concerns:

- **GDPR Article 12(3) caps deadline at 1 month** (extendable to 3 months for complex cases). The schema caps total deadline at 3 months from request.
- **Retention obligations beyond GDPR.** Tax records (7 years in most jurisdictions), medical records (10 years), anti-money-laundering (5 years). A deletion request must enumerate retained data categories with stated obligations; otherwise everything is erased.

The lifecycle interacts heavily with:

- ADR-0035 (audit and forensics) — legal holds block deletion.
- ADR-0021 (billing) — past_due → suspended after grace.
- ADR-0009 (security) — PHI export requires non-customer trigger.

## Decision

Tenant lifecycle contract has **six modules** in `@crossengin/tenant-lifecycle`:

1. **`states.ts`.** Seven states (trial, active, past_due, suspended, archived, pending_deletion, deleted). `TENANT_LIFECYCLE_TRANSITIONS` defines the allowed graph. `READ_ONLY_STATES` = {suspended, archived, pending_deletion} (blocks writes, allows reads). `TERMINAL_STATES` = {deleted} (blocks reads too). `RESTORABLE_STATES` = {suspended, archived, pending_deletion}.

2. **`actions.ts`.** Seven LifecycleActions (activate, suspend, restore, archive, schedule_deletion, cancel_deletion, execute_deletion) × 8 triggers (customer_request, billing_failure, compliance_directive, abuse_report, security_incident, scheduled_policy, platform_admin, support_escalation). `LifecycleEvent` enforces fromState ≠ toState, action↔toState consistency, actorUserId XOR actorSystemId, protected triggers need incident reference, execute_deletion always requires four-eyes (approver ≠ actor), suspend/schedule_deletion must notify customer.

3. **`grace-periods.ts`.** Five grace kinds: billing_grace (1..60d, default 14d), suspension_grace (7..90d, default 30d), archive_grace (30..365d, default 90d), deletion_grace (14..90d, default 30d), appeal_window (3..60d, default 14d). Each kind pairs with a specific fromState. `GracePeriod` enforces durationDays matches expiresAt − startedAt, customer extensions must push expiresAt later (not earlier), cancellation needs reason.

4. **`gdpr-deletion.ts`.** Six GDPR legal bases (article_17_right_to_erasure, article_21_objection_to_processing, data_subject_request, consent_withdrawn, contract_terminated, no_lawful_basis_remaining) × 6 statuses × 6 retention obligations × 5 verification methods. `GdprDeletionRequest` enforces deadlineAt ≤ submittedAt + 3 months (Article 12(3) cap), completion sha256 + before-deadline, verified status needs verifiedBy + method, retention obligations beyond 'none' require retainedDataCategories, retained categories require an obligation.

5. **`exports.ts`.** Five formats (json, ndjson, csv, parquet, sql_dump) × 5 triggers × 6 statuses. `TenantDataExport` enforces PHI exports cannot use customer_request alone (require regulatory_subpoena or pre_deletion_archive), ready_for_download requires sha256 + sizeBytes + storage URI, download window 24h..30d, downloadCount ≤ maxDownloads, expired requires purgedAt. Helper: `isExportDownloadable`, `shouldPurge`.

6. **`tombstones.ts`.** Five TombstoneKinds (tenant_deletion, user_deletion, data_subject_erasure, scheduled_purge, abandoned_export_purge) × 4 anchor kinds (internal_audit_log, trillian_log, blockchain_anchor, rfc3161_timestamp). `tomb_*` id pattern. `TombstoneRecord` enforces four-eyes (executor ≠ approver), data_subject_erasure requires relatedDeletionRequestId, tenant_deletion requires non-empty scope, rowCount > 0 requires tables in scope, retained reason requires retained data reference.

Four meta-schema tables (all RLS): `META_TENANT_LIFECYCLE_EVENTS`, `META_GDPR_DELETION_REQUESTS`, `META_TENANT_DATA_EXPORTS`, `META_TENANT_TOMBSTONES`.

## Alternatives considered

- **Option A:** Soft-delete only — mark deleted=true but keep data.
  - **Pros:** Simple. Reversible forever.
  - **Cons:** Doesn't satisfy GDPR Article 17. Doesn't reduce storage cost.
  - **Why not:** Right to erasure is a hard regulatory requirement.

- **Option B:** Immediate hard-delete on request.
  - **Pros:** Maximum compliance.
  - **Cons:** No grace window for mistakes. Tenants who change their mind 5 minutes later have no recovery.
  - **Why not:** 30-day grace is industry-standard balance; GDPR doesn't require immediate deletion (1-month deadline, 3 with extension).

- **Option C:** No tombstones — once deleted, no record.
  - **Pros:** Maximum data minimization.
  - **Cons:** Cannot prove deletion to a regulator without a permanent record. Cannot detect re-creation of a deleted entity.
  - **Why not:** Tombstone records are the audit proof; their content is anonymized (no PII), only metadata.

- **Option D:** Single tombstone kind for all deletions.
  - **Pros:** Smaller schema.
  - **Cons:** Different categories have different obligations: GDPR erasure, tenant termination, scheduled purge, abandoned exports. Kinds disambiguate retention and legal-hold behavior.
  - **Why not:** Differentiation needed for compliance accounting.

## Consequences

- **Positive.** Tenant exit is contractual, reversible up to a point, and ends with cryptographic proof. GDPR Article 17 is satisfied. Retention obligations are explicit (not implicit). Tombstones survive primary-data destruction permanently.
- **Negative.** Many states, transitions, and timestamp invariants. Customer-facing UX must explain grace periods clearly to avoid confusion.
- **Neutral.** Grace period bounds are per-kind; operations can tune within bounds.
- **Reversibility.** Tenant deletion is not reversible past the grace window. The schema makes this contractually clear; customer comms must reinforce it.

## Implementation notes

- **State graph.** `canTransitionLifecycle()` exposes the transition graph. Some transitions look unusual but are intentional: archived → active (restore from archive), pending_deletion → archived (cancel deletion), failed → running (retry) absent here, archived → pending_deletion (defer to delete after archive).
- **Four-eyes on execute_deletion.** Always required regardless of trigger. `actionRequiresFourEyes()` encodes the policy: execute_deletion always, archive with compliance_directive, schedule_deletion with platform_admin (admin can't unilaterally schedule deletion).
- **Customer notification.** suspend and schedule_deletion must notify (channel ≠ 'none'). The notification timestamp records when the customer was informed.
- **Retention beyond GDPR.** Tax/medical/AML obligations override Article 17 for the relevant data categories. `retainedDataCategories` enumerates what's kept; the rest is erased.
- **Export PHI restriction.** Customer-driven PHI exports forbidden — they could be a side-channel for unauthorized disclosure. PHI exports require regulatory_subpoena (with legal review) or pre_deletion_archive (operational, not user-driven).
- **Tombstone anchoring.** Multiple anchors per tombstone (internal audit log + RFC 3161 timestamp + optionally blockchain). `isCryptographicallyAnchored()` returns true if at least one is trillian / blockchain / rfc3161 (not just internal audit log).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Legal-hold interaction — does an active LH block scheduled deletion entirely or pause it | _pending_ | Phase 2 |
| Re-onboarding after deletion — same tenant id reused? new id? | _pending_ | Phase 2 |
| Customer-facing language for tombstones (what we tell the deleted tenant) | _pending_ | Phase 2 |
| Cross-region purge coordination — how do we confirm all 8 regions purged | _pending_ | Phase 3 |

## References

- GDPR Article 17 (right to erasure), Article 12(3) (response deadlines), Article 20 (data portability).
- HIPAA 45 CFR 164.530(j) (record retention).
- ADR-0028 (migration and onboarding) — the inverse.
- ADR-0035 (audit and forensics) — legal holds and tombstones overlap with forensic evidence.
- `packages/tenant-lifecycle/src/` for the zod schemas and helpers.
