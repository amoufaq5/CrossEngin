# ADR-0445: A column secret rotates, a write waits on the rekey, and a fenced table refuses a tenant delete by name

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0338 (per-tenant derived column keys; refuse only when nothing correct breaks), ADR-0347 (the DEK envelope and seeded provenance), ADR-0349 (`rekeyTenant`, one transaction; its stale-key window), ADR-0400 / ADR-0401 (restrictive `DELETE` fences and invariant 5), ADR-0409 (`app.platform_review` narrowed to `SELECT`), ADR-0424 (the API connects as `crossengin_app`) |

## Context

Four items from the external due-diligence audit, verified at `f6faf05`, were still open:

- **M-10, one secret derives every column key and KEK, with no rotation, pgcrypto defaults, and
  `pii` / JSONB plaintext.** Partly true: it was **overstated at audit**, because a per-tenant
  data-key rekey (ADR-0349) already existed. What held: the master secret and the KEK could not be
  rotated, the cipher was AES-128 with no AEAD, `pii` was never encrypted, the shipped `--store pg`
  JSONB store encrypted nothing, and there was no KMS. Measured before this change, pgcrypto's
  default packet header was `c30d04070302` (AES-128, SHA-1 key derivation).
- **M-25, `rekeyTenant` does not lock out concurrent writers.** True: a serving process kept a
  cached key for up to its TTL after a rekey committed, so a write could land under the destroyed
  generation. Bounded by the TTL, not closed; reachable on `--store pg-columns` in envelope mode only.
- **M-01, every RLS elevation is a `PUBLIC`-settable GUC and no policy names a role.** True:
  146 tables, 217 policies, **0** naming a role, over 7 elevation settings any session can set.
- **The ADR-0400 family.** 115 `meta` tables expose an `ALL`-scope arm with a NULL `WITH CHECK`, so a
  tenant-context session can `DELETE` its own rows; 18 were fenced and 97 not. And a fenced `DELETE`
  answered `DELETE 0` with no error code — the silent zero ADR-0400 recorded as its cost.

## Decision

**The column cipher is AES-256 with a SHA-256 key derivation.** `PGP_SYM_ENCRYPT_OPTIONS`
(`cipher-algo=aes256, s2k-digest-algo=sha256`) is passed by `pgpSymEncryptExpr`, which all five
`pgp_sym_encrypt` emitters go through. The trigger body is dollar-quoted, so the quotes in the
options literal are safe, and nothing in the tree parses the ciphertext header. Existing AES-128
values still decrypt. It is still OpenPGP CFB with MDC, not an AEAD.

**The column secret is a ring, and only envelope mode may rotate it.** Three environment variables,
never argv: `COLUMN_ENCRYPTION_SECRET`, `COLUMN_ENCRYPTION_SECRET_PREVIOUS` and
`COLUMN_ENCRYPTION_SECRET_GENERATION`. The previous secret is always generation − 1. Refused at boot:
a malformed generation; a previous secret without a generation of at least 2; a previous secret
identical to the current one; a previous secret in derived mode; and a generation other than 1 in
derived mode (`generation_in_derived_mode`), because derived mode reads no generation and the
seeding rule below depends on generation 1. The last refusal is on a variable this change introduces,
so no working deployment breaks.

**A data key is opened under the KEK generation its row records.** `PostgresDataKeyStore` takes a
`KekResolver` keyed by KEK generation; a missing generation raises `DataKeyKekUnavailable`, distinct
from `DataKeyUnwrapFailed`. A row under an older KEK is re-wrapped opportunistically when it is
read, and `operate-server rekey --rewrap-kek` re-wraps one tenant's current key on demand without
re-encrypting any column (it is refused together with `--allow-live-rekey`, which has nothing to
allow). The re-wrap `UPDATE` re-checks both the data-key generation and the KEK generation it read,
and a zero-row match **throws** rather than reporting a re-wrap.

**A tenant is seeded only from the secret its ciphertext is under.** Ciphertext written in derived
mode is under the generation-1 secret. `seedSecretOf` returns that secret only while the ring holds
it, and `null` otherwise; `resolveColumnKey` then refuses with `ColumnKeySeedUnavailable`, which
names the remedy, instead of seeding a tenant with a key its data is not under. A tenant holding no
ciphertext still gets a random key.

