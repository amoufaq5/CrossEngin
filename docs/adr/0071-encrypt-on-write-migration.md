# ADR-0071: Encrypt-on-write migration for at-rest columns (Phase 2 M7.8.5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0070 (at-rest encryption mechanism + coverage applier), ADR-0067 (encryption hint), ADR-0047 (kernel-pg) |

## Context

M7.8 (ADR-0070) chose pgcrypto as the at-rest encryption mechanism and shipped the coverage applier: it reads the `encrypt=at_rest` hint from the catalog, provisions pgcrypto, and reports `plaintext_at_rest` drift for PHI columns still stored as plaintext. But it stopped at *reporting* — a freshly-applied schema has every PHI column flagged, and nothing moves the data to ciphertext. M7.8's Q1 named the follow-up: the column-rewrite + encrypt-on-write path.

M7.8.5 ships that migration: it converts a hinted plaintext column to a pgcrypto-encrypted `BYTEA` column in place (encrypting the existing values), so the M7.8 coverage verifier reports it green, and supplies a decrypting view for transparent reads.

## Decision

A new `encryption-migration.ts` module in `@crossengin/kernel-pg` — pure DDL emitters + a migrator that drives them from the M7.8 introspection.

- **`emitEncryptColumnSql(input)`** — the ordered, deterministic in-place conversion for one column:
  1. `ALTER TABLE … ADD COLUMN <col>__enc BYTEA;`
  2. `UPDATE … SET <col>__enc = CASE WHEN <col> IS NULL THEN NULL ELSE pgp_sym_encrypt(<col>::text, <keyRef>) END;` (encrypt existing values; NULLs stay NULL)
  3. `ALTER TABLE … DROP COLUMN <col>;`
  4. `ALTER TABLE … RENAME COLUMN <col>__enc TO <col>;`
  5. `COMMENT ON COLUMN … IS 'crossengin.data_class=<class>; crossengin.encrypt=at_rest';` (re-apply the directive so the verifier still recognizes the now-`BYTEA` column — which it now reports as encrypted-storage = green).
- **`emitDecryptingViewSql(input)`** — a `CREATE OR REPLACE VIEW` that exposes the table for transparent reads: every column passes through except the encrypted ones, surfaced as `pgp_sym_decrypt(<col>, <keyRef>) AS <col>`.
- **`planColumnEncryption(column, keyRef)`** — turns an introspected `EncryptedColumn` into a `ColumnMigrationPlan`.
- **`EncryptionMigrator`** — `planSchema(schema, keyRef)` introspects and plans encrypt-in-place for every plaintext (non-`BYTEA`) hinted column; `migrateSchema(schema, keyRef)` runs each plan in its own transaction.

The key is always a **SQL reference** (`current_setting('app.column_encryption_key')` or a bind param), never inlined — the same principle as M7.8, enforced by a test asserting no statement inlines a key literal into `pgp_sym_encrypt`.

## Cross-cutting invariants enforced

- **The migration closes the M7.8 gap.** After `migrateSchema`, a PHI column is `BYTEA` ciphertext, so `EncryptionApplier.coverage` reports `encryptedStorage = true` — `plaintext_at_rest` goes green. The two milestones compose: M7.8 detects, M7.8.5 fixes.
- **NULLs are preserved.** The `CASE WHEN <col> IS NULL` guard keeps nullable columns nullable; only non-null plaintext is encrypted.
- **The directive survives the rewrite.** Step 5 re-applies `data_class` + `encrypt=at_rest` to the renamed column, so the classification provenance isn't lost in the column swap and the verifier still recognizes it.
- **Idempotent at the schema level.** `planSchema` filters to *plaintext* hinted columns, so re-running `migrateSchema` after a successful migration is a no-op (already-`BYTEA` columns are skipped).
- **Keys never enter SQL text.** Every emitter takes a `keyRef`; a test asserts no key literal is inlined. Keys live in the session setting / bind params, out of migration history and logs.
- **Each column migrates atomically.** Each plan runs in its own transaction, so a failure mid-schema leaves already-migrated columns committed and the failing one rolled back — restartable.

