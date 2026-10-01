# ADR-0285: A control that cannot fire must not be emitted as if it can (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0144 (accent-insensitive + trigram-indexed substring search — the decision this corrects), ADR-0166 (server-side `?q` search), ADR-0143 (`contains` operator), ADR-0283 (emitter reconciliation), ADR-0284 (the store owns entity DDL), ADR-0003 (meta-schema and dynamic entity engine) |

## Context

A downstream consumer — the Egypt UHI platform, which consumes CrossEngin as a pinned
submodule and therefore cannot patch it — bumped its pin across 166 upstream pull requests,
measured three defects in what it found, shipped shims, and filed the upstream changes by
name. All three were re-measured here against a throwaway Postgres 16.13 before anything was
changed, because evidence from another repository is a reason to look, not a reason to
believe.

They turned out to be one shape. In each case the platform **emits a control and the control
cannot fire**: an index the planner is structurally unable to match, and a precondition the
comparison is structurally unable to evaluate. Neither fails loudly. The unusable index
yields a correct answer by sequential scan; the unusable precondition yields `200 OK`. That
is why both survived ADR-0283's review and a year of use.

## What was broken

### 1. A trigram GIN index per text column, none of which could serve the query

`ColumnMappedEntityStore.ensureSchema` emitted `gin ("<col>" gin_trgm_ops)` per plaintext
text column, while the `contains` filter and `?q` search compared through
`unaccent(<col>::text) ILIKE …`. Measured on the composed `operate-erp/healthcare` pack
(54 entities, 54 tables): **291 trigram GIN indexes, 72.9% of every index in the schema,
4.5 MiB before a single row arrives** — and not one of them usable.

The emitted predicate, verbatim from the store, against a 50 000-row `product` table:

```
WHERE "tenant_id" = $1 AND unaccent("name"::text) ILIKE ('%' || unaccent($2) || '%')
```

```
-- EXPLAIN (ANALYZE, BUFFERS), default planner
 Seq Scan on product  (cost=0.00..2017.00 rows=5 width=244) (actual time=1.229..51.993 rows=2 loops=1)
   Filter: ((tenant_id = '…'::uuid) AND (unaccent((name)::text) ~~* (('%'::text || unaccent('Unique1000'::text)) || '%'::text)))
   Rows Removed by Filter: 49998
   Buffers: shared hit=767
 Execution Time: 52.040 ms

-- the same query with enable_seqscan = off
 Index Scan using idx_product_tenant on product  (cost=0.29..2438.29 rows=5 width=244) (actual time=0.763..37.565 rows=2 loops=1)
   Index Cond: (tenant_id = '…'::uuid)
   Filter: (unaccent((name)::text) ~~* (('%'::text || unaccent('Unique1000'::text)) || '%'::text))
   Rows Removed by Filter: 49998
   Buffers: shared hit=808
 Execution Time: 37.602 ms
```

Forced off sequential scans the planner reached for the *tenant* index and still left the
fold as a `Filter`. It never considered `product_name_trgm`. **That makes it a fact about
index MATCHING, not planner costing**, and it is the whole finding: the planner compares an
index's expression against the clause's left operand, and `col` is not `f(col)`. No change to
`unaccent` rescues a plain-column index.

Two beliefs written into this repository were measurably false:

- The comment in `list-sql.ts` said "A plain-column pg_trgm GIN index still accelerates
  this." It does not, as above.
- The comment in `entity-ddl.ts` said the plain-column form was chosen because "unaccent() is
  not IMMUTABLE and can't back an index". The premise is right and the conclusion does not
  follow — a locally declared IMMUTABLE wrapper can. And the catalog is harsher than the
  comment: `provolatile = 's'` for **both** overloads, including
  `unaccent(regdictionary, text)`, widely believed IMMUTABLE. "Switch overloads" is a fix the
  catalog refuses.

```
   oid    | proname  |        args         | provolatile
----------+----------+---------------------+-------------
 11952131 | unaccent | text                | s
 11952130 | unaccent | regdictionary, text | s
```

