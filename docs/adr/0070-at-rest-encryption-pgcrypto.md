# ADR-0070: At-rest encryption mechanism + coverage applier (Phase 2 M7.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0067 (acting on classification — encryption hint), ADR-0066 (field classification), ADR-0047 (kernel-pg), ADR-0048 (crypto) |

## Context

M7.7 (ADR-0067) made the kernel DDL emitter append `crossengin.encrypt=at_rest` to the column comment for `phi`/`regulated` fields, leaving the *mechanism* undecided (its Q2). The hint sits in `pg_catalog`; nothing reads or acts on it. M7.8 picks the mechanism and ships the applier that consumes the hint.

The choice is constrained by what's available: `@crossengin/crypto` provides SHA-256 / BLAKE2b / HMAC / Ed25519 + a `KeyStore`, but **no symmetric cipher** (no AES-GCM). Adding application-level envelope encryption would mean building a symmetric-encryption layer in `crypto` first — a large, key-management-heavy effort. Postgres already ships `pgcrypto` with audited symmetric encryption (`pgp_sym_encrypt`/`pgp_sym_decrypt`). So at-rest column encryption belongs in the database, driven from the catalog hint, with `kernel-pg` as the applier.

## Decision

**Mechanism: pgcrypto symmetric encryption.** A `phi`/`regulated` column's at-rest ciphertext is produced by `pgp_sym_encrypt(plaintext, key)` and stored as `BYTEA`; reads decrypt with `pgp_sym_decrypt(ciphertext, key)`. The key is supplied as a SQL *reference* (a bind param or `current_setting('app.column_encryption_key')`), never inlined — key management stays with the deployment / `@crossengin/crypto` `KeyStore`, out of the catalog and out of the SQL text.

A new `encryption.ts` module in `@crossengin/kernel-pg`:

- **`parseColumnDirectives(comment)`** — the pure inverse of the kernel emitter's directive string: `'crossengin.data_class=phi; crossengin.encrypt=at_rest'` → `{dataClass: "phi", encryptAtRest: true}`.
- **`introspectEncryptedColumns(conn, schema)`** — queries `col_description` for columns whose comment carries `encrypt=at_rest`, returning `{schema, table, column, dataType, dataClass, encryptedStorage}` (`encryptedStorage` = the live type is `bytea`).
- **`ensurePgcryptoExtension(conn)`** / **`pgcryptoInstalled(conn)`** — provision / detect the extension.
- **`pgpSymEncryptExpr` / `pgpSymDecryptExpr` / `pgpSymEncryptLiteral`** — pure builders for the pgcrypto SQL expressions (the building blocks an encrypting view / migration uses), with literal escaping and a key *reference* argument.
- **`summarizeEncryptionCoverage(schema, columns, pgcryptoInstalled)`** — a pure compliance report: counts ciphertext-stored vs plaintext columns and emits `EncryptionDriftIssue`s — `plaintext_at_rest` (a hinted column still stored as a plaintext type) and `pgcrypto_missing` (columns need encryption but the extension is absent).
- **`EncryptionApplier`** — `ensureProvisioned()` + `coverage(schema)` + `verify(schema)` tie introspection, the extension check, and the report together.

## Cross-cutting invariants enforced

- **The catalog hint is the contract.** The applier reads exactly what the kernel emitter wrote (`parseColumnDirectives` ↔ `emitColumnComments`), so the classification declared on a field (M7.6) drives the encryption posture with no parallel config.
- **Keys never touch the catalog or SQL text.** Encrypt/decrypt builders take a key *reference*; the literal builder escapes plaintext. The key lives in the deployment's secret store, surfaced via a bind param or `current_setting` — never a comment, never an inlined string.
- **Coverage is verifiable, not assumed.** `verify(schema)` reports every `encrypt=at_rest` column still stored as plaintext as `plaintext_at_rest` drift — a HIPAA control can assert "zero plaintext PHI columns" against the live catalog, and "is pgcrypto installed" is a single check.
- **Pure where it can be.** Parsing, the SQL builders, and `summarizeEncryptionCoverage` are pure (mock-connection tests); only introspection + provisioning touch the connection — matching kernel-pg's diff/drift module shape.

