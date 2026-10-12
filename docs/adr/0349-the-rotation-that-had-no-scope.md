# ADR-0349: The rotation that had no scope

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-08 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0347, ADR-0346, ADR-0338, ADR-0337, ADR-0336, ADR-0334, ADR-0333, ADR-0331, ADR-0330, ADR-0319, ADR-0316, ADR-0314, ADR-0301, ADR-0091, ADR-0070 |

## Context

ADR-0347 shipped the DEK envelope — a per-tenant data key stored only wrapped in
`meta.tenant_data_keys`, so destroying the row is expressible — and named the rekey executor as its
own first open end, in these words:

> for an **existing** deployment this increment bought the mechanism and **not yet the horizon**,
> since every migrated tenant with data is seeded.

A deployment that ran in `derived` mode and wrote PHI has tenants whose ciphertext is under
ADR-0338's derived column key. Switching to `envelope` mode must *seed* those tenants from that key
or their data becomes unreadable, so their row records `provenance: seeded_from_derived` — and that
key stays recomputable from `COLUMN_ENCRYPTION_SECRET`, so destroying the row destroys nothing.
`shreddabilityOf` answers `derivable` and says so. The rekey is what moves such a tenant to a
`random` key, and it is the only thing that makes a later destruction mean anything.

`KeyRotationMigrator` is the executor that was supposed to do it. It has existed since the pgcrypto
at-rest stack was written, has never had a caller, and is declared in
`pg-unreachable-stores.ts` as `prerequisite_of_unbuilt_surface` — "Ordering, not shape."

That classification was wrong. The class is **an executor whose only atomic unit was the wrong
one**: it rotates a whole *schema*, one *column* per transaction, and for a per-tenant key both axes
are wrong.

### Finding 1 — the rotation had no scope, and could not be given one

`reencryptColumnSql` emitted

```sql
UPDATE t SET c = pgp_sym_encrypt(pgp_sym_decrypt(c, old), new) WHERE c IS NOT NULL;
```

— every row in the table — and `ReencryptColumnInput` had **no field that could carry a predicate**.
So a per-tenant rekey was not a wiring step but a shape change to an exported interface.

It is not a hazard waiting for an unusual deployment. Under a boot manifest the column tables sit in
the deployment's **shared** schema with a `tenant_id` column — which is exactly the live finding
ADR-0347 recorded when it corrected `tenantMayHoldCiphertext` — and in envelope mode each tenant has
a *different* key. So `rotateSchema` run for one tenant would re-encrypt every other tenant's PHI
under this tenant's key pair, and cannot even get that far: `pgp_sym_decrypt` raises
`Wrong key or corrupt data` on the first foreign row.

`KeyRotationPlan.statement` was a bare `string` and `rotateSchema` ran it as
`tx.query(plan.statement)` with no params argument at all, so adding `AND tenant_id = $1` meant
widening the plan — otherwise the tenant id would have to be interpolated into SQL text, against the
module's one standing rule.

### Finding 2 — the per-column split bought nothing and cost the recovery

`rotateSchema`'s own doc named the halt-partway hole and declined to solve it:

> Recording which columns landed is a `_meta_migrations`-shaped subsystem, not a flag.

The premise is false. A resume ledger exists to make a half-applied rotation **resumable**, and a
half-rotated tenant is **unserveable either way**: `ColumnEncryptionKeySource` resolves exactly one
key per tenant per operation, so columns 1–3 under K_new and 4–7 under K_old cannot both be read by
any one key — and `data-key-envelope.ts` states the governing fact, *nothing records which key wrote
a given column*. So the split converts a recoverable failure (nothing committed, retry) into an
unrecoverable one.

Per-**tenant** scoping is what makes a single transaction plausible where per-schema did not: the
work is bounded by one tenant's rows rather than by a whole schema's.

### Finding 3 — the key row has to commit with the ciphertext

Each order is broken separately. Row first and the `UPDATE` fails → `load()` answers K_new over
K_old ciphertext and every read for that tenant is a 500. `UPDATE` first and the row write fails →
the mirror image. One transaction is the only correct arrangement, and it is available because none
of this is DDL.

It is also why the `*Within(tx, …)` seams are mandatory rather than stylistic: the real `node-pg`
binding **throws** on a nested transaction while **both** of `crypto-pg`'s fakes permit one, so a
seam that opened its own transaction would be green offline and dead live — ADR-0333's boundary, one
layer in.

### Findings 4 and 5 — two live defects in the envelope's own path

