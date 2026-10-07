# ADR-0347: The key that could not be destroyed

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0346, ADR-0338, ADR-0337, ADR-0329, ADR-0328, ADR-0320, ADR-0319, ADR-0316, ADR-0302, ADR-0301, ADR-0091, ADR-0070 |

## Context

ADR-0338 made at-rest PHI encryption work by **deriving** the per-tenant column key —
`HKDF-SHA256(ikm = COLUMN_ENCRYPTION_SECRET, salt = tenantId, info =
"crossengin.column-encryption.v1:gen<N>")` — and storing nothing. That was the right call for that
increment and bought the whole thing in one piece: no new table, no CHECK migration on a
`meta.crypto_keys` that is structurally a public-key directory, no cipher in `packages/crypto`,
whose three pins assert it has none. It named one cost, and both that ADR and CLAUDE.md have carried
it as the top follow-up ever since:

> **no crypto-shredding**, which is the only argument for a stored DEK and is now the top follow-up

ADR-0346 then added `packages/crypto/src/aead.ts` — AES-256-GCM, for the encrypted cursor — which
removed the one mechanical obstacle. This increment is the envelope.

### The motivation on file is an overclaim, and correcting it is most of the work

ADR-0338's own text states what the envelope would buy:

> destroying a wrapped DEK would make a tenant's PHI unrecoverable **including from backups**, a
> claim ADR-0316's `DROP SCHEMA` cannot make

That is false as stated, and it matters because it is the kind of falsehood ADR-0337 found in the
HIPAA report: a reassuring summary over a weaker reality. **The wrapped key and the ciphertext it
protects live in one database.** `meta.tenant_data_keys` and `public.patient` are backed up
together, so one restore restores the pair, and destroying the row does nothing to any backup that
already holds it. An envelope whose KEK lived in an external KMS would support something close to
the original claim; one whose wrapped key sits in the same cluster as the data does not.

What the envelope actually buys is a **bounded deletion horizon**: after the row is destroyed the
column ciphertext is recoverable only from backups taken *before* the destruction, and only until
those expire — so the bound is the deployment's backup retention rather than the destruction itself.
A derived key gives **no horizon at all**: it exists wherever `COLUMN_ENCRYPTION_SECRET` does, so a
tenant erased under ADR-0316 has their PHI recoverable forever from any backup, by anyone holding
the deployment secret. That difference is the whole value, and it is enough to ship for. Claiming
more is the thing to refuse.

### And it holds only for a key that is random

The second correction follows from the migration. A deployment switching to the envelope has tenants
that **already hold ciphertext written under the derived key**, and nothing in the schema records
which key wrote a given column. So provisioning a random data key for such a tenant makes their PHI
permanently unreadable — a data-loss bug, in the one column class the platform is most careful
about. The only safe migration is to **seed** that tenant's data key with the bytes of the key their
ciphertext is already under.

But a seeded key is still recomputable from `COLUMN_ENCRYPTION_SECRET`, so destroying its row
destroys nothing. The envelope's whole claim is therefore a property of **the row**, not of the mode,
and a deployment that cannot tell the two apart will believe an Article 17 erasure bounded a horizon
it did not. That is what forces `provenance` onto the row and makes shreddability a three-valued
answer over `(mode, provenance)` rather than a boolean.

## Decision

Six parts.

**(1) `packages/crypto/src/data-key.ts` — the envelope, thin over ADR-0346's AEAD.**
`generateDataKey()` is `randomBytes(32)` and nothing else; `wrapDataKey(kek, dek, aad)` and
`unwrapDataKey(kek, wrapped, aad)` are `aeadSeal`/`aeadOpen` with a data-key length check;
`dataKeyWrapAad(tenantId, generation)` is canonical JSON of `[tenantId, generation]`, for
`cursorSealAad`'s stated reason — JSON renders the pair unambiguously where a delimiter-joined form
rests on the delimiter not appearing in a UUID. `dataKeyToColumnKey(dek)` is base64 of the raw key,
which is what `pgp_sym_encrypt` takes. The wire format, the nonce discipline and the
`null`-on-failure rule are all ADR-0346's and are not restated.

A wrong-length data key **throws** rather than returning null, inheriting `requireAeadKey`'s rule,
and it matters most on `dataKeyToColumnKey`: `pgp_sym_encrypt` accepts a key of **any** length, so a
short key rendered to text would encrypt PHI weakly and report success.

**(2) `deriveTenantKek` — the KEK is derived, so the envelope adds no credential.**
`HKDF-SHA256(ikm = COLUMN_ENCRYPTION_SECRET, salt = tenantId, info =
"crossengin.key-encryption.v1:gen<N>")`, the same construction as the column key under a different
`info` tag, through the same `refuseWeakSecret` gate. So the envelope adds a *row* to keep or
destroy and no second secret to hold. A separately-held KEK is what would buy ADR-0338's original
claim, and it is a KMS decision left open below.