## Alternatives considered

- **An `INSTEAD OF INSERT/UPDATE` trigger on a writable view (full transparency).**
  - **Considered.** The app reads/writes a view; triggers encrypt on write, the view decrypts on read; the base table holds ciphertext under a different name.
  - **Decision.** Deferred. It's the most transparent option but adds trigger machinery + a base-table rename + INSTEAD OF rules per entity. M7.8.5 does the in-place column rewrite (so the entity table itself holds ciphertext) plus a *read* view; the write path encrypting transparently via triggers is a refinement once the app's write path is settled.
- **Keep a plaintext column and add a separate ciphertext column.**
  - **Decision.** No — leaving the plaintext column defeats the purpose (PHI still readable at rest). The rewrite drops the plaintext column.
- **Encrypt in the application layer before INSERT instead of a SQL migration.**
  - **Decision.** That's the envelope-encryption alternative (ADR-0070), which needs a symmetric cipher in `@crossengin/crypto`. M7.8.5 stays on the pgcrypto path chosen in M7.8; an app-layer path is a parallel option, not this milestone.
- **Migrate all columns in one transaction.**
  - **Decision.** Per-column transactions. A whole-schema transaction on large tables holds locks too long and makes a mid-migration failure all-or-nothing; per-column is restartable and bounds lock duration.
- **Re-encrypt existing data with a cast other than `::text`.**
  - **Decision.** `::text` by default (overridable via `plaintextCast`). pgcrypto encrypts text; the column's logical value round-trips through text. Binary/structured columns can supply a custom cast.

## Consequences

- **55 packages + 1 app, 122 meta-schema tables, 6,101 tests** (was 55 / 122 / 6,091; +10 tests, 0 new packages/tables). The encryption arc is now end-to-end: hint (M7.7) → mechanism + coverage (M7.8) → encrypt-on-write (M7.8.5).
- **`plaintext_at_rest` can go green.** A deployment runs `EncryptionMigrator.migrateSchema(schema, keyRef)` after applying the schema, and `EncryptionApplier.verify` returns zero `plaintext_at_rest` issues — the HIPAA "PHI encrypted at rest" control is satisfiable and verifiable.
- **Transparent reads via the decrypting view.** `emitDecryptingViewSql` gives a read surface where `mrn` reads back decrypted, so consumers that hold the key see plaintext while the base table stores ciphertext.
- **Restartable, key-safe migration.** Per-column transactions + key-by-reference make the migration safe to run against a live database and safe to leave in migration history.
- **The data-classification arc is complete.** Declare `classification: "phi"` → catalog comment + audit invariant (M7.6) → default mask + encryption hint (M7.7) → edge redaction (M7.7.5/.6) → at-rest coverage (M7.8) → **actual at-rest encryption (M7.8.5)**.

## Open questions

- **Q1:** The transparent *write* path — `INSTEAD OF INSERT/UPDATE` triggers on the decrypting view?
  - _Current direction:_ Next refinement. The read view exists; a writable view with encrypt-on-write triggers (or app-layer encryption) makes the ciphertext fully transparent to the entity CRUD path.
- **Q2:** Equality search / indexing on encrypted columns?
  - _Current direction:_ Out of scope (flagged in ADR-0070 Q4). A blind-index / deterministic-encryption companion column is the search-milestone concern; pgp_sym_encrypt is non-deterministic, so encrypted columns can't be B-tree searched directly.
- **Q3:** Key rotation — re-encrypting with a new key?
  - _Current direction:_ A `reencryptColumnSql(old, new)` (`pgp_sym_encrypt(pgp_sym_decrypt(col, old), new)`) follows the same emitter pattern; deferred until key-rotation policy is defined with the `@crossengin/crypto` KeyStore.
- **Q4:** Should `crossengin-pg` grow an `encrypt` CLI command (plan / migrate / verify)?
  - _Current direction:_ Likely — surface `EncryptionMigrator.planSchema` (dry-run) + `migrateSchema` + `EncryptionApplier.verify` as `crossengin-pg encrypt --dry-run|--apply|--verify`, alongside `drift`. A small follow-up.