A test asserted the wrong belief too (`"uses a plain column trigram index, not a functional
unaccent() index"`), which is how a false premise survives a test suite: it passes.

The claim traces to **ADR-0144**, which shipped the fold and the indexes in the same
increment and concluded "substring search is accent-insensitive and index-accelerated on the
column store". The first half was true and tested. The second was never measured — the tests
it cites assert *which indexes are emitted*, which is not the same question as whether the
planner can use one. **ADR-0166** then repeated it ("a plain-column `pg_trgm` GIN index still
accelerates it") when `?q` reused the predicate. Two ADRs and a test suite agreed, and an
`EXPLAIN` disagreed with all three.

Dropping the fold would make the index match — 2144 buffers and 164 ms become 500 and 3 ms on
a 200 000-row table — and it also **changes the answer**: the same query returns 0 rows
instead of 3, because the rows it was supposed to find are the accented ones. Diacritic
folding is the point of the predicate. It is not available as a thing to trade away.

### 2. 88 — here 67 — of those indexes were on `enum` columns

`enum` maps to `TEXT`, so a test on the SQL type alone indexed it. `enum` is not in this
repository's own `SEARCHABLE_KINDS`, the set that decides which fields `?q` reaches, so the
platform was indexing columns it had already decided were not searchable. Classified by
declared field kind, the 291 were:

| declared kind | count | searchable per the platform's own set |
|---|---|---|
| `text` | 118 | yes |
| `reference` | **82** | **no** |
| `enum` | **67** | **no** |
| `long_text` | 11 | yes |
| `email` | 7 | yes |
| `phone` | 5 | yes |
| `url` | 1 | yes |

**`reference` is 82 more than the downstream reported**, found here by classifying every
index rather than sampling: a reference column is `TEXT` holding the target's opaque id, and
nothing substring-searches an id either. So 149 of 291 — 51% — were over columns that are
matched by equality, which the primary key and the tenant index already serve.

They are not free. On the same 50 000-row `product` table:

```
   product_name_trgm                   5.17 MiB
   product_sku_trgm                    4.89 MiB
   product_category_trgm               4.34 MiB   <- a FIVE-value enum
   product_status_trgm                 4.31 MiB   <- a three-value enum
   product_pkey                        3.38 MiB
```

A trigram index over a five-value enum measured **larger than the table's own primary key**.

### 3. `expectedUpdatedAt` fenced nobody — three defects in one feature

The optimistic-concurrency guard on the generic update handler had three, each sufficient on
its own to make it useless.

- **It was opt-in per request.** A client that omitted the field got no protection. The
  substrate offered no way for a manifest to require it, so every consumer had to wrap the
  handler.
- **A non-string value was silently stripped.** `{"expectedUpdatedAt": 0}` was narrowed away
  by `typeof === "string"` and then `delete`d like any unknown key, so the write proceeded
  **unconditionally** while the caller believed it held a precondition.
- **On the column-mapped store the comparison never ran.** `rowToRecord` passes the driver's
  value through, node-postgres returns `TIMESTAMPTZ` as a JS `Date`, so
  `typeof before["updated_at"] === "string"` is false, `current` is `null`, and the guard
  skipped the compare.

Driven through the real handlers against the real store, on a real table:

```
read   -> 200, updated_at="2026-10-01T13:30:00.597Z"
store.get: updated_at is a Date -> Thu Oct 01 2026 13:30:00 GMT+0000
           typeof === "string" ? false        <-- the guard's test
PATCH with a DELIBERATELY STALE expectedUpdatedAt -> 200  *** THE PRECONDITION DID NOT FENCE ***
   body.name now: "STALE WON"
PATCH with expectedUpdatedAt: 0 (non-string)       -> 200  *** SILENTLY STRIPPED, WRITE PROCEEDED ***
   body.name now: "BOGUS WON"
```

The chain looks correct from outside, which is why it lasted: over the wire
`JSON.stringify(Date)` **is** an ISO string, so the response publishes a plausible version
and `operate-web` dutifully echoes it. Everything about the exchange was right except that
nothing compared it.

A fourth defect sits underneath, found here: `selectList` selects `id` plus the *planned*
columns only, so for an entity that is not `auditable` the column store never selected
`updated_at` at all. The document store has always returned it. So on that store the fence
was not merely broken, it was unsatisfiable — there was no version for a client to echo.

## Decision

**A control that cannot fire must not be emitted as if it can.** Applied twice.

### The search predicate and its index come from one definition

- **`packages/operate-runtime-pg/src/search-fold.ts`** declares the fold once:
  `searchFoldRef(schema)` names `"<schema>"."crossengin_fold_text"`, `searchFoldExpr(ref, e)`
  builds `ref(e::text)`, and `emitSearchFoldFunctionDdl(schema, unaccentSchema)` emits the
  `CREATE OR REPLACE FUNCTION`. The DDL emitter's index expression, the `contains` predicate
  and the `?q` search are **three uses of `searchFoldExpr`**, not three strings that have to
  agree. A second derivation would be the kind of coincidence maintained by hand whose
  failure is silent: a correct answer, read by sequential scan.
- **The fold is a locally declared IMMUTABLE wrapper**, because a STABLE function cannot back
  an index expression at all. The lie is narrow and worth stating: `unaccent` is STABLE only
  because `ALTER TEXT SEARCH DICTIONARY` could change the rules under it, so **a deployment
  that edits its unaccent rules must `REINDEX`** — the same obligation as changing any index
  expression's meaning. The fold's semantics are `unaccent`'s, unchanged.
- **Both the function and the dictionary are schema-qualified from the catalog.**
  `ensureSchema` reads `pg_extension` for where `unaccent` actually landed rather than
  assuming `public` (Supabase and others put extensions elsewhere), and refuses to boot if it
  is absent. An index expression resolved through `search_path` is pinned to whatever it
  resolved to at creation while the query resolves per session; the two silently diverging is
  the failure this module exists to prevent. Verified with `search_path` set to `''`.
- **`::text` is carried on both sides**, so the index expression and the predicate are
  textually identical and matching cannot depend on which casts the parser happens to strip.
  (It does strip the `varchar`→`text` relabel, verified — but relying on that is a
  coincidence, not a contract.)
- **The index set is derived from the declared field kind, not the SQL type.** The kernel now
  owns that fact: `TEXT_SEARCHABLE_FIELD_KINDS` + `isTextSearchableFieldType` in
  `ddl/field-type.ts`, where the field→Postgres-type mapping already lives.
  `operate-runtime`'s `list-query.ts` (which decides what `?q` reaches) and
  `operate-runtime-pg`'s column plan (`ColumnMapping.textSearchable`, which decides what gets
  indexed) now read the same set, so the index set and the search surface cannot drift apart.
  An `array` is excluded explicitly: its column is `<element>[]`, which no text operator class
  accepts.
