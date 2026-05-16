# ADR-0040: Access reviews and periodic attestations

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0004 (auth), ADR-0007 (compliance packs), ADR-0008 (audit), ADR-0035 (forensics), ADR-0037 (incident response), ADR-0038 (SSO), ADR-0039 (notifications) |

## Context

`@crossengin/auth` (ADR-0004) gives us **what an authenticated principal is allowed to do**; `@crossengin/sso` (ADR-0038) gives us **how they authenticated**; `@crossengin/notifications` (ADR-0039) gives us **how we tell them about it**. What we still lack is the SOC 2 / ISO 27001 / HIPAA loop that says: **"prove, on a recurring schedule, that those grants are still appropriate."**

Every regulated buyer in our target families demands this and most auditors fail an attestation when it's missing or done by spreadsheet:

- **SOC 2 Type 2** — CC6.1 (logical access controls), CC6.2 (new access provisioned, terminated access revoked), CC6.3 (periodic review of access).
- **ISO 27001:2022** — A.5.18 (access rights), A.5.15 (access control), A.9.2.5 (review of user access rights).
- **HIPAA Security Rule** — §164.308(a)(3)(ii)(B) Workforce Clearance Procedure, §164.308(a)(4)(ii)(C) Access Establishment and Modification.
- **PCI DSS v4** — 7.2.4 (review user accounts ≥ semi-annually), 7.2.5 (review service accounts), 7.2.6 (least-privilege enforcement).
- **21 CFR Part 11** (FDA) — §11.10(d), §11.10(g) periodic re-validation of e-signature holders.
- **GDPR Article 32(4)** — only authorised persons access data; review who's authorised.

The threat model is concrete: reviewers rubber-stamping ("looks fine") to clear their queue; admins reviewing their own grants; "auto-revoked" sweeps that actually mean "nobody got around to it" with no audit trail; exceptions that have no expiry; emergency break-glass access that becomes permanent; auditor wants evidence and we hand them a CSV that the customer compiled manually two weeks before audit.

This ADR establishes the contract types for periodic access-review campaigns with strong attestation, four-eyes enforcement, exception lifecycle, and per-framework evidence aggregation. The contract is pure — it does not run anything. A Phase 2 service consumes these types to drive the campaign loop (open campaign → enumerate items → assign reviewers → collect decisions → escalate → auto-revoke → seal evidence).

## Decision

Access-reviews contract has **seven modules** in `@crossengin/access-reviews`:

1. **`scope.ts`.** Eight scope kinds (all_users_with_role, specific_principals, all_tenant_admins, custom_predicate, mfa_status_in, last_login_older_than, external_users_only, service_accounts_only) as discriminated union. Five principal types (user, service_account, ai_architect, system, external_partner). Seven grant kinds (role, permission, resource_access, tenant_membership, field_permission, api_key_scope, marketplace_pack_grant). `principalMatchesScope(scope, principal, now)` is the deterministic scope-resolution helper. `isHighRiskPrincipal(principal, now, staleLoginDays)` returns true for no-MFA, SMS-only-MFA, never-logged-in, or stale-login principals — used to prioritize within a campaign queue.

2. **`campaigns.ts`.** Eight frequencies (one_time, monthly, quarterly, semi_annual, annual, sox_quarterly, post_incident, ad_hoc) × seven lifecycle statuses (draft → scheduled → in_progress → in_remediation → completed → archived; cancelled is terminal from any non-terminal state) with `CAMPAIGN_TRANSITIONS` map. Five reviewer-assignment policies (principal_manager, specific_user, role_based, ai_suggested_human_confirmed, round_robin_pool). Four auto-revoke policies (auto_revoke_on_deadline, escalate_to_manager, default_keep, default_revoke). Seven compliance frameworks (soc2_type2, iso27001, hipaa_security_rule, pci_dss_v4, gdpr_article_32, cfr_21_part_11, custom). `ReviewerAssignment` enforces policy-required fields and unique reviewer ids across pool + escalation chain. `AccessReviewCampaign` enforces: deadline > scheduledStart; post_incident requires relatedIncidentId; completed needs completedAt; cancelled needs cancelledReason; counts cannot exceed totalItems; completed campaign must have all items resolved. Helpers: `computeCampaignProgress`, `isPastDeadline`, `isPastGracePeriod`, `computeNextScheduledStart` (handles 91-day quarter, 365-day annual, etc.).

