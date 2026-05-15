# ADR-0035: Audit and forensics

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0008, ADR-0009, ADR-0012, ADR-0014, ADR-0036, ADR-0037 |

## Context

ADR-0008 defined the audit log: every operation, before/after diff, actor, rego decision trace. That's day-to-day audit. This ADR addresses the higher-stakes use cases beneath:

- **Tamper-evident logging.** Auditors need to verify that an old log record hasn't been silently modified. Hash-chained append-only logs (with periodic external anchoring) provide cryptographic proof of integrity.
- **Evidence handling.** When an incident, regulatory inquiry, or litigation surfaces, the platform must be able to seal logs, snapshots, files, and other artifacts into an evidence record that survives normal retention purging.
- **Chain of custody.** Every transfer of evidence between custodians needs a signed handoff. Custody chains must be verifiable end-to-end with sha256 checks that detect tampering.
- **Legal holds.** A subpoena or preservation letter freezes deletion across in-scope data. Holds must block retention-based purges while in effect, with explicit release ceremony.
- **E-discovery.** Production of evidence to opposing parties (or regulators) needs a defensible search-scope record, privileged-content exclusion, and a cryptographically-anchored production artifact.
- **Court-admissible attestations.** Some declarations need witness signatures, notarization, oath, or expert credentials. The schema must enforce these so a non-admissible attestation can't accidentally pass as admissible.

These are tier-3 problems — not every tenant encounters them — but when they do, getting it right matters enormously. A broken chain of custody invalidates evidence; a missed preservation order is sanctionable; a leaky e-discovery production is privilege waiver.

## Decision

Forensics contract has **six modules** in `@crossengin/forensics`:

1. **`tamper-evident-logs.ts`.** Seven log kinds (audit_event, access_event, data_change, config_change, security_event, deletion_event, approval_decision) × 3 hash algorithms (sha256, sha512, blake3). `ChainedLogEntry` (strict): sequenceNumber, payloadSha256, priorEntryHash, entryHash, signing key fingerprint, signature. `ChainedLogSchema` enforces sequence monotonicity + hash chain (`priorEntryHash` = previous `entryHash`) + entryHash ≠ priorEntryHash + non-decreasing recordedAt. `ChainCheckpoint` anchors the chain to an external timestamping authority. Helper: `verifyChainIntegrity()`.

2. **`evidence.ts`.** Ten EvidenceKinds (log_export, database_snapshot, file_artifact, network_capture, memory_dump, configuration_snapshot, screenshot, video_recording, witness_statement, expert_report) × 6 sensitivity levels (public, internal, confidential, phi_protected, attorney_client_privileged, national_security) × 5 provenance kinds. `EV-YYYY-NNNN` id pattern. Enforces sealed-after-collected + retention-after-collected + two-person integrity (collectedBy ≠ sealedBy) for human collection + cannot-destroy-under-legal-hold + attorney_client_privileged cannot use automated_collection.

3. **`chain-of-custody.ts`.** Nine CustodyActions (collected, transferred, accessed, analyzed, duplicated, redacted, exported_for_review, returned, destroyed) × 6 purposes. `COC-YYYY-NNNN` id pattern. `CustodyEntry` enforces verifiedSha256 = expectedSha256 (mismatch flags chain BROKEN) + first entry must be 'collected' + 'transferred' requires witness + witness must be third party + destroyed/duplicated need sealNumber. `CustodyChain` enforces single evidence id + chronological order + custody continuity.

4. **`legal-holds.ts`.** Seven HoldKinds (litigation, regulatory_inquiry, internal_investigation, tax_audit, merger_acquisition_diligence, subpoena, preservation_letter) × 5 statuses (draft / active / suspended / released / expired) × 6 scope kinds. `LH-YYYY-NNNN` id pattern. Active holds require custodianNotificationsSent=true. Released-by must differ from issued-by (separation of duties).

5. **`ediscovery.ts`.** Eight-status request lifecycle × 5 production formats (native, pdf_with_load_file, tiff_with_load_file, csv, json). `ED-YYYY-NNNN` id pattern. `SearchScope` enforces overbroad-scope-disallowed (must declare tenants / custodians / keywords). Delivered/complete require cryptographic productionSha256 + storage URI. Requesting party ≠ legal counsel (separation of party and counsel).

