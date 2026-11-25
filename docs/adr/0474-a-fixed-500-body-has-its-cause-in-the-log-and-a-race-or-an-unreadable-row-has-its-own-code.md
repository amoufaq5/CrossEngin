# ADR-0474: A fixed 500 body has its cause in the log, and a create race or an unreadable row has its own code

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0359 (a thrown handler's 500 names nothing), ADR-0373 / ADR-0405 (a page one bad row takes with it), ADR-0383 (the search fold), ADR-0417 (loading existing records), ADR-0425 (bounded boot DDL), ADR-0432 (posting refusals), ADR-0440 (maker-checker on moved lines; the unique enforcement line), ADR-0444 (boot DDL changes only what differs), ADR-0449 (the gateway's request-id log line) |

## Context

Seven write-path and boot diagnostics, each re-measured before it was designed against. All seven
are a fact that existed at the failure site and did not reach the person who has to act on it.

1. **A write failure's cause reached nobody** (register P2.7, ADR-0449 Q1). `writeTxn` answers an
   unclassified failure with the fixed body `500 {"error":"write_failed","detail":"the write could
   not be completed"}`, deliberately, because the exception is a database error naming tables,
   constraints and tenant ids. Its comment said the cause was "in the process log". Nothing wrote
   it there: a handler that *returns* a 500 is not one that throws, so the gateway's
   `onInternalError(err, {requestId, stage, answered})` never ran. Measured live: a forced `23503`
   answered the fixed body and the log held only the gateway's generic
   `{"reason":"handler_returned_500"}` record. A second comment beside the posting refusals
   (ADR-0432 Q6) said their details were built from "literals and server-chosen values only",
   while the tax refusals carry the caller's own jurisdiction and tax codes, dates and amounts —
   none a classified field, so a stale comment rather than a disclosure.
2. **Two creates of one new caller-chosen id: the loser answered 500** (register P1.13b,
   ADR-0417 Q2). The create handler's pre-flight `get` cannot see an uncommitted row, so both
   requests pass it and the loser meets the database's own key: `<table>_pkey` on the column store,
   and on the document store `operate_entity_records_tenant_entity_record_key` — **not** a pkey,
   because `meta.operate_entity_records`' primary key is the surrogate `id` no caller names. The
   brief named "pkey" for both; the document store's real constraint is the unique key. A sequential
   duplicate was already 409 `id_conflict`; the race was `500 write_failed`.
3. **One unreadable row made a whole list page an unclassified 500** (ADR-0405 Q1, ADR-0373 Q1).
   Re-measured, the column store's mapper is **total in practice**: `kernel-pg`'s `isoInstant`
   renders an invalid `Date` as the string `"Invalid Date"` rather than throwing, so a `TIMESTAMPTZ`
   in year 294000 reads back without error. The live producer of the 500 is one layer up, in the
   wire-type decorators (`withDatetimeWireType` / `withDecimalWireType`), which throw
   `DatetimeWireError` / `DecimalWireError` with `direction: "stored"` for the first record they
   cannot represent. The store's `listPageOn` was nonetheless a bare `rows.map(rowToRecord)`, the
   last `unmigrated` member of ADR-0373's class on the most-travelled read in the product.
4. **A refused unique index always said "duplicates"** (ADR-0425 Q2). Both boot sites printed
   *"the duplicate rows are already there … Deduplicate, then run"*. Since ADR-0425 a boot statement
   runs under `lock_timeout` and `statement_timeout`, so an index on a table another session holds is
   refused `55P03` having read no row; the printed remedy sends an operator hunting for duplicates
   that may not exist. And the column store's **applying** arm fed nothing to the boot enforcement
   line, so a refused index there was counted enforced (ADR-0440 Q9): `ensured.uniqueIndexes` is
   filled on the verifying arm only.
5. **A boot behind an exclusive lock failed naming nothing** (ADR-0444 Q6). `applyBootStatement`
   rethrows Postgres's own `canceling statement due to lock timeout` after its retries, which names
   neither the table nor which of the 1,274 statements an `erp-core` boot issues was waiting.
   Measured: every one of the 1,274 names at least one planned table; 75 name two (a foreign key).
6. **The search fold had a default** (ADR-0383 Q4). `ListSqlAdapter.foldText` was optional and
   `foldOf` fell back to the indexable wrapper, so a store that forgot to declare its fold silently
   got one it might not have an index for — the document store has none and measured 170.1 ms →
   715.5 ms under the wrapper.