3. **`items.ts`.** Eight item statuses (pending → in_review → decided/escalated/exception_pending → ...) with `REVIEW_ITEM_TRANSITIONS` map. Three reviewer kinds (human_user, ai_suggested_pending_human, system_automated). Four risk levels (low, medium, high, critical) with `computeRiskLevel` scoring service-accounts, external-partner principals, role/tenant-membership grants, no-MFA, never-used grants, and stale grants. `AccessReviewItem` enforces: four-eyes (reviewer ≠ principal); decided requires decisionId + decidedAt; auto_revoked requires autoRevokedAt + autoRevokeReason; in_review / escalated require currentReviewer. `assignReviewer` is the only safe transition into in_review — it throws on four-eyes violation + invalid transitions. `shouldEscalate` and `isItemOverdue` are deterministic time-based predicates for the campaign worker.

4. **`decisions.ts`.** Five decision kinds (keep, revoke, time_bound_extend, modify_grant, defer_to_next_campaign). Fourteen decision reasons partitioned into `REASONS_REQUIRING_REVOKE` (security_concern_revoked, departure_revoked, duplicate_access_revoked, unused_access_revoked) and `REASONS_REQUIRING_KEEP` (role_appropriate, last_login_recent, business_justification_attested, compliance_attestation, manager_attestation, regulatory_requirement). Five attestation kinds (click_through_acknowledgement, typed_attestation_phrase, e_signature_digital, qualified_e_signature, two_person_attestation) with `STRONG_ATTESTATION_KINDS` set (last three). `DecisionAttestation` enforces: e-sig kinds require signatureSha256 + signingKeyFingerprint; two_person_attestation requires distinct coAttestingUserId + coAttestedAt. `AccessReviewDecision` enforces: decidedByUserId === attestation.attestedByUserId; kind ↔ reason consistency (no keep+security_concern; no revoke+role_appropriate); time_bound_extend needs future date; modify_grant needs modifiedGrantAttributes; appliedAt ≥ decidedAt; applicationFailedAt requires applicationFailureReason. `requiresStrongAttestation(kind, reason)` returns true for regulatory_requirement keeps, time_bound_extends, and security-concern revokes — so the Phase 2 UI can gate weak attestations.

5. **`exceptions.ts`.** Six statuses (requested → approved/rejected → expired/revoked_early/superseded) with state machine. Eight reasons with `MAX_EXCEPTION_DURATION_DAYS` map (emergency_break_glass=7, vendor_support_requirement=30, contractor_renewal_pending=90, dual_role_business_need=180, migration_in_progress=180, regulatory_exemption=365, system_account_required=365, audit_trail_required=730). `RESTRICTED_EXCEPTION_REASONS` flags emergency + regulatory for elevated scrutiny. `AccessReviewException` enforces: requestedExpiresAt > requestedAt; duration ≤ reason cap; four-eyes (approver ≠ requester); approved requires grantedExpiresAt; rejected requires rejectedReason; emergency_break_glass approval requires quarterly re-attestation. Helpers: `isExceptionExpired`, `daysRemainingOnException`, `requiresReattestation` (90-day default interval), `isRestrictedReason`.

6. **`templates.ts`.** Four-state template lifecycle (draft → published → deprecated → retired) with four-eyes enforcement (publishedBy ≠ createdBy). Per-framework defaults — SOC 2 Type 2 must be quarterly or annual; HIPAA Security Rule must be semi_annual or annual (per §164.308 recommended cadence); SOX must be sox_quarterly. Seven `BUILTIN_TEMPLATE_SEEDS` so the Phase 2 seeder ships ready-to-use defaults (soc2.quarterly.privileged_access, soc2.annual.full_workforce, iso27001.a9.2.5.annual, hipaa.workforce.semi_annual, pci.dss.v4.req7.quarterly, cfr21_part11.quarterly.signature_holders, gdpr.article32.annual.data_access). `isTemplateUsable` returns true for published + recently-deprecated (within 180-day grace) — so in-flight campaigns can finish on a soon-to-retire template without breaking.