**(3) `meta.tenant_data_keys` — the 146th catalogued table.** Keyed `(tenant_id, generation)`
unique, with `wrapped_key BYTEA NOT NULL`, `kek_generation INTEGER NOT NULL CHECK >= 1`, and
`provenance TEXT NOT NULL CHECK IN ('random', 'seeded_from_derived')`. RLS enabled with the standard
isolation policy and **no platform arm**: a data key is never platform-scoped, `tenant_id` is NOT
NULL, and a platform read arm would let any tenant's gateway session read every tenant's wrapped
key.

It **cascades from `meta.tenants`**, which is the opposite of `PLATFORM_RECORD_TABLES`' rule
(ADR-0335) and deliberately so: those tables exist to outlive the tenant they describe, and this one
exists to *not* — a wrapped key surviving its tenant is the one row whose survival defeats the
feature. The Article 17 erasure needs no new code to destroy it, which the shared-table erasure
counts confirmed by failing on the table count the moment it was catalogued (114 → 115 targets).

**(4) `PostgresDataKeyStore` — `ensure` / `load` / `destroy`.** `ensure(tenantId, seed?)` is
idempotent under an xact-scoped advisory lock (`DATA_KEY_LOCK_SQL`, copied in shape from
`TENANT_SCHEMA_LOCK_SQL` — `kernel-pg`'s applier lock is a *session* lock that node-pg refuses
inside a transaction, and this lock has to be held by the transaction that reads and inserts).
A row that exists **ignores the seed**, so the seed decision is made once per tenant and never
revisited. `provenance` is derived from whether a seed was supplied, never accepted from a caller.
`destroy` is a **hard delete** and not a `destroyed_at` flag: a soft delete leaves the wrapped key in
the row, so a tombstone would claim a destruction over a key that was still there and still openable
— ADR-0323's tampered scope in a new place. A failed unwrap raises `DataKeyUnwrapFailed` naming the
tenant and generation and never the key.

**(5) `--column-key-mode derived|envelope`, default `derived`.** Opt-in because it is a storage
change under live PHI, and `envelope` on a deployment that encrypts no column is **refused at boot**
by name: a mode that silently does nothing would let an operator believe a tenant's key is
destroyable when there is no key.

**(6) The seed decision, and the probe behind it.** `tenantMayHoldCiphertext` asks the direct
question — does any table carrying an encrypted column hold a row for this tenant — and **every
uncertainty resolves to `true`**, because the two errors are not symmetric: seeding a tenant that
holds nothing costs only shreddability, while randomising one that holds ciphertext destroys their
PHI. A `42P01` (relation does not exist) is `false`, because a table the store has not created holds
nothing; any other error is `true`.

`shreddabilityOf(mode, provenance?)` answers `shreddable` / `derivable` / `not_applicable` over the
**pair**, with `envelope` and no provenance in hand answering `derivable` — the conservative
direction — and the boot line states the bound in the words of the corrected claim, never "including
from backups".

## Alternatives considered

- **Option A: store the DEK wrapped under a KEK from an external KMS.**
  - **Pros:** supports ADR-0338's original claim — the wrapped key and the data share a backup, but
    the *unwrapping capability* does not, so revoking the KMS key does bound recovery from every
    backup.
  - **Cons:** a KMS is a deployment dependency this platform does not have, an unwrap is a network
    call on the write path needing its own cache and failure policy, and the self-hosted compose
    stack has nowhere to put one. `KEY_MANAGEMENT_KINDS` models `customer-managed-byok` and nothing
    implements it.
  - **Why not:** it is the right end state and a different increment. Deriving the KEK ships the
    horizon today with no new credential; `kek_generation` is on the row so a KMS-wrapped
    generation 2 is an addition rather than a rewrite.

- **Option B: a derived DEK, stored wrapped, with no `randomBytes` anywhere.**
  - **Pros:** no migration problem at all — every tenant's stored key equals the key their
    ciphertext is already under, so the switch is invisible and `provenance` is unnecessary.
  - **Cons:** it buys **nothing**. A key that can be recomputed cannot be destroyed, so the row is a
    cache and deleting it has no consequence. This is exactly the `seeded_from_derived` state, which
    the design treats as a *migration residue* to be rekeyed away rather than as the design.
  - **Why not:** it would have made the whole increment a no-op wearing the costume of a fix, which
    is the class ADR-0335 and ADR-0336 exist to end.

