# ADR-0338: the key nobody set, and the write that handed it back

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0070 (pgcrypto mechanism, Q2 left open), ADR-0071 (encrypt-on-write migration), ADR-0074 (`crossengin-pg encrypt`), ADR-0091 (transparent encryption in the column store), ADR-0314 (per-tenant schemas), ADR-0302 (a per-tenant key derived from one deployment secret), ADR-0301 (argv is readable via `ps`), ADR-0334 (an unservable field is a boot refusal), ADR-0337 (found this) |

## Context

ADR-0337 found, as a side observation from a lane scoped elsewhere, that at-rest PHI
encryption was reachable by no deployment. It fixed the third of three parts — a
compliance control that reported encryption over plaintext — and left the first two
open, because the remedy was a key-management decision ADR-0070 named as "the envelope
refinement" and deferred. This increment takes that decision.

Both defects reproduced on a throwaway PG 16 cluster, as a **non-owner role**, through
the real server:

```
--store pg-columns   POST /v1/patients {"mrn":"MRN-1", …}
  HTTP 500 {"error":"write_failed",
            "detail":"unrecognized configuration parameter \"app.column_encryption_key\""}

--store pg (default) POST /v1/patients {"mrn":"MRN-SECRET", …}
  HTTP 201
  select document->>'mrn' from meta.operate_entity_records where entity='Patient'
  -> MRN-SECRET
```