**The seed probe answered `false` for a non-owner, in the destructive direction.**
`tenantMayHoldCiphertext` issued `SELECT 1 … WHERE tenant_id = $1 LIMIT 1` through a **bare
`conn.query` with no tenant context**. Every entity table enables RLS with
`tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID`, so as a non-owner
with no context that predicate is NULL and the query returns **zero rows and no error**: the probe
answers `false`, the tenant is handed a **random** key, and PHI written the day before becomes
permanently unreadable.

The function's own doc says *"every uncertainty resolves to `true`"* and *"A probe that throws for
any other reason answers `true`"*. Both are true of the code and neither covers this case, because
**RLS does not throw — it answers confidently and emptily.** That is this repo's own
`rls_would_confine_this_session` class, and it is precisely why
`KeyRotationMigrator.surveySchema` refuses on it up front instead of counting rows. ADR-0347 records
that the *first* version of this probe was wrong and was fixed live; this is a second,
differently-shaped wrong answer in the same function, in the same direction.

**And it only ever looked in the boot schema.** The probe is called once, with the boot manifest and
the boot schema. A tenant serving their own activated manifest (ADR-0314) holds their encrypted
columns in `t_<uuid>.<table>`, which the probe never queries and whose entity names the boot
manifest may not even declare — so such a tenant reads `false`, gets a random key, and their
existing ciphertext is unreadable. ADR-0347's narrative is that the probe was changed *from* a
per-tenant-schema question *to* this one; the per-tenant-schema case became the hole rather than the
covered case.

## Decision

**`rekeyTenant`, one transaction per tenant**, in `@crossengin/crypto-pg` — the only package that
depends on both `@crossengin/kernel-pg` (the emitter and the migrator) and `@crossengin/crypto` (the
wrap), since `kernel-pg` does not depend on `crypto-pg`.

1. set the tenant context;
2. take the per-tenant advisory lock, so a concurrent `ensure` for a cold tenant cannot interleave
   and two replicas cannot race one;
3. `loadWithin` generation G, or refuse `no_data_key_row`;
4. mint a **random** DEK — there is no such thing as a seeded rekey, because seeding exists only to
   keep existing ciphertext readable and a rekey has just rewritten it;
5. refuse `new_key_equals_old` if the two resolved key **values** are equal;
6. set both key GUCs as bound parameters of `set_config`;
7. `rotateTenantWithin` — survey inside the transaction, refuse, rotate every column, then **confirm
   every rotated row reads back under the new key**;
8. `rekeyWithin` writes generation G+1 with provenance `random` and deletes every earlier
   generation;
9. commit.

**Nothing is caught.** A returned result means the ciphertext and the key row agree; a thrown error
means neither moved.

`ReencryptScope` is a **required** discriminated union — `{kind: "tenant", column, tenantId}` or
`{kind: "every_row", because}` — and all three statements the rekey issues (the `UPDATE`, the row
count and the confirm) are built from **one** `scopeWhere` clause, so the two counts it compares
cannot be about different row sets. `OLD_COLUMN_KEY_REF` joins `DEFAULT_COLUMN_KEY_REF` through the
same `columnKeyRefFor`, so both are the one-argument raising form.

The surface is `operate-server rekey --tenant <uuid> --confirm-tenant <uuid> [--plan]`, the fourth
maintenance subcommand, and it is deliberately **not** an HTTP route.

Findings 4 and 5 are fixed in the same increment: the probe is extracted to
`tenant-ciphertext-probe.ts`, every row query runs inside `withTenantContext` **and** keeps its
`tenant_id = $1` predicate — both arms, for the two roles — its tables come from
`introspectEncryptedColumns` rather than the manifest, and it asks the tenant's own schema as well
as the boot schema.

## Alternatives considered

- **Option A: a resume ledger for the per-column rotation**, as `rotateSchema`'s own doc proposed.
  - **Pros:** no interface change; the existing executor would have gained a caller unchanged.
  - **Cons:** a ledger makes a half-applied rotation resumable **in principle** and leaves it
    unreadable **in fact**, because one key is resolved per tenant per operation.
  - **Why not:** it solves the wrong problem. The atomic unit for a per-tenant key is the tenant,
    and once it is, no ledger is wanted at all. `rotateSchema` keeps its per-column transactions,
    and its doc now says what they are *right* for — a rotation whose key is not per tenant, i.e. a
    KEK rotation, where every row in the schema is under one key pair.

