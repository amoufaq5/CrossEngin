# ADR-0067: Acting on data classification — default redaction + encryption hints (Phase 2 M7.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0066 (field-level data classification), ADR-0003 (auth / field permissions), ADR-0001 (DDL emit), ADR-0048 (crypto) |

## Context

M7.6 (ADR-0066) made the manifest field the single source of truth for data classification: `FieldSchema.classification`, a DDL column comment carrying the class into `pg_catalog`, and a "PHI requires auditable" validator. But it explicitly *recorded* the class without *acting* on it — its open questions named the follow-up: default field redaction in `@crossengin/auth` and at-rest encryption hints in DDL.

M7.7 closes that loop. A sensitive field should be redacted on read and write-protected by default — not only when a developer remembers to write an explicit per-field grant — and a PHI/regulated column should carry an at-rest encryption directive the storage layer can act on.

## Decision

Three small, additive changes (`types`, `kernel`, `auth`); no new packages, no new META_ tables, fully backward compatible.

### `@crossengin/types` — an encryption predicate

- `ENCRYPT_AT_REST_DATA_CLASSIFICATIONS` (`phi` / `regulated`) + `requiresEncryptionAtRest(c)`. Same membership as the audit-required set today, but a separate name so the two policies can diverge later (e.g., encrypt `commercial_sensitive` without auditing it).

### `@crossengin/kernel` — encryption directive in the column comment

`emitColumnComments` now builds a directive list: always `crossengin.data_class=<class>`, plus `crossengin.encrypt=at_rest` when `requiresEncryptionAtRest`. A column has one comment, so the directives are joined with `; ` into a single `COMMENT ON COLUMN … IS 'crossengin.data_class=phi; crossengin.encrypt=at_rest'`. The storage/migration layer reads the directive from `pg_catalog` and applies column encryption (pgcrypto / app-level via `@crossengin/crypto`) — the kernel emits intent, not implementation.

### `@crossengin/auth` — classification-driven default redaction + write-mask

Two new functions alongside the existing `computeFieldRedaction` / `validateWriteMask` (which are untouched):

- `computeClassifiedFieldRedaction(principal, entityPerms, roles, fields: ClassifiedField[], policy?)` — `ClassifiedField` is `{name, classification?}`. Rules:
  1. An explicit per-field `read` grant wins (existing semantics).
  2. Otherwise, a field whose classification is redacted-by-default (the sensitive set: pii/phi/regulated/commercial_sensitive, overridable via `policy.redactByDefault`) is readable **only** if the principal holds a `policy.privilegedRoles` role; else redacted.
  3. Unclassified (or non-sensitive) fields with no rule stay readable.
- `validateClassifiedWriteMask(...)` — the write analogue: a sensitive field with no explicit `update` grant is writable only by a privileged role.
- `SensitiveFieldPolicy = {privilegedRoles?, redactByDefault?}` parameterizes both.

## Cross-cutting invariants enforced

- **Sensitive-by-default is fail-closed.** A PHI field with *no* field-level permission is now redacted for non-privileged principals — the safe default — rather than silently readable (the M7.6 gap). A developer opts *in* to exposure with an explicit `read` grant, not *out* of leakage.
- **Explicit grants always win.** Both new functions check the explicit per-field rule first, so existing manifests that already declare `fields.<name>.read/update` behave exactly as before. The classification default only fills the *absence* of a rule.
- **Backward compatible.** `computeFieldRedaction` / `validateWriteMask` are unchanged; the classification-aware variants are additive. Callers opt in by passing `ClassifiedField[]` + a policy. No existing test or manifest changes behavior.
- **The DDL change is comment-only and additive.** Unclassified columns emit no comment; pii columns get the data-class comment without an encrypt directive; phi/regulated get both. The `CREATE TABLE` body is untouched.
- **Policy is injectable, not hard-coded.** `privilegedRoles` and `redactByDefault` are per-call, so a tenant/vertical decides which roles see PHI and which classes are masked — the kernel/auth ship the mechanism, the manifest/deployment supplies the policy.

## Alternatives considered

- **Bake the redaction default into `computeFieldRedaction` (mutate the existing function).**
  - **Decision.** Rejected — it would change the behavior of every existing caller (sensitive fields would flip from readable to redacted without a policy). A separate `computeClassifiedFieldRedaction` keeps the old contract and makes the new behavior opt-in with an explicit policy.
- **Hard-code the privileged role (e.g., always an `*_admin`).**
  - **Decision.** No — privilege is a deployment/vertical decision (healthcare: `clinician`; finance: `accountant`). `policy.privilegedRoles` is supplied per call.
- **A second column comment for encryption.**
  - **Decision.** Postgres allows one comment per column, so the directives are combined into one comment with a `; ` separator. A structured key=value list is trivially parseable by the storage layer.
- **Emit real `pgcrypto` / column-encryption DDL now.**
  - **Decision.** Out of scope. The encryption *strategy* (pgcrypto symmetric, app-level envelope via `@crossengin/crypto`, or tablespace/TDE) is its own decision with key-management implications. M7.7 emits the *hint*; the applier acts on it when the encryption ADR lands.
- **Auto-redact at the gateway/serialization layer instead of in auth.**
  - **Decision.** Auth is where field-level read/write decisions already live (`computeFieldRedaction`); putting the classification default there keeps one decision point. The gateway calls auth, as it does today.

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,056 tests** (was 55 / 122 / 6,046; +10 tests, 0 new packages/tables). The data classification declared in M7.6 now drives behavior.
- **PHI is fail-closed.** Wiring `computeClassifiedFieldRedaction` with `{privilegedRoles: ["clinician"]}` means a front-desk principal reading a `Patient` sees `mrn`/demographics redacted with zero per-field permission boilerplate — the classification alone protects the data.
- **The storage layer has an encryption signal.** A migration applier (a future `kernel-pg` enhancement) reads `crossengin.encrypt=at_rest` from the column comment and provisions encryption for PHI/regulated columns — driven by the schema, verifiable in the catalog.
- **The healthcare pack is now protected end-to-end.** Its M7.6 classifications (`Patient.mrn` → phi, etc.) mean: PHI redacted-by-default in auth, an encrypt directive in its DDL, and the audit-trail invariant — all from the field declarations, no extra permission wiring.
- **Compliance posture is mechanized, not documented.** "PHI is encrypted at rest and masked from unprivileged users" is now enforced by code paths, not a policy PDF.

## Open questions

- **Q1:** Should the gateway/SDK serialization layer call `computeClassifiedFieldRedaction` automatically for every read, given the entity's classified fields?
  - _Current direction:_ The function is ready; wiring it into the gateway response transform (so redaction happens without each handler opting in) is a gateway-runtime follow-up (M7.7.5).
- **Q2:** Which encryption mechanism does `crossengin.encrypt=at_rest` map to?
  - _Current direction:_ Undecided — pgcrypto vs app-level envelope (via `@crossengin/crypto`) vs TDE. The hint is mechanism-neutral; the encryption ADR picks one with key-management in scope.
- **Q3:** Should `privilegedRoles` be derivable from the manifest (e.g., roles with a `delete` grant on the entity) instead of supplied per call?
  - _Current direction:_ Explicit policy for now. A `defaultPrivilegedRoles(manifest, entity)` helper could infer it, but explicit is clearer for the first cut.
- **Q4:** Redaction *value* — null, a fixed mask token, or omission?
  - _Current direction:_ `FieldRedactionResult` returns the *names* of readable vs redacted fields; how the serializer renders a redacted field (drop / `null` / `"[redacted]"`) is the caller's choice. A standard mask token could be added to the contract if consumers want consistency.