- **Option C: randomise every tenant and migrate the ciphertext (decrypt under the derived key,
  re-encrypt under the random one).**
  - **Pros:** every tenant ends up `shreddable`; no `provenance` column, no probe, no two-valued
    answer.
  - **Cons:** it is a data migration over every classified column of every tenant, which is
    `KeyRotationMigrator`'s job — and that class **has no executor** (CLAUDE.md's open item (2)
    under the PHI entry). Writing one inside this increment means deciding what happens to a
    migration that halts partway, with a tenant's columns split across two keys and nothing
    recording which is which.
  - **Why not:** the honest decomposition is *seed now, rekey later*. The rekey is a named follow-up
    and `provenance` is precisely the field that tells an operator which tenants want it.

- **Option D: record the key generation per row, so a tenant's columns may be under two keys.**
  - **Pros:** makes a partial rekey safe and removes the probe's asymmetry — a mis-seeded tenant
    would be recoverable.
  - **Cons:** a `key_generation` column on every entity table carrying an encrypted column, read on
    every decrypt, chosen on every write, and it has to reach the encrypting-view trigger path where
    the key ref is baked into a plpgsql function body.
  - **Why not:** a real improvement and a kernel-level one (it changes `emitEntityTableDdl`'s column
    plan). The probe resolving towards `seeded` makes the current design safe without it.

- **Option E: no `provenance` column — infer shreddability by comparing the stored DEK to the
  derived key.**
  - **Pros:** one less column, and the comparison is exact rather than remembered.
  - **Cons:** it needs the deployment secret in hand to answer a question about a row, so nothing
    can report shreddability without unwrapping; and it is **wrong after a secret rotation**, where a
    seeded key no longer matches the newly-derived one and would read as `random` — the unsafe
    direction, claiming a horizon that does not exist.
  - **Why not:** the provenance is a fact about how the row was created, and facts about the past are
    recorded rather than recomputed. That is the same rule as ADR-0335's actor columns.

## Consequences

- **Positive.** An Article 17 erasure can now bound the recovery horizon for a tenant's at-rest PHI,
  which it previously could not at all. The capability needs no new credential, no KMS, and no
  change to the compose stack: the KEK is derived from the secret already required for PHI. The
  erasure destroys the row with no new code, because the table cascades and carries `tenant_id`.
  ADR-0338's overclaim is corrected in the three places a reader meets it — the module doc, the boot
  line and CLAUDE.md.
- **Negative.** A second code path for the column key, so a deployment can be in one of two modes
  and a bug can live in only one of them. A database round trip on a cold tenant's first encrypted
  write, mitigated by a promise cache whose one limitation is stated rather than left to be found: a
  destroyed key leaves a stale cache entry, harmless only because the destruction happens inside the
  pipeline that retires the tenant row in the same transaction (ADR-0319, ADR-0320) and
  `--tenant-status-gate` refuses the tenant at the edge afterwards.
  Every tenant migrated with existing ciphertext is `seeded_from_derived` and therefore **not
  shreddable** until rekeyed, so for an existing deployment this increment buys the *mechanism* and
  not yet the horizon. A wrong-length DEK or a failed unwrap is a refused request rather than a
  degraded one, deliberately: the available fallback — deriving instead — would split one tenant's
  ciphertext across two keys irreversibly, and a refused write is recoverable where that is not.
- **Neutral.** `meta.tenant_data_keys` is the 146th catalogued table (147 in a fresh database, with
  `_meta_migrations`). The default is unchanged, so a deployment that does not pass the flag behaves
  exactly as it did under ADR-0338 and the new table stays empty.
- **Reversibility.** Returning to `derived` is free for a tenant whose row is
  `seeded_from_derived` — the stored key *is* the derived key, so dropping the flag serves the same
  bytes. For a tenant with a `random` row it is **not** reversible without a rekey: their ciphertext
  is under a key that exists only in that row. That asymmetry is the feature working.

## Implementation notes

- `packages/crypto/src/data-key.ts` is new and exported from the package root; `deriveTenantKek` and
  `KEK_KEY_DERIVATION_INFO` join `key-derivation.ts` beside the column and cursor derivations, and
  `refuseWeakSecret` took a `label` parameter so the three secrets' refusals name the right
  variable.
- `packages/crypto-pg/src/data-key-store.ts` is new. It uses `tenant-context.ts`'s `scopeFilter` and
  `SET_TENANT_CONTEXT_SQL` and sets tenant context on **every** statement including the reads, since
  the table's isolation policy is its only arm (ADR-0335's class).
- `apps/operate-server/src/data-key-envelope.ts` holds the mode, the shreddability pair, the two
  boot-line formatters and `buildEnvelopeKeySource`. It performs no encryption, issues no SQL and
  never reads the environment; the secret arrives **already parsed**, so there is one place the
  deployment secret enters.
- `node.ts` parses the secret once, eagerly, before either closure, and builds the envelope source
  after the connection exists. The derived source stays live in envelope mode because it is the
  **seed**: the two are one decision rather than alternatives.