- **Option B: an optional tenant predicate on `ReencryptColumnInput`.**
  - **Pros:** one fewer type; every existing call site compiles untouched.
  - **Cons:** an optional parameter can be forgotten with the type still valid, and the thing
    forgotten is the difference between rotating one tenant and rotating every tenant under one
    tenant's key.
  - **Why not:** ADR-0330's rule. The discriminated union makes the unsafe branch *say why it was
    chosen* (`because`, refused when blank), which is `pg-unreachable-stores.ts`' declaration idiom.

- **Option C: drop `rls_would_confine_this_session` for the tenant-scoped path**, on the grounds
  that with the context set, RLS and the predicate agree, so the refusal is spurious.
  - **Pros:** the rekey would run as an ordinary non-owner service role.
  - **Cons:** it is true of the **rows** and false of the **count**. A confined session that can see
    none of them reports `0 rows re-encrypted`, byte-identical to *this tenant holds no ciphertext*
    — and the rekey's very next act is to delete the generation those rows are under.
    `probeJobQueueVisibility`'s ambiguity, in the one place where resolving it wrongly is permanent.
    And for an **owner** the tenant context is inert, because the owner bypasses RLS.
  - **Why not:** so the tenant predicate is **not a second belt beside RLS — it is the only
    confinement**, which is exactly why it has to be required, discriminated and bound. The refusal
    stays, and its detail string now says this.

- **Option D: an HTTP route rather than a subcommand**, beside `--tenant-erasure-routes`.
  - **Pros:** consistent with the other destructive platform operations; a role vocabulary already
    exists.
  - **Cons:** the lock window is proportional to the tenant's row count, so it would hold a request
    open for exactly the deployments where it matters most, and a half-applied rekey is
    unrecoverable in a way an erasure's refusal is not.
  - **Why not:** the three existing maintenance subcommands set the precedent, and this one needs no
    role vocabulary — it needs `COLUMN_ENCRYPTION_SECRET` and a session RLS does not confine, which
    is a property of the invocation rather than of a caller.

- **Option E: a value-equality check inside `kernel-pg`**, so `keys_are_the_same` would be true to
  its comment.
  - **Pros:** one refusal in one place.
  - **Cons:** it would require the key material to enter the module whose entire `keyRef` design
    exists to keep it out.
  - **Why not:** `kernel-pg` compares *references* **because** values must not enter it, and that
    comment is corrected in place rather than made true. The value check lives in the one module that
    holds both values.

## Consequences

- **Positive:** a `seeded_from_derived` tenant can be moved to a random key, which is the first time
  destroying a data key row bounds anything. `formatShreddability` gains its first caller in any
  deployment, so an operator can finally ask whether a given tenant is shreddable. Two live
  destructive defects in the seed probe are closed. `KeyRotationMigrator` has a caller, so its
  planner — `planColumnKeyRotation` and `reencryptColumnSql`, whose only non-test callers were
  inside the callerless class itself — is reachable for the first time.
- **Negative:** the rekey commits out of process, so a serving process holding the previous key in
  `buildEnvelopeKeySource`'s cache has stale state until the TTL expires. Its **reads** raise
  `Wrong key or corrupt data`, which is loud and never a wrong answer; its **writes** would store
  new values under the old key and split the tenant's data across two keys with nothing recording
  which. `--column-key-ttl-ms` bounds that window and does not close it, and
  `formatStaleKeyWindow` is what says so to the operator.
- **Neutral:** `ReencryptStatement` replaces a bare string, so `KeyRotationPlan.statement` is now
  `{sql, params}`. No non-test caller existed outside `encryption-writepath.ts`.
- **Reversibility:** the code is ordinary to revert. A rekey that has **run** is not: the tenant's
  ciphertext is under a random key whose only copy is the stored row, which is the whole point.

## Implementation notes

- `rotateTenantWithin` applies `sessionSettings` **first**, then surveys **inside** the transaction,
  so what is rotated is what was surveyed and every refusal rolls back.
- `readCount` accepts `count()`'s BIGINT-as-string (ADR-0331's measured class) and **throws** on
  anything else rather than substituting 0 — a 0 would let the confirm comparison pass vacuously.
- The migrator is constructed over `tx` and not over `input.conn`. `rotateTenantWithin` never reads
  the migrator's own connection, so the choice decides only what a mistake costs: handed `conn`, an
  accidental `rotateSchema` would run its unscoped whole-schema rewrite outside this transaction and
  outside this tenant's scope; handed `tx` it is a nested transaction the real binding refuses.
- `priorGenerationsDestroyed === 0` **throws**. `loadWithin` found a row at `current.generation`
  under this transaction's lock, so the `DELETE` had at least that row to reach; zero means the
  statement reached nothing, and the consequence is the previous generation surviving the rekey while
  the deployment believes the tenant is shreddable.