**A column-key write waits on the rekey and reads the generation after the wait.** The data-key
store takes a shared per-tenant lock (and a try-lock) beside the rekey's exclusive one.
`fenceColumnKeyGeneration` applies only to statements that set the column-encryption key: it takes
the shared lock, then reads the current generation **in a separate statement**. If the generation
moved it loads the new key in the same transaction and uses it (`healed`); if the key row is gone it
refuses by name (`ColumnKeyRetired`). The order is load-bearing: under READ COMMITTED a statement's
snapshot is taken when it starts, so a generation read folded into the lock statement reads the
pre-rekey row. `ColumnKeyLedger` records which generation each key came from, and **keeps a
superseded key's entry** — in envelope mode every key the column store sets comes from the ledger,
so an unknown key can only be an evicted stale one, and evicting it let it through the fence.

**Boot says what is not protected.** A line states that `--store pg` and `--store memory` encrypt
nothing, that `pii` is plaintext on every store, that the cipher is not an AEAD, and that there is no
KMS, and that only `--column-key-mode envelope` can re-encrypt.

**Six more tables refuse a tenant `DELETE`, and the fence is a declared set, not only the retention
set.** `tenantUndeletableRecord(table)` fences `crypto_audit`, `slo_enforcement_actions`,
`dr_failover_executions`, `dr_drill_executions`, `dr_readiness_snapshots` and
`notification_suppressions`; restrictive `DELETE` policies go 18 → 24. `pg-record-retention.ts`
declares them in `TENANT_UNDELETABLE_TABLES` with a reason each, and invariant 5 becomes
fence ⟺ (retained ∪ declared-undeletable), checked in both directions with three new finding kinds
(`undeletable_table_undeclared_here`, `declared_undeletable_unfenced`,
`undeletable_table_is_retained`). The rule also checks that no declared table has a tenant-context
`DELETE` writer, and that no unfenced parent `CASCADE`s into a fenced table, because RLS does not
apply to referential actions.

**The confined role is denied `DELETE` on every fenced table.** `deploy/postgres/roles/app-role.sql`
ends with `REVOKE DELETE` on each table carrying a restrictive `FOR DELETE USING (false)` policy, the
set read from `pg_policy` rather than listed. ADR-0400's silent `DELETE 0` becomes
`permission denied`. The owner opt-out path exits before the revoke, so an owner-run deployment keeps
its privilege.

**M-01 is measured and not closed in the catalog.** `crossengin_app` performs tenant and platform
writes on one role, so scoping a policy by role needs a second connection role — a deployment
change, not a policy edit.

## Alternatives considered

- **Fence every writerless unfenced table, at no mechanical cost.** Refused on measurement: the
  cascade check showed `feature_flag_changes` is a `CASCADE` child of the unfenced `feature_flags`,
  so a fence there would not hold. Six tables were fenced, not seven.
- **Close M-01 by naming roles in the policies.** Refused: one role carries both tenant and platform
  writes, so no role list can separate them without a second connection role.
- **Seed a tenant from `previous ?? current`.** Refused by review: once rotation 1 → 2 completes and
  the previous secret is unset, it seeds a tenant holding derived-mode ciphertext with the current
  secret, so every read fails and new writes land under a second key. `--rewrap-kek` cannot prevent
  it, since it answers `no_data_key_row` for such a tenant.
- **Evict a superseded key from the ledger.** Refused by review: a request that had read the old key
  before another request healed got `originOf(oldKey) === undefined`, and the fence passed it through
  as `unknown_key` — no lock, no generation check, a write under the destroyed key. The implementer's
  test pinned that eviction as the specification and is rewritten.
- **Read the generation in the same statement that takes the lock.** Refused on a live measurement:
  it waits and then reads the stale generation (below).
- **Let derived mode rotate its secret.** Refused: a derived key exists wherever the secret does, so
  there is no row to re-wrap. The route is to switch to envelope mode first, seeded from the current
  secret, then rotate; the boot refusal names it.

## Consequences

- **Positive:** new column ciphertext is AES-256 with a SHA-256 key derivation; the column secret and
  the KEK can be rotated without re-encrypting a column; a concurrent write can no longer land under a
  key a rekey destroyed; a tenant is never seeded with a key its ciphertext is not under; six more
  tables of platform evidence cannot be deleted by their tenant; and a tenant `DELETE` on any fenced
  table is a named error instead of a silent zero.