- Three tests moved by one: `shared-table-erasure.test.ts` (114 → 115 erasure targets, two places)
  and `deletion-pipeline.test.ts` (96 → 97). They failed before the fix, which is the confirmation
  that the Article 17 erasure picks the new table up with no code.

### Verified live, as a non-owner role, on PG 16

A throwaway cluster with `app_rw` as a non-owner, `erp-core` plus a `Chart` entity carrying a `phi`
`mrn`, two tenants: one provisioned and written to **before** the switch, one only after.

1. **Derived mode.** `POST /v1/charts {"label":"a1","mrn":"MRN-OLD-1"}` → 201; read back
   `a1=MRN-OLD-1`; `meta.tenant_data_keys` holds **0 rows**.
2. **Envelope mode, same manifest.** The old tenant's ciphertext — written under the derived key —
   **still reads** (`a1=MRN-OLD-1`), a new row works (`a2=MRN-OLD-2`), and the new tenant works
   (`b1=MRN-NEW-1`). The table then holds exactly two rows, 60 wrapped bytes each:
   `44444444…|1|1|random` and `11111111…|1|1|seeded_from_derived`.
3. **The ciphertext is ciphertext.** `encode(substring(mrn from 1 for 3),'hex')` is `c30d04` — an
   OpenPGP packet header, with the plaintext absent.
4. **The boot refusal fires.** `--column-key-mode envelope` on `--store pg` with no secret:
   `fatal: --column-key-mode envelope needs a deployment that encrypts a column …`, exit before a
   connection is opened.
5. **The property the migration rests on, proved offline against the live rows.** Unwrapping each
   stored key with its derived KEK: the `seeded_from_derived` row's
   `dataKeyToColumnKey(dek) === deriveTenantColumnKey(secret, tenant)` is **true** and the `random`
   row's is false. In both rows another tenant's KEK fails to unwrap, the right KEK with
   `generation = 2` fails, and the right KEK with another tenant's AAD fails — so the AAD binds both
   fields it names.

The first probe was **wrong and found live**, which is the part worth recording. It asked whether the
tenant's own Postgres schema existed — sound only for ADR-0314's per-tenant manifests, since a boot
manifest's column tables live in the deployment's shared schema. It answered `false` for every
tenant, handed each a random key, and made the PHI written one step earlier unreadable. Nothing
offline distinguishes a proxy that is merely indirect from one that is wrong.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The rekey executor: `KeyRotationMigrator` still has no caller, so a `seeded_from_derived` tenant cannot be moved to a random key and the horizon stays unbought on an existing deployment. It needs a decision about a migration that halts partway. | Platform | 2026-11-30 |
| A KMS-held KEK (`kek_generation` is on the row for it). It is what would support ADR-0338's original "including from backups" claim, and `KEY_MANAGEMENT_KINDS.customer-managed-byok` models the per-tenant form. | Platform | 2026-12-31 |
| `shreddabilityOf` has no caller that reads a **real** provenance: nothing loads a tenant's row to report it, so the boot line answers from the mode alone and an operator cannot ask "is tenant X shreddable". A platform route or a CLI subcommand would. | Platform | 2026-11-30 |
| `PostgresDataKeyStore.destroy` has no caller. The erasure destroys the row by cascade, which is correct and means the method is reachable by nothing — the `pg-unreachable-stores.ts` question for a *method* rather than a class, which that rule does not ask. | Platform | 2026-11-30 |
| The key-source cache is not evicted on destruction. Harmless today because a destruction happens inside the pipeline that retires the tenant row, so nothing serves that tenant afterwards; a destruction reachable outside that pipeline needs an eviction. | Platform | 2026-11-30 |
| No `key_generation` column on the entity tables, so a tenant's encrypted columns must all be under one key and a partial rekey is unsafe. It is what would make a mis-seeded tenant recoverable. | Platform | 2026-12-31 |

## References

- ADR-0338 (the derived column key, and the overclaim this ADR corrects), ADR-0346 (AES-256-GCM),
  ADR-0335 (facts about the past are recorded, not recomputed; a store that sets no tenant context),
  ADR-0337 (a falsely-true control is worse than a falsely-false one), ADR-0329/ADR-0328/ADR-0316
  (the Article 17 erasure and its proof), ADR-0319/ADR-0320 (one transaction, and the ordering
  against `meta.tenants`), ADR-0323 (a claim over data that is still there), ADR-0302 (a per-tenant
  key derived from one deployment secret), ADR-0301 (a secret arrives by environment, never argv),
  ADR-0091 and ADR-0070 (the at-rest requirement, and the key-management question left open).
- RFC 5869 (HKDF), NIST SP 800-38D (GCM), RFC 4880 §5.3 (the OpenPGP symmetric-key packet
  `pgp_sym_encrypt` emits).
