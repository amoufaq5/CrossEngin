# ADR-0232: PHI column key rotation (Phase 3 P8.1)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0071 (encrypt-on-write migration), ADR-0074 (crossengin-pg encrypt CLI), ADR-0070 (at-rest encryption) |

## Context

P8's GA checklist includes "a key rotation re-encrypts PHI columns with zero downtime".
M7.8.5 (ADR-0071) built the encrypt-on-write migration (plaintext → encrypted `BYTEA`), but
there was no way to roll an already-encrypted column from one pgcrypto key to a new one —
the named P8 deliverable `reencryptColumnSql`.

## Decision

Key rotation in `@crossengin/kernel-pg`'s `encryption-migration.ts`, plus a CLI surface:

- **`reencryptColumnSql(input)`** — emits a single NULL-safe `UPDATE` that re-encrypts an
  already-encrypted `BYTEA` column in place: `SET col = CASE WHEN col IS NULL THEN NULL ELSE
  pgp_sym_encrypt(pgp_sym_decrypt(col, oldKeyRef), newKeyRef) END`. The column type is
  unchanged (it is already `BYTEA`), so the decrypting read view keeps working once the
  deployment's key reference points at the new key. **Both keys are SQL references, never
  inlined** (test-enforced).
- **`planColumnRotation` / `formatRotationPlan`** + `EncryptionMigrator.planRotation` /
  `rotateSchema(schema, oldKeyRef, newKeyRef)` — plans rotation for **only the
  already-encrypted** (`encryptedStorage`) hinted columns (the inverse filter of
  `migrateSchema`'s plaintext-only), and executes each column's rotation in its own
  transaction.
- **CLI** — `crossengin-pg encrypt --rotate --old-key-ref=<sql> [--key-ref=<new>] [--apply]
  [--confirm]`: `--rotate` alone prints the rotation SQL (dry-run); `--apply` runs it
  (production-guarded by `--confirm`); `--key-ref` is the *new* key (default the standard
  reference), `--old-key-ref` is required.

## Consequences

- **73 packages + 4 apps, 128 meta-schema tables, ~7,483 offline tests.** No new META_
  tables (rotation is in-place over the existing encrypted columns). New tests: 6 in
  `encryption-migration.test.ts` — the NULL-safe re-encrypt UPDATE (keys by reference, no
  inlined key), `planColumnRotation` / `formatRotationPlan`, and `rotateSchema` rotating only
  bytea columns in a transaction / no-op when none. Verified end-to-end: `crossengin-pg
  encrypt --rotate … --schema=meta` → "No encrypted-at-rest columns to rotate" (exit 0)
  against the live test DB.
- PHI/regulated columns can now be rotated to a new key without a schema change — closing
  the encryption arc (declare → comment → mask → BYTEA → encrypt-on-write → **rotate**). The
  remaining P8 increments: the SLO loop on operate-server's real request stream, scheduled
  access-review campaigns, and a PG sibling for DR failover/drill records.