- The probe runs **one transaction per table**, not one around the loop: `PgConnection` offers no
  savepoint, so a statement that raises inside a shared transaction poisons it and every later table
  answers `25P02` — safe, but it would make the honest `false` for an absent relation unreachable the
  moment any one table was missing.
- `introspectPartitionedEncryptedTables` feeds a new `partitioned_table_unreachable` refusal.
  `ENCRYPTED_COLUMN_QUERY` filters `relkind = 'r'`, so a partitioned table carrying an
  at-rest-encrypted column is invisible to introspection and a rotation would have reported itself
  complete having skipped it. The refusal is a separate probe rather than a widening of the
  introspection, because rotating a partitioned parent *and* its leaves would double-encrypt.
- `--confirm-tenant` is required even under `--plan`, so the invocation an operator reviews is the
  invocation they re-run without the flag. There is no `--yes`: a flag meaning "I meant it" can be
  pasted from a runbook without reading the tenant id, which is the thing being confirmed.
- Two schema flags, which this subcommand cannot avoid: one `--schema` drives
  `PostgresDataKeyStore` (default `meta`) and `ColumnMappedEntityStore` (default `public`), so a
  single value would address the wrapped key correctly and the ciphertext incorrectly for at least
  one configuration — and, finding no key where it looked, provision a second one.
- The write-status gate refuses `permits_writes` with `--allow-live-rekey` as the hatch, and
  **reports** `no_tenant_row` rather than refusing, because `--api-key 'key:role:tenant'` names an
  arbitrary UUID with no `meta.tenants` row in any dev deployment (ADR-0334's boot survey found
  exactly that).

### Verified live

PG 16, a throwaway cluster, the entity table owned by the serving role and `meta.*` owned by the
migration role, so every data-key statement runs as a **non-owner** and RLS applies to it.

1. **derived mode, two tenants write PHI** — both `mrn` columns are `bytea` beginning `c30d04`
   (OpenPGP), with the plaintext absent; `meta.tenant_data_keys` holds no row, which is what
   `derived` means.
2. **envelope mode seeds both** — `gen=1 seeded_from_derived` for each, reads keep working, and the
   boot log carries `data key shreddability: derivable` **per tenant**: `formatShreddability`'s
   first caller in any deployment.
3. **the fence** — as a role that owns nothing and has no `rolbypassrls`:
   `REFUSED rls_would_confine_this_session: row-level security confines 'confined' on public.chart`.
4. **the confirmation** — `--confirm-tenant` naming the other tenant is refused; `--plan` reports
   `would rewrite 1 row(s) across 1 column(s)` and leaves both key rows untouched.
5. **the write-status gate** — refused with `still accepts writes` while the tenant was `active`;
   after `status='suspended'` the survey reads `write status: blocks_writes — this is the state to
   rekey in` and the rekey proceeds.
6. **the rekey** — `generation 1 → 2, provenance seeded_from_derived → random`,
   `1 row(s) re-encrypted, 1 confirmed readable under the new key; 1 earlier generation(s)
   destroyed`, and the shreddability line flips to `shreddable`.
7. **the tenant predicate, which is the whole increment** — tenant A's ciphertext under the derived
   key it was written with now raises `ERROR: Wrong key or corrupt data`, while tenant B's still
   returns `MRN-BBB`. An exact complement: one tenant moved and the other did not.
8. **serving after** — both tenants read, and a fresh `POST` for A under the new key returns 201 and
   reads back.
9. **the shred** — after `DELETE FROM meta.tenant_data_keys WHERE tenant_id = A`, A's PHI raises
   `Wrong key or corrupt data` **with `COLUMN_ENCRYPTION_SECRET` in hand**, while B remains
   readable. That is the thing ADR-0347 shipped the mechanism for and could not demonstrate.

### Three facts the live run produced that nothing offline could

1. **`--column-key-mode envelope` cannot provision a key for a tenant with no `meta.tenants` row.**
   `tenant_data_keys_tenant_id_fkey` is `FOREIGN KEY (tenant_id) REFERENCES meta.tenants(id) ON
   DELETE CASCADE` — ADR-0347 added it deliberately, as "the one table whose *survival* defeats its
   own purpose". The consequence nobody checked: a deployment booted with `envelope` and
   `--api-key 'ka:clinician:<uuid>'` accepts the boot, logs `column key mode: envelope`, and then
   answers **every** PHI read and write with that constraint violation — surfaced to the client as
   an HTTP **504 gateway-timeout**, a retryable status for a permanent configuration fault. And
   `--api-key` names an arbitrary UUID, which ADR-0334's own boot survey established has no
   `meta.tenants` row in any dev deployment. A boot survey named after
   `surveyUserFkReadiness` reports it, three-valued (`provisioned` / `missing` / `unknown`) for that
   function's reason: a count of 0 means either the row is absent or this role may not read the
   table, and printing the first when the second is true prints a list of tenants that are fine.