- **The fold index gets a new name and the old one is dropped by name.**
  `<table>_<col>_fold_trgm` is created; `<table>_<col>_trgm` is dropped for every column that
  could have had one, including the enum and reference columns that now get no index at all.
  The drop is mandatory, not tidiness: `CREATE INDEX IF NOT EXISTS` on an existing name
  **keeps the old definition and creates nothing** (verified — the notice reads `relation
  "…" already exists, skipping`), so reusing the name would have left every existing
  deployment with exactly the unusable index it already had. Dropping an index is also not the
  kind of data decision ADR-0283 holds migrations back from: no row changes, and the index
  provably cannot serve any predicate this store emits.
- **The document store is untouched.** Its adapter supplies `foldFn: "unaccent"`, so its SQL
  is byte-identical to before — proven by its expectations in `list-sql.test.ts` needing no
  edit. It has no per-entity tables and therefore nothing for a folded expression to match.
  `ListSqlAdapter.foldFn` is **required**, not optional: a store that forgot it would emit an
  unfolded predicate that silently answers *narrower*, so the omission has to be a compile
  error.

### A precondition must either fence or refuse

- **`Entity.concurrency: "optimistic"`** is a manifest declaration. It sets
  `RouteSpec.requireVersion` on the generic `update` route only, and a `PATCH` without
  `expectedUpdatedAt` is then refused. Declared on the entity, not configured per deployment,
  so a manifest cannot serve the same records with the fence on in one environment and off in
  another. Absent, the route stays unconditional — today's behaviour, and every builtin pack's.