7. **A line moved onto an approved document had no offline fence** (ADR-0440 Q8). The maker-checker
   read of child rows checks `created_by` *or* `updated_by`; the moved-onto direction was pinned only
   by a trailing assertion in an unrelated test.

## Decision

**The rule: a fixed body is a decision about the caller, never about the operator; the cause goes
to a required reporter under the request id the caller holds, and a failure the caller can act on
gets its own code.**

1. **`HandlerContext.reportFault` is required** (`handler-fault.ts`), with two kinds,
   `write_failed` and `page_unreadable` — two because the second fixed-body failure is a read, and a
   seam named for writes would have been a misnomer. `writeTxn` calls it immediately before its
   unchanged fixed 500. `compileOperateServer` builds it from `onInternalError`, which moved from
   `OperateGatewayOptions` to `OperateRuntimeOptions` so the compile step can read it; the gateway
   forwarding is unchanged. Without one, a console line in the gateway's own `[5xx] <requestId>`
   shape. The fault travels to `onInternalError` as a `HandlerFaultReport` whose `stack` is the
   redacted line alone, because that reporter prints `err.stack ?? err.message` and the original
   stack begins with the message. **Redaction is by error shape**: a `ZodError` is reduced to sorted
   `path: code` (its message is the JSON of its issues, and `invalid_enum_value` carries the value);
   a Postgres error prints `name sqlstate= constraint= table= column= schema=` and never `message`
   or `detail` (which hold `Key (…)=(value)`); anything code-authored prints `name: message`, bounded
   at 500 characters. Required and not optional, because an optional reporter defaulting to silence
   is the defect as a default (ADR-0364's addendum); a reporter that throws is swallowed so a failed
   log cannot lose the response. Both false comments are rewritten.
2. **`RecordIdConflict(entity, id)`** in `store.ts`, thrown by both stores on their own id key
   (`isPrimaryKeyViolation(err, table)` against `entityPrimaryKeyConstraintName`, truncated to 63 as
   Postgres truncates; `isDocumentRecordKeyViolation` against `DOCUMENT_RECORD_KEY_CONSTRAINT`,
   asserted equal to the catalog's declaration). `writeTxn` answers **409 `id_conflict`** — the
   pre-flight's own body — only when the conflict names this entity *and* the id the caller supplied;
   a conflict on a server-chosen id stays the fixed 500, because "choose another id" is an
   instruction the caller cannot follow for a value it never sent (ADR-0360's 409 rule).
3. **`ListRowUnreadable(entity, rows)`**: `listPageOn` reads through `readRowsWithUnreadable` and
   throws naming every refused row's id and detail, dropping none. The list handler catches **the
   store call alone** and answers **500 `page_unreadable`** naming the entity — for that error and
   for a decorator's `stored`-direction `DatetimeWireError` / `DecimalWireError`, which is the
   producer that actually fires; an inbound wire error is the caller's and is rethrown. The body says
   *what refused it is in the server log under this request's id*, not "the refused records are
   named", because the decorator arm names entity and field and not the row — found live. The
   `pg-unreadable-rows.ts` declaration is **deleted**, not moved: the rule derives the site
   `guarded_by_primitive` now, and keeping an `unmigrated` declaration reads `overtaken`.
4. **A refusal carries its cause**: `onUniqueIndexRefused` gains a required fourth argument
   `{field, cause}` with `cause ∈ {duplicates, timed_out, other}` decided by SQLSTATE (`23505`,
   `applyStatementStop(err) !== null`, else), and `TenantUniqueIndexRefusal` carries `field` and
   `cause`. `apps/operate-server/src/unique-index-refusal.ts` is the one formatter both `node.ts`
   sites use, over a total map from cause to sentence: **only `duplicates` says deduplicate**;
   `timed_out` says no row was read and names **no flag**: the boot store and `column-schema` build
   the index through `applyBootStatement`, whose `SET LOCAL` bounds are fixed and override
   `--pg-lock-timeout-ms` / `--pg-statement-timeout-ms` (only a tenant application runs under the
   serving session's bounds). The first draft named both flags, which review found false for the
   arm that prints the line most.
   The applying arm's refusals feed the enforcement line through `observedUniqueRefusal`, with a new
   `index_timed_out` reason beside `existing_duplicates`, whose own sentence stops saying "the shared
   table" now that the column store reports it too.
5. **`BootDdlStopped`**: the column store's bounded-DDL runner catches a `lock_timeout` /
   `statement_timeout` stop and rethrows naming the planned tables the statement mentions and its act
   (`ADD COLUMN`, `CREATE TABLE`, …), with a `pg_locks` lookup that names those tables so it can be
   pasted as printed. A `statement_timeout` stop says to run that act on that table by hand while
   it is quiet — not to raise the bound, which no flag reaches. Any other DDL failure is untouched.
6. **`foldText` is required** on `ListSqlAdapter` and the fallback is deleted; both adapters
   declare theirs (the column store the wrapper, the document store the raw fold).
7. A fake-store test where Alice moves Carol's line onto a bill Alice then approves → 422
   `maker_cannot_approve` naming `BillLine`, with a control approver at 200.

## Alternatives considered

- **Put the cause in the 500 body, bounded.** Refused on ADR-0359's ground: the body is read by the
  caller and the cause names schema objects and tenant ids; the request id the caller already holds
  is the join to the log.
- **Name the seam `reportWriteFault`.** Refused: the second fixed-body failure is a read.
- **Map every `23505` in `writeTxn` to `id_conflict`.** Refused: a `23505` on a declared unique field
  is already `UniqueViolation`'s 409, and one on an index nothing attributes is an internal fault.
- **Move the `pg-unreadable-rows.ts` declaration to `page_refusal_declared` (the brief).** Refused by
  the rule itself: a site guarded by the primitive needs no declaration, and the rule refuses a
  reason that contradicts its derived verdict.
- **Make the decorators name row ids.** Out of this slice's files (`datetime-store.ts`,
  `decimal-store.ts`); recorded as an open question.

## Consequences

- An operator greps one request id and finds both the gateway's record and the cause; the client's
  body is byte-identical to before for `write_failed`.
- Two concurrent creates of one id answer 201 and 409 on both stores.
- A list holding one unreadable row answers a named 500 rather than an unclassified one; the row is
  not dropped, so the collection is still unreadable until the row is repaired — the decision ADR-0405
  made for the console list routes, now on the entity list.
- A deployment supplying its own `ListSqlAdapter` must now declare `foldText` (a compile error).
- `onUniqueIndexRefused`'s signature changed; the one external spelling outside this slice,
  `bin/operate-server.ts`' `column-schema` line, still prints the old "Deduplicate" sentence.

## Implementation notes

Files: `packages/operate-runtime/src/{handler-fault.ts (new), handlers.ts, store.ts, compile.ts}`
and `handlers.test.ts`; `packages/operate-runtime-pg/src/{column-store.ts, entity-ops.ts,
list-sql.ts, tenant-schema-apply.ts}` and their tests plus `entity-ops.test.ts` (new);
`apps/operate-server/src/{unique-index-refusal.ts (new), unique-enforcement.ts, node.ts}` and
`unique-index-refusal.test.ts` (new); `packages/testing/src/strategy/pg-unreadable-rows.ts`.

Mutation-checked: removing the `write_failed` report fails 4 tests; disabling the `RecordIdConflict`
arm 1, and widening its id test 2; disabling `page_unreadable` 1; the document store's key arm 1;
the column store's pkey arm 1; `listPageOn`'s refusal 1; `BootDdlStopped`'s arm 1; the column
store's `foldText` 1 (a new assertion — the mutation survived before it was added); removing the
`updated_by` clause in `maker-checker.ts` fails the new moved-onto test.

## Verification

Live on PG 16.15, owner `crossengin` (superuser, as the official image's `POSTGRES_USER` is) and the
confined `crossengin_app` (`NOSUPERUSER NOBYPASSRLS`, owning 0 of 147 tables, from
`deploy/postgres/roles/app-role.sql`), catalog applied with `crossengin apply --confirm` (994
statements), `document-indexes` and `column-schema` as the owner; `operate-server --pack erp-core`
on 8806 as the confined role, on both stores. Faults forced by an owner trigger.

| Arm | `--store pg` | `--store pg-columns` |
|---|---|---|
| Forced `23503` (`CONSTRAINT forced_fk_0474`, `DETAIL` holding a secret) | fixed body; `[5xx] <id> … HandlerFault: write_failed warehouse.create Warehouse: error sqlstate=23503 constraint=forced_fk_0474`; secret absent | same |
| Two concurrent POSTs, one new id (trigger sleeps 2 s) | 201 + 409 `id_conflict`, both at 2.02 s; a sequential repeat 409 in 6 ms | 201 + 409 at 2.03 s |
| Control: the same race with the pkey arm disabled in `dist` | — | 201 + **500** `write_failed`, log `sqlstate=23505 constraint=warehouse_pkey` |
| One stored `created_at` in year 294000 | `page_unreadable`, log `DatetimeWireError: Warehouse.created_at: not_an_instant (datetime, stored)`; Currency list 200 | same |
| `ACCESS EXCLUSIVE` on `public.warehouse` during `column-schema` (a dropped column to re-add) | — | `fatal: schema DDL stopped by lock_timeout on public.warehouse (ADD COLUMN)…`; the printed lookup, pasted, returned the holding session (`AccessExclusiveLock`) |
| `ROW EXCLUSIVE` held, unique index dropped, owner boot | — | `[unique] boot Warehouse.code … (timed_out) … no row was read`; enforcement line `31 of 32`, `1 withheld (index_timed_out)` |
| Two duplicate rows, owner boot | — | `(duplicates) … deduplicate those rows`; `1 withheld (existing_duplicates)` |

Before this change the applying arm's line read `32 of 32 enforced` over a missing index (read from
`node.ts`: the applying arm passed `ensured.uniqueIndexes`, empty there).

Packages: `@crossengin/operate-runtime` build/typecheck/test green at 1855; `operate-runtime-pg`
934; `operate-server` 6690 in 181 files; `testing` 912. A later operate-runtime run saw 1885 tests
with one failure in `compile.test.ts:1556`, an assertion another concurrent slice (ADR-0475) was
editing; that file is not this slice's.

### Adversarial review

A reviewer read the diff against the shipped configuration and found four false statements, all
fixed; no code path changed except two refusal sentences, so the live arms above stand.

1. **The `timed_out` remedy named flags that cannot reach the arm that prints it.** Both the
   per-refusal sentence and the enforcement line's `index_timed_out` remedy said to raise
   `--pg-lock-timeout-ms` / `--pg-statement-timeout-ms`. The boot store and `column-schema` build
   the index through `applyBootStatement`, which issues `SET LOCAL lock_timeout` /
   `statement_timeout` from `kernel-pg`'s fixed defaults (5 s, retried twice; 10 min), and
   `node.ts` passes no `ddl` option at either construction site — so the session flags are
   overridden and no flag raises the bound. Only a tenant application runs under the serving
   session's bounds. Live arm (E) printed the false remedy. Both sentences now say where each arm's
   bound comes from and name no flag; a test asserts neither flag appears.
2. **`BootDdlStopped`'s `statement_timeout` remedy said "raise it for this boot"**, for the same
   reason unfollowable. It now says to run that act on that table by hand as the owner while it is
   quiet; a new test fails under the old sentence (mutation-checked).
3. **Two comments named a live producer the implementer had measured not to exist.** `listPageOn`
   said "the live member is a `TIMESTAMPTZ` past year 275760 … whose `toISOString()` raises", and
   `ListRowUnreadable`'s doc said an unreadable row "used to escape the store as a bare `RangeError`
   or `ZodError`". `isoInstant` renders an invalid `Date` as "Invalid Date" and the mapper is total,
   as this ADR's Context already states; both comments now say the store arm is a fence and the
   decorator is the live producer.
4. **Context item 1 misdescribed ADR-0432 Q6** as a comment claiming posting refusals were
   "logged"; it claimed their details held only literals and server-chosen values.

Not fixed, and outside this slice's files: `bin/operate-server.ts`' `column-schema` line still prints
"Deduplicate, then run" for every cause (Open question 3), and `uniqueIndexFields` keys by index
name, so two unique columns whose 63-character-truncated index names collide would misalign the
positional zip of fields to statements on both the boot and tenant arms — pre-existing for the
names, now carried into the reported field.

## Open questions

1. **The wire-type decorators name entity and field, not the row id.** `withDatetimeWireType` and
   `withDecimalWireType` stop at the first record and do not say which; naming ids would let an
   operator find the row without a query.
2. **A single-record `GET` of an unreadable row is still the gateway's generic 500** (measured);
   whether a read gets `record_unreadable` is a separate decision.
3. **`bin/operate-server.ts`' `column-schema` refusal line** still says "Deduplicate" for every cause.
4. **The moved-away direction** of ADR-0440 Q8 (a line moved off another author's document, read
   from the audit trail's child detachments) still has no offline test.
5. **`deploy/README.md` *Loading existing records*** still says a concurrent duplicate id answers 500;
   it answers 409 `id_conflict` now.

## References

ADR-0359, ADR-0360, ADR-0364, ADR-0373, ADR-0383, ADR-0405, ADR-0417, ADR-0425, ADR-0432,
ADR-0440, ADR-0444, ADR-0449.
