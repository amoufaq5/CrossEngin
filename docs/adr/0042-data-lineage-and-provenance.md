# ADR-0042: Data lineage and provenance

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0007 (compliance packs), ADR-0008 (audit), ADR-0009 (security/classification), ADR-0013 (reporting), ADR-0014 (files), ADR-0029 (ML training), ADR-0036 (tenant lifecycle), ADR-0040 (access reviews), ADR-0041 (workflow engine) |

## Context

`@crossengin/tenant-lifecycle` covered **GDPR Article 17** (right to erasure) — a data subject asks to be deleted and we follow the chain to find what to delete. The mirror obligation — **GDPR Article 15** (right of access) — is the customer-facing question we cannot answer with existing packages: "show me what derived data exists from my data across your platform." Plus its peers in other jurisdictions (CCPA right-to-know, LGPD Article 18, PIPEDA Principle 9, UAE Data Protection Law).

Without a unified lineage graph, derived data is invisible:

- `@crossengin/ml-training` has datasets + models + evaluations — but nothing tying the dataset rows back to the source tables.
- `@crossengin/reporting` has report runs + scheduled exports — but nothing tying a report column back to the upstream join.
- `@crossengin/search` has search index documents — but nothing tying an index document back to its source row.
- `@crossengin/files` has uploaded artifacts — but nothing tying a generated PDF back to the database query.
- `@crossengin/ai-providers` has AI call records — but nothing tying the AI output back to the prompt's source data.

A subject access request today would require manually grepping six packages for "any reference to alice@example.com" and praying we caught everything. That fails any GDPR readiness audit.

There's also a second, separate gap: **classification propagation**. ADR-0009 defined data classifications (public/internal/confidential/pii_personal/phi_protected/regulated_financial). But there's no enforcement that a derived view of a PHI table is also PHI, or that an aggregation result drops below k-anonymity threshold N before being marked public. Misclassified derived data is the most common HIPAA/GDPR leak path.

This ADR establishes the contract types for a lineage graph, provenance records, data subject mapping, subject access requests, classification propagation, and retention policy. It does **not** include the actual graph database, the SQL parser that infers lineage from queries, the column-level lineage extractor, or the SAR bundle compiler — those are Phase 2 build artifacts.

## Decision

Data-lineage contract has **six modules** in `@crossengin/data-lineage`:

1. **`nodes.ts`.** Fourteen node kinds covering the data-platform graph: source_table, derived_table, dataset, ml_model, ml_evaluation, report, dashboard, tenant_export, ai_call_output, search_index_document, materialized_view, file_artifact, aggregation_result, redacted_view. Six data classifications with `CLASSIFICATION_SENSITIVITY` ordering map (public=0 < internal < confidential < pii_personal < regulated_financial < phi_protected=5) and `REGULATED_CLASSIFICATIONS` set (last three). Five-state node lifecycle (active → frozen → archived → purged → tombstoned) with `NODE_LIFECYCLE_TRANSITIONS` map. `LineageNode` enforces: either createdByUserId or createdBySystem set; frozen requires frozenAt + frozenSha256 (content-addressed snapshot); purged requires purgedAt; tombstoned requires tombstonedAt; **aggregation_result requires minimumKAnonymity** (k-anonymity floor); **redacted_view classification must downgrade from pii_personal** (cannot stay pii_personal — that would defeat the redaction); tenant_export requires tenantId. Helpers: `isRegulatedNode`, `isHigherSensitivity`, `maxSensitivityOf` (returns highest of N classifications), `isWithinRetention`.

