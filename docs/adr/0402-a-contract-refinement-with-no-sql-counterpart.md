# ADR-0402: A contract refinement with no SQL counterpart

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-04 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0330, ADR-0352, ADR-0360, ADR-0362, ADR-0373, ADR-0374, ADR-0388, ADR-0399, ADR-0401 |

## Context

ADR-0362 established that of the twelve workspace rules **none compares a contract field to a
catalog column**. ADR-0373 and ADR-0374 then added seven column CHECKs by hand, each chosen by a
rule those ADRs wrote down and never applied mechanically: *a column is owed a CHECK iff a reader
parses it against a contract narrower than its type.* This increment applies that rule for the
first time, at both scopes — per-field (a column CHECK) and cross-field (a table constraint) — and
takes register P2.12b, P2.12c and P2.13(a)/(c).

The class in one sentence: **the catalog enforces what somebody thought to enforce, and nothing
asks what the contract declares.**

### The rule cannot be an offline text comparison, demonstrated twice on my own measurement

ADR-0352 refused a regex over deparsed CHECK text and the refusal holds one level out. Two
candidate classes were produced by comparing the declaration against the CHECK *as text* and both
were wrong:

- `num_nonneg`: the text test reported 1 uncovered column; live, **25 of 25** are already fenced,
  because `>= 1` covers `.positive()` and the pattern `/>=\s*0/` did not see it.
- `min_length` on `gdpr_deletion_requests.request_id`: a false positive, because
  `^dreq_[A-Za-z0-9_-]{8,40}$` already bounds the length and a regex over the expression cannot
  tell.

So the candidate is taken from the **contract** and the question is asked of a **live database** —
ADR-0352's own split, with the direction reversed. Soundness comes from a per-candidate floor:
assert the contract **refuses** the candidate before asking whether the column admits it.

### The per-field measurement

Denominators first, because CLAUDE.md carries three and all three had drifted: 505 TEXT / 159 JSONB
/ 444 TIMESTAMPTZ columns with no CHECK reads **502 / 158 / 443** today, and the difference is
exactly accounted for (ADR-0373 −2/−1/0, ADR-0374 −2/0/−2, ADR-0387 +1/0/+1). *Drifted, not
wrong-when-written.*

The honest population, which the register gave none of: **1,135** no-CHECK columns of a
constrainable type (excluding 409 UUID and 76 BOOLEAN, which the type constrains), of which **583**
sit on a table `STORELESS_TABLES` declares writerless and **552** on a writer-bearing table across
69 tables. Of 450 (column, binding) pairs, **302 resolve to a contract field** (67%).

Live, as the non-owner `serving` role on PG 16, with a per-candidate type cast, a savepoint each and
`SET TRANSACTION READ ONLY`: **124 candidates derived from contracts, 92 ADMITTED** — the column
takes a value its own contract refuses — across **87 distinct columns and 19 tables**. 32 were
refused by a live CHECK (the fence works where it exists) and **0** by the type. By class: instant
35, `min_length` 30, `max_length` 22, uuid 5.

The chain through the **real store** (`apps/operate-server`'s notification-template store, which
parses and throws), as the non-owner:

| write | read back |
|---|---|
| floor: untouched row | `store.list()` OK, 1 record |
| `created_by := 'not-a-uuid'` | committed; **`ZodError {validation: "uuid", path: ["createdBy"]}`** |
| `created_at := 'infinity'` | committed; **bare `RangeError: Invalid time value`** |
| `created_at :=` year 294276 | committed; `RangeError` |
| control: `'' → actor_reference` (ADR-0373-fenced) | refused `23514` by the database |

`notification_templates` is the specimen and shows the selection was per-column rather than
per-class: **8 of its 18 columns carry a CHECK and they are exactly the value-set and pattern
ones**, while `created_at`, `created_by`, `approved_at`, `approved_by`, `content` and `variables`
carry none.