7. **`evidence.ts`.** Six evidence statuses (draft → compiled → sealed → submitted_to_auditor → accepted_by_auditor / rejected_by_auditor; rejected can transition back to draft). `CONTROL_MAPPINGS` declares the framework→control codes the evidence must reference (SOC 2: CC6.1/CC6.2/CC6.3/CC6.7; ISO 27001: A.5.18/A.5.15/A.9.2.5; HIPAA: 164.308(a)(3)(ii)(B)/164.308(a)(4)(ii)(C)/164.312(a)(1); PCI: 7.2.4/7.2.5/7.2.6; GDPR: Art.32.1.b/Art.32.4; 21 CFR Part 11: 11.10(d)/11.10(g)/11.10(j)). `computeCampaignEvidenceMetrics` returns `{ completionRate, keepRate, revokeRate, autoRevokeRate, exceptionRate, strongAttestationRate, overdueRate }` — the metrics auditors actually look at. `AccessReviewEvidence` enforces: periodEnd > periodStart; sealed status requires sealedAt + sealedSha256 + storageUri (anchors content-addressed); submitted requires submittedToAuditorId; rejected requires rejectedReason; controlMappings must include ≥ 1 framework-expected control. `sealEvidence` transitions compiled → sealed by computing sha256 + storage URI.

Six meta-schema tables wired into kernel:

- **META_ACCESS_REVIEW_TEMPLATES** — nullable tenant_id (platform templates) with custom RLS `tenant_id IS NULL OR …`. Unique on (tenant_id, template_key, version).
- **META_ACCESS_REVIEW_CAMPAIGNS** — campaign records with RESTRICT FK to templates so deletes are blocked.
- **META_ACCESS_REVIEW_ITEMS** — CASCADE FK to campaigns; per-grant items with assigned reviewer state.
- **META_ACCESS_REVIEW_DECISIONS** — CASCADE FK to items + RESTRICT FK to campaigns; full attestation columns including ip_address, user_agent, signature/co-attestor fingerprints; supersedesDecisionId chains supersessions.
- **META_ACCESS_REVIEW_EXCEPTIONS** — CASCADE FK to items + RESTRICT FK to campaigns; quarterly reattestation tracking.
- **META_ACCESS_REVIEW_EVIDENCE** — period-aggregated metrics + sealed sha256 + auditor handoff lifecycle.

All FK indexes on user-reference columns (created_by, decided_by_user_id, approved_by_user_id, etc.) following the prior meta-schema grooming convention.

## Alternatives considered

- **Option A:** Build a single `Attestation` record without separate Campaign + Item + Decision tables.
  - **Pros:** Simpler schema.
  - **Cons:** Loses lineage. Auditors ask "show me everyone who attested to this grant over the last 4 quarters" — that's a four-table join (campaigns → items → decisions → attestations) with the current model, which is what they want for evidence packs. Flattening makes that query impossible.
  - **Why not:** The relational structure mirrors how auditors think about the evidence.

- **Option B:** Defer exception management to a separate package.
  - **Pros:** Smaller surface here.
  - **Cons:** Exceptions are inseparable from the campaign loop — a reviewer reviewing a grant might issue an exception in the same workflow. Splitting creates a cross-package dependency for the most common path.
  - **Why not:** Exceptions live in `@crossengin/access-reviews` because they share the campaign + item lifecycle.

- **Option C:** Skip evidence aggregation; let consumers compile it.
  - **Pros:** Smaller surface.
  - **Cons:** Evidence packaging is the whole point of access reviews. Without sealed sha256-anchored evidence with framework control mappings, the customer can't hand it to their SOC 2 auditor; they'd have to re-compute the metrics manually, defeating the purpose.
  - **Why not:** `evidence.ts` is the highest-leverage module — it's what differentiates "we track reviews" from "we ship auditor-ready evidence."

- **Option D:** Allow reviewers to review their own grants if they self-attest.
  - **Pros:** Simpler workflow for solo founders / small tenants.
  - **Cons:** Four-eyes is the entire control point. Auditors will fail attestations where the principal is also the approver. The schema-level rejection is the safeguard.
  - **Why not:** Four-eyes is non-negotiable. Solo-tenant case is solved via the platform-wide reviewer assignment (`fallbackReviewerUserId` can be a platform-admin).