2. **`edges.ts`.** Ten edge kinds describing how data flows: derived_from, joined_with, aggregated_from, transformed_by, redacted_from, anonymized_from, referenced_by, copied_to, predicted_by, trained_on. `CLASSIFICATION_DOWNGRADING_EDGES` set restricts which edge kinds may produce a lower-classification target (redacted_from, anonymized_from, aggregated_from). `LineageEdge` enforces: no self-edges; either user or system actor set; **classification downgrade only via downgrading edge kinds** (non-downgrading edges cannot lower target classification below source); redacted_from requires non-empty redactionRules; anonymized_from + aggregated_from require kAnonymityAchieved; **anonymized_from requires k ≥ 5** to downgrade. The core helper `propagateClassification({ edgeKind, inputClassifications, kAnonymityAchieved, allColumnsRedacted })` returns the deterministic target classification — pii_personal flows through redacted_from to internal (if all columns redacted); pii_personal flows through anonymized_from to public (if k ≥ 5); phi_protected flows through aggregated_from to internal (if k ≥ 11, HIPAA Safe Harbor). `isValidDowngrade` is the pre-write guard that Phase 2 runtimes call before persisting edges.

3. **`provenance.ts`.** Append-only audit of every transformation. Fifteen operation kinds (ingest, transform, join, aggregate, redact, anonymize, train, evaluate, predict, export, query, index, ai_inference, copy_to_region, tombstone). `REGULATED_OPERATIONS` flags the five that always need audit reproducibility (redact, anonymize, export, ai_inference, tombstone). Four outcomes (succeeded, partial_succeeded, failed, rolled_back). `ProvenanceRecord` enforces: either actor user or system set; **ingest cannot have inputNodeIds** (it's the entry point); **non-ingest non-tombstone operations require ≥ 1 inputNodeId**; failed needs errorCode + errorMessage; rolled_back needs rolledBackAt + rolledBackReason; **regulated operations require operationParametersSha256** for reproducibility; same node cannot be both input and output of the same provenance record. Cross-package linking via relatedWorkflowInstanceId / relatedActivityId / relatedJobRunId. Helpers: `isProvenanceImmutable`, `requiresRegulatoryAudit`, `aggregateProvenance` (counts by outcome + operation + regulated count + total rows read/written).

4. **`subjects.ts`.** Data subject registry + SAR (subject access request) lifecycle. Ten identifier kinds (email_address, user_id, external_user_id, patient_mrn, national_id, tax_id, phone_e164, device_fingerprint, ip_address, pseudonymous_id) with `STRONG_SUBJECT_IDENTIFIERS` set (first five — those that can uniquely identify a person). Seven request statuses (submitted → verified → in_progress → partial_complete / complete / rejected / deferred) with transition map. Six legal bases (gdpr_article_15, ccpa_right_to_know, lgpd_article_18, pipeda_principle_9, uae_data_protection_law, custom_contract_obligation) with `SUBJECT_DEADLINE_DAYS` map enforcing per-regulation timelines (GDPR=30, CCPA=45, LGPD=15, PIPEDA=30, UAE=30). Five delivery formats (json, ndjson, csv, pdf_report, machine_readable_archive). `DataSubject` enforces verified requires verifiedAt + verificationMethod; identifier kinds unique across primary + alternates; lastSeenAt ≥ firstSeenAt. `SubjectNodeOccurrence` tracks "this subject appears in this node" with edge-trail for derived data. `SubjectAccessRequest` enforces **deadlineAt ≤ submittedAt + legal-basis deadline** (can't promise longer than the law allows); status-specific required-field invariants; **complete requires bundle sha256 + storage URI + encryption key fingerprint** (sealed evidence). `computeDeadline(submittedAt, legalBasis)` is the deterministic deadline calculator.

5. **`graph.ts`.** Pure graph traversal — no I/O, no globals, takes (nodes, edges) and returns deterministic answers. `buildLineageGraph` indexes nodes by id and edges by source/target for O(1) lookup. `findAncestors` / `findDescendants` are BFS traversals capped at maxDepth=50 to prevent runaway. `findShortestPath` returns the BFS shortest path or null. `hasCycle` detects directed cycles via DFS three-color marking (white/gray/black). `findRootNodes` / `findLeafNodes` for surface-area inventory. `computeImpactedDescendants` answers "if these nodes change, what downstream needs invalidation?". The headline helper: `computeSubjectImpact(graph, subjectNodeIds)` returns `{ directNodes, derivedNodes, totalNodeCount, regulatedNodeCount }` — this is what feeds the SAR bundle compiler.

6. **`compliance.ts`.** Retention policies + Article 15 evidence packs. Six retention bases (tenant_policy, regulatory_minimum, customer_request, indefinite_legal_hold, contract_duration, consent_grant_period). `REGULATORY_RETENTION_MINIMUMS_DAYS` map (HIPAA PHI=2190 / 6yr; SOX financial=2555 / 7yr; PCI=365 / 1yr; 21 CFR Part 11 records=3650 / 10yr; FDA clinical trial=9125 / 25yr). `RetentionPolicy` enforces: maxRetentionDays ≥ minRetentionDays; regulatory_minimum requires regulatoryReference (citation); indefinite_legal_hold must have null maximumRetentionDays + blocksAutoDeletion=true; disabled policies require four-eyes (disabledByUserId ≠ enabledByUserId). Four evidence pack statuses (compiling → sealed → delivered / expired). `Article15EvidencePack` enforces sealed/delivered require sealedSha256 + storageUri + encryptionKeyFingerprint; expiresAt > sealedAt; redactedPiiFields and redactedReasons must have equal length. The integration point: `decideRetention({ node, applicablePolicies, now }) → { canPurge, reason, blockingPolicyId, effectiveRetentionUntil }` — a single function the Phase 2 purger calls per candidate node.

Six meta-schema tables wired into kernel:

- **META_LINEAGE_NODES** — nullable tenant_id (platform nodes) with custom RLS. 14-kind check, 6-classification check, 5-status check.
- **META_LINEAGE_EDGES** — nullable tenant_id with custom RLS. RESTRICT FK on source/target nodes (preserve lineage through node tombstones).
- **META_PROVENANCE_RECORDS** — nullable tenant_id with custom RLS. 15-operation check, 4-outcome check. Append-only (no UPDATEs in Phase 2 runtime).
- **META_DATA_SUBJECTS** — RLS tenant-scoped. Unique on (tenant_id, primary_identifier_kind, primary_identifier_sha256). SHA-256 of identifier — never the plaintext.
- **META_SUBJECT_NODE_OCCURRENCES** — CASCADE FK on subjects + nodes. Unique on (subject_id, node_id).
- **META_SUBJECT_ACCESS_REQUESTS** — RESTRICT FK on subjects. 6-legal-basis check, 7-status check, 5-delivery-format check.

## Alternatives considered

- **Option A:** Compute lineage on-demand from query parser (no stored graph).
  - **Pros:** No storage overhead.
  - **Cons:** SAR responses become slow (parse N queries per request); cross-tool lineage (Postgres → search index → AI prompt) requires N parsers; rolled-back operations leave no trail. Regulators want a persistent audit trail, not a derived view.
  - **Why not:** Persistent lineage is the customer-facing audit artifact.

- **Option B:** One mega-package combining lineage + GDPR deletion + retention.
  - **Pros:** Tighter integration.
  - **Cons:** Deletion is already in tenant-lifecycle (Article 17). Splitting Article 15 (access) into a separate package mirrors the GDPR text structure and keeps each package focused.
  - **Why not:** Article 17 and Article 15 are conceptually distinct (delete vs reveal); separating them clarifies which schema handles which obligation.

- **Option C:** Store subject identifiers in plaintext.
  - **Pros:** Easier debugging.
  - **Cons:** A breach of `META_DATA_SUBJECTS` would expose every email/MRN/SSN at once — exactly the catastrophe GDPR Article 32 wants prevented. Storing sha256 means a breach of this table leaks only opaque hashes; the actual identifiers remain in the source systems with their own RLS + encryption.
  - **Why not:** Identifier hashing is non-negotiable for a privacy-pivot table.

- **Option D:** Allow classification downgrade via any edge kind with admin override.
  - **Pros:** Flexibility.
  - **Cons:** "Admin override" is the most-exploited bypass in compliance systems. The schema-level invariant that pii → public requires an `anonymized_from` edge with k≥5 is what makes the audit trail credible.
  - **Why not:** Schema-level enforcement is the entire point.

- **Option E:** Skip cycle detection in `graph.ts`.
  - **Pros:** Smaller surface.
  - **Cons:** Self-joins, recursive views, and certain materialized-view patterns can create cycles. `hasCycle` lets pre-commit hooks reject ingest that would introduce a cycle, before it breaks BFS traversals downstream.
  - **Why not:** Cheap, defensive, prevents foot-guns.

- **Option F:** Use a graph database (Neo4j / DGraph) instead of relational tables.
  - **Pros:** Native graph queries.
  - **Cons:** Requires Phase 2 to depend on a new infra component. The relational model (nodes + edges as two tables with FK) is well-served by Postgres + RLS for tenant isolation, which we already have. Graph traversals (BFS / DFS) execute in app code today; a future runtime can materialize them via PG recursive CTEs if needed.
  - **Why not:** Postgres is enough; defer graph-DB until the workload demands it.

## Consequences

- **Closes the GDPR / CCPA / LGPD / PIPEDA / UAE access-request loop.** Combined with tenant-lifecycle's deletion (Article 17) and access-reviews' periodic attestation (CC6.3), the regulated-data compliance triangle is complete.
- **Forces classification correctness at the schema layer.** Misconfigured derivations (pii flowing through a non-downgrading edge to a "public" target) fail validation before they ship.
- **Anchors evidence cryptographically.** Article 15 packs require sealed sha256 + encryption key fingerprint — auditors and data subjects both can verify what they received.
- **Per-package linking is bidirectional.** Provenance records cite workflowInstanceId, activityId, jobRunId — any downstream investigation ("why did this AI call exist?") can chain through the engine to find the originating user action.
- **Retention policies are first-class.** Phase 2 purgers gate every delete through `decideRetention`. HIPAA's 6-year minimum cannot be bypassed by a tenant-level "purge everything" policy.

## Open questions

- **Q1:** Column-level lineage vs row-level vs node-level — the contract supports columnsContributing/columnsConsumed but Phase 2 query extraction has not been specified.
  - _Current direction:_ Node-level is mandatory; column-level is best-effort from the SQL parser; row-level is out of scope.
- **Q2:** Subject identifier matching — fuzzy or exact?
  - _Current direction:_ Exact hash match only. Fuzzy matching ("Alice Smith" / "A. Smith") is a separate Phase 3 concern with its own privacy implications.
- **Q3:** Cross-tenant lineage (Tenant A's export feeds Tenant B's ingest)?
  - _Current direction:_ Out of scope for v1. Each lineage subgraph is tenant-scoped or platform-wide (null tenantId for platform infrastructure nodes).
- **Q4:** Retroactive lineage — can we mine historical query logs to backfill nodes/edges?
  - _Current direction:_ Possible; provenance records with `actorSystemId: "backfill-job"` are valid. The Phase 2 backfill tool consumes audit logs + query logs from `observability` and `reporting`.
- **Q5:** Lineage for AI-generated outputs that don't trace cleanly to a single source (synthesis from N retrievals)?
  - _Current direction:_ `ai_call_output` node + N `derived_from` edges from each retrieval source. The AI prompt + context attribution work in `@crossengin/ai-providers` already records retrievals; the lineage extractor consumes them.

## References

- **GDPR** — Article 15 (Right of access), Article 32 (Security of processing)
- **CCPA** — Cal. Civ. Code §1798.100 (Right to know)
- **LGPD (Brazil)** — Lei nº 13.709, Article 18
- **PIPEDA (Canada)** — Principle 9 (Individual Access)
- **UAE Federal Decree-Law No. 45 of 2021** — Data Protection
- **HIPAA Safe Harbor** — 45 CFR §164.514(b)(2)(i) (de-identification standard, 18 identifiers)
- **k-anonymity (Sweeney, 2002)** — k-Anonymity: A Model for Protecting Privacy
- **NIST SP 800-188** — De-Identification of Personal Information
- ADR-0007, ADR-0008, ADR-0009, ADR-0013, ADR-0014, ADR-0029, ADR-0036, ADR-0040, ADR-0041