- **Negative:**
  - A tenant that may hold derived-mode ciphertext and has no data-key row is refused
    (`ColumnKeySeedUnavailable`) once the previous secret is unset. The route is to keep the previous
    secret set and serve the tenant once; the refusal and the boot line say so.
  - The ledger grows one entry per rekey, which is an operator action.
  - The fence's stated reason overreaches: `tenantUndeletableRecord` calls the six tables the
    platform's evidence about the tenant, yet the Article 17 erasure still deletes all six, since they
    are not retained. The fence is coherent (no tenant deletes them during its life); the wording is
    wider than the property.
  - ADR-0338's rule for each behaviour change: the six fences and the `REVOKE` refuse nothing correct,
    because no writer deletes from those tables (confirmed by grep and by the rule's own scan;
    suppressions have no lift path); the derived-mode generation refusal is on a new variable.
- **Neutral:** the column store wrote 2,000 rows in 254.2 ms with the new options against 300.8 ms
  with the defaults. In `kernel-pg`'s canonical test the narrowed-policy count goes 102 → 108 and the
  restrictive count 18 → 24. The review re-derived M-01 from the built catalog: 223 policies
  (217 + 6), 0 naming a role, 7 elevation settings plus the tenant one; 115 tables exposed to a tenant
  `DELETE`, 24 fenced, 91 unfenced.
- **Reversibility:** the pgcrypto options, the ring and the fence are code; dropping a fence is a
  catalog change plus re-running `app-role.sql`. Ciphertext written under AES-256 stays AES-256.

## Implementation notes

- Changed: `packages/kernel-pg/src/encryption.ts` and its tests (`encryption`, `encryption-migration`,
  `encryption-writepath`, `canonical`); `packages/operate-runtime-pg/src/column-store.test.ts`
  (expected SQL only); `packages/crypto-pg/src/data-key-store.ts`, `test-fakes.ts`,
  `data-key-store.test.ts`; `packages/kernel/src/bootstrap/meta-schema.ts` and `emit.test.ts`;
  `packages/testing/src/strategy/pg-record-retention.ts`; `apps/operate-server/src/`
  `column-secret-ring.ts`, `column-key-fence.ts` (new, with tests), `data-key-envelope.ts`,
  `column-encryption.ts`, `node.ts`, `rekey.ts`, `cli.ts`, `bin/operate-server.ts`;
  `deploy/postgres/roles/app-role.sql`, `deploy/README.md`.
- In process (review): testing 909, crypto-pg 174, kernel-pg 929, kernel 973; operate-server
  typecheck clean and 328 passed across the seven suites the review ran, including `node.test` and
  `deployment-defaults`; the full operate-server suite was not re-run. The implementer's earlier full
  run was 6062 passed and 1 failed (`manifest-view.test` `grantCount`, another lane), and
  operate-runtime-pg 808 passed with 1 failure plus a `store-parity` suite error, both
  `UndecidedColumnTypeError` on `geo_point` from another lane.
- Two workspace-rule findings were fixed at the cause: an interpolated `SET` clause became literal
  placeholders, and a local named `to` binding into `kek_generation` was renamed `kekGeneration`.
- Mutation-checked, each reversed: no pgcrypto options (7 fail); `open()` under the store's KEK
  generation instead of the row's (8, re-run independently by review: 8); no KEK-generation check in
  the re-wrap `UPDATE` (5); fence generation comparison broken (1); fence shared lock removed (1);
  `crypto_audit` fence removed (3, `declared_undeletable_unfenced:crypto_audit`); ledger eviction
  restored (2); `previous ?? current` restored (1).
- **Live, implementer, PG 16 on 5987 as the non-owner `serving` role, catalog with 24 restrictive
  policies:** a tenant-context `DELETE` on `notification_suppressions` answered `DELETE 0`, and with
  the fence flipped to `USING (true)` as a control `DELETE 2` against an owner count of 2. After
  `app-role.sql` the same `DELETE` raised `permission denied for table notification_suppressions`.
  `UPDATE` on a fenced table stayed `UPDATE 2`, by design. Readback: `DML on 122 of 146 catalog
  tables in meta (DELETE withheld on 24 fenced); owns 0 of them`.
