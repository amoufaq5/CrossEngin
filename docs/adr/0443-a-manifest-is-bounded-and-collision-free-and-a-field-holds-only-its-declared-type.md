# ADR-0443: A manifest is bounded and collision-free, and a field holds only its declared type

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0414 (a value bound by its own type — its open questions 1, 2, 3 and 4 are closed here), ADR-0388 and ADR-0402 (`id`, `tenant_id`, `created_at`, `updated_at` reserved), ADR-0338 (classified fields are ciphertext at rest; refuse only when nothing correct breaks), ADR-0334 (`duration` refused at plan time), ADR-0331 (absent versus null), ADR-0410 and ADR-0419/ADR-0433 (`WhtCertificate` permissions and lock), ADR-0428 (unclassified personal data in the retained audit trail — its first open question is narrowed here), ADR-0345 (`list_sort_addresses_withheld_field`), ADR-0357 (the cursor-disclosure survey), ADR-0440 (the `column-schema` remedy for `--store pg-columns`) |

## Context

The external due-diligence audit's **M-13** and **M-26**, verified at `f6faf05` as *partly fixed*,
and the four open questions ADR-0414 left.

- **M-13 (manifest schema):** ADR-0388 and ADR-0402 reserve `id`, `tenant_id`, `created_at` and
  `updated_at`, but there were no size caps, and names that map to one physical object passed
  `validateManifest`: `ABTest` and `AbTest` map to one table, a reference `owner` stores `owner_id`
  beside a declared `owner_id`, and an own field could also be supplied by a custom trait.
- **M-26 (classification):** `Contact` was wholly unclassified; `Patient`'s demographics were `pii`,
  not `phi`, so not encrypted at rest; `WhtCertificate` had no permissions and no lock guard.
  Re-measured here, **both `WhtCertificate` findings were already fixed**: permissions in
  `permissions-ext.ts:165` (ADR-0410) and the lock guard in `compile.ts:474` (ADR-0419/ADR-0433).
- **ADR-0414 Q1:** an encrypted JSONB-kind column bound `String(bound)`, so `{a:1}` read back as
  `"[object Object]"`, `["x"]` as `"x"` and `7` as `"7"`.
- **ADR-0414 Q2:** `geo_point` and `geo_polygon` planned `geography(…)` and raised `42704` at boot
  without PostGIS.
- **ADR-0414 Q3:** a field set to `null` read back present on `--store pg` and absent on
  `--store pg-columns`.
- **ADR-0414 Q4:** fields published as `type: "string"` accepted the JSON number `42`. ADR-0414
  recorded **210**; at this tree the figure is **197** of `erp-core`'s 327 string-published own
  fields (text 97, reference 79, long_text 11, country_code 5, phone 4, url 1), re-derived by the
  review, or 211 counting server-owned fields. The implementer attributed the change to `decimal` now
  publishing `oneOf`; ADR-0414's 210 already excluded `decimal`, and the review's 211 points at the
  fields ADR-0421 made server-owned instead. The two stores already disagreed on such a write
  (`pg` kept `42`, `pg-columns` returned `"42"`), and the in-repo console sends a number only for an
  `integer` input.

Pack maxima, measured before choosing caps: the largest resolved pack is `erp-grocery` (56 entities,
145,406 bytes); `erp-core` is 51 entities, 427 own fields and 133,843 bytes (ADR-0414 counted 426);
at most 21 resolved fields per entity, 10 enum values, `maxLength` 500 and decimal precision 20.

## Decision

**A manifest is bounded.** `packages/kernel/src/manifest/limits.ts` caps a manifest at 4 MiB, 500
entities, 400 fields per entity, 1000 enum values, `maxLength` 10 MiB and decimal precision 1000 —
far above every shipped pack, all seven of which validate under them.

**A manifest whose names collide physically is a validation error** (ADR-0348's split: a property of
the manifest alone). Refused, each by name:

- two entities mapping to one table, and any identifier over 63 bytes
  (`POSTGRES_IDENTIFIER_MAX_BYTES`);
- a column collision, including a reference `x` whose stored `x_id` clashes with another field or
  with `id` / `tenant_id`;
