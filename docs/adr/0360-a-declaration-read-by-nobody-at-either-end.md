# ADR-0360: A declaration read by nobody at either end

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0283, ADR-0290, ADR-0295, ADR-0307, ADR-0314, ADR-0322, ADR-0331, ADR-0334, ADR-0336, ADR-0337, ADR-0338, ADR-0348, ADR-0350, ADR-0353, ADR-0359 |

## Context

`Field.unique` is declared in `packages/types/src/meta-schema/field.ts`, validated by
`validateManifest`, merged across `meta.extends` lineage, hashed into `manifestHash`, and **45
distinct (entity, field) pairs** declare it across the seven resolved packs. Zero UNIQUE constraints
existed on any of the 54 entity tables, and none ever had.

The register (P0 item 7) recorded this as *"`unique: true` emits no constraint on any entity table
**while the UI says the field is unique**"*, and that second clause is false. The declaration had
**two** readers in the whole workspace and neither emitted anything:

- `packages/kernel/src/ddl/diff.ts:152` reads it only to **throw** `UnsupportedDiffChangeError` when
  it changes — a refusal to migrate a constraint nothing enforces.
- `packages/operate-runtime/src/ui-schema.ts:171` copies it onto the `UiSchema`. And `unique` occurs
  **exactly once in the whole `apps/operate-web` tree**: the type declaration
  `readonly unique?: boolean` at `lib/schema.ts:26`. No component reads it — not `FieldInput.tsx`,
  not `SchemaView.tsx`.

So the defect is one notch **worse** than the register claimed, not better. *The UI says the field is
unique* would at least have been a promise. What was actually true is that the declaration was
authored, validated, hashed, serialized to every client, and read by nobody at either end — P1 item
2's shape (*authored, validated, hashed, read by nothing*) reaching **inside** a section that
otherwise is served.

The consequences were live on the shipped stack. Two employees could share an `employee_number`, two
patients an `mrn`, two invoices an `invoice_number`. 47 source declarations, 34 of them in
`erp-core`'s own domain — the accounting identifiers the double-entry core keys on.

Three further facts shaped the work, each found by measuring rather than by reading:

1. **`UniqueHintSchema` is `boolean | {scope: string[]}`** and has been since it was written, so a
   manifest can already declare a composite key. Any fix reading `field.unique === true` **silently
   drops** it. Measured: 0 of 47 use the scoped form, and `ddl/diff.ts` compares it with `deepEqual`
   while `ui-schema.ts` flattens it to `true` — so the structural diff is stricter about `unique`
   than any emitter was.
2. **14 of the 45 carry a `sequence` default** (`Invoice.invoice_number`, `PurchaseOrder.po_number`,
   … `INV-{YYYY}-{SEQ:5}`). A `23505` on one the caller omitted is the *allocator* having handed out
   a number it had already handed out — an internal fault, not a user error.
3. **The document store cannot carry the guarantee at all.** On `--store pg` — the shipped compose
   default — every entity's records live in one shared catalogued table whose only UNIQUE is
   `(tenant_id, entity, record_id)`; `PostgresEntityStore` has no `ensureSchema`, so there is no DDL
   seam; and enforcing a *field* would need a partial unique expression index per (entity, field),
   which `META_TABLES` cannot declare because the catalog cannot know a manifest and which
   `diffSchema` would then report as undeclared drift on every check forever. So the honest headline
   for that deployment is **0 of 32 enforced**, which is a bigger number than the
   encrypted-withholding one and the one an operator actually needs.

## Decision

**A declared `unique` is emitted as a per-tenant unique index, withheld only where a store cannot
carry it, and said at boot either way.**

### The index

`emitUniqueIndexDdl(plan)` emits, per column declaring `unique` and not encrypted at rest:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "<table>_<col>_uniq"
  ON "<schema>"."<table>" ("tenant_id"[, ...declared scope], "<col>");
