# ADR-0225: Transparent encryption write-path + key rotation (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0070 (pgcrypto at-rest mechanism), ADR-0071 (encrypt-on-write migration), ADR-0077 (P3 plan — P8) |

## Context

P8 is the production-hardening + GA milestone. Two encryption follow-ups were explicitly deferred by
M7.8 / M7.8.5 and named as P8 work in ADR-0077 (line 81): the **transparent write path** (M7.8.5
shipped a `pgp_sym_decrypt` read view via `emitDecryptingViewSql`, but writes to the BYTEA columns
still required callers to `pgp_sym_encrypt` by hand), and **key rotation** (`reencryptColumnSql`).
Both are pure, deterministic SQL — the same builder-plus-migrator shape as `encryption-migration.ts`
— so they land offline-tested in `kernel-pg`, closing the data-classification arc's last mechanism gap
before GA.

## Decision

A new `kernel-pg` module, `encryption-writepath.ts`:

- **Key rotation.** `reencryptColumnSql({schema, table, column, oldKeyRef, newKeyRef})` emits
  `UPDATE … SET col = pgp_sym_encrypt(pgp_sym_decrypt(col, oldKey), newKey) WHERE col IS NOT NULL` —
  decrypt under the old key, re-encrypt under the new, NULLs skipped by the guard, both keys as SQL
  *references* (never inlined, test-enforced). `planColumnKeyRotation` + `formatKeyRotationPlan` mirror
  the migration module's plan/format helpers, and `KeyRotationMigrator.planSchema` /
  `rotateSchema(schema, oldKeyRef, newKeyRef)` introspect every **ciphertext** (BYTEA) hinted column
  (`introspectEncryptedColumns`, `encryptedStorage === true`) and re-encrypt each in its own
  transaction.
- **Transparent write path.** `emitEncryptingViewTriggersSql({schema, table, viewName, columns,
  encryptedColumns, keyColumns, keyRef})` emits an `INSTEAD OF INSERT OR UPDATE OR DELETE` trigger
  (plus its plpgsql function) on the decrypting view: an INSERT/UPDATE through the view lands in the
  base table with each encrypted column stored as `pgp_sym_encrypt(NEW.col::text, key)` and plaintext
  columns passed through; UPDATE/DELETE match the row by `keyColumns` (e.g. `(tenant_id, id)`); NULLs
  stay NULL. Paired with `emitDecryptingViewSql`, the view is now a **fully transparent read+write
  facade** over an encrypted table — callers read and write plaintext, the database encrypts. The
  trigger is dropped-if-exists then recreated and the function is `CREATE OR REPLACE`, so re-runs are
  idempotent; `keyColumns` must be non-empty (an empty set would make UPDATE/DELETE unbounded — it
  throws).

## Consequences

- The pgcrypto at-rest story is now end-to-end executable: declare `phi`/`regulated` → column comment
  → default redaction → edge redaction → BYTEA at-rest → encrypt-on-write migration → **transparent
  read+write facade** → **key rotation**. GA no longer has a "callers must hand-encrypt on write" or
  "no rotation path" gap.
- Rotation is per-column, per-transaction, and re-entrant against the live catalog (it keys off the
  `crossengin.encrypt=at_rest` comment + BYTEA storage), so a scheduled rotation job can sweep a schema
  safely; a plaintext (not-yet-migrated) hinted column is skipped by rotation and picked up by the
  migration module instead.
- The write-path triggers are pure builders (they need the base table's column list + PK, which the
  catalog comment doesn't carry), so the caller — e.g. the column-mapped store or a provisioning step —
  supplies those; this keeps the module offline-testable and free of a bespoke introspection query for
  view/PK shape.
- +15 tests (rotation SQL + plan/format + migrator; trigger DDL for INSERT/UPDATE/DELETE + key-ref
  safety + empty-keyColumns guard). Full build + typecheck + workspace tests green. No META tables, no
  new package or dependency.
- Remaining P8 work (future PRs): `@crossengin/dr-runtime` (failover records + drills executed), the M8
  SLO loop wired to `operate-server`'s real request stream, and scheduled `access-reviews` campaigns
  against live grants.