- an own field a trait also supplies, and two traits supplying one field;
- a join table colliding with an entity table or with another pair's join table;
- **a derived index or foreign-key name** over 63 bytes or duplicating a table, a join table or
  another derived name (`checkDerivedNames`, added by review). The first version checked tables and
  columns only, and four adversarial manifests passed and collided: `Order.line_item` and
  `OrderLine.item` both derive `order_line_item_uniq`, and `Order`'s `idx_order_tenant` is the table
  of an entity `IdxOrderTenant`. Postgres silently truncates past 63 bytes and the DDL is
  `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`, so the second index was silently skipped and the
  second foreign key dropped the first.

Every derived name is spelled once in `ddl/identifiers.ts` (`joinTableName`, `joinTableColumns`,
`uniqueIndexBaseName`, `trigramIndexBaseName`, `tenantIndexName`, `foreignKeyBaseName`) and read by
both the DDL emitter and the validator, so the two cannot disagree about what a name will be.

**Patient demographics are `phi`, and personal fields elsewhere are `pii`.** All seven personal fields
on `Patient` are now `phi` (six moved from `pii`). `Contact`'s four personal fields,
`Employee.given_name` / `family_name` and `Account.billing_email` are `pii`, with explicit grants so
the roles that read them keep reading them; the one exception, for `erp_viewer` over seven fields, is
pinned in `permissions.test.ts`. Classified fields go from 46 to 53 (25 `pii`, 17
`commercial_sensitive`, 10 `phi`, 1 `regulated`).

**An encrypted column that is not `bytea` refuses the boot.** `ensureSchema` migrates additively, so
on an upgraded `--store pg-columns` + `erp-healthcare` deployment the six newly `phi` columns stay
TEXT/DATE: every Patient write stored the text form of the ciphertext and every read raised
`pgp_sym_decrypt(text, text) does not exist`. `EncryptedColumnNotCiphertext` is thrown before both the
applying and the verifying branch, through `ENCRYPTED_COLUMN_TYPE_SQL` — a `pg_catalog` read a
non-owner role can run — and no query is made when nothing is encrypted. Refusing breaks nothing
correct (ADR-0338): every request it stops was already failing.

**A JSONB-kind or array encrypted column is encrypted as JSON text** and parsed on decrypt; a scalar
encrypted field still binds `String()`, so no existing ciphertext changes. An encrypted field written
as `null` binds SQL NULL — found live: it stored the encrypted text `"null"` — and a decrypted JSON
`null` reads as absent.

**`geo_point` and `geo_polygon` are refused at plan time** with `UndecidedColumnTypeError`, the
treatment ADR-0334 gave `duration`.

**A null field is absent on all three stores**: dropped on write (`withoutNullFields`), and the
document store drops it when reading an older document. A typed column holds one NULL for both, so
*absent* is the only reading both stores can give.

**A string-published field holds a string.** The string-published kinds reject a non-string with
code `type`, and an enum requires a string. The type is enforced rather than the published schema
loosened, because the stores already answered such a write differently, so no correct client breaks.

## Alternatives considered