```

**`(tenant_id, …)` and never `(col)` alone**, which is the whole of why this could not be an inline
`UNIQUE` in the `CREATE TABLE` copied from the field: these tables are multi-tenant with a
`(tenant_id, id)` primary key, so a bare `UNIQUE (col)` would make one tenant's `employee_number`
collide with another's — a cross-tenant coupling, the one thing the isolation model exists to
prevent. The uniqueness a pack means by `unique: true` is uniqueness *within a tenant*.

Tenant **first**, before the declared scope, because a multi-column index serves a prefix of its own
columns: leading with `tenant_id` makes the index useful to the tenant-filtered lookups every read
here issues, where leading with the scope would leave it serving a cross-tenant prefix no query asks
for.

An **index** rather than a table constraint, and separately from `CREATE TABLE`, because
`ensureSchema` re-runs on every boot and `CREATE TABLE IF NOT EXISTS` no-ops on an existing table —
so an inline constraint would apply to tables created from this manifest and be silently skipped for
every table an earlier manifest created, which is `emitAddColumnDdl`'s reason one constraint over.

### The scope, read in both its forms

`ColumnMapping.uniqueScope: readonly string[] | null` replaces what would have been a boolean:
`null` declares none, `[]` is unique within the tenant, `["department_id"]` within
`(tenant, department_id)`. `field.unique === true` would answer `null` for a declared composite key,
which is a silent drop in an emitter deciding a **constraint** — this increment's own class inside
its own fix.

A scope names sibling **fields** and the index needs their **columns**, so `columnPlanForEntity`
resolves them in a second pass and throws `UnresolvableUniqueScopeError` on one it cannot resolve.
That follows `UNDECIDED_SQL_TYPES`' precedent in the same function: a plan that cannot be built
honestly throws, and `applyTenantManifestSchema` catches it and reports a blocking change
(ADR-0334's `unservable_field_type`). The alternative — emitting the index without the unresolved
column — would silently enforce a **stricter** constraint than the manifest declares, refusing
writes a reviewer approved.

`validateManifest` refuses it first, as a **validation error and not a boot refusal**, on ADR-0348's
split: an obligation's dischargeability is a property of the *deployment*, while this is a property
of the manifest alone, so it is decidable by a pack author, by `crossengin validate`, by the pack's
own suite and by the reviewer approving what the Architect designed — and a rule checkable earlier
should be. Over `resolvedFields` and not `entity.fields`, because a unique field and the field its
scope names can both arrive from a **trait**. A scope naming the field itself is refused too, with
`unique: true` as the remedy: it degenerates to the unscoped form, so it is not wrong so much as a
declaration that does not say what its author thinks.

### These statements can fail, and that is why they are separate

Adding a unique index to a populated table holding duplicates raises `23505`, and no amount of
`IF NOT EXISTS` helps — **the condition is in the data, not in the catalog**. `kernel-pg`'s
reconciler draws exactly this line already (*"every step in the plan is expected to succeed; anything
whose outcome depends on existing data is reported with the SQL instead"*), so the indexes run
**last**, each in its own try, and a failure is reported while the remaining indexes are still
attempted (ADR-0295's continue-past-a-failure rule). Last for a mechanical reason as well as a safety
one: an index can be on a column `emitAddColumnDdl` has only just added, so it must follow the whole
additive sequence and not merely the `CREATE TABLE`.

**In the per-tenant applier a try/catch alone would have shipped the opposite of that design, and
this was measured rather than reasoned.** `applyTenantManifestSchema` runs the whole application
inside one explicit `conn.transaction(...)`, unlike `ColumnMappedEntityStore.ensureSchema`, which
issues each statement on `this.conn` as its own implicit transaction. In Postgres a raise aborts the
containing transaction: every later statement answers `25P02 current transaction is aborted` and the
`COMMIT` becomes a rollback. So the catch would have reported a refusal it had in fact turned into
the total schema-application failure the design exists to prevent — and that failure is what
`TenantColumnStoreRegistry` degrades to the JSONB fallback (ADR-0314), where the tenant's data is in
a different place than they think and no field is encrypted. Per-statement savepoints are
`check-admission.ts`' and `expression-render.ts`' established idiom, and `ROLLBACK TO SAVEPOINT`
leaves the savepoint established, so the loop must `RELEASE` as well or a tenant with many unique
fields grows a subtransaction per index. Both halves verified live on PG 16.13 (see
*Implementation notes*).

### A violation is a 409 — **only** when the caller named the field

`UniqueViolation {entity, field}` carries a `23505` the store could attribute, and `writeTxn`
answers **409** `unique_violation` naming the field. This is the one exception to that catch's *"the
body names nothing"* rule: everything else reaching it is a condition the caller cannot act on, which
is why its body is a fixed sentence, and a unique violation is the one write failure the caller is
the **only** party who can fix, by sending a different value. The field name is not a disclosure
because they supplied it. Answering the fixed 500 there would have enforced uniqueness and made the
refusal undiagnosable — this increment's own class in a new place.

**And the exception is scoped by its own reason**, which is why `callerKeys` is a required fourth
parameter on `writeTxn` and not a convenience. *The caller supplied the value* is the whole
justification, so where they did not, it evaporates: on the 14 sequence-defaulted fields, a `23505`
the caller did not provoke is an internal fault, and telling that client `'invoice_number' must be
unique … another record already holds that value` is an instruction they cannot follow for a value
they never sent. Those take the fixed 500 and the diagnosis stays with the operator.

The keys come from `parsedBody`, which is what the create handler already reads for the write mask,
for the same reason and in so many words: *"a sequence / literal / settings default and the
`created_at`/`updated_at` stamp are the server writing a field, not the caller writing it."* One
rule, read twice. A delete and a transition pass `NO_CALLER_SUPPLIED_FIELD` — a named empty list
rather than a bare `[]`, because the empty set is the *claim* there and ADR-0331's rule is that
*nothing* and *nobody looked* stay distinguishable wherever the difference decides an answer. Here it
decides a 409 against a 500.

**409 and not 422**: the value is well-formed and the request would have been valid a moment earlier
or in another tenant, so this is a conflict with current state rather than a malformed body — the
same distinction `conflict_idempotency_mismatch` draws.

An **unattributable** `23505` — a constraint this store never emitted — is re-thrown untouched.
Claiming a field for a constraint we cannot attribute would be a guess in an error message, and an
unattributable duplicate is exactly as opaque as it was before, which is honest rather than improved.
The attribution goes through `uniqueIndexFields`, derived from the same function that generated the
name rather than parsed back out of it, because `uniqueIndexName` truncates at 63 characters and a
parser would have to guess where the column started.

### The boot line, over the manifest and not the store

`surveyUniqueEnforcement(manifest, storeKind)` is a pure function over a **total map across the three
store kinds**, and that is the decision rather than taking the withheld list from the store: the two
stores that enforce nothing have no plan to ask, and **those are exactly the deployments carrying the
headline**. A store-sourced survey would have reported the small figure on the deployment that is
mostly right and printed nothing on the deployment that is wholly wrong.

It **reports and never refuses**. ADR-0338's premise does hold — zero UNIQUE constraints existed, so
*the refusal breaks nothing that worked* is satisfied — and two measurements take it away. The
remedy cannot work: the declarations are in builtin packs, and on `--store pg` + `erp-core` 32 of 32
are unenforceable with no action an operator owns short of a data migration, so a refusal would be
ADR-0334's *remedy that cannot work is worse than none*. And the deciding half: the degradation is
**permissive, not a wrong answer**. A plaintext PHI column is incoherent — the manifest says the
value is protected and it is not. An unenforced `unique` is a missing constraint: every read returns
the right rows, every write stores what it was given, and the only consequence is that a duplicate
can be created. ADR-0359 drew this line one increment ago — *a surface whose drop changes WHICH rows
come back is refused; one whose drop changes only their ORDER is reported* — and an absent unique
index changes neither.

**Where the store can answer, it is asked, and the two answers are compared.** They are independent
derivations of one fact — the survey reads `resolvedFields` and `requiresEncryptionAtRest` off the
manifest, the store reads `encryptAtRest` off the column plan the emitter is driven by — so a
divergence does not make the DDL wrong, it makes the *line* wrong, and an operator reading
`33 of 34 enforced` would be trusting a figure that no longer describes the indexes. Compared as sets
of (entity, field) and not by count, because two lists of equal length naming different fields is the
divergence a count cannot see. It is free, since the plans exist by the time it runs — and it is also
what keeps the store's method from being a second spelling with only a test behind it, which was its
state for about an hour of this increment.

## Alternatives considered

| Option | Why not |
|---|---|
| An inline `UNIQUE (col)` in `CREATE TABLE`, copied from the field | Cross-tenant: one tenant's `employee_number` would collide with another's. And `CREATE TABLE IF NOT EXISTS` no-ops, so it would apply to new tables and be silently skipped for every table an earlier manifest created. |
| An inline `UNIQUE (tenant_id, col)` in `CREATE TABLE` | Correct in scope and still skipped on an existing table, for the second reason above. |
| Run the indexes with the other statements | Their outcome depends on existing **data**. One tenant's duplicate rows would stop the whole deployment booting, over a guarantee the table was serving without. |
| A try/catch rather than a savepoint in the per-tenant applier | Measured false: a raise aborts the containing transaction, so the catch reports a refusal it has turned into total failure. 5 tests fail on this mutation. |
| Read `field.unique === true` | Silently drops `unique: {scope: [...]}`, which the schema has always admitted. 0 declarations use it today, so reading it costs nothing and is the only reading that cannot go quietly wrong later. |
| Refuse the scoped form in `validateManifest` instead of implementing it | Narrows a manifest contract that has always admitted it, and the column store can express it in one line. The refusal that *is* right is a scope naming a field that does not exist. |
| Emit the index without an unresolved scope column | Enforces a **stricter** constraint than the manifest declares, refusing writes a reviewer approved. |
| 409 for every `UniqueViolation` | Wrong for the 14 sequence-defaulted fields: it instructs a client to change a value they never sent, for an allocator fault. |
| 422 instead of 409 | The value is well-formed; this is a conflict with current state. |
| Name the field for an unattributable `23505` | A guess in an error message. |
| Take the boot survey's withheld list from `store.uniqueWithheld()` | `--store pg` and `--store memory` have no plan to ask, and those are the deployments with the big number. |
| Report `--store memory` under `document_store` | `memory` is not the document store and that sentence would be false of it; `boot-erasure-report.ts` refuses the same conflation. It gets `no_durable_store`. |
| Refuse at boot when any declaration is unenforceable | The remedy is a data migration no flag can perform, and the degradation is permissive rather than a wrong answer. ADR-0359's own line. |
| `Record<UniqueWithheldReason, UniqueEnforcementReason>` for the coverage fence | Breaks whenever the app's `dist` is a build behind the package's source — ADR-0307 and ADR-0329's conditional green. A type-level `extends` is green against both and errors only on a genuinely unknown reason. |

## Consequences

- 45 declared unique fields are enforced where a store can carry them, per tenant. Measured live:
  33 of 34 on `erp-healthcare` + `--store pg-columns`, 32 of 32 on `erp-core`.
- **A duplicate is now a 409** where it used to be a silent second row — a caller-visible behaviour
  change on every create and update touching one of the 45 fields.
- `writeTxn` gained a **required** fourth parameter. Four call sites; the compiler asks.
- `TenantSchemaApplication` gained a **required** `uniqueIndexRefusals` field. `[]` is the claim.
- A tenant whose existing rows hold duplicates gets their schema applied with one guarantee
  withheld, reported, rather than being pushed to the JSONB fallback.
- The `[unique]` boot line is said on all three stores, either way, including when the figure is
  zero — which is the half that would have surfaced this four phases ago.
- **`Patient.mrn` and `Citizen.national_id` remain unenforced**, in whichever deployment serves their
  pack. `pgp_sym_encrypt` is non-deterministic, so a UNIQUE over ciphertext never fires — verified,
  both rows insert. This is a choice between two guarantees, not a misconfiguration.

## Implementation notes

**Measured, against the committed tree and the real resolved packs.** 45 distinct (entity, field)
pairs; 47 source declarations; 238 (pack, entity, field) triples counting lineage repeats; `erp-core`
**32** — the register said 34, which is the *resolved `erp-healthcare`* figure transposed onto the
pack that is its base. 0 of 47 use the scoped form. 14 are sequence-defaulted. **2** are
`phi`/`regulated`, and they are in **different packs** (`Patient.mrn` in healthcare,
`Citizen.national_id` in government), so no single deployment holds both and the per-deployment
withheld count on `pg-columns` is at most 1. None of the 45 is `pii` or `commercial_sensitive`, so
the encrypt-at-rest interaction is the only classification interaction there is and *reclassify below
phi/regulated* names the whole of the available move.

**The savepoint, verified live on PG 16.13.** Without one, inside a single explicit transaction, the
`23505` aborts it: the next statement answers `current transaction is aborted, commands ignored
until end of transaction block`, the `COMMIT` returns `ROLLBACK`, and a table created earlier in the
same transaction is gone. With one, the failure is contained, **`RELEASE SAVEPOINT` after
`ROLLBACK TO SAVEPOINT` succeeds** — so the savepoint was still established and the extra release is
necessary rather than redundant — the transaction stays live, and everything else commits.

**The three boot lines, live as a non-owner role.**

```
--pack erp-core --store pg
[unique] declared unique fields: 0 of 32 enforced on --store pg
  32 withheld (document_store): the JSONB document store shares one table across every entity and
    has no DDL seam, so a per-field UNIQUE cannot be declared there
    Invoice.invoice_number, Item.sku, Warehouse.code, Vendor.vendor_code, … (+24 more)
    remedy: serve this manifest on --store pg-columns, which emits one unique index per field;
      measured on this manifest, that would enforce 32 of these 32

