# ADR-0066: Field-level data classification (Phase 2 M7.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0065 (pack-erp-healthcare), ADR-0001 (manifest + DDL emit), ADR-0042 (compliance packs), ADR-0003 (auth / field permissions) |

## Context

M7.5 (ADR-0065) shipped the healthcare pack and expressed PHI two ways: at the manifest level (`compliancePacks: ["hipaa"]`) and at the job boundary (`inputDataClass: "phi"`). But the *fields that actually hold PHI* — `Patient.mrn`, `Observation.value_text` — carried no classification. The taxonomy existed (`DATA_CLASSES` in `@crossengin/jobs`, a parallel `EntityClassification` structure in `@crossengin/security`), but nothing attached a data class **inline to a manifest field**, where a developer declares the schema.

M7.6 closes that gap: a `classification` attribute on the manifest `FieldSchema`, the catalog plumbing to carry it into Postgres, and a compliance invariant that PHI must be audited. The healthcare pack is updated to use it, demonstrating the feature end-to-end.

## Decision

Changes in three packages (`types`, `kernel`, `pack-erp-healthcare`); no new packages, no new META_ tables.

### `@crossengin/types` — classification on the field

- `DATA_CLASSIFICATIONS` (`public | internal | commercial_sensitive | pii | phi | regulated`) — the same six-value taxonomy as `jobs`' `DATA_CLASSES`, defined locally because `types` is the lowest layer and cannot depend on `jobs`.
- `FieldSchema` gains an optional `classification: DataClassificationSchema`.
- Helpers: `SENSITIVE_DATA_CLASSIFICATIONS` (pii / phi / regulated / commercial_sensitive), `AUDIT_REQUIRED_DATA_CLASSIFICATIONS` (phi / regulated), `isSensitiveDataClass`, `requiresAuditTrail`, `fieldClassification`, `isFieldSensitive`, and `entityClassifiedFields(entity)` → `{field, classification}[]`.

### `@crossengin/kernel` — catalog plumbing + compliance invariant

- **DDL emit** (`ddl/emit.ts`): `emitColumnComments(entity, ctx)` emits `COMMENT ON COLUMN <schema>.<table>.<col> IS 'crossengin.data_class=<class>';` for each classified field (using the reference-column name for reference fields). `emitEntity` now appends these after the `CREATE TABLE` + indexes. The classification lands in `pg_catalog`, so introspection, masking, and encryption tooling can read it back from the database itself.
- **Manifest validation** (`manifest/validate.ts`): a new `validateClassifications` step enforces that any field classified `phi` or `regulated` lives on an entity carrying the `auditable` trait — PHI/regulated data must be audited. Plus `manifestClassifiedFields(manifest)` → `{entity, field, classification}[]`, a compliance inventory over a whole manifest.

### `@crossengin/pack-erp-healthcare` — real usage

`Patient.mrn` → `phi`; demographics (`given_name` / `family_name` / `date_of_birth` / `sex` / `email` / `phone`) → `pii`; `Encounter.chief_complaint` → `phi`; `Observation.value_quantity` / `value_text` → `phi`. All three entities are already `auditable`, so the new invariant passes; the resolved manifest still cross-validates.

## Cross-cutting invariants enforced

- **PHI implies audit.** `validateClassifications` rejects a `phi`/`regulated` field on a non-auditable entity. `pii` does not trigger the requirement (it's sensitive but not audit-mandated by default), so low-stakes PII fields stay ergonomic.
- **The classification reaches the database.** It's not just a manifest annotation — `emitColumnComments` writes it as a column comment, queryable via `pg_catalog` / `information_schema`. Downstream masking + encryption can be driven from the catalog without re-parsing the manifest.
- **Backward compatible.** `classification` is optional; every existing entity (pack-erp-core, all fixtures) is unaffected — no comments emitted, no validator firing. The `emitEntity` output is byte-identical for unclassified entities.
- **Taxonomy parity.** The `types` `DATA_CLASSIFICATIONS` mirrors `jobs` `DATA_CLASSES` exactly, so a field's class and a job's `inputDataClass` speak the same language.

## Alternatives considered

- **Reuse `@crossengin/security`'s `EntityClassification` instead of a field attribute.**
  - **Considered.** It already models per-field data classes.
  - **Decision.** That structure is a *separate, parallel* declaration a developer must keep in sync with the schema. Putting `classification` on the field itself makes the schema the single source of truth — the security `EntityClassification` can be *derived* from the manifest (via `manifestClassifiedFields`) rather than hand-maintained.
- **Import `DATA_CLASSES` from `jobs` into `types`.**
  - **Decision.** Rejected — `types` is the lowest-layer package; depending on `jobs` inverts the dependency graph. Defining the enum in `types` (and noting parity) is correct; if anything, `jobs` should later re-export from `types`.
- **Enforce masking/encryption at validation time.**
  - **Decision.** Out of scope. M7.6 records the classification and the audit invariant; *acting* on it (default field redaction in `@crossengin/auth`, at-rest encryption hints in DDL) is M7.7. Keeping them separate avoids coupling the manifest layer to the auth/crypto layers prematurely.
- **A CHECK constraint or native column annotation instead of a comment.**
  - **Decision.** A `COMMENT` is the right Postgres mechanism for metadata that tooling reads but the engine doesn't enforce. CHECK constraints are for value rules; classification is metadata.
- **Make `pii` also require auditing.**
  - **Decision.** No — only `phi`/`regulated` (HIPAA / regulated-data territory) mandate an audit trail by default. PII is sensitive (masking candidate) but auditing every PII field would make the invariant noisy. Tenants who want stricter posture can mark fields `regulated`.

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,046 tests** (was 55 / 122 / 6,027; +19 tests, 0 new packages/tables). The healthcare pack now classifies its PHI/PII fields and still cross-validates.
- **The schema is the source of truth for data classification.** A developer declares `classification: "phi"` next to the field; the kernel carries it to the catalog and enforces the audit invariant. Compliance tooling reads `manifestClassifiedFields` (design time) or the column comments (runtime).
- **Foundation for masking + encryption (M7.7).** `@crossengin/auth` can default field redaction from `isFieldSensitive`; the DDL layer can emit pgcrypto / column-encryption hints from the same classification. Both now have a single, authoritative input.
- **Compliance packs get a real signal.** The HIPAA pack (ADR-0042) can assert "every PHI field is on an auditable entity and audited" against `manifestClassifiedFields`, turning a documentation claim into a validated invariant.

## Open questions

- **Q1:** Should `@crossengin/auth` default field-level read redaction from `classification` (M7.7)?
  - _Current direction:_ Yes, next. A sensitive field with no explicit `fields.<name>.read` grant should default to redacted-for-non-privileged-roles, derived from `isFieldSensitive`. Deferred to keep M7.6 to the manifest+kernel layer.
- **Q2:** Should the DDL layer emit at-rest encryption hints (pgcrypto / TDE) for `phi`/`regulated` columns?
  - _Current direction:_ Comment only for now. Encryption strategy (column-level vs tablespace vs app-level via `@crossengin/crypto`) is its own ADR.
- **Q3:** Should `jobs` `DATA_CLASSES` be re-pointed at `types` `DATA_CLASSIFICATIONS` to remove the duplication?
  - _Current direction:_ Leave both for now (they're value-identical); unify in a cleanup once nothing else depends on the `jobs` copy's location.
- **Q4:** Per-field rationale / regulation citation (like `security`'s `FieldClassification.rationale`)?
  - _Current direction:_ Not yet. The class alone is enough for emit + the invariant. A `classificationRationale` string can be added if auditors want the "why" inline.
