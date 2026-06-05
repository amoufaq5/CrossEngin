# ADR-0148: column-store encrypted-PHI read-fidelity gated test + NULL fix (Phase 3 P2.39)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0091 (column-store transparent encryption), ADR-0090 (column-mapped store), ADR-0125 (column-store NUMERIC read fidelity), ADR-0126 (column-store DATE/TIMESTAMPTZ read fidelity), ADR-0119 (P1.24 column-store integration), ADR-0070 / ADR-0071 (pgcrypto), ADR-0077 (Phase 3 plan) |

> **Numbering.** P2 follow-on increment (P2.39) — a hardening pass over the P1.11
> encrypted-column path discovered through writing real-Postgres read-fidelity
> coverage. ADRs 0080–0085 stay reserved for Phase 3 P3–P8 (per ADR-0077).

## Context

`ColumnMappedEntityStore` (ADR-0091, P1.11) wires pgcrypto into the column-mapped
store so a `phi`/`regulated` field is `pgp_sym_encrypt`'d to `BYTEA` on write and
`pgp_sym_decrypt`'d on read — transparently. The P1.24 integration test
(`apps/operate-server/src/integration-columns.test.ts`) proves the happy path
against a real Postgres: a `Patient.mrn` value round-trips through write→read,
the column type is `bytea`, and the ciphertext doesn't contain the plaintext.

P1.27 (ADR-0125, NUMERIC) + P1.28 (ADR-0126, DATE/TIMESTAMPTZ) extended that
coverage to **read-fidelity edge cases** that node-postgres' driver coercions
make subtle — a decimal returned as a string, a date returned as a `Date` —
each fix sitting in `coerceColumnValue`. The same pattern hasn't been applied
to the encrypted code path: empty-string vs. NULL, multibyte / Unicode (the
platform targets MENA), very long values, listPage decryption under projection
were untested.

Writing the test surfaced a latent bug in `writePlaceholder`:

```ts
private writePlaceholder(mapping, value, params) {
  if (mapping.encryptAtRest) {
    params.push(String(value));                    // ← bug
    return pgpSymEncryptExpr(`$${...}::text`, this.keyRef);
  }
  params.push(value);
  return `$${...}`;
}
```

For an encrypted column written with `value === null`, `String(null)` is the
literal string `"null"` — bound as text, encrypted, and stored as a non-NULL
`BYTEA` envelope containing the four characters `n,u,l,l`. On read the column
decrypts to the string `"null"`, not `null`. (For a plaintext column the
existing branch is correct: `params.push(null)` becomes a SQL NULL bind.) A
clear PHI value to `null` round-trips as the unrelated string "null" — silently
wrong, and not detected by any prior test.

## Decision

**1. Fix `writePlaceholder` to bind `NULL` as a bare SQL literal regardless of
classification.** A `null` value short-circuits both branches to the keyword
`NULL`, so:

- A plaintext column's `null` write is unchanged (`NULL` and `params.push(null)`
  are equivalent in SQL).
- An encrypted column's `null` write stores a true SQL NULL — not the encrypted
  string `"null"`. NULL → null round-trips both ways.

The literal `NULL` is safe to interpolate because no caller data is involved —
it's a fixed keyword chosen from the value's type, not its content.

**2. Add three offline unit tests** in `packages/operate-runtime-pg/src/column-store.test.ts`
asserting the placeholder shape for `create` with `null`, `update` with `null`,
and `create` with `""` (empty string — distinct from null; still encrypted).

**3. Add a gated real-Postgres test** in
`apps/operate-server/src/integration-columns-encrypted.test.ts` (`CROSSENGIN_PG_TEST=1`)
covering encrypted-column read fidelity end-to-end through pgcrypto + node-postgres:

- **NULL PHI** — write `secret: null` → BYTEA column is genuinely NULL (no
  ciphertext envelope) → read returns `null`. Update from null → real value
  encrypts in place. Update back to null clears the ciphertext.