- **Live, review, PG 16 on 5991 as a non-owner role against a concurrent exclusive-lock holder:** the
  lock-then-read in separate statements waited 1.53 s and read generation 2; folded into one
  statement it waited 1.53 s and read generation 1.
- **Live, independent run, PG 16 on 5981, the API as `crossengin_app`:**
  - The app deleting its own tenant's rows from `audit_log`, `forensic_chain_entries`,
    `notification_suppressions` and `invoices` was `DELETE 0` before and `permission denied` on all
    four after; the `job_runs` control deleted 6.
  - Derived mode with a generation or a previous secret: boot fatal naming envelope mode. A previous
    secret equal to the current one, or without a generation: fatal, fatal.
  - Envelope mode over an existing derived-key tenant: 200, key seeded from the derived key.
  - `rekey --plan` printed the plan; a mismatched confirm exited 2; a live tenant exited 1; run as the
    app it exited 1, RLS confining it. On a suspended tenant: a random key at generation 2, reads and
    writes 200 under envelope.
  - Rotation with the previous secret held: 200, the key re-wrapped on read.
  - `--rewrap-kek` on an already-current key and from KEK generation 2 to 3: exit 0 both, no column
    re-encrypted; generation 3 alone then reads 200.
  - The same run's manifest arm read `Patient` demographics as `bytea` with header `c30d04090308`
    (AES-256 / SHA-256).
- The M-25 fence through the real server, against a concurrent rekey, was not run live; it is
  tested against the fakes, with the lock-ordering premise verified live as above.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Two configurations boot clean and then fail every PHI request with an opaque 500, explained only in the log: switching back to derived mode after a rekey, and a new secret with rows still wrapped under the old generation and no previous secret. The key rows are readable at boot, so both could be boot refusals. Found live. **Closed by ADR-0455.** | CrossEngin platform | _unscheduled_ |
| `--rewrap-kek` does not provision a seeded row for a tenant that holds ciphertext and has no data-key row; the route is to keep the previous secret set and serve the tenant once. | CrossEngin platform | _unscheduled_ |
| No KMS: the KEK is derived from a secret the deployment holds. Out of scope; the boot line says so. | CrossEngin platform | _unscheduled_ |
| Derived mode cannot rotate its secret; its route is envelope mode first. | CrossEngin platform | _unscheduled_ |
| M-01: scoping elevations by role needs a second connection role for platform writes — a deployment change. | CrossEngin platform | _unscheduled_ |
| The `DELETE` revoke is applied by `app-role.sql`, so a fence added by a bare `migrate` is not revoked until `app-role` runs again, and a role that never ran it keeps the privilege. A statement-level trigger would cover both. | CrossEngin platform | _unscheduled_ |
| `feature_flag_changes` stays unfenced until its `CASCADE` parent `feature_flags` is fenced too. | CrossEngin platform | _unscheduled_ |
| `COLUMN_ENCRYPTION_SECRET_PREVIOUS`, `COLUMN_ENCRYPTION_SECRET_GENERATION` and `--rewrap-kek` appear nowhere in `deploy/`; the rotation procedure lives only in the boot line. | CrossEngin platform | _unscheduled_ |
| The at-rest honesty line covers the boot manifest only, not a tenant's activated one. | CrossEngin platform | _unscheduled_ |
| The cipher is still OpenPGP CFB with MDC, not an AEAD, and `pii` is still plaintext on every store. | CrossEngin platform | _unscheduled_ |

## References

- `packages/kernel-pg/src/encryption.ts` (`PGP_SYM_ENCRYPT_OPTIONS`, `pgpSymEncryptExpr`)
- `packages/crypto-pg/src/data-key-store.ts` (`KekResolver`, `rewrap`, `DataKeyKekUnavailable`)
- `apps/operate-server/src/column-secret-ring.ts`, `column-key-fence.ts`, `data-key-envelope.ts`
  (`ColumnKeyLedger`, `ColumnKeySeedUnavailable`), `column-encryption.ts`, `rekey.ts`
- `packages/kernel/src/bootstrap/meta-schema.ts` (`tenantUndeletableRecord`)
- `packages/testing/src/strategy/pg-record-retention.ts` (`TENANT_UNDELETABLE_TABLES`)
- `deploy/postgres/roles/app-role.sql`
- ADR-0338, ADR-0347, ADR-0349, ADR-0400, ADR-0401, ADR-0409, ADR-0424