- **Option E:** Use a generic state-machine library instead of inlined transitions.
  - **Pros:** Less custom code.
  - **Cons:** Phase 1 is contract-types only; introducing a runtime library before we need it bloats the dep graph. The inlined `_TRANSITIONS` maps + `canTransition*` helpers are 5 lines each and easy to audit.
  - **Why not:** Defer until the workflow-engine package needs it broadly.

- **Option F:** Skip `BUILTIN_TEMPLATE_SEEDS` — let tenants build templates from scratch.
  - **Pros:** Smaller surface.
  - **Cons:** Most tenants will use the seven SOC 2 / ISO 27001 / HIPAA / PCI / GDPR / 21 CFR / SOX templates verbatim. Shipping the seeds lets Phase 2 ship out-of-the-box compliance coverage without the customer designing controls themselves.

## Consequences

- **Closes the SOC 2 access-control evidence loop.** Combined with `@crossengin/auth` and `@crossengin/sso`, we now cover provisioning, authentication, and periodic review with a single contract chain.
- **Forces four-eyes at the schema layer.** Reviewers cannot self-attest; approvers cannot self-request exceptions; template publishers cannot self-approve. Three independent four-eyes refinements.
- **Anchors evidence cryptographically.** Sealed evidence requires sha256 + storage URI; auditor handoff is auditable; rejected evidence can be re-drafted with full lineage via supersession chains.
- **Per-framework correctness.** SOC 2 quarterly defaults are quarterly, HIPAA workforce defaults are semi-annual or annual — wrong combinations fail schema validation, not auditor review.
- **Notifications integration.** Each campaign + item + escalation + exception expiration is a `NotificationDispatch` from `@crossengin/notifications` waiting to happen. The Phase 2 service composes the two.

## Open questions

- **Q1:** Should we model **delegated reviewers** (Alice OOO → Bob reviews Alice's queue for a window)?
  - _Current direction:_ Defer. The escalation chain partially covers this; a true delegation feature would extend `ReviewerAssignment` with a `temporaryDelegations[]` field. Wait for buyer demand.
- **Q2:** AI-suggested decisions — should they be a first-class decision kind or just a reviewer kind?
  - _Current direction:_ `ReviewerKind = "ai_suggested_pending_human"` makes AI a reviewer that requires human confirmation, not a decision kind. Decisions are always human-attested. This matches ADR-0025 (AI Architect safety) — AI proposes, humans dispose.
- **Q3:** Per-item decisions vs bulk "select all keep" actions?
  - _Current direction:_ Bulk operations are a UI concern; at the contract layer every decision is per-item with its own attestation. Bulk = N separate `Decision` records with shared timestamp.
- **Q4:** Cross-campaign exception inheritance (e.g., emergency-access granted in Q1 carries over to Q2 if active)?
  - _Current direction:_ No. Each campaign re-opens all in-scope grants. Active exceptions show up as `exception_pending` items; the reviewer must explicitly re-attest. This is what auditors want.
- **Q5:** SCIM provisioning records → access review evidence?
  - _Current direction:_ Possible in Phase 2: a `provenance` field on `ReviewGrant` could cite the SCIM provisioning record from `@crossengin/sso`. Defer the contract change until concrete demand.

## References

- **SOC 2 Type 2** — Trust Services Criteria CC6.1, CC6.2, CC6.3, CC6.7
- **ISO/IEC 27001:2022** — A.5.18 (Access rights), A.5.15 (Access control), A.9.2.5 (Review of user access rights)
- **HIPAA Security Rule** — 45 CFR §164.308(a)(3)(ii)(B), §164.308(a)(4)(ii)(C), §164.312(a)(1)
- **PCI DSS v4.0** — Requirements 7.2.4, 7.2.5, 7.2.6
- **21 CFR Part 11** (FDA) — §11.10(d), §11.10(g), §11.10(j)
- **GDPR** — Article 32(1)(b), Article 32(4)
- **NIST SP 800-53 Rev. 5** — AC-2, AC-6, IA-4
- ADR-0004 (auth/RBAC), ADR-0007 (compliance packs), ADR-0008 (audit), ADR-0035 (forensics), ADR-0037 (incident response), ADR-0038 (SSO), ADR-0039 (notifications)