--pack erp-core --store pg-columns
[unique] declared unique fields: 32 of 32 enforced on --store pg-columns — one unique index per
  field on (tenant_id, …any declared scope, column)

--pack erp-healthcare --store pg-columns
[unique] declared unique fields: 33 of 34 enforced on --store pg-columns
  1 withheld (encrypted_at_rest): …pgp_sym_encrypt is non-deterministic, so a UNIQUE over it never
    fires
    Patient.mrn

--store memory
[unique] declared unique fields: 0 of 32 enforced on --store memory
  32 withheld (no_durable_store): …keeps records in a Map keyed on the record id and scans no field
```

34 declared minus 1 encrypted is 33, and `pg_indexes` reports exactly 33 `%_uniq` indexes with 0 on
`mrn` — the arithmetic closes.

**The guarantee and the gate, live.** One request shape, five outcomes:

```
first  E-1 in tenant A -> 201
second E-1 in tenant A -> 409  {"error":"unique_violation","field":"encounter_number",
                                "detail":"'encounter_number' must be unique within this tenant on
                                          'Encounter', and another record already holds that value"}
E-1 in tenant B        -> 201     <- the index is (tenant_id, col)

caller NAMES invoice_number=INV-X, twice   -> 201, then 409 naming it
caller OMITS it and the allocator collides -> 500 {"error":"write_failed",
                                                   "detail":"the write could not be completed"}
                                              with the field name absent from the body
```

The last pair differs only in whether the caller typed the value. The collision was forced by seeding
a row holding `current_value + 1` read from `meta.operate_sequences` — the allocator keeps its own
counter independently of what rows exist, and a first attempt that guessed the number from the
invoice rows did not collide.

**The cross-check is not vacuous**, proved by mutation: making the survey report one extra field
withheld yielded

```
[unique] declared unique fields: 31 of 32 enforced on --store pg-columns
[unique] the boot figure above and the emitted DDL disagree about 1 field(s): Item.sku (survey only).
  The indexes are whatever the emitter wrote; the line is the one to distrust.
```

reverted after.

**Four claims corrected in the course of the work, each by measuring:**

1. The register's *"while the UI says the field is unique"* — false; `unique` occurs once in
   `operate-web`, as a type, read by nothing.
2. The register's *"34 in erp-core"* — 32.
3. **My own first boot line's remedy was false**: it said *"Declassify the field, or serve this pack
   on `--store pg` where the value is plaintext"*, and on `--store pg` **nothing** is enforced, so
   that half traded one withholding for another. A test now pins that the `encrypted_at_rest` remedy
   string does not contain `--store pg`.
4. A refuter's *"`onApplication` has zero consumers"* — wrong cause, right conclusion. It **is**
   wired, and it `return`ed early on `applied: true`, which is exactly the arm a `uniqueIndexRefusals`
   arrives on. So the fact reached nobody: the same defect `onUniqueIndexRefused` exists to prevent,
   one path over, in the file whose comment argues against it.

**`uniqueWithheld()` was callerless for about an hour of this increment** — a two-function chain
whose only caller was a test, ADR-0336's exact class inside the increment about a declaration nobody
reads. It was given the boot cross-check rather than deleted, because a repo bitten repeatedly by two
readings of one fact should compare them rather than discard one.

## Open questions

1. **`entity.indexes[].unique` is a second, independent route to uniqueness** (`index-def.ts:10`),
   resolved by `computeResolvedIndexes` whose only caller is `ddl/diff.ts`. Equally unemitted, and
   vacuous today because no pack declares one. Covering it drags in the `indexed` hint, which
   `entity-ddl.ts` also does not read — it emits a trigram GIN per plaintext text column regardless
   of what the field declares — so it belongs with the register's P1 item 1 rather than here.
2. **`ensureSchema`'s foreign-key statements have the identical data-dependence and no fence.**
   Observed by accident during this increment: an `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` over
   rows with orphans raises, and it takes the boot down with `fatal:`. Narrower than `unique` was —
   the FK is at least declared *and* read — but the same shape, and the savepoint pattern this
   increment established is the fix.
3. **A scoped unique index is unverified against a real database.** 0 declarations use the form, so
   the live run exercised only the unscoped shape; the scoped one is covered by unit tests and by
   `ensureSchema` carrying it through, not by an applied `CREATE`.
4. **Nothing reports a unique index that an operator dropped by hand.** `kernel-pg`'s reconciler
   compares catalogued indexes; entity tables are outside `META_TABLES`, and `diffTenantSchema`
   compares columns and types. So the guarantee can be removed silently after boot, and the next
   boot's `IF NOT EXISTS` will restore it only if the data still permits.
5. **The 409 names the field and not the value.** A caller sending a duplicate learns which field
   collided, which is right, and cannot tell *whose* row holds it, which is also right — but a
   client wanting to offer "that number is taken, next free is X" has no surface for it, and
   inventing one is a disclosure question rather than a convenience.
6. **Three sibling tests assert a two-interpolation sentence by substring presence alone**, so
   transposing the two values passes — the defect a refuter found in this increment's own 409 test
   and which a mutation confirmed. Found while fixing that one, reported rather than fixed, because
   each belongs to another increment's finding and none has been mutation-verified:
   `handlers.test.ts:547` (the write-mask 403, `mrn` + `Patient`), `:1655` (`addressingRefused`,
   whose template `'${field}' on '${entity}' may not address rows …` is structurally identical to
   `uniqueConflict`'s) and `:1921` (`storeRefused`, **doubly** exposed — neither the field↔entity
   pair nor the field↔reason pair is order-pinned). The general shape is worth naming: *a test over
   a sentence built from two values of the same type must pin their order, because presence is
   satisfied by the transposition.*
7. **`UniqueViolation`'s own `Error` message is a second spelling of the 409's sentence** —
   `'${field}' must be unique within the tenant on '${entity}'`, *the* where the handler says
   *this* — carrying the same transposition hazard and pinned by nothing. It never reaches a client,
   since `uniqueConflict` builds the body fresh, so it is not a disclosure; it is the
   two-spellings-of-one-sentence shape this repo keeps finding, in the increment that added it.
6. **`UNIQUE_WITHHELD_REASONS.document_store` has no producer in the module that declares it** —
   deliberately, because that module plans column tables only and the boot survey emits it — and
   `no_durable_store` lives in the survey joined by a type-level `extends`. Two vocabularies for one
   concept, bounded by a compile-time fence rather than by being one list; whether they should
   eventually be one is the question that fence defers.
7. **`unique` on a per-tenant activated manifest is enforced and not surveyed.** The applier emits
   the indexes and reports refusals, and no path prints a `[unique]` figure for a tenant's own
   manifest — the same gap ADR-0339's Q5 names for classified fields, and the same remedy
   (`buildOperateHttpServer`, where ADR-0340 put the obligation check).

## References

- ADR-0283, ADR-0314 — the column store's additive migration and per-tenant schemas.
- ADR-0290, ADR-0295 — *anything whose outcome depends on existing data is reported with the SQL*,
  and continue-past-a-failure.
- ADR-0307, ADR-0329 — three gates, and the stale-`dist` conditional green.
- ADR-0331 — *nothing* against *nobody looked*.
- ADR-0334 — a page-one failure converted to a boot statement; a remedy that cannot work.
- ADR-0336, ADR-0337 — a callerless symbol is a question, not a verdict.
- ADR-0338 — refuse where nothing worked before; `operationsForEntity`'s required-ness.
- ADR-0348 — a property of the manifest alone is a validation error, not a boot refusal.
- ADR-0350 — a passing check and a missing guarantee can be one sentence.
- ADR-0359 — refused where the drop changes *which* rows, reported where it changes only their order.