- **The refusal is 428 Precondition Required, not 409.** Every neighbouring refusal on that
  route means *no role may do this*, and that reason is false here: any role may, once the
  request is conditional.
- **A present-but-unusable value is 400, never a silent unconditional write.** Non-string,
  empty, whitespace, and a string that does not parse as a date are all
  `invalid_precondition`. The last one matters as much as the others: a value that can never
  equal a published version would otherwise turn every such request into a permanent 409
  rather than telling the caller what it sent was not a version.
- **The comparison runs, against the version a read PUBLISHED.** `publishedVersion(record)`
  in `operate-runtime`'s `store.ts` is the one definition: an ISO string stays itself, a
  `Date` becomes `toISOString()`, anything else is null. It is deliberately the **same lossy
  step the response body goes through**, so the loss cancels — a row whose `updated_at`
  carries microseconds (a column default `now()`) publishes a millisecond version, and
  re-reading it publishes that same millisecond version, so an echoed value still compares
  equal.
- **An indeterminate version refuses.** If a precondition was supplied and the record
  publishes no version, the answer is 409, not a write. Skipping the comparison is the same
  defect as stripping the value, one layer down.
- **The column store publishes the system timestamps it was hiding.** `selectList` and
  `rowToRecord` now include `created_at`/`updated_at` when the entity does not declare them,
  via one exported `unplannedSystemTimestamps(plan)` shared with the DDL that creates them.
  Without it, `concurrency: "optimistic"` on a non-`auditable` entity would be a fence no
  client could satisfy.

### What was deliberately NOT done

- **The precondition is still read-then-compare, not a compare-and-set.** Routing it through
  the existing `ConditionalEntityStore.updateIf` — as the transition handler already does for
  its state field — would close the simultaneous case too, and it was tried on paper and
  rejected for a measured reason: `preconditionSql` compares `column::text`, and a
  `timestamptz`'s text rendering (`2026-10-01 13:30:00.597312+00`) is **not** the value a read
  published (`2026-10-01T13:30:00.597Z`). Comparing in SQL therefore needs a decision about
  timestamp precision — a column default `now()` stores microseconds the driver truncates —
  and taking that decision inside this ADR would have settled it by side effect. The
  sequential case, which is the one a real client hits, is closed. See the follow-ups.
- **`rowToRecord` still consults no declared field type.** It passes the driver's value
  through, which is also why a downstream consumer needs a read-projection shim for decimals.
  Fixing the precondition did not require fixing that, and it is not fixed: the normalisation
  lives in the handler, where the published representation is formed, and the store's read
  types are unchanged.
- **The fold's dictionary is unchanged.** Worth recording, because the downstream deployment
  is Arabic: the stock `unaccent` rules **do not** strip Arabic harakat
  (`unaccent('مُحَمَّد') <> 'محمد'`, verified). What it folds is Latin diacritics. That is a
  dictionary question, not an indexability one, and the fold function is now the single place
  a deployment can swap it.

## Consequences

- **The same query, after, on the same 50 000-row table** — the fold preserved, the index
  matched:

  ```
   Bitmap Heap Scan on product  (cost=277.81..297.93 rows=5 width=244) (actual time=0.594..0.600 rows=2 loops=1)
     Recheck Cond: (crossengin_fold_text((name)::text) ~~* '%Unique1000%'::text)
     Buffers: shared hit=59
     ->  Bitmap Index Scan on product_name_fold_trgm  (cost=0.00..277.81 rows=5 width=0) (actual time=0.549..0.549 rows=2 loops=1)
           Index Cond: (crossengin_fold_text((name)::text) ~~* '%Unique1000%'::text)
   Execution Time: 0.624 ms
  ```

  52.040 ms → **0.624 ms** (83x), 767 → 59 buffers (13x), and the same 2 rows — including the
  accented ones the unfolded form misses. `?q` across two columns is a `BitmapOr` of
  `product_name_fold_trgm` and `product_sku_fold_trgm`.
