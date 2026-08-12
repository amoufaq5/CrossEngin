# ADR-0247: Live forensic hash-chain evidence source for certification (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0246 (certification serve lifecycle), ADR-0244 (certification-runtime), the `forensics` tamper-evident log, ADR-0077 (Phase 4) |

## Context

The certification serve lifecycle (ADR-0246) wired three live evidence sources — encryption coverage,
DR readiness, sealed access-review evidence — and left the fourth control (`audit.tamper_evident_log`)
`not_assessed`, because nothing persisted the `forensics` hash-chained audit log: no `forensics-pg`
package, no META table for `ChainedLogEntry`. This adds the persistence + the live source so the audit-
integrity control is assessed from a real chain.

## Decision

- **New META table `meta.forensic_chain_entries`** (table #135) — an append-only store for the
  `forensics` `ChainedLogEntry` (sequence_number, kind, recorded_at, actor_reference, payload_sha256,
  payload_size_bytes, prior_entry_hash, entry_hash, signing_key_fingerprint, signature; hashes
  `CHAR(64)` + regex-checked, `kind` CHECK against the seven `LOG_KINDS`). A unique
  `(tenant_id, sequence_number)` enforces per-scope append ordering, `entry_hash` is globally unique, and
  **platform-or-tenant RLS** confines reads to the caller's tenant (or the platform chain when
  `tenant_id IS NULL`).
- **`forensicChainSource` + `PostgresForensicChainReader`** in `operate-server`'s `certification.ts`
  (mirroring `PostgresAccessReviewEvidenceReader`). The reader loads the whole chain ordered by
  `sequence_number` ascending — verification must start at the genesis hash — within the tenant's RLS
  context (or the platform chain for a null tenant). The source folds it through
  `verifyChainIntegrity` and yields `evidenceFromForensicChain`.
- **Empty chain ⇒ no evidence.** `verifyChainIntegrity([])` is vacuously valid, but "no audit log
  exists" must not read as a *satisfied* audit-integrity control. So the source returns `[]` on an empty
  chain, leaving the control `not_assessed` (fail-closed, not certifiable) — only a non-empty chain is
  verified and reported.
- **`forensicChain` config toggle** (default on) adds the source to `defaultLiveSources`; the CLI help +
  option doc mention the tamper-evident audit chain.

## Consequences

- The certification pass now assesses all four modeled controls from live infra — encryption at rest, DR
  readiness, access recertification, **and** audit-log tamper-evidence — so a SOC 2 / HIPAA report
  reflects the real integrity of the audit trail, sealed and persisted like the rest.
- The chain persistence is honest but read-only here: this PR ships the table + reader + verification
  source. The **producer** — writing audit events into the chain (e.g. the gateway's `emit_audit` stage
  appending `buildChainEntry` rows) — is the open follow-up, exactly as `drReadinessSource` depends on
  the DR-readiness lifecycle and `accessReviewSource` on sealed access-review evidence being produced
  elsewhere. Until a producer runs, the chain is empty and the control is honestly `not_assessed`.
- The reader loads the full chain (integrity folds from genesis); checkpoint-anchored incremental
  verification (verify a suffix against a signed `ChainCheckpoint` root) is the scale follow-up for long
  chains.
- Meta-schema grows to **135 tables** (+ `meta-schema.test.ts` count + sorted-names + `apply.test.ts`
  `tableCount`). +3 tests (empty-chain → no evidence, intact chain → satisfied, broken chain → flagged
  with the break point) on top of the certification suite. Full build + typecheck + workspace tests green.
  The reader's SQL stays offline-untestable (needs a live RLS-scoped Postgres), like the other live
  readers; its parsing + the source logic are unit-tested with stubs.