## Alternatives considered

- **Application-level envelope encryption (AES-GCM via `@crossengin/crypto`).**
  - **Considered.** A per-tenant DEK wrapped by a KEK, encrypt/decrypt in the app, columns as `BYTEA`.
  - **Decision.** Deferred. `crypto` has no symmetric cipher yet; building one + the DEK/KEK envelope + the app-side encrypt/decrypt path is a milestone of its own. pgcrypto is available today, audited, and keeps the ciphertext beside the data. The envelope approach can supersede this for deployments that refuse to give the database the key.
- **Transparent disk/tablespace encryption (TDE).**
  - **Decision.** Out of scope — it's an infra/storage concern (cloud-provider TDE, LUKS), encrypts everything indiscriminately, and isn't column-granular. It complements, not replaces, column-level encryption for PHI.
- **Rewrite `phi`/`regulated` columns to `BYTEA` in the kernel DDL emitter now.**
  - **Considered.** Would make `encryptedStorage` true out of the box.
  - **Decision.** No — storing plaintext in a `BYTEA` column without the encrypt-on-write path is *worse* (wrong type, still plaintext). The column-rewrite + an encrypting view / write trigger that calls `pgp_sym_encrypt` is the next milestone; M7.8 ships the mechanism, provisioning, builders, and the coverage verifier that *reports* the gap honestly.
- **Inline the key into the generated SQL.**
  - **Decision.** Never. The builders take a key reference; a key in SQL text would leak into logs, query plans, and the migration history.

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,091 tests** (was 55 / 122 / 6,077; +14 tests, 0 new packages/tables). The `encrypt=at_rest` hint from M7.7 now has a consumer.
- **The mechanism is decided and documented.** pgcrypto symmetric encryption, `BYTEA` ciphertext, key-by-reference — the path from "classification: phi" to "encrypted at rest" is no longer a TODO.
- **Compliance has a live coverage tool.** `EncryptionApplier.verify(schema)` enumerates every PHI/regulated column and whether it's encrypted-at-rest yet, plus whether pgcrypto is provisioned — auditable against the running database, not a doc.
- **The building blocks for the data migration exist.** `pgpSymEncryptExpr`/`DecryptExpr` are what the next milestone's encrypting view / write-path uses to actually move plaintext PHI to ciphertext.
- **Honest about the remaining gap.** A freshly-applied schema reports its PHI columns as `plaintext_at_rest` — correctly, because the column-rewrite + encrypt-on-write path is the explicit follow-up. The verifier turns "are we encrypting PHI?" into a query.

## Open questions

- **Q1:** The column-rewrite + transparent access path — an encrypting `BEFORE INSERT/UPDATE` trigger, a writable view, or app-layer encrypt/decrypt?
  - _Current direction:_ The next milestone. A view that exposes `pgp_sym_decrypt(col, key)` for reads plus a trigger that `pgp_sym_encrypt`s on write is the pgcrypto-native option; app-layer is the alternative if the DB shouldn't hold the key.
- **Q2:** Where does the key reference come from at query time?
  - _Current direction:_ `current_setting('app.column_encryption_key')` set per session from the `@crossengin/crypto` `KeyStore`, mirroring the tenant-RLS `app.current_tenant_id` pattern. A per-tenant DEK is the envelope refinement.
- **Q3:** Should `kernel-pg`'s `drift` command surface `plaintext_at_rest` issues alongside schema drift?
  - _Current direction:_ Likely yes — fold `EncryptionApplier.verify` into the `crossengin-pg drift` CLI output so one command reports schema + encryption coverage. A small follow-up.
- **Q4:** Indexing encrypted columns?
  - _Current direction:_ Encrypted `BYTEA` columns can't use ordinary B-tree predicates; equality search needs a deterministic-encryption or blind-index column. Out of scope; flagged for the search/index milestone.