6. **`attestations.ts`.** Eight kinds (witness_to_collection, witness_to_transfer, expert_analysis, authenticity_certification, completeness_certification, non_alteration_oath, privilege_log_review, court_declaration) × 6 attestor roles × 5 signature kinds (platform_keypair, pgp_keypair, qualified_electronic_signature, wet_signature_scan, notarized). `ATT-YYYY-NNNN` id pattern. court_declaration / non_alteration_oath require isUnderOath + penaltyOfPerjuryAcknowledged + notarized-or-qualified signature. expert_analysis requires credential reference + independent (non-internal-employee) attestor.

Four meta-schema tables: `META_FORENSIC_EVIDENCE`, `META_CHAIN_OF_CUSTODY`, `META_LEGAL_HOLDS`, `META_EDISCOVERY_REQUESTS` (platform-wide; cross-tenant by design for legal counsel access).

## Alternatives considered

- **Option A:** Rely on the underlying database's audit features (PG audit extension).
  - **Pros:** Out of the box.
  - **Cons:** Doesn't address evidence handling, chain of custody, legal holds, e-discovery, attestations. Tamper-evidence requires application-layer hash chaining.
  - **Why not:** This ADR is about the layers above the audit log.

- **Option B:** Use a vendor like Datadog Audit or Logz.io for forensics.
  - **Pros:** Less to build.
  - **Cons:** Doesn't model legal holds or e-discovery production. Cross-vendor evidence portability poor.
  - **Why not:** Forensic data residency is sensitive; staying in-platform is the safer choice.

- **Option C:** Trillian or sigstore for the hash-chain backend.
  - **Pros:** Battle-tested, established cryptographic anchoring.
  - **Cons:** Operational complexity; needs careful integration.
  - **Why not:** We model the contract here; runtime can use trillian/sigstore or custom chains. `TombstoneAnchor.kind` includes `trillian_log` for this reason.

- **Option D:** No formal e-discovery contract — handle each case ad hoc.
  - **Pros:** Less code.
  - **Cons:** First subpoena in production becomes a fire drill. Defensible production scope is non-trivial.
  - **Why not:** Plan ahead. The contract makes production reproducible and reviewable.

## Consequences

- **Positive.** Tamper-evident logs detect silent modification. Evidence handling has explicit lifecycle + retention. Chain of custody is verifiable cryptographically. Legal holds block deletion. E-discovery production is defensible. Attestations gate court admissibility.
- **Negative.** Significant ceremony — chain-of-custody handoffs, witness requirements, four-eyes, notarization. Not all tenants will encounter this, but the contract carries cost for those who do.
- **Neutral.** Anchor kinds extensible (`AnchorKind` enum); we can add new external anchoring providers without schema changes.
- **Reversibility.** Schema changes possible early; once evidence records exist, changes need version-2 schemas.

## Implementation notes

- **Hash chaining.** `GENESIS_HASH = "0" * 64`. Every chain starts there. `verifyChainIntegrity()` is `O(n)` — walk the chain checking sequence + priorHash match.
- **Tamper detection.** `verifiedSha256 !== expectedSha256` in any custody entry is a chain-BROKEN signal. The schema rejects records with mismatch; runtime layer must alert P0.
- **Privilege handling.** `excludePrivilegedContent=true` is the default for `SearchScope`. attorney_client_privileged evidence cannot be exported through standard production; it goes through privilege-log workflow (separate record).
- **Attestation independence.** Authenticity / expert / completeness / court declarations cannot come from `internal_employee` attestors — independence requirement. External counsel, certified forensic examiners, notaries, or court-appointed masters only.
- **Notary stamp.** `notarized` signature kind requires `notaryStampReference`. The stamp itself lives in an external system (jurisdiction-specific); we record the reference.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Cross-jurisdiction enforcement — when a US notary stamp isn't enough for EU court | _pending_ | Phase 3 |
| Privilege log automation — assist counsel with classification | _pending_ | Phase 3 |
| Blockchain anchoring choice — public Ethereum vs permissioned | _pending_ | Phase 3 |
| Storage retention for tombstones (ADR-0036) vs forensic evidence — overlap, defer | _pending_ | Phase 2 |

## References

- ADR-0008 (RBAC, ABAC, and audit) — day-to-day audit feeds this layer.
- ADR-0009 (security model) — incident classification.
- ADR-0012 (compliance packs) — retention mandates from packs.
- ADR-0036 (tenant lifecycle) — tombstones overlap with evidence destruction.
- Federal Rules of Evidence 901 (authentication and identification) as the bar for admissibility.
- `packages/forensics/src/` for the zod schemas and helpers.