2. **A `--store pg-columns` deployment's serving role must own its entity tables**, because
   `ensureSchema` runs on every boot and its `ALTER` and `DROP POLICY`/`CREATE POLICY` statements are
   owner-only — a non-owner boot fails `must be owner of table chart`. So on the column store RLS is
   never the confinement *for the serving role*; tenant isolation there rests on the `tenant_id`
   predicates in the store's own SQL. That is the same conclusion this increment reached about the
   rekey, arrived at from the other end, and it is why the fence demonstration above needs a third
   role.
3. **`meta.tenants.schema_name` carries a UNIQUE constraint**, so two tenants cannot share one —
   which is correct for ADR-0314's per-tenant schemas and surprising for a boot-manifest deployment
   where no tenant has a schema of its own.

### Corrections to this repo's own records

1. **CLAUDE.md credited the Article 17 erasure with reaching `meta.tenant_data_keys` "by cascade".**
   It does not: `eraseSharedTablesWithin` deletes the row by name, and the `ON DELETE CASCADE` has
   **never fired and cannot**, because nothing in the workspace ever deletes a `meta.tenants` row —
   retirement is `UPDATE … SET status`.
2. **ADR-0347's open end 5 is false, and the comment asserting it cited an ADR that rejected its
   premise.** `data-key-envelope.ts` argued the stale cache is harmless because the destruction
   happens inside the Article 17 pipeline "which retires the tenant row **in the same transaction**
   (ADR-0319, ADR-0320)". ADR-0320 has a section headed *"The tenant row is retired **after** the
   pipeline commits"* and lists retiring it inside the transaction as **rejected**. Both legs are
   additionally conditional: the retirement runs in a `try`/`catch` reporting `tenantRetired: false`
   on a **200**, and `--tenant-status-gate` is opt-in and off by default.
3. **`KeyRotationMigrator`'s declaration claimed `planColumnKeyRotation` and `reencryptColumnSql`
   are "pure and reachable through the package's exports".** Their only non-test callers were inside
   that class's own methods, so they were reachable only through `index.ts`'s `export *` — precisely
   the false-"reached" ADR-0337 measured and refused a transitive fence over. Wiring the executor
   wires the whole **planning** path for the first time, not merely the execution half.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The stale-key window is bounded by a TTL and not closed. Closing it needs the serving fleet told — a platform route that evicts, or a generation check per operation. | Platform | _next_ |
| `--column-key-mode derived` still has no rotation, and the HKDF generation is exposed by no flag — now for a better reason: a rekey mints a new **data key** generation, so the derived seed is only ever the default. | Platform | _next_ |
| No `key_generation` column on the entity tables, so a partial rekey remains unsafe and the single transaction is the whole defence. A kernel change reaching `emitEntityTableDdl` and the trigger path. | Platform | _later_ |
| `PostgresDataKeyStore.destroy` still has no caller: the erasure deletes the row by name. That is `pg-unreachable-stores.ts`' question asked of a *method*, which the rule does not ask. | Platform | _later_ |
| The KMS-held KEK (ADR-0347 open end 2) is untouched, and is the only thing that would support a claim stronger than a bounded horizon. | Platform | _later_ |
| **The Article 17 erasure does not reach a boot-manifest tenant's entity tables at all** — see ADR-0350. Until that lands, the horizon this increment bounds is measured from a destruction that does not happen. | Platform | _now_ |

## References

- ADR-0347 — the DEK envelope, and the open end this closes.
- ADR-0338 — the derived per-tenant column key, and the GUC that must raise rather than yield NULL.
- ADR-0333 — what a fake `PgConnection` structurally cannot see.
- ADR-0334 — converting a page-one failure into a boot refusal; the `meta.tenants` row survey.
- ADR-0331 — `NUMERIC`/BIGINT as a string from node-postgres.
- ADR-0330 — an optional field can be forgotten with the type still valid.
- ADR-0319, ADR-0320 — the deletion pipeline's one transaction, and when the tenant row is retired.
- ADR-0316 — confirm absence before committing, inverted here to confirm readability.
- ADR-0314 — per-tenant schemas, and why the probe must ask two schemas.
- ADR-0301 — a secret arrives by environment, never argv.
