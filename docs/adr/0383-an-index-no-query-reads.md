# ADR-0383: An index no query reads

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-26 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0144 (the trigram index and the accent fold, whose Consequences this corrects), ADR-0143 (the `contains` operator and the typeahead), ADR-0166 (the extension this binary provisions for both stores), ADR-0292 (ask Postgres rather than write a SQL parser), ADR-0330 (ask for a fact Postgres will state), ADR-0331 (a claim is not a gap), ADR-0334 (a remedy that cannot work is worse than none), ADR-0336 (a wrong answer is worse than a refusal), ADR-0337 (a falsely-true control), ADR-0340 (wrong-and-safe before fast-and-wrong), ADR-0349 (the column store's serving role owns its tables), ADR-0352 (a survey that reports and never refuses), ADR-0362 (a comment asserting a property the code does not have), ADR-0372 (a test asserting the defect as the specification) |

## Context

Register item P1.1:

> **Every list search is an unindexed table scan and a comment asserts the opposite.**
> `list-sql.ts` emits `unaccent(<col>::text) ILIKE …` while `entity-ddl.ts` indexes the bare
> column; the predicate's comment claims a plain-column GIN index still accelerates it and the DDL
> comment two files away notes `unaccent` is not IMMUTABLE.

Both halves are true, and neither file is wrong about its own half. `entity-ddl.ts:321-322` is
**right**: `unaccent` is STABLE, not IMMUTABLE — measured, `pg_proc.provolatile = 's'` for both
`unaccent(text)` and `unaccent(regdictionary,text)` — and `CREATE INDEX … (unaccent(col))` raises
`functions in index expression must be marked IMMUTABLE`, verified for gin *and* btree and for both
argument forms. `list-sql.ts:327` was **false**: it claimed *"A plain-column pg_trgm GIN index still
accelerates this"*, and a bare-column index cannot serve an accent-folded predicate.

What nobody did was draw the conclusion from the true half. If the predicate cannot be indexed, the
index cannot serve the predicate — so the 272 trigram GIN indexes resolved `erp-core` emits over its
51 tables (measured by calling the real `columnPlansForManifest` and `emitEntityTableDdl`: 51 tables,
630 columns, **272** statements containing `gin_trgm_ops`) were read by nothing.

The index was not *useless*, which is why nobody noticed. A bare `family_name ILIKE '%Smith421%'`
**is** served by it — `Bitmap Index Scan on employee_family_name_trgm`, measured. It was dead for the
one predicate this codebase emits, and grepping `packages/` and `apps/` outside tests finds exactly
two `ILIKE` sites, both in `list-sql.ts`. So the indexes served nothing at all while being maintained
on every write.

Measured on PG 16.13 over a 200,000-row `public.employee` built by the real emitter, as the table
owner, with `max_parallel_workers_per_gather = 0`, using the SQL the real
`ColumnMappedEntityStore.listPage` emits (captured from the store, not hand-written):

| query | pre-fix plan | pre-fix | post-fix plan | post-fix |
|---|---|---|---|---|
| 4-field `?q=`, 1000 matches | Seq Scan, 199,000 removed | 156.2 ms | BitmapOr over 4 indexes | **4.81 ms** |
| 1-field `[contains]` typeahead | Seq Scan, 199,800 removed | 79.7 ms | Bitmap Index Scan | **3.42 ms** |
| 4-field `?q=`, matching nothing | Seq Scan | 153.6 ms | BitmapOr | **0.2 ms** |

Two of the register's framings were refuted before the work started, by a read-only measurement pass,
and are recorded here so nobody re-derives them: the "66×" figure is low (the indexed form measures
0.146 ms against 46.5 ms, ~318×, on that pass's fixture), and *"issued per keystroke"* is false —
both callers debounce 250 ms (`apps/operate-web/app/e/[slug]/page.tsx:227`,
`components/ReferencePicker.tsx:95`). Sharper than the keystroke claim: the cleanup only
`clearTimeout`s a *pending* request and sets `alive = false` to discard a *landed* one, so neither
cancels a query already running in Postgres, `createNodePgConnection` sets no pool `max` (pg-pool
defaults to 10) and no `statement_timeout`, and 10 concurrent searches on a 1M-row tenant took
**7614 ms** wall.

## Decision

**One IMMUTABLE wrapper, named by the predicate and by the index, with a fence over the declaration
it rests on and a declared exemption for the store that has no index.**

1. **`public.ce_unaccent(text)`**, `LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT`, body
   `SELECT public.unaccent('public.unaccent'::regdictionary, $1)` — the **pinned two-argument** form,
   schema-qualified on both sides.
2. **`searchFunctionCall(expr)` is the one spelling of a call**, shared by `list-sql.ts`'s two
   predicate sites and by `entity-ddl.ts`'s index expression. Two independently written call sites is
   precisely how the bare-column index and the folded predicate came to be two things that do not
   meet.
3. **The emitted index becomes `gin (public.ce_unaccent("<col>"::text) gin_trgm_ops)` under a new
   suffix `_utrgm`.** The rename is load-bearing, not cosmetic: the emitter writes
   `CREATE INDEX IF NOT EXISTS`, so reusing `_trgm` would find the old bare-column index on every
   already-applied deployment, no-op, and leave the fix landing on fresh databases only.
4. **`ensureSearchExtension` provisions the function after the extension and probes it**, so the
   deployed binary needs no wiring change: `apps/operate-server/src/node.ts:828` already calls it and
   prints `searchExtensionLine`, which now renders a two- or three-line block.
5. **The fence reports and never repairs.** `probeSearchFunction` compares the live `prosrc` (trimmed)
   and `provolatile` to what this binary assumes, and `ensureSearchFunction` issues `CREATE FUNCTION`
   and **never `CREATE OR REPLACE`** — because replacing a body an index was built from is the act
   that silently invalidates the index.
6. **`auditSupersededTrigramIndexes` finds the leftover bare-column indexes and hands over the
   `DROP INDEX` statements without running one** (ADR-0330's idiom for a statement a plan must not
   run unasked).
7. **`ListSqlAdapter.foldText?` lets a store with no trigram index decline the wrapper**, defaulting
   to `searchFunctionCall`. See *Consequences → Negative* for the measurement that forced this and
   *Implementation notes* for the one line the document store still needs.

### The fence is the sharpest part, and it is three separate findings

Marking a function `IMMUTABLE` is a **declaration, not a fact**, and three things follow. All were
reproduced on a live cluster.

**(a) `CREATE OR REPLACE FUNCTION` on a function an index depends on is permitted with no error and
no reindex.** The index keeps the function's OID and its entries keep the *old* body's output. What
it produces is **not** a false positive — `gin_trgm_ops` is a lossy index, so the Bitmap Heap Scan
rechecks every candidate with the *live* function — it is a false **negative**: after replacing the
body with one that also translates `S` to `Z`, the same predicate answered **0 rows via the index and
1022 via a forced sequential scan**. A wrong answer, in the under-reporting direction, which for a
typeahead is the empty dropdown `search-extension.ts`'s own doc comment already names as the worst
shape this surface has.

So the binary does not perform that act on an operator's behalf. It reports a divergence with both
statements in the order they must run (`CREATE OR REPLACE`, then `REINDEX`) and the rule it yields is
worth stating plainly: **a definition an index was built from is data, not configuration.**

**It reports rather than refusing, and the reason is a measurement rather than a preference: the
probe cannot tell the harmful case from the harmless one.** A body replaced *before* any index
existed is internally consistent and answers correctly; a body replaced *after* is silently wrong;
and neither `pg_proc` nor `pg_index` carries a modification timestamp, so no catalog fact separates
them. Refusing would refuse a deployment that works, which is ADR-0352's own ground for a survey that
reports. ADR-0336's wrong-answer-beats-refusal rule does not override that, because the finding is
reported loudly with its remedy — what is withheld is the *boot refusal*, not the alarm.

**(b) `DROP EXTENSION unaccent CASCADE` does not drop the index.** Measured: four dependency rows on
the index, and after the drop the index and `ce_unaccent` are both still present, because the index
depends on `ce_unaccent` and `ce_unaccent` is not an extension member. The table then becomes
**unwritable** — an `INSERT` raises `text search dictionary "public.unaccent" does not exist`. Loud
rather than silent, so it is not prevented. Its standing form *is* fenced: a deployment whose
`unaccent` lives in another schema gets `CREATE FUNCTION` succeeding (a `LANGUAGE sql` string body is
parsed at *inlining*, which the hazard's own error text says) and the first **call** failing, so
`dictionary_absent` is a state of its own, checked before the body.

**(c) The boot line this increment first wrote was false, and the live run is what said so.** It read
`substring search is index-accelerated`. As the non-owner `serving` role with tenant context the plan
is a `Seq Scan … Rows Removed by Filter: 199000`, because `ILIKE`'s own operator function `texticlike`
is `proleakproof = false`, so a session that row-level security *confines* cannot evaluate the
predicate before the policy. That is ADR-0337's falsely-true control, in the boot line of the
increment that exists to close one. The sentence now states what this pass established — that the two
expressions meet — and `probeSearchIndexReach` adds the caveat with its cause. See *Open questions 1*.

### The boot line was wrong in both directions, and the wrapper has two dependents

An adversarial review of the committed increment found that the `absent` line — *"every `?q=` and
every `[contains]` filter will answer 500"* — is false **in both directions**, and the cause is that
it names no store while the wrapper has two dependents that are not the same set.

- **The query builder's dependent is the column store alone.** `entity-ops.ts` declares
  `foldText: (sql) => rawFoldCall(sql)`, so on `--store pg` the predicate is
  `public.unaccent('public.unaccent'::regdictionary, …)` and names `ce_unaccent` **nowhere**. The
  shipped compose default therefore searches correctly in all seven states of this function, and the
  line told its operator otherwise. Asserted now over the **real** adapter by driving `listPageOp`
  with a recording connection — not a synthetic one, which is what every previous `foldText` test
  used, so the one line this ADR calls *"the increment is incomplete without"* was fenced by nothing.
  Mutation-checked: deleting it fails that test, and before it was written, deleting it failed none.
- **The DDL's dependent is the column store too, and that one is new.** `entity-ddl.ts`'s index
  expression names the same function, so a state that blocks index creation does not degrade search —
  it makes the store **unprovisionable** (see the privilege note). *"Every search answers 500"* and
  *"this store cannot be provisioned"* are different findings with different remedies, and the second
  is the one an operator meets first.

So `SEARCH_FUNCTION_ADMITS_INDEX` is a **second** total map over the state enum, answering *can a new
trigram index be created from this*, and `dependentsClause` renders the per-store attribution from
the pair. Two maps and not one because they genuinely disagree, on two states and in opposite
directions: a replaced body **admits** an index and is built from the wrong output
(`ANSWERS_TRUSTED: false`, `ADMITS_INDEX: true`), and a non-IMMUTABLE function answers existing
queries correctly while refusing a new index (`true`/`false`). One map would have to pick one of
those facts and drop the other. That also gives `SEARCH_FUNCTION_ANSWERS_TRUSTED` its first non-test
reader, which the review raised separately: ADR-0344's ground for a total map is that a new enum
member must be a compile error, and a map nothing reads is a constant nobody reads.

This is hazard (c) one field further in — a boot line asserting a consequence the pass did not
establish — so the increment reproduced its own class twice, once in the sentence it corrected before
shipping and once in the sentence it shipped.

### The argument for keeping the wrapper out of `ensureColumnStoreExtensions` expired inside this increment

`search-extension.ts` argued that `ensureColumnStoreExtensions` *"provisions what the column store's
**DDL** depends on … and `unaccent` is not in that category. It is what the **query builder** depends
on"*. That is true of the extension and was carried, unexamined, to the wrapper beside it — and it
stops applying the moment `entity-ddl.ts`'s index expression starts naming the function, which is
this increment. ADR-0364's class: an argument that expired and nothing noticed.

The consequence is that **`ensureSearchFunction` reaches the boot path only.** `node.ts` calls
`ensureSearchExtension` before `store.ensureSchema()`; `applyTenantManifestSchema` calls
`ensureColumnStoreExtensions` and never this. So a per-tenant activation provisions `pg_trgm` and not
the function its own index statements name. `entity-ddl.ts` asserted the opposite in a comment —
*"provisioned by `ensureSearchFunction`, which `ensureSearchExtension` calls before either store
serves"* — which is true of one path and false of the other (ADR-0362), and is corrected.

**The refusal belongs in `ensureColumnStoreExtensions`, not here, and that is argued rather than
preferred.** The review offered either making `ensureSearchFunction`'s create failure fatal for
`--store pg-columns` *or* provisioning the wrapper there; the two are not equal.

1. **A throw in `ensureSearchFunction` cannot be conditioned on the store** — that function is handed
   a connection and nothing else — and an unconditional one refuses `--store pg` for the absence of
   an object it does not use, measured above. That is ADR-0352's *refusing a deployment that works*,
   and the deployment is the shipped compose default.
2. **It also could not reach the per-tenant applier at all**, which is the path whose failure is
   silent. `ensureColumnStoreExtensions` is the one place **both** column-store call sites pass
   through, it already issues two uncaught `CREATE EXTENSION`s, and its own doc says it provisions
   what this store's DDL depends on — so a refusal there is that file's existing contract rather than
   a new policy.
3. **Refusing is not refusing a working deployment, which is what lifts ADR-0352's bar.** Such a
   deployment already fails; the choice is a **named boot refusal against an opaque mid-DDL raise**,
   which is ADR-0334's conversion and ADR-0338's `decidePhiStorage` shape. There is no
   degraded-but-coherent state to protect with a hatch: on `--store pg-columns` an absent function
   breaks the predicate *and* the DDL, so ADR-0336's wrong-answer-beats-refusal does not apply —
   both arms fail loudly and only one says why.

`ensureColumnStoreExtensions` is outside this increment's file ownership, so that half is recorded as
*Open questions 8* with its exact statement, following Option G's precedent.

### The record correction ADR-0144 owes

ADR-0144's Decision is right at line 29-30: *"Deliberately a **plain-column** index, not
`unaccent(col)` — `unaccent()` is not IMMUTABLE and cannot back a functional index."* Its
Consequences, five lines later at line 34, read: *"Substring search is accent-insensitive and
index-accelerated on the column store."* **The second sentence is false and was false the day it was
written**, for the reason the first sentence gives. It is corrected here rather than in ADR-0144,
which is a historical record.

Its stated follow-up — that the JSONB store also emits `unaccent(...)` and its table is provisioned
by a bootstrap that creates neither extension — was closed for `unaccent` by ADR-0166 and is **still
open for `pg_trgm`**; see *Open questions 2*.

## Alternatives considered

- **Option A: drop the accent fold and index the bare column, matching the DDL.**
  - **Pros:** one-line change; the existing 272 indexes become live immediately.
  - **Cons:** it is a correctness regression.
  - **Why not:** measured on the real table — the accent query answers **0 rows where the correct
    answer is 1000** (`family_name ILIKE '%Munoz%'` against 1000 rows holding `Muñoz-José`). ADR-0143
    and ADR-0144 chose accent-insensitivity deliberately for a typeahead over European names.

- **Option B: a `GENERATED ALWAYS AS (unaccent(col)) STORED` column, indexed plainly.**
  - **Pros:** no wrapper; the index is on a plain column.
  - **Cons:** it is not an alternative — **it requires the wrapper**.
  - **Why not:** `GENERATED ALWAYS AS (unaccent(col)) STORED` raises `generation expression is not
    immutable` — and with `ce_unaccent` it succeeds. Both halves verified here. The cost is a second
    stored copy of every searchable column and a real `ADD COLUMN` on every existing table, and the
    read-only pass that surveyed this measured the two at the same read speed (0.173 ms against
    0.163 ms). The wrapper dominates it on every axis.

- **Option C: tsvector full-text search.**
  - **Pros:** the canonical Postgres answer for text search; GIN-indexable without a wrapper.
  - **Cons:** different semantics — no substring match.
  - **Why not:** `to_tsvector` indexes lexemes, so `?q=mith` finds nothing in `Smith`. The surface
    this serves is a **typeahead** (ADR-0143's reference picker), which is substring by definition.

- **Option D: `ALTER FUNCTION ce_unaccent(text) LEAKPROOF`, to recover the index under RLS.**
  - **Pros:** would make the fix land for a non-owner serving role too.
  - **Cons:** a security declaration requiring superuser, and it does not work.
  - **Why not:** measured — with `ce_unaccent` marked LEAKPROOF the plan is still a `Seq Scan`,
    because `texticlike` is the non-leakproof half and marking a core text operator leakproof is not
    something a platform does to its operators' databases. The restriction is also **pre-existing**:
    a bare `family_name ILIKE '%…%'` against the *superseded* plain-column index is a `Seq Scan` for
    the same non-owner, so the old indexes were dead for two independent reasons and this increment
    removes one of them.

- **Option E: one spelling everywhere, with the document store paying the wrapper's call cost.**
  - **Pros:** no per-store branch; the strongest form of the one-spelling rule.
  - **Cons:** a 4.2× regression on the shipped compose default.
  - **Why not:** measured on `meta.operate_entity_records`, 200,000 rows, 4-field `?q=` matching
    nothing — **170.1 ms → 715.5 ms**. The wrapper cannot be inlined (see *Implementation notes*), so
    it costs a SQL-function call per row, ~0.77 µs, and that store has no index to pay it back.
    `--store pg` is what `deploy/docker-compose.yml` runs.

- **Option F: derive the fold from the adapter's shape (e.g. whether `columnExpr` returns a bare
  column).**
  - **Pros:** no new adapter member; no change needed in either store.
  - **Cons:** a heuristic deciding a behaviour.
  - **Why not:** ADR-0343 refuses probing a response's shape to decide an authorization answer for
    the same reason it is refused here — the fold decides which rows match, and a shape test would
    answer from a coincidence rather than from a declaration.

- **Option G: make `foldText` required, so no store can forget it.**
  - **Pros:** ADR-0338's required-rather-than-defaulted rule; a new adapter is a compile error until
    it answers.
  - **Cons:** both construction sites are outside this increment's file ownership, so it would not
    compile until the orchestrator applied two edits.
  - **Why not:** not refused on merit — deferred, with the default chosen so that forgetting is
    *wrong-and-safe* rather than *fast-and-wrong* (ADR-0340's ordering argument). Making it required
    is *Open questions 4*.

- **Option I: put `ce_unaccent` in the *served* schema rather than in `public`, so the floor does not
  rise.**
  - **Pros:** it is the only option that avoids raising the privilege floor at all. ADR-0349 records
    that a `--store pg-columns` serving role must **own** its entity tables, so such a role can
    already create objects in the schema it serves, and `ListSqlAdapter.foldText` is the seam that
    would let the predicate name a per-schema function.
  - **Cons:** an index is usable only by a predicate naming the **same function OID**, and
    `list-sql.ts` builds the predicate with no knowledge of which schema the row came from — one
    builder serves `meta.operate_entity_records` and every per-tenant column schema.
  - **Why not:** the cost is a function per tenant schema, each needing its own probe, its own
    `body_differs` fence and its own `REINDEX` remedy, and `foldText` would have to carry a schema it
    is not given. Recorded because it is the honest answer to *must the floor rise?* — it does not
    have to, and the price is N functions and N fences for one deployment-wide property. See
    *Open questions 9*.

- **Option H: narrow `isTrigramIndexable` from "is this text?" to "is this searchable?".**
  - **Pros:** the larger half of the win — of the 272 indexes, the read-only pass measured **106** on
    a column some search surface can reach and **166 (61%)** on a column no surface can reach at all.
    Live on one entity: `public.employee` carries **13** `_utrgm` indexes and
    `listConfigForEntity(manifest, "Employee").searchableFields` names **4**.
  - **Cons:** a separate decision about which fields earn an index, touching `[contains]`-capable
    filterable fields as well as `searchableFields`.
  - **Why not:** deliberately out of scope. Fixing the predicate without narrowing converts 106 dead
    indexes into live ones and leaves 166 dead — but that cost is **already being paid today**, so
    this increment does not make it worse. The cost is real and measured here: five trigram indexes
    over a 1,000,000-row table hold **195 MB** against a 141 MB heap, and five over a fresh table
    cost **13.6×** on write throughput (10,000 inserts: 582.9 ms with, 42.9 ms without). On the real
    `employee` table, 17 trigram indexes hold 91 MB against a 31 MB heap. The read-only pass that
    surveyed this measured the same shape at 129 MB/145 MB and 10.7×, on its own fixture.

## Consequences

- **Positive.** The predicate and the index are one expression, by construction rather than by two
  authors agreeing. On the column store as the table owner — which ADR-0349 records is the role that
  store must run as, since `ensureSchema` issues owner-only `ALTER` and policy statements on every
  boot — a 4-field `?q=` over 200,000 rows goes from 156.2 ms to 4.81 ms, and from 153.6 ms to 0.2 ms
  when it matches nothing. The declaration the fix rests on is fenced three ways, with a remedy
  printed for each — each remedy performable by the role that is refused, which took a correction.
  The leftover indexes are named with their `DROP` statements. The boot line attributes every
  consequence to a store, derived from two total maps rather than asserted. `ADR-0144`'s false
  Consequence is corrected in the record. And `search-extension.ts` gains the test file it never had.

- **Negative, and the first of these is the cost worth reading.** **The privilege floor for
  `--store pg-columns` rises to CREATE on schema `public` (or a one-time `CREATE FUNCTION` by a role
  that holds it), and a deployment that cannot meet it cannot apply this store's schema at all** —
  where before this increment it booted and served with a slow search. The two `CREATE EXTENSION`
  statements beside the new one establish no such floor, because `IF NOT EXISTS` short-circuits on an
  installed extension before any privilege check, so nothing in the pre-existing code implied it.
  Nothing in code can lower it while the function is deployment-wide (Option I is the alternative that
  would, at a price); what code can do is say so, and the `absent` boot line names the privilege and
  both remedies. Until *Open questions 8* lands, the refusal is a boot line on one path and an aborted
  transaction on the other.

  Second: the wrapper costs a SQL-function call per row wherever the index does not apply, ~0.77 µs,
  measured as 42.4 ms → 195.3 ms on a single-field full scan of 200,000 JSONB rows. That is why
  `foldText` exists, and the document store declares it — applied, and fenced over the **real**
  adapter rather than a synthetic one, so deleting the line now fails a test where before it failed
  none. Without it a `--store pg` deployment would pay **10.4 ms → 38.1 ms** for a realistic 4-field
  `?q=` matching 1000 rows and **170.1 ms → 715.5 ms** for the worst case that matches nothing; the
  default remains the safe direction rather than the right one. Separately, an already-applied
  deployment carries both index sets until an operator drops the old ones, and nothing drops them
  automatically.

- **Neutral.** `_trgm` → `_utrgm` renames every trigram index. `emitEntityTableDdl` emits the same
  number of statements. The two folds agree about which rows match — verified live on the same data,
  1000 rows both ways — so a deployment that declares the raw fold answers identically, only slower
  in the indexed case and faster in the unindexed one.

- **Reversibility.** The predicate and the emitter are a few lines each. The *function* is harder: an
  index depends on it, so `DROP FUNCTION` is refused (observed — `cannot drop function
  ce_unaccent(text) because other objects depend on it`) until the indexes go. Reverting means
  dropping the `_utrgm` indexes, dropping the function and re-emitting the bare-column form, which
  restores the defect.

## Implementation notes

**The document store's declared fold — applied, and now fenced.** `listPageOp` in
`packages/operate-runtime-pg/src/entity-ops.ts` builds the document store's `ListSqlAdapter`, and it
carries one member and one import beside the existing `./list-sql.js` block. An earlier version of
this paragraph described it as *"the change the orchestrator must apply, in a file this increment does
not own"*; it was applied in the same session and the status line went stale, which the review
caught. What was genuinely missing is the fence: `listPageOp` had **no test caller at all**, so every
`foldText` assertion ran against a hand-written adapter and this line — the one without which the
increment is incomplete — was asserted by nothing. There is now a test driving the real `listPageOp`
with a recording connection, in both directions (the real store names `ce_unaccent` nowhere and emits
four raw folds; the default fold emits four wrapper calls over the same two surfaces), and deleting
the line fails it.

```ts
import { rawFoldCall } from "./search-function.js";
```

```ts
    // No trigram index exists on `meta.operate_entity_records` — it declares one btree on
    // `(tenant_id, entity)` and no GIN index of any kind — and `pg_trgm` is created nowhere for this
    // store, so the wrapper's per-row call would be pure cost: measured 170.1 ms -> 715.5 ms for a
    // 4-field `?q=` matching nothing over 200,000 rows. `rawFoldCall` is still the pinned
    // two-argument form, and is itself faster than the one-argument `unaccent` it replaces
    // (42.4 ms against 58.0 ms single-field). Whatever gives this store an index must delete this
    // line in the same increment, because it is what makes the predicate unindexable.
    foldText: (sql) => rawFoldCall(sql),
```

**Migration reach, verified rather than assumed.** `ensureSchema` runs `emitManifestSchemaDdl` in a
plain loop and the trigram statements are `CREATE INDEX IF NOT EXISTS` with **no data dependency**, so
the renamed expression index lands automatically on an already-applied deployment — unlike ADR-0360's
unique index, whose outcome depends on existing rows. Verified live: `ensureSchema()` against a
cluster already holding the old indexes created all 272 new ones and reported no refusal.

The function is created **before** the DDL loop **on the boot path**, by `ensureSearchExtension`,
which `node.ts` calls at line 830 ahead of `store.ensureSchema()`. **That is not true of the
per-tenant path**, and this paragraph originally implied it was: `applyTenantManifestSchema` calls
`ensureColumnStoreExtensions` and never `ensureSearchExtension`, so a tenant activating its own
manifest provisions `pg_trgm` and not the function its own index statements name, and the first
`CREATE INDEX` aborts the applier's transaction. On a deployment where boot already created the
function the ordering is fine by coincidence; on a fresh column-store deployment whose first
provisioning is a tenant activation it is not. That is *Open questions 8*.

**Privileges — this increment raises the floor for `--store pg-columns`, and an earlier version of
this paragraph said it did not.** `CREATE FUNCTION` in `public` needs CREATE on the schema;
`CREATE EXTENSION unaccent` needs CREATE on the **database** (all three of `unaccent`, `pg_trgm` and
`pgcrypto` are `trusted = true` in PG 16, so a non-superuser can create them with that one
privilege). The two are **different, not nested**, which is why the function has its own outcome
rather than riding on the extension's.

It then concluded *"`ensureColumnStoreExtensions` already issues two uncaught `CREATE EXTENSION`s, so
the column-store path's privilege floor is unchanged"*, and **that is false**. The review measured it
on this increment's own cluster as its own non-superuser `serving` role:
`has_database_privilege('serving',…,'CREATE')` and `has_schema_privilege('serving','public','CREATE')`
are **both false**, and both `CREATE EXTENSION IF NOT EXISTS` statements nonetheless **succeed** with
`NOTICE: … already exists, skipping` — because `IF NOT EXISTS` short-circuits on an installed
extension before any privilege check, and `deploy/postgres/init` plus the one-shot `extensions`
service install them. So those two statements establish **no floor at all**; the `trusted = true`
parenthetical describes first-install only, which on the shipped stack never happens as the serving
role. `CREATE FUNCTION public.ce_unaccent(text)` as `serving` is `ERROR: permission denied for
schema public`.

The consequence is a real regression on a least-privilege column-store deployment, and it is not a
search gap. With `ce_unaccent` absent, in a schema `serving` owns, the **old** bare-column
`gin (fam gin_trgm_ops)` is created and the **new** `gin (public.ce_unaccent(fam::text)
gin_trgm_ops)` raises `function public.ce_unaccent(text) does not exist` — so this store goes from
*boots and serves, search is a scan* to *cannot apply its schema*. On the boot path
`ColumnMappedEntityStore.ensureSchema` runs those statements in a plain **uncaught** loop, so the
boot dies; on the per-tenant path `applyTenantManifestSchema` runs them inside one transaction, so
the tenant is left on the JSONB fallback and never told, which is ADR-0314's *their data is in a
different place than they think*.

**The floor is therefore stated rather than denied: `--store pg-columns` requires CREATE on schema
`public`, or a one-time `CREATE FUNCTION` by a role that holds it.** The `absent` boot line names
that privilege, names the `IF NOT EXISTS` short-circuit so an operator does not reason from the two
extensions, and prints both remedies — the statement for a privileged role and the grant — because
printing the statement that was just refused to the role that was refused is a remedy that cannot
work (ADR-0334). `--store pg` is unaffected: see *The boot line was wrong in both directions* above.

**Why the dictionary is pinned, and why that is what makes IMMUTABLE true.** `unaccent(text)` is
STABLE for a real reason: it resolves the dictionary named `unaccent` from the caller's `search_path`
at execution time. Measured — with a second dictionary `ext2.unaccent` in place, an unqualified
`'unaccent'::regdictionary` resolves to `ext2.unaccent` under `search_path = ext2, public` and to
`public.unaccent` under `search_path = public, ext2`. A `LANGUAGE sql` string body is parsed at
inlining, in the caller's session, so an unqualified reference inside the wrapper would carry that
dependence straight through and the `IMMUTABLE` label would be **false** rather than merely unproven.

**Why the wrapper is not inlined, and why that is not an accident.** Index matching requires the
query to present the wrapper call that the index *stores*, so inlining and index matching are mutually
exclusive by construction — the call layer is the price of indexability, not an implementation
shortfall. Confirmed two ways: the plan shows `Index Cond: (ce_unaccent((family_name)::text) ~~* …)`
rather than an inlined `unaccent(…)`, and removing `STRICT` (the usual inlining blocker) changed
neither the plan nor the 170–200 ms unindexed figure.

**The `::text` cast.** Written into both the predicate and the index even though it is redundant for a
TEXT column, so the two are one spelling. Both normalise to the same expression tree: a VARCHAR
column's implicit coercion is *stored* as `ce_unaccent((vc)::text)`, and a TEXT column's no-op cast is
elided to `ce_unaccent(tx)` — and the cast-bearing predicate reaches both, measured.

**`PARALLEL SAFE` and `STRICT` are declared and not fenced**, because neither can change which rows
come back. `STRICT` is redundant for the answer — `unaccent` is itself STRICT, so measured, both forms
return NULL for a NULL input — and `PARALLEL SAFE` decides only whether the fallback sequential scan
may use workers (771 ms with two workers against 1865 ms without, for a 5-field group over 1M rows).

**The body comparison trims.** The live run tripped the fence on a hand-created function carrying the
identical statement written `AS $$ SELECT … $$` — two spaces — and told its operator that substring
search may silently miss rows when it will not. Whitespace around a complete SQL statement cannot
change what it does, so trimming admits no false negative; normalising whitespace *inside* it would be
the first step of the SQL parser ADR-0292 refused to write.

**The `body_differs` remedy named the wrong index set, and that was three errors in one clause.** It
read *"then REINDEX every index named in the superseded-index line above (or REINDEX DATABASE)"*.
The superseded line names the **bare-column `_trgm`** indexes, which do not depend on `ce_unaccent`
at all, so reindexing them repairs nothing; the indexes that need it are the expression indexes built
from the function, which **no** boot line enumerates; and that line is pushed *after* this one by
`searchExtensionLine` and is `null` on a converged deployment, so on exactly the deployments needing
this repair there is no "line above". ADR-0334's class — a remedy that cannot work is worse than
none — inside the increment that cites it, and only the parenthetical was ever correct.

It now names the set **by its dependency**: *every index that depends on
`public.ce_unaccent(text)` — which is what `DROP FUNCTION` on it refuses over* (observed, and recorded
under *Reversibility*) — with `REINDEX DATABASE;` as the one form that needs no list. By dependency
rather than by the `_utrgm` suffix for a mechanical reason: the suffix constants live in
`entity-ddl.ts`, which imports `searchFunctionCall` from `search-function.ts`, so naming them in the
line would be a module cycle. Spelling `_utrgm` a second time to avoid the import is what this whole
increment exists to stop. Printing an exact `pg_depend` enumeration was refused for a different
reason: it would be unverified SQL in a boot line, which is the defect ADR-0360 and ADR-0376 both
record. See *Open questions 10*.

**`meta` is in scope for a structural reason, and the measurement that said so was false.** The audit
excludes `pg_catalog` and `information_schema` and nothing else by name, and the note defending that
read *"measured: 0 gin indexes in `meta` on a freshly applied database"*. `META_TABLES` declares
**three** (`idx_audit_actor`, `idx_feature_flags_environments`, `idx_incidents_tenants`, all
`kind: "gin"`), so the figure is wrong — a false measurement defending correct code, ADR-0362's class.
The query was never at risk, for two independent reasons, and the honest statement is the one that
cannot go stale when a fourth gin index lands: the kernel's `IndexSpec` is
`{name, columns, unique?, kind?, where?}` and carries **no operator-class field at all**, so a
catalogued gin index always emits the default opclass for its column type and `gin_trgm_ops` is not
declarable there — and none of the three ends in `_trgm` either. Corrected in the module and in the
test that repeated it.

**The superseded-index scope is three conjuncts, two of which are the finding and one the fence.** The
access method and operator class are asked of `pg_opclass` through `pg_index.indclass` rather than read
out of `pg_get_indexdef`'s text (ADR-0330). `indexprs IS NULL` is the load-bearing conjunct: it is
exactly what makes an index unable to serve the folded predicate, and it is what excludes the
replacement. The name suffix adds nothing to the diagnosis and bounds the **remedy** — without it the
probe would tell an operator to drop every bare-column trigram index in their database, including ones
they created for their own queries. A name is a weak signal (ADR-0355) and here it is this emitter's
own deterministic output, so its error is to *under*-report an index renamed by hand. Measured
complete for the shipped pack: of the 272 names, **0** are truncated by the 63-character cap (longest
is 42, `purchase_order_line_purchase_order_id_trgm`), so every one still ends in the suffix; the 272
replacement names are likewise all `_utrgm` with none at the cap (longest 43). The
suffix's leading `_` is escaped in the `LIKE` pattern, because `_` is a wildcard and the unescaped
pattern would match `_utrgm` too.

**Tests.** 657 pass in `@crossengin/operate-runtime-pg`, up from 563; 94 added across five files, and
`search-extension.ts` had no test file at all before this. **Fifteen fences were mutation-checked**,
each reversed by the inverse string replacement with the mutation asserted present first and the file
asserted byte-restored — never `git checkout --`, which CLAUDE.md forbids by name because other agents
hold uncommitted work. All fifteen were caught.

Three of those fifteen are the review's, and the third is the one worth knowing. Deleting
`entity-ops.ts`'s `foldText` line now fails a test, where **before it failed none**: `listPageOp` had
no test caller at all, so every `foldText` assertion ran against a hand-written adapter and the
shipped `--store pg` fold was fenced by nothing. And flipping `SEARCH_FUNCTION_ADMITS_INDEX`'s
`volatility_differs` arm to `true` is caught by **one** test rather than three, because the other two
derive their expectation from the same map — ADR-0362's retired test, a rule compared against a
derivation of itself. That division is deliberate and is written at both sites: the derived tests fence
the map being **read** (mutation-checked by replacing the read with a constant, which fails both), and
the per-arm literal assertions fence the **values**. The literals must not be "simplified" into a loop.

**One stale fake was found while applying these and is ADR-0363's defect exactly.**
`search-extension.test.ts`'s connection modelled the audit's pre-rename `schema_name` column, so
`r.nspname` read `undefined` and every mapped `schema` came back `undefined` while the two assertions
over it — a row count, and a hand-built result literal in the line tests — still passed. The fake and
the code agreed with each other and with nothing else, and the only symptom was vacuity. Fixed, and
the count assertion is now a `toEqual` over the whole triple.

**Seven pre-existing tests asserted the defect**, which is ADR-0372's class again, and one asserted it
in its own title: `entity-ddl.test.ts:73`, *"uses a plain column trigram index, not a functional
unaccent() index"*, asserting `expect(sql).not.toContain("unaccent(")`. Its premise is still true and
is recorded in `search-function.ts`; its conclusion was wrong. The replacement asserts the index's own
shape rather than the absence of a substring, so an index on a *different* expression cannot satisfy
it.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| 1. Under RLS, **no** trigram index can serve **any** `ILIKE` predicate, because `texticlike` is not LEAKPROOF — measured both ways, and marking `ce_unaccent` LEAKPROOF does not help. On the column store this is moot (ADR-0349: that serving role owns its tables). It is **not** moot for a deployment that gives the serving role a least-privilege non-owning role, or for the document store. `probeSearchIndexReach` reports the role half and cannot ask the per-table half, because it runs before `ensureSchema` creates any table; `kernel-pg`'s `row_security_active` is the right question one argument later. Neither the register nor the brief had this. | Platform | 2026-11-30 |
| 2. **The document store has no index and not even the extension to build one from**, verified three ways: `pg_trgm` is created in exactly one place (`column-store.ts:81`, inside `ensureColumnStoreExtensions`, whose callers are both column-store paths) and nowhere else in any `.ts`, `.sql` or compose file; `meta.operate_entity_records` declares one btree on `(tenant_id, entity)` plus a unique constraint and **no GIN index**; and `PostgresEntityStore` has **zero** occurrences of `ensureSchema`. The wrapper is what would make one creatable — `gin (ce_unaccent(document ->> 'family_name') gin_trgm_ops)` succeeds and the raw form is refused, measured, and takes a single-field `?q=` to **5.6 ms** — but it has nowhere to be emitted from. Closing it means a GIN index in `meta-schema.ts`, `pg_trgm` for that store, a decision about which JSON keys to index, and deleting the `foldText` line above. | Platform | 2026-12-31 |
| 3. **Narrowing the emitter from 272 to 106** (Option H), which is the larger half of the win and pays back 10.7× on writes and 129 MB per 1M rows. | Platform | 2026-12-31 |
| 4. Make `ListSqlAdapter.foldText` **required** (Option G), so a new adapter is a compile error until it declares its fold. Needs both construction sites edited in one change. | Platform | 2026-11-30 |
| 5. **No `statement_timeout`, no pool `max`, and no cancellation of an in-flight query.** The web client's debounce cleanup only `clearTimeout`s a pending request and discards a landed one; 10 concurrent searches on a 1M-row tenant took **7614 ms** wall against a pool whose default size is 10. This increment makes the indexed case fast and leaves the unindexed one unbounded. | Platform | 2026-11-30 |
| 6. A `REINDEX` is printed as a remedy and **nothing verifies the operator ran it**, so a `body_differs` deployment that replaces the function and skips the reindex keeps answering wrongly with no further finding. A checksum of the index's contents is not available; re-probing after the replace would say only that the body now matches. | Platform | 2026-12-31 |
| 7. `rawFoldCall` and `searchFunctionCall` are asserted to pin the same dictionary by a test over their text, not by construction. One function taking the wrapper-or-not as a parameter would make it structural, at the cost of a boolean that decides indexability. | Platform | 2026-12-31 |
| 8. **`ensureColumnStoreExtensions` must provision the wrapper and refuse when it cannot.** This is the half of the privilege fix that is outside this increment's file ownership, and it is the only one that reaches `applyTenantManifestSchema` — see *The argument … expired* for why the refusal belongs there and not in `ensureSearchFunction`. The change is: import `ensureSearchFunction` and `SEARCH_FUNCTION_ADMITS_INDEX` from `./search-function.js`, and after the two `CREATE EXTENSION`s, `const probe = await ensureSearchFunction(conn); if (SEARCH_FUNCTION_ADMITS_INDEX[probe.state] !== true) throw new Error(searchFunctionLine(probe));` — the boot line as the message, so the refusal carries the privilege, the short-circuit note and both remedies rather than a second spelling of them. No cycle: `column-store.ts` already imports `entity-ddl.ts`, which imports `search-function.ts`. It runs *outside* the per-tenant transaction (`tenant-schema-apply.ts:227`, before `:229`), which is what makes it a refusal rather than an abort. The open part is not the statement but the **grade**: `!== true` refuses on `unreadable` too, where nothing was established, and whether an unreadable catalog should refuse a boot or warn is ADR-0322's split and is not settled here. | Platform | 2026-11-30 |
| 9. **Whether the privilege floor should rise at all** (Option I). A per-served-schema `ce_unaccent` avoids it entirely, because ADR-0349's serving role owns the schema it serves and `foldText` is the seam — at the cost of one function, one probe and one `REINDEX` remedy per tenant schema, and a `foldText` that is handed a schema it currently is not. Worth deciding before a deployment meets the refusal in (8). | Platform | 2026-12-31 |
| 10. **The `body_differs` remedy names its index set by dependency rather than enumerating it.** `REINDEX DATABASE;` needs no list and reindexes more than necessary; the exact set is readable from `pg_depend` (`refclassid = 'pg_proc'::regclass AND refobjid = to_regprocedure('public.ce_unaccent(text)')`), which was **not** printed because an unverified query in a boot line is the defect ADR-0360 and ADR-0376 both record, and this increment had no cluster to verify it on. Enumerating them properly means a second audit beside `auditSupersededTrigramIndexes` — which already asks this question for the *other* suffix — threaded into the line through `searchExtensionLine`, which is the only place holding both facts. | Platform | 2026-12-31 |

## References

- PostgreSQL 16, `unaccent` — the two-argument form and the standard `f_unaccent` wrapper recipe.
- PostgreSQL 16, `pg_trgm` — `gin_trgm_ops` and `LIKE`/`ILIKE` index support; lossy index recheck.
- PostgreSQL 16, `CREATE FUNCTION` — `IMMUTABLE`, `LEAKPROOF`, `PARALLEL SAFE`, SQL-function inlining.
- PostgreSQL 16, row security — `check_enable_rls`, and why a non-LEAKPROOF qualifier cannot be
  evaluated before a policy.
- ADR-0144, ADR-0143, ADR-0166 — the fold, the typeahead and the extension.
- ADR-0330, ADR-0331, ADR-0334, ADR-0336, ADR-0337, ADR-0340, ADR-0349, ADR-0352, ADR-0362, ADR-0372.

## Addendum: verified live, and one refinement the maps needed

This increment shipped with *"not verified live"* recorded against it, and every Postgres
measurement in its prose attributed to the review that took it. That gap is now closed, on PG 16.13
(Ubuntu 16.13-0ubuntu0.24.04.1), with a 60,000-row `public.patient` fixture carrying two accented
rows among unaccented filler.

**The index is used, which is the claim the whole increment rests on and which nobody had shown.**
The review measured a sequential scan against a *bare-column* index; what was never demonstrated is
that a GIN index on `public.ce_unaccent(fam)` is read by the predicate that names the same
expression. It is:

| the predicate | plan | time |
|---|---|---|
| `public.ce_unaccent(fam) ILIKE public.ce_unaccent('%angstrom%')` | `Bitmap Index Scan on patient_fam_utrgm` | **0.157 ms** |
| `unaccent(fam) ILIKE unaccent('%angstrom%')` (pre-increment) | `Seq Scan`, `Rows Removed by Filter: 59999` | **23.388 ms** |

149× on this fixture. The figures differ from the review's 129.6/1.95 ms because the fixture and the
search term differ; they are not a reproduction of that pair and are not offered as one. The row it
returned is `Ångström`, found through an **unaccented** term, so the fold is doing its job *through
the index* rather than being applied after it.

**All five probe states were driven against a real catalog**, and the two maps' disagreement — the
reason there are two — holds live:

| state | how it was produced | `ANSWERS_TRUSTED` | `ADMITS_INDEX` |
|---|---|---|---|
| `matches` | the function as `CREATE_SEARCH_FUNCTION_SQL` writes it | true | true |
| `body_differs` | body replaced with `SELECT lower($1)` | **false** | **true** |
| `volatility_differs` | same body declared `STABLE` | **true** | **false** |
| `created` | absent, then `ensureSearchFunction` | true | true |
| `dictionary_absent` | the dictionary dropped *after* the function was created | false | false |

`body_differs` and `volatility_differs` disagree in **opposite** directions, measured, which is the
decision this ADR argued for and could not previously demonstrate.

**The refinement: `absent` and `dictionary_absent` are separated by *when* the dictionary went
missing, and the first attempt at this test got it wrong.** Dropping the function and the extension
and then calling `ensureSearchFunction` answers **`absent`**, not `dictionary_absent` — because
`'public.unaccent'::regdictionary` is a *constant cast*, resolved at parse time, so the `CREATE
FUNCTION` itself is refused and the create's `catch` arm reports `absent` with the error. The
`dictionary_absent` arm is reached only when the dictionary disappears **after** the function
exists, and what makes that reachable is worth knowing: `DROP EXTENSION unaccent` **succeeds with no
`CASCADE` and does not drop the function**, because a string-bodied `LANGUAGE sql` function records
no dependency on a dictionary named inside it. Verified both ways, including that calling the
surviving function then raises `text search dictionary "public.unaccent" does not exist`. So the
map's `dictionary_absent` comment is correct and its *window* is narrower than a reader would
assume, and the conservative `false` it carries is right for a different reason than the obvious
one: the function is already there, so nothing will re-create it.

**The privilege regression is confirmed, including the one Postgres behaviour this ADR attributed to
the review rather than measuring.** As a `serving_nocreate` role holding `CONNECT` and
`USAGE ON SCHEMA public` and *not* `CREATE`:

```
role: { current_user: 'serving_nocreate', can_create: false }
CREATE EXTENSION IF NOT EXISTS unaccent;   -> OK
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -> OK
probe: absent | admitsIndex = false | refuses = true
detail: permission denied for schema public
```

Both extension statements **succeed** for a role that cannot create a function, which is exactly why
they establish nothing about this privilege and why the boot line says so rather than reasoning from
them. The refusal fires, and its line names the privilege, the driver's own message, the statement to
run and both remedies.

Throwaway databases (`adr0383_live`, `adr0383_body`, `adr0383_dict`, `adr0383_priv`) and the
`serving_nocreate` role were dropped afterwards; the cluster was left running.