- **Empty-string PHI** — write `mrn: ""` (length 0, not null) → BYTEA column is
  non-null (pgp_sym_encrypt emits a real envelope even for zero-length plaintext)
  → read returns exactly `""`. Proves the empty-string path is distinct from the
  NULL path on the ciphertext side.
- **Multibyte / Unicode PHI** — write a `محمد-…` (Arabic + ASCII) value → read
  returns the identical UTF-8 string; the ciphertext does not contain the
  plaintext substring (sanity check the UTF-8 + pgcrypto round-trip is
  encrypting, not bypassing).
- **Long PHI (>700 chars)** — write 771 ASCII chars → read returns the identical
  string with no truncation (pgp_sym_encrypt imposes no plaintext-length cap).
- **listPage decryption** — `listPage` over patients with an encrypted `mrn`
  returns the decrypted plaintext in each record, both with and without a
  `?fields` projection that includes `mrn` (the SQL pushdown still wraps the
  encrypted column in `pgp_sym_decrypt`).

The NULL test and the long-PHI test use small inline manifests under schema
`lk` because the healthcare pack's `Patient.mrn` is `required: true` + has a
`maxLength: 32`. The encryption pipeline is identical — the test isolates the
fidelity question from the manifest's required/length constraints.

## Cross-cutting invariants enforced (by tests)

- **`null` is a first-class write for encrypted columns.** No "null" string
  artifact; the BYTEA column is genuinely SQL NULL.
- **`""` is distinct from `null` on both sides.** Empty plaintext yields a
  non-null BYTEA envelope; reads return `""`, not `null`.
- **UTF-8 PHI round-trips unchanged.** Multibyte sequences (Arabic, etc.)
  encrypt and decrypt without re-encoding.
- **No length cap on encrypted PHI.** 700+-char plaintext round-trips exactly.
- **`listPage` decrypts encrypted columns.** The SQL pushdown for `?fields` and
  the default SELECT both wrap `phi` columns in `pgp_sym_decrypt`.

## Alternatives considered

- **Encode `null` as the encrypted sentinel `\0NULL`** — No. Sentinels mean every
  consumer (CLI, replayer, kernel-pg drift scan) has to know the encoding, and a
  legitimate plaintext of that sentinel collides. SQL NULL is exactly what NULL
  PHI is.
- **Reject `null` writes to encrypted columns** — No. NULL is a perfectly valid
  PHI value (no MRN issued yet, etc.); rejecting it forces callers to invent a
  placeholder and breaks parity with plaintext columns.
- **Use a parameter (`$N`) bound to JavaScript `null`** — Considered. Binding
  `null` to a `BYTEA` parameter inside `pgp_sym_encrypt(NULL::text, key)` would
  also work — pgp_sym_encrypt of NULL is NULL — but it spends a parameter slot
  on a constant, complicates the placeholder string, and is harder to read at the
  SQL level than the bare `NULL` keyword. The two are observationally equivalent;
  the literal is simpler.

## Consequences

- **+1 fix in `ColumnMappedEntityStore.writePlaceholder`** (the only production
  code change).
- **+3 offline unit tests** in `column-store.test.ts` covering NULL on create,
  NULL on update, and empty-string-stays-encrypted.
- **+1 gated integration test file** (`integration-columns-encrypted.test.ts`)
  with 5 real-Postgres tests covering NULL, empty string, multibyte, long, and
  `listPage` decryption.
- **Data-classification arc deepens.** Declaring `classification: "phi"` now
  guarantees: write `null` → SQL NULL; write `""` → encrypted empty; UTF-8 +
  unbounded length round-trip; `listPage` decrypts. The serving store's
  encrypted-column contract is now genuinely transparent.
- **No DDL change, no meta-schema change, no new package.** The fix lands behind
  the unchanged `EntityStore` contract, with no migration required.