The **uuid** class is the consequence of two previous increments' own fixes, which is what makes it
the sharpest member rather than an oversight. Of 109 actor-ish columns, 74 are still `UUID`, 35 are
`TEXT`, and **31 are TEXT with no CHECK and no reference**. ADR-0335's rule is that *a column
recording who performed an act is a record of the past, and a referential constraint on it makes
the actor undeletable* — and the remedy that rule demands is dropping the **reference**.
`meta.feature_flags.created_by` is the existence proof sitting in the same catalog: `UUID` with
`references: null`, which satisfies the rule and keeps the shape. ADR-0370 then converted
`notification_templates.approved_by` for a different reason (a `uuid <> text` four-eyes comparison
Postgres has no operator for) and likewise replaced nothing. Of the 31, 6 resolve to a contract
field and **5 of those declare `.uuid()`**.

### The cross-field measurement, and the two floors that shaped it

The register named two members: a `cron_schedule` row with a NULL `cron_expression` (P2.13(c)) and
a breach notification with no deadline (P2.13(a)). My own pre-increment notes said the first was
"four shapes, not one". **Both figures are wrong and the correction runs in both directions.**

Floor 1 — *the contract refuses it*, by `safeParse` of the candidate row rather than a reading of
the source. Two shapes that look incoherent are **admitted** by `WorkflowTimerSchema`: an
`absolute_at` carrying both parameters, and a `business_hours` carrying a cron expression. That
schema has three *requires* clauses and no *surplus* clause, so a CHECK refusing either would be
stricter than the contract — ADR-0373's rule pointing the other way. My "four shapes" counted
*incoherent rows the database admits*, which is not the predicate.

Floor 2 — *the live writer satisfies it* (ADR-0360: a constraint the writer can violate turns a
working write into a `23514` inside a transaction). `projectTimers` is pure, so this is answerable
offline: eleven writer-producible rows across the three statuses it can reach, each evaluated
against each clause.

With both floors applied the figure is **21 expressible clauses across two tables** — nine on
`workflow_timers` and twelve on `incident_communications` — against the register's two. Plus four
that are not defects and are declared as such:

| tier | member | why |
|---|---|---|
| `contract_admits` | `absolute_at` with both parameters; `business_hours` with a cron expression | a CHECK would be stricter than the contract |
| `writer_cannot_satisfy` | `cancelled` requires `cancelled_reason` | see below |
| `operand_absent` | `absolute_at` requires `absoluteTimestampVariable` | no column holds it |
| `check_forbidden` | `languages` must be duplicate-free | set distinctness needs a subquery |

The `writer_cannot_satisfy` member is the one worth the most. `PostgresTimerStore.upsert` names
sixteen columns and `cancelled_reason` is in neither its column list nor its `SET` list, so every
cancellation writes NULL; `projectTimers`' `MutableTimer` has no such field to carry; and the two
`timer_cancelled` emitters **disagree about whether the log holds the fact at all** —
`cancelInstance` writes `payload.cancelledBy = "instance_cancellation"` while `applyCancelTimer`
writes `payload = { timerName }` and names no cause. So a constraint there would refuse every
cancellation the engine performs, and substituting a default would state a reason nobody gave,
which `TIMER_PROVENANCE_DEFECTS` refuses by name.

And `timer-provenance.ts`' own doc comment states this whole class outright — *"writing the kind and
omitting its parameter produces a row the contract forbids and the CHECK permits, which is the very
class this fix is closing"* — having closed it at the **writer**, so any second writer or a
hand-run `UPDATE` reopens it. Measured as the non-owner under tenant context: every one of the nine
shapes was admitted.

### P2.12c, where three of the four stated reasons do not survive

`resolution.ts`' comment argued that `created_at`/`updated_at` must stay out of
`RESERVED_ENTITY_FIELD_NAMES`: *a name refusal is the wrong instrument, because `auditable` supplies
exactly those two names and an own field colliding with a trait-supplied one is already refused, so
the uncovered case is an own `created_at` on an entity without `auditable`, where what is wrong is
the type.*

- **The collision is not already refused where it matters.** `checkEntityFieldNames` refuses it and
  has two callers, both in `computeEntityDiff` — the *reviewer's* path — while `validateManifest`
  tests only the reserved set. Measured: `auditable` plus an own `created_at: text` is **accepted**
  by `validateManifest`, so on a deployment not passing `--require-design-review` the collision
  reaches the schema.
