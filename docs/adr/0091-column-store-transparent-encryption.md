# ADR-0091: transparent at-rest encryption in the column-mapped store (Phase 3 P1.11)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0090 (column-mapped store), ADR-0070 (pgcrypto at-rest mechanism), ADR-0071 (encrypt-on-write migration), ADR-0067 (acting on classification), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.11), closing ADR-0090's last
> deferred item.

## Context

ADR-0090 gave the `ColumnMappedEntityStore` typed per-entity tables and emitted
the `crossengin.encrypt=at_rest` comment on `phi`/`regulated` columns — but it
still **wrote those columns as plaintext**, naming transparent encrypt-on-write
through the store as the explicit follow-up. The mechanism already exists:
ADR-0070 chose pgcrypto symmetric encryption and `kernel-pg` ships
`pgpSymEncryptExpr` / `pgpSymDecryptExpr` (key by SQL *reference*, never inlined)
+ `ensurePgcryptoExtension`. This increment wires those into the store so a PHI
column is encrypted on write and decrypted on read, **transparently** — the
caller sends and receives plaintext; ciphertext never leaves the database.

This closes the data-classification arc end-to-end *through the serving store*:
declare `classification: "phi"` → typed `BYTEA` column + at-rest comment → the
store encrypts on write / decrypts on read, with no application code aware of it.

## Decision

Changes confined to `@crossengin/operate-runtime-pg` (the `EntityStore` contract
is unchanged):

- **`entity-ddl.ts`** — a column flagged `encryptAtRest` is now emitted as
  `BYTEA` (pgcrypto ciphertext), not its plaintext SQL type. The
  `crossengin.data_class=…; crossengin.encrypt=at_rest` comment is still written.
- **`column-store.ts`**:
  - A configurable `encryptionKeyRef` (default
    `current_setting('app.column_encryption_key')`) — a SQL **reference** that
    yields the key, never the raw key text. Empty → constructor throws.
  - `ensureSchema()` runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` when any
    entity has an encrypted column.
  - **Write** (`create` / `update`): an encrypted column's value is bound as
    text and its placeholder is `pgp_sym_encrypt($n::text, keyRef)`; plaintext
    columns bind the raw value (`writePlaceholder` is the single shared helper).
  - **Read** (`get` / `list` / `listPage` / `update … RETURNING`): an encrypted
    column is selected as `pgp_sym_decrypt("col", keyRef) AS "col"`, so the row
    maps back to plaintext under the same field name.
  - **Sort / filter**: encrypted columns are **excluded** — you can't
    meaningfully order ciphertext, and decrypt-per-row would defeat the index;
    an encrypted field in a `?sort`/filter is silently dropped.

## Cross-cutting invariants enforced (by tests)

- **Encrypted on write, plaintext to the caller.** `create({ mrn })` emits
  `pgp_sym_encrypt($n::text, current_setting('app.column_encryption_key'))` and
  binds the plaintext as text; `get` selects `pgp_sym_decrypt("mrn", keyRef) AS
  "mrn"` and the record carries the plaintext back. `update` re-encrypts a
  patched PHI column.
- **Key by reference, never inlined.** The key is always a SQL reference
  (`current_setting(...)` or an injected `encryptionKeyRef`); the raw key never
  appears in the emitted SQL (test-asserted with a custom ref).
- **BYTEA at rest.** The DDL stores a `phi` column as `BYTEA`, not `TEXT` —
  the catalog matches the `encrypt=at_rest` comment (no `plaintext_at_rest`
  drift for these columns).
- **pgcrypto provisioned.** `ensureSchema` issues `CREATE EXTENSION IF NOT
  EXISTS pgcrypto` when an encrypted column is present.
- **Ciphertext isn't sorted/filtered.** A `?sort=mrn` / filter on a PHI column is
  dropped (no `ORDER BY "mrn"`, no bound filter), falling back to the id order.

## Alternatives considered

- **Filter/sort on encrypted columns via decrypt-in-WHERE.**
  - **Decision.** No — `pgp_sym_decrypt("col", key) = $n` decrypts every row
    (full scan, no index) and re-exposes the value in the query plan. Excluding
    encrypted columns from sort/filter is the safe, honest default; deterministic
    or searchable encryption is a separate, much larger decision.
- **Encrypt with a bound key parameter instead of a SQL reference.**
  - **Decision.** No — passing the raw key as a bind param puts key material in
    the application process and the wire. A SQL reference
    (`current_setting(...)`, a session GUC / Vault-sourced setting) keeps the key
    in the database session, matching the M7.8 / `crossengin-pg encrypt`
    discipline.
- **Preserve the column's native type by encrypting per-type.**
  - **Decision.** No — pgcrypto yields `BYTEA` and `pgp_sym_decrypt` yields
    `text`; PHI is overwhelmingly textual (mrn, identifiers, demographics). A
    non-text PHI value round-trips as its text form — documented; a typed-decrypt
    cast is a future refinement if a numeric PHI field appears.
- **Key rotation / re-encryption.**
  - **Decision.** Out of scope — `keyRef` indirection makes the *active* key
    swappable, but bulk re-encryption on rotation is owned by the kernel-pg
    migration tooling (ADR-0071), not the serving store.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,307 tests** (was 6,300;
  +7, 0 new packages/tables). ADR-0090's last deferred item is closed: the
  column store now encrypts PHI/regulated columns at rest **transparently**.
- **The classification arc is end-to-end through serving.** `classification:
  "phi"` now drives: catalog comment → audit invariant → default redaction →
  edge redaction → typed `BYTEA` column → **encrypt-on-write / decrypt-on-read in
  the store** — no hand-written crypto in any handler or pack.
- **`operate-server --store pg-columns` serves PHI encrypted at rest.** With
  `app.column_encryption_key` set on the connection, served PHI is ciphertext in
  the table and plaintext to authorized callers (post-redaction).
- **Searchable encryption + key rotation remain the deferred crypto follow-ups**,
  behind the settled `encryptionKeyRef` seam.