The column genuinely is encrypted on the typed store — `patient.mrn` is created `BYTEA`
— and `DEFAULT_ENCRYPTION_KEY_REF` genuinely is
`current_setting('app.column_encryption_key')`. **Nothing in the workspace set that
GUC.** Four ADRs specify it and ADR-0091 names the requirement in so many words ("With
`app.column_encryption_key` set on the connection, served PHI is ciphertext in the table
and plaintext to authorized callers"); the setter was never built. So the healthcare pack
could not store one `Patient`, and the default store held PHI in the clear with the
limitation documented nowhere.

**The open item named only healthcare. It is five fields across two packs**, measured
over all seven: `Patient.mrn`, `Encounter.chief_complaint`, `Observation.value_quantity`,
`Observation.value_text` (`phi`), and — unnoticed until now — `erp-government`'s
`Citizen.national_id` (`regulated`). Three of the five are nullable, which matters below.

### Why `packages/crypto` could not answer this

ADR-0070 chose pgcrypto because `@crossengin/crypto` has no symmetric cipher. That is
still true, and more structurally than the ADR states: the package imports no
`createCipheriv`, and the absence is pinned in three places — `KEY_ALGORITHMS` has no
cipher member, `KEY_PURPOSES` no encryption purpose, and `CRYPTO_OPERATIONS` no
encrypt/decrypt operation, with `audit.test.ts` asserting
`isCryptoOperation("encrypt") === false`. There is also **no key-derivation function of
any kind** — no HKDF, PBKDF2 or scrypt anywhere in `packages/*/src/`.

And `meta.crypto_keys` cannot hold a data key. It is structurally a public-key
directory: no private-material column, `algorithm` CHECK is `('hmac-sha256','ed25519')`,
and `key_id`'s regex rejects anything else. Storing a wrapped DEK there means migrating
two CHECKs and a regex.

One further mismatch worth recording: `packages/security`'s `AT_REST_ALGORITHMS` is
`["aes-256","aes-256-gcm","chacha20-poly1305"]` and `KEY_MANAGEMENT_KINDS` names six KMS
providers. **None of those values describes what the code does** — pgcrypto's
`pgp_sym_encrypt` is OpenPGP CFB with an MDC — and nothing reads either enum. The
contract's algorithm vocabulary does not describe the mechanism, which is its own gap.

## Decision

**A per-tenant column key, derived rather than stored, from one deployment secret.**

`HKDF-SHA256(ikm = COLUMN_ENCRYPTION_SECRET, salt = tenantId, info =
"crossengin.column-encryption.v1:gen<N>")`, 32 bytes, base64, set on the connection as
`app.column_encryption_key` **transaction-locally and as a bound parameter**.

This is convergence, not invention. ADR-0302 already decided exactly this shape for the
structurally identical problem — a per-tenant HMAC key derived from one deployment
secret, `NOTIFICATION_BOUNCE_SECRET` — and following it means no new table, no CHECK
migration, no cipher added to a package whose three pins say it has none, and no key
material at rest anywhere. The whole increment is verifiable end to end rather than
half-built.

What it costs is stated in *Alternatives* and in *Consequences*: **no crypto-shredding.**
A derived key cannot be destroyed, because it is a function of the master secret, so
Article 17 gains nothing here. That is the one argument for a stored DEK and it is a real
one.

### The GUC is forced, not chosen

ADR-0091 argued for a SQL reference over a bound key on the grounds that a bind parameter
"puts key material in the application process and the wire". That reasoning is weaker
than it reads — `set_config($1, $2, true)` puts the key in both as well — but the
conclusion survives for a different and decisive reason: `emitEncryptingViewTriggersSql`
bakes the key reference into a plpgsql **function body** at `CREATE FUNCTION` time, so a
bind parameter is structurally impossible on the trigger path. The key must arrive as a
session setting. What the GUC actually buys is narrower than claimed and still worth
having: the key is a bound value, so it appears in no SQL text, no `log_statement='all'`
output, no `pg_stat_statements` entry and no query plan. Verified: the key string appears
zero times in the server log across the whole live run.

### The house GUC idiom would have destroyed PHI, and ADR-0070 proposed it

ADR-0070's Q2 direction was `current_setting('app.column_encryption_key')` set per
session "mirroring the tenant-RLS `app.current_tenant_id` pattern". **Mirroring that
pattern is the one thing that must not be done here.** Measured on PG 16:

| expression | unset | after use-and-reset on that connection |
|---|---|---|
| `current_setting('app.k')` | **raises** | returns `''` |
| `current_setting('app.k', true)` | returns NULL | returns `''` |
| `pgp_sym_encrypt(x, NULL)` | **returns NULL, silently** | — |
| `pgp_sym_encrypt(x, '')` | **raises** `Illegal argument to function` | — |

The tenant-RLS predicate uses the two-argument form, and composing it here —
`pgp_sym_encrypt('MRN-1', current_setting('app.column_encryption_key', true))` — returns
NULL with no error. So the repo's own idiom, applied to this GUC, writes NULL over every
PHI value and reports success. It bites on **three of the five real fields**, the
nullable ones, where no `NOT NULL` constraint catches it.

`isRaisingKeyRef` answers whether a reference can be shown to raise, `columnKeyRefFor`
emits only the one-argument form, and `crossengin-pg encrypt --apply` **refuses**
`key_ref_can_yield_null` for a caller-supplied two-argument ref rather than warning,
because that is the PHI-destroying path and nothing else about the invocation is more
important.

The form is also nondeterministic by connection history, which is worse than a flat bug:
on a fresh connection the one-argument form raises, and on a pooled connection that has
already served one PHI request it returns `''` and **pgcrypto** becomes the thing that
raises. The same deployment would therefore fail two different ways on two connections.
It is loud in both, never silent, which is why the one-argument form is the guard — but
the resolved key is also refused when empty, by name, rather than left to reach pgcrypto
as an opaque `Illegal argument`.

### A refusal at boot, not a 500 on the first write

`decidePhiStorage` is a total map over five verdicts, and `mayServe` is read off
`PHI_VERDICT_MAY_SERVE` rather than an `if`-chain, so a sixth verdict is a compile error
and cannot default to serving.

| store | phi fields | secret | `--allow-plaintext-phi` | verdict | serves |
|---|---|---|---|---|---|
| any | none | — | — | `no_phi` | yes |
| `pg-columns` | yes | set | — | `encrypted` | yes |
| `pg-columns` | yes | unset | — | `refused_no_secret` | **no** |
| `pg` / `memory` | yes | — | no | `refused_plaintext_store` | **no** |
| `pg` / `memory` | yes | — | yes | `plaintext_accepted` | yes |

Three rules behind it:

- **`refused_no_secret` converts a request-time 500 into a boot failure naming entity and
  field**, which is ADR-0334's conversion for an unservable `duration` field applied
  unchanged.
- **`--allow-plaintext-phi` does not rescue it.** On the typed store the column is
  `BYTEA`, so a plaintext write cannot succeed at all; the flag would name an outcome
  that store cannot produce. It is refused by name when combined with `pg-columns`,
  on the rule `--gateway-execution-capture 0` and `--workflow-defer-activities` are both
  refused by.
- **Refusing `--store pg` by default breaks nothing that worked.** ADR-0334 left
  `--tenant-status-gate` opt-in because on-by-default would refuse requests of a
  deployment that works today; here the reasoning **inverts**, because no deployment
  served PHI correctly today. The shipped compose is `erp-core`, which declares no
  `phi`/`regulated` field, so it is untouched by the storage refusal — and the compose file says what switching
  `OPERATE_PACK` to healthcare or government requires, since that is where an operator
  would trigger the refusal.

The secret is read from the environment and **never from argv**, ADR-0301's rule. The
decision is logged either way, including when it is fine, because "this deployment
encrypts PHI" and "this deployment stores PHI in the clear because it was told to" are
both facts worth having on the record; a secret that is set and unused warns rather than
refusing, since the variable may be set for a sibling service.

The ordering of those two steps is load-bearing and was caught in review rather than by a
test: `secretPresent` is "the variable is non-empty", which cannot see a secret that is
present and too weak to use, so a weak secret decides `encrypted` and is then refused by
the parser. Logging before building the key source would put "phi storage: encrypted" on
the record and throw immediately after — the exact shape of defect this increment closes,
one layer in. The source is built first. Verified: a 35-byte single-byte-value secret
logs **zero** `encrypted` lines and exits `fatal: column encryption secret refused
(too_uniform): secret has 1 distinct byte value(s) across 35 bytes; minimum is 16`.

### The fallback was a silent downgrade from ciphertext to plaintext

`TenantColumnStoreRouter.storeFor` returns the JSONB fallback whenever a tenant's column
store is absent — which is what a **refused** DDL application produces (ADR-0314). The
JSONB store has no encryption. So a tenant whose column schema was refused had their PHI
written in the clear while the log reported a refusal and the caller got a 201. ADR-0314
described that fallback as "their data is in a different place than they think"; with
encryption in the picture it is worse than a different place.

`encryptedEntities` makes those entities **refuse** instead, reads as well as writes — a
read from the plaintext fallback cannot return PHI that was written encrypted, so serving
it is a wrong answer rather than a degraded one, which is `IdempotencyStore.get`'s rule
from ADR-0336. Two details carry weight: `withTransaction` hands its callback the
*underlying* store, so a guard on the router's own methods would be bypassed by every
handler that writes inside a transaction — the ordinary write path — and the wrapper is
hand-written rather than a `Proxy` so a seventh `EntityStore` method fails to typecheck
instead of passing through unguarded. And the set is derived from the **tenant's own**
manifest, not the deployment's: under per-tenant manifests a tenant authors
independently, so a deployment-wide set taken from the boot pack would have been correct
only for tenants serving that pack and would have left exactly the tenant-declared PHI
field unguarded. One router per tenant gateway; the registry stays shared.

### And the write handed the plaintext straight back

Found while verifying the fix, and it is the sharper half of this increment. Same
credential, same record, same server:

```
GET   /v1/patients/{id}  keys: [account_id, created_at, id, status, updated_at]
PATCH /v1/patients/{id}  keys: [account_id, created_at, date_of_birth, family_name,
                                given_name, id, mrn, sex, status, updated_at]
```

The PATCH body was `{"sex":"female"}`. Everything else in that response is a field the
caller never supplied and **cannot read through GET**. So a credential with update
permission read any patient's MRN with a no-op PATCH, and the same held for
`Citizen.national_id`.

Classification-driven redaction is operation-keyed and the stage itself is fine; the
registry was populated from `entityReadOperationIds`, which returns `[list, read]`, while
`operations.ts` emits `list, create, read, update, delete` **plus one per workflow
transition**. The function's own doc comment — "The operationIds whose responses carry
this entity's records (for redaction)" — was false. `api-gateway-runtime`'s unused
default was wrong twice over in the same place: it listed a `.get` operation that no
route derivation emits, and lowercased a name the real id camel-cases, so it matched
nothing at all for any multi-word entity and would have silently dropped redaction for a
caller who omitted the override.

That is ADR-0288's `needsAuditEmitter` shape for the fourth time: a hand-maintained list
of the operations somebody remembered. It is **derived from the routes actually
derived** now — `entityOperationIndex` folds `compileOperateServer`'s own `routeSpecs`
and its three association spec families into entity → operationIds — and a static helper
structurally could not have been right, because a lifecycle transition's operationId
comes from the manifest's workflow and a `(name: string) => string[]` cannot know it.

**The scale, measured on resolved retail+core: 24 operations covered before, 90 after.**
Sixty-six operations across twelve classified entities were serving classified fields
unredacted — all four `salesOrder` transitions, and nine each for `Payment`, `Lead`,
`Project`, `FixedAsset` and `MaintenanceOrder`.

**And there was a second live member the trace missed**: the association list route.
`GET /v1/<owner>/{id}/<related>` was in no entity's mapping at all, while
`buildAssociationListHandler`'s own doc comment reads *"full records; the gateway redacts
per-caller at the edge, exactly like the list endpoint"* — it did not. Attribution for
those routes goes by **whose records come back**: list and count to `relatedEntity`,
link/unlink to `ownerEntity`. No pack declares a `many_to_many`, so no pack exercised it
and a fixture had to be extended rather than shipping an unverified branch.

Both hand-maintained lists are **deleted** rather than corrected, and
`operationsForEntity` is now **required**. `defaultOperationsForEntity` was worse than
the trace said — `[read, list, get]`, with **no write ids at all** — so a caller omitting
the override lost write redaction for *every* entity, not only the multi-word ones whose
reads the casing bug also lost. A default that is structurally incapable of being correct
fails silently in the unsafe direction, so the option demands the answer instead of
guessing half of it; the dependency direction is `operate-runtime` →
`api-gateway-runtime`, so importing `entityCamel` to fix the casing would have inverted it
and replicating the rule would have been a second copy with a test pinning them equal —
two lists with no comparison, again. Fail closed in two further places:
`fallbackOperationIds` yields the statically derivable CRUD ids if the index somehow has
no entry (unreachable today, but "no index entry" must not be the one path that serves
PHI in the clear), and `redactionRegistryFromManifest` **throws `RedactionCoverageError`**
when a classified entity's operation list is empty rather than registering nothing and
reporting success.

`CompiledOperateServer` now exposes `redactionOperationIds`, because
`MapRedactionRegistry` answers only `specFor(id)` — so the mapping was checkable in one
direction ("is this id covered") and never the other ("is every covered id one the
derivation emits"). That missing direction is exactly what let a `.get` that no route
emits sit in the list unnoticed, and it is the both-ways comparison ADR-0334 identified as
the thing whose absence made `needsAuditEmitter` wrong.

Encrypting a column at rest while any write returns its plaintext is a protection that
reads as stronger than it is — ADR-0337's falsely-true-control direction, which is the
dangerous one.

## Cross-cutting invariants enforced

- **Keys are derived per tenant and never stored.** Nothing writes key material to any
  table, file or log. `columnKeyFingerprint` exists so a key can be *identified* in a log
  line without being disclosed, and a test asserts no error path leaks the secret or the
  key.
- **The key reference raises; it never yields NULL.** `isRaisingKeyRef` + a refusal on
  both the CLI and the store path, with the measurement in the comment.
- **A classified field is encrypted at rest or the deployment refuses to serve it.** No
  third outcome, except the one a flag whose name is the admission opts into.
- **A classified field is redacted from every response an ungranted principal receives**,
  read or write, derived from the operations the server actually serves.
- **Fail closed.** A plaintext fallback for an encrypted entity refuses rather than
  serving; a weak secret refuses at boot; an unresolvable tenant refuses rather than
  deriving one shared key.

## Alternatives considered

- **A per-tenant DEK, wrapped by a deployment KEK, stored in a table.**
  - **Considered seriously; it is the stronger scheme.** Its decisive advantage is
    crypto-shredding: destroying a tenant's wrapped DEK makes their PHI unrecoverable
    *including from backups*, which is a claim ADR-0316's `DROP SCHEMA` cannot make, and
    it would make the Article 17 proof materially stronger.
  - **Decision.** Deferred, and named as the top follow-up. It needs AES-256-GCM in
    `packages/crypto` (whose three pins assert no cipher exists), a new table or two
    CHECK migrations on `meta.crypto_keys`, a KEK source, an unwrap cache, and a story
    for an unreadable DEK row — each defensible, none shippable in this increment
    alongside the defects above. Deriving is strictly better than the status quo and does
    not foreclose it: the derivation is already generation-tagged, so an envelope scheme
    becomes generation 2 rather than a rewrite.
- **One platform-wide key.**
  - **Decision.** No. One compromise would expose every tenant's PHI, which is the first
    question a BAA asks of a multi-tenant platform, and the per-tenant salt costs one
    HKDF call per tenant per process.
- **An external KMS (`KEY_MANAGEMENT_KINDS` names six).**
  - **Decision.** Out of scope. No client exists in the repo, and which provider is a
    deployment choice. The seam that would take one is `ColumnEncryptionKeySource`, a
    function from tenant id to key, which a KMS-backed resolver satisfies without
    touching anything else.
- **Exposing the derivation `generation` as a flag or env var.**
  - **Decision.** No, deliberately. `KeyRotationMigrator` is still callerless, so nothing
    re-encrypts: a deployment that bumped the generation would make every existing
    ciphertext undecryptable, with a `Wrong key or corrupt data` on read and no way back.
    The parameter exists so rotation is expressible without moving the domain tag later;
    the knob lands with the executor, in the same increment.
- **Refusing `--store pg` for a PHI manifest with no opt-out at all.**
  - **Decision.** No. A developer serving non-production data has a legitimate need, and
    one loud flag is better than a deployment finding a workaround. The flag's name is the
    admission and the boot line repeats it at `warn`.

## Consequences

- **Both live defects are closed, verified end to end as a non-owner role on PG 16.** The
  `POST /v1/patients` that was a 500 returns **201**; `pg_typeof(mrn)` is `bytea`, 76
  bytes for a 10-byte value, `position('MRN-LIVE-1' in encode(mrn,'escape'))` is **0**,
  and the stored bytes begin `c30d04` — the OpenPGP packet magic. A PATCH re-encrypts
  (ciphertext changes, decrypts to the new value, plaintext absent), which also proves the
  decrypt in `RETURNING` ran.
- **All four PHI shapes in the healthcare pack are encrypted at rest**, including the one
  ADR-0091 deferred as "a future refinement if a numeric PHI field appears" — one has, and
  it works: `Observation.value_quantity` is `decimal(14,4)`, stores as 73 bytes of
  ciphertext, and decrypts to `72.5000`, preserving the scale, so ADR-0332's canonical
  decimal wire form survives pgcrypto's text round trip.
- **Per-tenant separation is proven, not asserted.** Tenant A's derived key decrypts the
  row the store wrote; tenant B's derived key is refused `Wrong key or corrupt data`.
- **`crossengin-pg encrypt --verify` reports `ciphertext: 4   plaintext: 0`, exit 0** over
  the live schema, and `--apply` with no key in the environment refuses by name and exits
  **2** having run nothing. `EncryptionMigrator` gained the `sessionSettings` option its
  sibling `KeyRotationMigrator` already had, which is what made `--apply` possible at all
  — with the default key ref it could never have worked.
- **`pgcrypto` is provisioned in the self-hosted deployment**, which it was not;
  `deploy/postgres/init/00-extension.sql` created only `pg_uuidv7`. It is **guarded**,
  unlike `pg_uuidv7`, and the asymmetry is deliberate: the entrypoint runs these files
  with `ON_ERROR_STOP=1`, so a failing `CREATE EXTENSION` aborts initialisation and the
  container never comes up. `pg_uuidv7` should do that — the applier hard-requires it.
  pgcrypto is needed only by a classified manifest, so a missing one degrades to a boot
  refusal naming the field instead of a database that will not start. Both arms verified:
  `EXECUTE` inside a `DO` block does create the extension, and an unavailable one is
  caught with `psql` still exiting 0.
- **The GUC expression had three independent spellings** and now has one,
  `DEFAULT_COLUMN_KEY_REF`, exported from `kernel-pg` beside the GUC name itself.
- **Write responses lose classified fields for ungranted principals.** This is a
  caller-visible behaviour change for every entity in every pack, and it is a security
  fix. Its reach is wider than the encryption half's and worth stating plainly: redaction
  keys on *any* classification, not just the encrypt-at-rest ones, so it changes
  `erp-core` too — **21 fields** there (10 `pii`, 11 `commercial_sensitive`), none of which
  is encrypted at rest. A deployment on the default pack sees no storage change and does
  see write responses narrow. It also closes a **browser-visible** disclosure: `apps/operate-web`'s record page
  does `setRecord(await updateRecord(...))`, so a field the page could not display on load
  (because `getRecord` redacted it) appeared the moment the user saved anything. The UI
  needs no change — it loaded a redacted record and now gets a redacted one back, which is
  consistent where it previously was not — and the optimistic-concurrency token it relies
  on is `updated_at`, which carries no classification and survives redaction.
- A note on what "end to end over HTTP" means here: with the fix, no healthcare-pack role
  is granted field read on `phi`, so the API returns the record *without* the field on
  both reads and writes. The at-rest and the in-response protections are independent
  layers and both now hold; a deployment that wants a role to read PHI grants it in the
  manifest.

## Open questions

- **Q1: the DEK envelope, and crypto-shredding.** The top follow-up. See *Alternatives*
  for what it needs. The sub-question that decides its shape: does an unreadable DEK row
  mean "refuse this tenant" (fail closed, and a backup-restore ordering bug takes a tenant
  offline) or "refuse the request" (fail closed per call, and a partial outage looks like a
  classified-field outage)?
- **Q2: rotation has no executor.** `KeyRotationMigrator` is still constructed only by its
  own test, so nothing re-encrypts under a new key, and the `generation` parameter is
  deliberately unexposed for that reason. A `crossengin-pg rotate-keys` subcommand plus the
  operator confirmation a re-encrypting `UPDATE` over populated PHI needs is the increment.
  Until then a key change is unrecoverable.
- **Q3: `unique: true` is unenforced on the column store, and unenforceable on an encrypted
  column.** Measured: **zero** UNIQUE constraints across all 54 column-store tables, though
  `erp-core` declares `unique` on fields — `unique` is simply not plumbed into the entity
  DDL, encrypted or not, so this increment regresses nothing. But `Citizen.national_id` is
  both `unique: true` and `regulated`, and `pgp_sym_encrypt` is non-deterministic: two rows
  with the same plaintext under a UNIQUE `bytea` column both insert, verified live. So
  whoever plumbs `unique` must **refuse** the encrypted case rather than emitting a
  constraint that silently never fires. ADR-0070's Q4 noticed encrypted columns cannot be
  searched; nobody noticed they cannot be unique.
- **Q4: `packages/security`'s at-rest vocabulary describes a mechanism the repo does not
  use.** `AT_REST_ALGORITHMS` offers AES and ChaCha AEADs; the implementation is OpenPGP
  CFB+MDC via pgcrypto, which is none of them, and nothing reads the enum. Either the enum
  gains the mechanism in use or it is honest about being aspirational.
- **Q5: one secret per deployment, so one key lineage per tenant.** There is no per-tenant
  BYOK, which `KEY_MANAGEMENT_KINDS`' `customer-managed-byok` and `EncryptionProfile`'s
  `byokRequired` both model and nothing implements. `ColumnEncryptionKeySource` is the seam.
- **Q6: an encrypted column cannot be sorted or filtered**, which ADR-0091 decided and this
  increment does not change — the store drops an encrypted field from `?sort` and from
  filters silently. With encryption now live, "silently" is the part worth revisiting: a
  caller sorting on `mrn` gets id order and no indication why.
- **Q7: the write-mask mirror of this defect is unbuilt**, found while fixing the response
  half and left open because it is the same shape one layer over.
  `validateClassifiedWriteMask` exists in `@crossengin/auth` and has **zero non-test
  consumers** in `operate-runtime` or `api-gateway-runtime`. ADR-0329 built it on the rule
  that *a role cannot write a class it may not read*, and put one function behind both
  halves precisely so the two could not diverge — but only the read half is called on the
  request path. So a principal with `update` on the entity and no field-level `update`
  grant can **write** a `phi` field it cannot read back. That is ADR-0336's callerless
  shape: a rule built, tested, and connected to nothing. Fixing it is a handler change in
  `operate-runtime` with its own blast radius (it refuses writes that currently succeed),
  so it wants its own increment rather than riding along on this one.