- **Adding them does not refuse the built-in trait.** The set is evaluated in three places and none
  sees a built-in trait's fields. Verified by adding them: all 69 pack entities, 68 `auditable`,
  still validate.
- **The type is not the whole of what is wrong**, which is why a type check was refused as the
  remedy. Measured live, each case its own entity (the first run contaminated itself, because
  `columnPlanForEntity` derives the table from the *entity name* and ignores a `table` option):

| case | result |
|---|---|
| own `created_at: text`, no `auditable` | `text`, **nullable**, and the `ALTER` **succeeds** — the default becomes a `DateStyle`-dependent text rendering (`"04.11.2026 08:53:15.311 UTC"` under German/DMY) that `z.string().datetime({offset: true})` refuses in **all four** settings including the default |
| own `created_at: datetime` | `TIMESTAMPTZ` **nullable**, where the system column is NOT NULL — so a type check alone loses the stamp's guarantee |
| `auditable` + own `created_at: text` | `validateManifest` **accepts** it |
| own `updated_at: integer` | `ALTER … SET DEFAULT` raises **`42804`**, the transaction aborts (`25P02` thereafter), so ADR-0360's single-transaction `applyTenantManifestSchema` fails and the tenant is served from ADR-0314's JSONB fallback |
| control: both proper | `TIMESTAMPTZ NOT NULL`, stores `"2026-11-04T08:52:49.946Z"` |

### P2.13(a) and P2.13(b), measured

`isBreachNotificationTimely` has **zero non-test callers** and three arms, two of which answer
false — and the `superRefine` refuses **both**, so of 8 probe inputs 2 parsed and **0 made the
predicate answer false**: provably constant `true`. The catalog's
`incident_communications_breach_window_check` enforces the **comparison** and not the
**requirement**, so live, as the non-owner: a breach notification with a NULL deadline was
**admitted** by the database and refused by the contract — *exactly the input that would make the
predicate answer false*. So P2.13(a) contains a P2.12b member and the two items are one class.

P2.13(b) is confirmed and sharper than the register: there are **two exported `HASH_ALGORITHMS`
constants with the same name and non-overlapping members past `sha256`** (forensics
`["sha256","sha512","blake3"]`, crypto `["sha256","blake2b-512"]`), of forensics' three only
`sha256` is computable anywhere, and `root_hash CHAR(64)` structurally refuses the 128-hex digest
that would make `algorithm='sha512'` true. `pg-value-set-domains.ts` declares the column `mirrors`
that enum and **passes, because both artifacts are wrong together** — ADR-0361's lesson on the
value-set rule. Left open: it is a contract edit with a stored-digest consequence, not a CHECK.

## Decision

### Seventeen column CHECKs behind two shared helpers, and 40 columns given them

`instantRangeCheck(column)` and `uuidShapeCheck(column)` are exported from the catalog and applied
to the **40** columns the live admission test named (35 instant + 5 uuid), with ADR-0374's two
inline instant expressions converted to the helper rather than left as a second spelling. Total
column CHECKs: **788 → 828**.