- **Loosen the published schema instead of enforcing the type (ADR-0414 Q4's other option).**
  Refused: the write it would bless was stored as a number on one store and a string on the other.
- **The implementer's upgrade remedy, `crossengin-pg encrypt --plan` then `--apply`.** Refuted by
  review: it rewrites the whole column under one key with no tenant filter, while this store reads
  each tenant's rows under that tenant's derived key, so on a multi-tenant table it produces
  ciphertext the server cannot read.
- **Encrypt every encrypted column as JSON text, scalars included.** Refused: it would change the
  stored format of every existing encrypted scalar (`Patient.mrn`, `Citizen.national_id`), where the
  JSONB-kind change touches no shipped field.
- **Check only table and column names.** Refused on review's four adversarial manifests above.
- **Caps at the pack maxima.** Refused: a cap that refuses a shipped pack, or one a little larger,
  refuses a working deployment; the caps bound abuse, not growth.

## Consequences

- **Positive:** a manifest cannot silently lose an index, a foreign key or a column to a name
  collision; patient demographics are ciphertext at rest on `--store pg-columns`; Contact, Employee
  names and `Account.billing_email` are redacted where classification reaches, including the
  retained audit trail (ADR-0428 Q1 narrowed); encrypted JSON round-trips its type; the two stores
  agree on `null` and on a number sent to a string field.
- **Negative:**
  - An upgraded `--store pg-columns` + `erp-healthcare` deployment now **fails at boot** until the six
    columns are `bytea`, where before only Patient requests failed. The refusal names the columns and
    gives `ALTER … TYPE bytea USING NULL` for an empty table only; **no shipped command converts a
    populated table per tenant**.
  - On `--store pg-columns`, `?family_name=` and `?q=` over patient names are 400 and the default
    family-name sort on the patient list is not applied.
  - `Employee.family_name` is `pii` and the default list sort in all seven packs, so
    `list_sort_addresses_withheld_field` would now name 8 fields instead of 1. Latent: no pack
    declares a row-filtering policy.
  - `erp-core` gains sortable classified fields — the survey reads 4 after this change
    (`Account.billing_email` and `Employee.given_name` / `family_name` / `work_email`), measured over
    the resolved pack after the commit. `Employee.family_name` is also the list's **default** sort,
    so on a deployment that has not set `CURSOR_ENCRYPTION_SECRET` every unsealed Employee cursor
    now carries a classified value with no `?sort` at all. That is not a disclosure on the shipped
    packs: every role that may list Employee may also read `family_name` (its field grant is
    `HR_READERS`, the same set as the entity's `list`), so nothing withheld travels; the field whose
    value a caller can extract this way remains `?sort=work_email`. A pack that narrowed
    `family_name`'s read grant would make the default sort the disclosing member. Sealed when the
    secret is set, which `.env.example` ships uncommented (ADR-0377).
  - A client sending a number to a string field gets 422 `type` on both stores.
- **Neutral:** `erp-healthcare` already needed `--store pg-columns` with `COLUMN_ENCRYPTION_SECRET`, or
  `--allow-plaintext-phi` on `pg`, because of `mrn`; that requirement is unchanged. The shipped compose
  (`erp-core` on `pg`) is unaffected by the boot refusal.
- **Reversibility:** the caps, name checks and type check are validation and handler changes; the
  reclassification is a pack change, but undoing it after ciphertext is written needs a data
  migration.

## Implementation notes

- Changed: `packages/kernel/src/ddl/identifiers.ts`, `manifest/limits.ts` (new), `manifest/validate.ts`
  (`checkManifestLimits`, `checkTraitFieldCollisions`, `checkPhysicalNames`, `checkDerivedNames`),
  `manifest/index.ts`; `packages/operate-runtime/src/validation.ts`, `store.ts`, `entity-audit.ts`
  (comment); `packages/operate-runtime-pg/src/column-store.ts`, `records.ts`, `entity-ops.ts`,
  `column-plan.ts`, `entity-ddl.ts`, `tenant-schema-diff.ts`; `packages/pack-erp-core/src/entities.ts`,
  `entities-hr.ts`, `permissions.ts`; `packages/pack-erp-healthcare/src/entities.ts`; with tests
  alongside, including one `entity-ddl.test.ts` describe checking every emitted name against
  `validateManifest`.
- In process, after review: kernel 978/978, types 95/95, operate-runtime-pg 844/844, testing 909/909,
  packs core 62, healthcare 47, retail 35, grocery 29, construction 36, education 35, government 35.
  operate-runtime 1492/1493: the failure is `compile.test.ts`'s option-forwarding fence over another
  slice's idempotency options. Typecheck clean on kernel, operate-runtime, operate-runtime-pg and the
  packs.
- Mutation-checked, each reversed: the table, system-column, column and trait collision checks; the
  manifest byte cap; the string type check and null-dropping on create; JSON encrypt and decrypt; the
  geo refusal; null handling in the document store's read and merge; the two encrypted-null fixes;
  the `checkDerivedNames` call and its guards; the column-type probe call (3 fail); inverting the
  `bytea` test (4 fail); disabling the nothing-encrypted early exit (1 fail).
- **Implementer, live on PG 16 as the non-owner `serving` role:** encrypted `json` round-trips object,
  array, `"s"`, `7`, `"7"` and `true` with their types and the stored bytes are ciphertext
  (`c30d04…`); encrypted integer and boolean come back as a number and a boolean; a null field is
  absent on create, read and clear on both stores, and a legacy JSONB `null` reads absent; geo kinds
  refused at plan time.
- **Review, live on PG 16:** as the owner, a plain boot applied and reclassifying the field raised
  `EncryptedColumnNotCiphertext ["live_m13.widget.mrn (text)"]`; a fresh `phi` boot and a rerun
  applied with `mrn` as `bytea`. As the non-owner `serving` role the same refusal fires on the
  verifying branch.
- **Independent live run** on PG 16, migrated as the owner (990 statements, 0 failed), the API as
  `crossengin_app` unless an arm said otherwise:
  - two entities mapping to one table, `owner` vs `owner_id`, trait field collisions, a derived
    unique-index name collision, a table name over 63 bytes, 1001 enum values and 401 fields: each
    accepted before, `crossengin validate` exit 1 naming it after; a 400-field manifest stays valid;
  - a `geo_point` field: `42704` at boot before, `column-schema` exit 1 *"needs PostGIS"* with nothing
    created after;
  - `name: 42`: stored differently per store before, 422 `type` on both after;
  - a field created or cleared to null: present on `pg` and absent on `pg-columns` before, absent on
    both after; an encrypted PHI field set to null: SQL NULL, absent on read;
  - Patient demographics: plaintext before, `bytea` with header `c30d04090308` (AES-256 / SHA-256)
    after;
  - a PHI column that is not `bytea`: a per-request 500 before, a boot fatal naming the column after.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Three `apps/operate-server` tests pin the old classifications and now fail: `sensitive-field-policy.test.ts` (46 → 53) and two in `abac-obligations.test.ts` (8 entries naming `Employee.family_name`; `Patient.family_name` is now `phi`). Rewriting them needs a decision on whether `Employee.family_name`'s default sort should stay. | CrossEngin platform | _unscheduled_ |
| No tool converts a populated encrypted column to `bytea` per tenant, so an upgraded `pg-columns` + `erp-healthcare` deployment holding patients has a named refusal and no shipped remedy. | CrossEngin platform | _unscheduled_ |
| Per-tenant manifests go through `applyTenantManifestSchema`, not `ensureSchema`, so the TEXT-versus-`bytea` case is not checked there. | CrossEngin platform | _unscheduled_ |
| Ciphertext an older binary wrote for `null` still reads back as the text `"null"`, and a legacy encrypted JSONB string `"7"` would read as the number 7. No shipped field is in that state. | CrossEngin platform | _unscheduled_ |
| Array elements of string kinds are not type-checked. | CrossEngin platform | _unscheduled_ |
| A number sent to an enum field answers `enum` while one sent to a text field answers `type` (live). | CrossEngin platform | _unscheduled_ |
| `Contact.title` and free-text `notes` / `memo` fields stay unclassified, so their values still reach the retained audit trail (ADR-0428 Q1). | CrossEngin platform | _unscheduled_ |
| The decrypt paths for encrypted `DATE` and other scalar types were not reviewed. | CrossEngin platform | _unscheduled_ |

## References

- `packages/kernel/src/manifest/limits.ts`, `validate.ts`; `packages/kernel/src/ddl/identifiers.ts`
- `packages/operate-runtime/src/validation.ts`, `store.ts`
- `packages/operate-runtime-pg/src/column-store.ts` (`EncryptedColumnNotCiphertext`,
  `ENCRYPTED_COLUMN_TYPE_SQL`), `column-plan.ts`, `entity-ddl.ts`, `records.ts`
- `packages/pack-erp-core/src/entities.ts`, `entities-hr.ts`, `permissions.ts`;
  `packages/pack-erp-healthcare/src/entities.ts`
- External due-diligence audit, findings M-13 and M-26
- ADR-0414, ADR-0338, ADR-0334, ADR-0331, ADR-0428