- **A downstream schema loses 149 indexes and keeps 142, all of them usable.** On the composed
  healthcare pack: 399 → 250 indexes, 291 → 142 trigram, 72.9% → 56.8%, 4.5 → 2.2 MiB empty.
  Every remaining trigram index is over a `text`/`long_text`/`email`/`phone`/`url` column.
- **Existing deployments migrate on the next boot, with no data decision.** Simulated live by
  recreating all 291 legacy plain-column indexes on a schema and re-running `ensureSchema`:
  `legacy=291 fold=142` → `legacy=0 fold=142`. The cost is one `CREATE INDEX` per free-text
  column at boot, which `ensureSchema` already paid, plus a brief `ACCESS EXCLUSIVE` per drop.
- **`ensureSchema` now refuses to boot without the `unaccent` extension** rather than emitting
  an index it cannot build. That is a new failure mode on a managed Postgres that forbids the
  extension — but it was already a *latent* one: the predicate has always called `unaccent`,
  and a `contains` filter would have raised `function unaccent(text) does not exist` at
  request time instead of at boot.
- **API responses for non-`auditable` entities on the column store now include `created_at`
  and `updated_at`.** Additive, and it makes the two stores answer the same question the same
  way, but it is a visible payload change.
- **A stale precondition is 409 and a malformed one is 400**, both verified live through the
  real handlers against the real store; both previously 200 with the write landing. A missing
  one on a `concurrency: "optimistic"` entity is 428, satisfied by the version a read returns.
- +73 tests (types **97**, kernel **576**, operate-runtime **403**, operate-runtime-pg
  **231**; workspace **9,405** over 585 files). Full workspace build + typecheck + test green
  over 83 packages and apps, including `apps/operate-web`'s Next build.

  One caveat on how that was measured, since this repository's CLAUDE.md warns against
  trusting an exit status you did not read: the first two `pnpm -r test` runs reported a
  failure, both times the same two `@crossengin/compliance` tests, both times `Test timed out
  in 5000ms`. Those tests take **689 ms** in isolation and pass 3/3 there; the machine was at
  load average ~49 with seven sibling agents running suites. Re-run with
  `--testTimeout=30000` the whole workspace is green with zero failures. `packages/compliance`
  is not touched by this change.

### Follow-ups left open

- **The simultaneous case is still racy.** Two concurrent conditional `PATCH`es are both
  admitted, because the check and the write are two statements. Closing it means routing the
  precondition through `updateIf`, which first needs the timestamp-precision decision above:
  either compare `date_trunc('milliseconds', "updated_at")` (correct, but couples the SQL to a
  driver's parsing) or stop storing microseconds in `updated_at` at all (cleaner, and a
  behaviour change for every consumer).
- **`concurrency: "optimistic"` is opt-in per entity and no builtin pack declares it.** Making
  it the default is the obvious next step and a breaking change for every existing client, so
  it is a separate call.
- **`UiSchema` does not publish the mode**, so a generic client cannot know it must send a
  version before it gets its first 428. `operate-web` happens to send one whenever the record
  it read has a string `updated_at`, which this change also makes true for non-`auditable`
  entities on the column store.
- **`rowToRecord` consults no declared field type** (above). The decimal read surface is the
  known consequence.
- **The unaccent dictionary folds no Arabic** (above).
- **Index-name truncation can collide.** Both names are sliced to 63 characters, so two long
  column names on one table could still collide — pre-existing, and the `_fold_trgm` suffix is
  four characters closer to it.
- **ADR-0144's own open follow-up is still open**, and this change narrows it rather than
  closing it: the kernel bootstrap that provisions `meta.operate_entity_records` for the
  document store still does not `CREATE EXTENSION unaccent`, so a `--store pg` deployment
  whose database lacks it still fails at request time on a `contains` filter. The column
  store now refuses at boot instead, which is the better failure, but only for itself.