`instantRangeCheck` carries ADR-0374's three measured decisions, which is the reason it is a helper
and not 37 literals: the lower bound is **1 BC and not 1 AD** (because `toISOString()` renders JS
year 0 as `0000-01-01T00:00:00.000Z`, which zod admits and Postgres reads as 1 BC, so an AD bound
would refuse what the reader accepts); the **`+00` is load-bearing** (a bare literal folds in the
applying session's `TimeZone` and under `Asia/Tokyo` crosses the era boundary); and there is no
`isfinite()` and no `extract(year …)`, the latter being STABLE.

`uuidShapeCheck` is a **pattern and not a cast**, because `col::uuid` in a CHECK raises `22P02`
rather than violating, which aborts a batch where a `23514` is an answer (ADR-0352).

### Seventeen table-level constraints, taking the catalog from 8 to 25

Seven on `meta.workflow_timers` (covering eight clauses) and ten on
`meta.incident_communications` (covering thirteen). Clauses that share a discriminator and a remedy
are combined under one name, following `workflow_definitions_published_fields_check`; the
status-page pair is a **biconditional** following `notification_user_quiet_hours_window_pair_check`,
because the contract states it in both directions.

`languages` and `delivery_channels` are fenced as `jsonb_typeof(x) = 'array' AND
jsonb_array_length(x) >= 1` — `jsonb_typeof` **first**, because `jsonb_array_length` raises `22023`
on a non-array and the bare form would turn a malformed row into an error rather than a violation
(ADR-0373's reason for the tombstone attestations fence). `delivery_channels` is a *per-field*
refinement found by hand, because `comms-store.ts` renders its column list from
`COMMS_COLUMN_NAMES.join(", ")`, so `scanColumnBindings` resolves **zero** bindings for that table —
one of 19 writer-bearing tables in that state, which is the census's real bound (open question 4).

Nothing deepens the `breach_window_check`. GDPR Article 33(1) requires a late notification to be
reportable *with its reasons for the delay* — a field no record here carries — so the register's
standing item is a **relaxation plus a new field**, and the clauses added are the ones that make the
table agree with the contract rather than ones adjudicating whether the contract is right.

### `created_at` and `updated_at` are reserved names, with their own reason

`IMPLICIT_COLUMN_CONSEQUENCE` is a total map over the four implicit columns to the two mechanisms
(`duplicated` for `id`/`tenant_id`, `overridden` for the timestamps) and
`RESERVED_ENTITY_FIELD_NAMES` is derived from it. The map exists because **one shared message was
false for half the set the moment the set grew past two**: "a declaration of it is a duplicate
column" is true of `id` and wrong about `created_at`, where the emitter writes the system column
*instead*. Measured cost of the addition: **zero** — 0 of 556 own fields and 0 trait fields across
the seven packs and the four compliance packs.

`emitTimestampPrecisionDdl` skips a system timestamp whose **planned** column cannot take the
default, with `timestampPrecisionSkips` naming what was skipped. That is the backstop for a manifest
stored before the rule, and it is ADR-0360's savepoint reasoning without the savepoint: *report a
refusal rather than turn it into the total failure*. The predicate is the **emitted** type, so
`encryptAtRest` is covered by construction (`columnType` renders a classified column `BYTEA`
whatever its field type, and a `BYTEA` default raises exactly as `INTEGER` does).

### Two fences, and the one the live apply found

`tableConstraintNamesAvoidColumnFamily()` refuses a table-level constraint named
`<table>_<column>_check`, because Postgres derives exactly that name for an inline column CHECK over
one column (ADR-0330, the naming family `column-check.ts` exists to predict). **Four of the
seventeen did, and only the live apply found it** — `check constraint "…" already exists` at
statement 1,563 of the bootstrap. The fence is the **shape** and not the present collision, because
only two of the four collided at the time: the other two named columns carrying no CHECK, so they
applied cleanly and would have broken the apply the day somebody added one. A present-tense check
would have passed on exactly the latent half.

`INSTANT_RANGE_CHECKED_COLUMNS` / `UUID_SHAPE_CHECKED_COLUMNS` are the 40 pairs as a **declared
list compared in both directions**, with equality against the **helper's own output** rather than
against a second spelling written in the test — the distinction ADR-0362 retired a test for. A
hand-edited expression on one column fails; a deliberate change to the helper moves both sides
together, which is correct because the helper *is* the definition. The list also separates the uuid
shape from ADR-0302's two structured-actor checks, which a regex counting `[0-9a-f]{8}-` matches
(7 columns look uuid-ish; exactly 5 carry this constraint).

## Alternatives

**An offline workspace rule deriving the candidates from the contracts.** Refused: unsound, shown
twice on this increment's own measurement (`num_nonneg` 1 → 0; a bounded pattern false-positived as
`min_length`). `packages/testing` imports no workspace package and reads from disk, and a rule green
only after a database is not a rule — so the derivation stays live and the *declaration* is what a
test compares.

**All 92 live-admitted candidates in one increment.** Refused on migration cost: `decideCheckPlan`
plans a new CHECK only on `live_implies_declared` or `!confined && rowCount === 0`, so on a
populated deployment each is `constraint_widening_unproven` — **92 standing manual `ALTER`s**. The
40 shipped are the two classes where a refused row defeats a *detector* (a bare `RangeError` and a
`ZodError` in a store whose consumer is a verifier); `min_length` 30 and `max_length` 22 are
declared backlog, where the consequence is a `ZodError` on read and no detector is disabled.

**Declaring all 552 writer-bearing no-CHECK columns.** Refused: 552 declarations by hand against
`pg-value-set-domains.ts`' 288, for a population where **250 of 552 do not resolve to a contract
field at all**.

**`.regex()` → SQL `~`.** Refused: a JS `RegExp` is not a Postgres ARE, 656 occurrences, and the
7 regex candidates are excluded for that reason. **`.email()`/`.url()`** likewise: zod's `.url()` is
`new URL()`, which no CHECK expresses.

**A surplus-parameter constraint on `workflow_timers`.** Refused by floor 1 — the contract admits
both shapes, so the CHECK would be stricter than the declaration. This was in my own pre-increment
design and the floor is what removed it.

**A type check as the P2.12c remedy** (the register's prescription). Refused on measurement: an own
`created_at: datetime` yields a **nullable** TIMESTAMPTZ where the system column is NOT NULL, so
the type alone loses the guarantee the column exists to carry.

## Consequences

**The migration.** On a fresh database all 57 new constraints are in the emitted bootstrap —
verified by applying it and then **re-planning against the database it produced: 0 steps, 0
unreconciled**, over **983** emitted statements. (That figure was 964 in this ADR's first draft,
carried from ADR-0355 rather than measured, which is register P3.1's class inside the increment
whose method section is about floors: a statement count is a *drifted* figure, so the remedy is to
re-derive it and not to re-quote it.) On a populated one each is reported with its SQL as
`constraint_widening_unproven`, and some deployments will instead get
`constraint_violated_by_existing_rows` with a violator `SELECT` — the migration finding a row that
should not exist, as ADR-0373's and ADR-0374's did.

**Verified live** as the non-owner `serving` role on PG 16.13: the catalog applies with all 17
table constraints present and deparsing as declared, and **35 probes with 0 mismatches** — each new
constraint refuses the shape its contract refuses and admits the coherent control; the live writer's
own cancelled row passes (the clause deliberately not declared); both contract-admitted surplus
shapes pass; and the duplicate-language clause a CHECK cannot say is admitted.

**Mutation-checked**, four ways, catalog byte-identical afterwards: dropping one instant CHECK,
hand-editing the instant lower bound to 1 AD, renaming a table constraint into the column-check
naming family, and removing `workflow_timers`' constraints — each caught by its named fence.

**A test that pinned the defect is rewritten rather than deleted.**
`validate.test.ts`'s *"holds the emitted columns a declaration duplicates, and not the ones it
overrides"* required `validateManifest` to accept an own `created_at: text`. That is this run's
seventh instance of ADR-0372's class — the defect written down as a specification — and what
survives is pinned: the two mechanisms differ and the message must say which.

**The declared non-defects are a taxonomy and not a list of excuses.** Four tiers, each costing
something checkable: `contract_admits` (a CHECK would be stricter), `writer_cannot_satisfy` (the fix
is at the emitter), `operand_absent` (no column holds the operand), `check_forbidden` (Postgres
forbids the expression). It mirrors `pg-unreachable-stores.ts`' ordering-versus-shape distinction,
for the same reason: calling all four "unfenced" sends the next person to write the constraint that
cannot be written honestly.

**One consequence stated rather than guarded**: `emitTimestampPrecisionDdl`'s skip is silent at the
emitter, because that function returns `string[]` and has one caller. `timestampPrecisionSkips`
exists so a caller holding a reporting channel — `applyTenantManifestSchema` already returns
`uniqueIndexRefusals` — can surface it, and threading it there is the follow-up.

## Open questions

1. **`min_length` 30 and `max_length` 22 are declared backlog**, and the decision is whether 52
   standing manual `ALTER`s buy enough: the consequence is a `ZodError` on read, which no detector
   depends on, so they are the weakest members of the class and the bulk of its migration cost.
2. **`cancelled_reason` needs a cause on the second `timer_cancelled` emitter and a field on
   `MutableTimer`** before its constraint can land. `applyCancelTimer` writes no cause at all, so
   this is a question about what a `cancel_timer` action's reason *is* rather than a wiring step.
3. **`absolute_timestamp_variable` has no column**, so an `absolute_at` timer row cannot record
   which variable it reads its instant from. Adding one changes `TimerProvenance` and the store's
   sixteen-column INSERT, and `definitionContentSha256` does not cover it, so it is cheap — but it
   is a column for a kind `TIMER_KIND_SCHEDULING` marks `schedulable: true` and nothing schedules.
4. **The per-field census is bounded by the binding index, and that bound is wider than it looks.**
   **19 of the 69 writer-bearing catalogued tables resolve ZERO bindings** (27.5%), so the census
   cannot ask about a single one of their columns — and the two columns this increment found *by
   hand* are both on that list. 247 unresolved entries explain it, concentrated in four writer
   idioms: `parameter_not_a_property` 93, `value_not_a_parameter` 73, `params_after_spread` 29 and
   `params_not_an_array` 26, plus `set_clause_unresolved` 11, `values_clause_unresolved` 10,
   `values_clause_absent` 3 and `column_list_unresolved` 2. Two of them are decisive here:
   `comms-store.ts` renders its column list from `COMMS_COLUMN_NAMES.join(", ")`, and
   `integrity-verdict-store.ts` passes a `params` **variable** rather than an array literal.
   That last one is the sharpest consequence, because it explains a remainder rather than merely
   bounding a figure: ADR-0374 named **`meta.audit_integrity_verdicts.verified_at`** "the sharpest
   remainder" of its class — whose `isoOf` turns the same tamper into a bare `RangeError` inside the
   store that holds the verdicts — and **this increment did not close it**. Not because the field
   lacks a refinement (`verifiedAt` is `z.string().datetime({offset: true})`, declared twice in that
   very file) but because the table is one of the 19. So the honest statement is that the class's
   population is *the binding index's reach*, and raising it is a scanner increment with a census
   behind it, not more CHECKs. 158 JSONB columns carry no CHECK and the index resolves 2.
5. **The two `HASH_ALGORITHMS` constants** (P2.13(b)) are a contract edit whose stored-digest
   consequence is unmeasured, and `CheckpointMeta.algorithm` is typed `string` rather than either
   enum, so nothing would catch a third spelling either.
6. **`isBreachNotificationTimely` is still constant `true`** and still callerless. This increment
   made the table agree with the contract; whether the *contract* is right about Article 33(1) — a
   late notification must be representable with its reasons — is untouched and needs a new field.
7. **`parseCatalogSource` cannot see a CHECK expressed as a helper call, and this increment is what
   made that reachable.** Found by auditing this ADR's own diff rather than by a test: that parser
   reads `check:` only as a **string literal**, so running it over the pre- and post-change source
   reports `checkAdded: 0` for all 40 new CHECKs and `checkRemoved: 2` for ADR-0374's two inline
   instant literals that this increment converted to `instantRangeCheck(…)`. Harmless today and
   measured so — the one strategy consumer of that field is `pg-value-set-domains.ts:116`, whose
   population is **288 before and 288 after**, because every helper-expressed CHECK here is a range
   or a pattern and never a value set. What is now reachable is the next person expressing a
   **value-set** CHECK through a helper (plausible: `retainedRecordNoTenantDelete` is already a
   policy helper, and a shared status vocabulary is the obvious case), which would drop that column
   out of the 288 **silently** — in the one rule whose whole purpose is that every value set
   declares its domain. The honest remedy is one level up and is a *scanner* change: have the parser
   report a helper-call `check` as **unreadable** rather than absent, so a rule can refuse to go
   quiet (`pg-record-reads.ts`' silent-skip shape, already on file as register P3.3). It is not
   bolted onto this increment because `parseCatalogSource` is the input to nine rules, which
   CLAUDE.md says needs a census behind it. The cheap interim fence is a source-text assertion that
   no helper-expressed CHECK is a value set; it needs the kernel's test to read its own source from
   disk (ADR-0392's `served-surface.test.ts` idiom) and to reach `catalogValueSets` across a
   devDependency, so it is a choice between that and the scanner fix rather than a free addition.
