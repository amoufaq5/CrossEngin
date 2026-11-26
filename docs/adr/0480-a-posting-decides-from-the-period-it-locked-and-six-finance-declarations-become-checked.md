# ADR-0480: A posting decides from the period it locked, and six finance declarations become checked

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0429 Q9 (period-close race), ADR-0432 Q5 and Q6 (tax jurisdiction, refusal details), ADR-0433 Q6 and Q8 (lock list, `closed_at`), ADR-0443 Q5 and Q6 (array elements, enum order), ADR-0465 Q8 (starter-chart actor), ADR-0466 Q5 (reverse-charge withholding), ADR-0467 (remittance entry numbers), ADR-0419 (locked documents), ADR-0422 (conditional transitions) |

## Context

Eight open items from the finance ADRs, re-measured against the tree before any design.

1. **A post could commit into a period a concurrent close had just closed.** `resolvePostingPeriod`
   read the covering periods with a plain `listPage` and decided on the rows it had read. A close is a
   transition, which holds the period `FOR NO KEY UPDATE` until it commits, so a post running beside
   it read `open`, posted, and committed after the close had committed `closed`. Reproduced live on PG
   16 as the confined role with the fix removed from the built output: a session holding the period's
   lock, a `POST /v1/journal-entrys/{id}/post` sent while it is held, and the close committed two
   seconds later. The post answered **200 immediately** and the entry stayed `posted` in a `closed`
   period. `journalPostingGuard` read the period an entry names with a plain `get` for the same
   reason. A comment at `posting-period.ts:113-115` also said a refusal's detail could carry nothing a
   caller had sent, which was false of the tax refusals that name the caller's own codes.
2. **Remittance entry numbers were not reserved.** ADR-0467's remittance posts `<return>-REMIT-<n>`
   and reverses it as `…-REV`, and `taxRemittanceJournalReverseGuard` identifies a remittance reversal
   by that shape. A journal entry a caller created with that number could not be told from one the
   effect posted, and the return's own `mark_paid` then refused `tax_remittance_number_taken` — a
   refusal at the wrong act, about a number the caller never meant to take from the return. Measured on `erp-core`: `JournalEntry.entry_number` is sequence-defaulted, so a
   caller may supply a number on create (the documented import path) and may never change one on
   update. So only the create half is reachable on the shipped pack.
3. **A reverse-charge rule on a withholding code was applied as an ordinary reverse charge**
   (ADR-0466 Q5): the purchase side self-assessed withholding and the sales side charged none.
   Reverse charge is a VAT mechanism and has no meaning for withholding.
4. **The lock list was written twice.** `compile.ts` built each `lockedDocumentGuard` config inline
   and kept `STATE_LOCKED_ENTITIES` as a separate eight-name literal, so a locked document added to
   one could be missed in the other (ADR-0433 Q6).
5. **`FiscalPeriod.closed_at` was declared and written by nothing**, and a caller could write it
   (ADR-0433 Q8).
6. **`finance.defaultTaxJurisdiction` was saved unchecked** (ADR-0432 Q5). A code naming no
   jurisdiction saved with a 200 and surfaced at the first invoice as a 409.
7. **Validation had two gaps** (ADR-0443 Q5, Q6). An `array<primitive>` field checked only that the
   value was an array, never its elements; and an enum checked membership before string-ness, so the
   JSON number `42` against `["42", "x"]` was answered `enum` (not a member) rather than `type`.
8. **A `--job-actor-role` that cannot create `LedgerAccount` refuses every starter chart, and nothing
   said so until the first approval** (ADR-0465 Q8).

## Decision

1. **The decision is taken from the locked rows.** After the scan, `resolvePostingPeriod` takes a
   `share` lock on every covering period through `getLocked`, in id order, re-reads each, drops any
   row that no longer covers the date, and decides from what remains. A share lock waits for the
   close's exclusive lock, so the post sees the close's committed state. Locking every covering row
   rather than only the chosen one keeps the overlap rule (any covering period locked refuses) sound
   under the same race. The guard reads its named period the same way. Both take
   `Pick<EntityStore, "listPage" | "getLocked">`. The guarantee holds only inside a transaction: on a
   store with no `withTransaction`, `getLocked` takes no lock, and the doc comment says so. The stale
   comment is rewritten: a detail is built from literals, server-chosen values and the caller's own
   document values, and must never interpolate a classified field.
2. **`reservedRemittanceEntryNumberGuard` refuses** a `JournalEntry` create, or an update that
   changes the number, naming `<x>-REMIT-<n>` (n a positive integer without a leading zero) or any
   `-REV` of one: **422 `entry_number_reserved`**, with a fixed detail. It is registered only when the
   manifest has a remittance wiring, and an update that keeps the number is admitted so a server-posted
   entry's own transitions still work. Effects write through the store and run no guards, so the
   remittance itself is unaffected.
3. **A reverse-charge rule on a withholding code is refused**: **409
   `tax_rule_reverse_charge_withholding`**, naming the code, the jurisdiction, the side and the date,
   on both sides, before any write. `determineLines` takes a required `isWithholding` reader, so a
   caller cannot forget it. `resolveTaxJurisdiction` is extracted so posting and saving share one
   resolution (exactly one row with that code, not inactive).
4. **`LOCKED_DOCUMENT_SPECS` in `locked-documents.ts` is the one list.** Each spec names the entity,
   where its state field comes from (`state`, `lifecycle_or_state`, `lifecycle`), the locked states,
   its line entities, the errors, nouns and corrections. `compile.ts` calls
   `lockedDocumentGuardsFor(manifest, names, entity)` per spec in the old order, and
   `STATE_LOCKED_ENTITIES` is derived (every spec that may read `state`, plus `JournalEntry`), equal to
   the old literal. `correctionHints` moved with it. A test reads `compile.ts` as text and asserts the
   entities it asks about equal the spec list, both ways.
5. **`closed_at` is an effect stamp.** `periodClosedAtStampEffect` sets it to the server clock on the
   edge into `closed` or `locked`, keeps it across `closed → locked`, and clears it on the edge out
   (`reopen`). It is registered as an `EffectStamp`, so a client body naming it is 422
   `field_server_owned`.
6. **The settings update resolves `finance.defaultTaxJurisdiction`** with `resolveTaxJurisdiction`
   whenever it is set and non-blank, and refuses **422 `tax_jurisdiction_unresolved`** without saving.
   The check is wired only when the manifest declares `TaxJurisdiction`.
7. **Validation checks elements and type first.** An array field's element rule is built from the
   field type and every element is checked (a null element is a `type` error naming its index; an
   element's error keeps its code and names the index). An enum is `stringThen(checkEnum)`, so a
   non-string is `type`.
8. **The boot line says whether the starter chart can be written.** `starterChartActorCapability`
   asks `rbacCheck` whether the job actor roles may create `LedgerAccount` (a `system` principal, no
   attributes), and `node.ts` prints the answer under `--platform-admin` with a Postgres store: info
   when it can, a warning naming `--job-actor-role` when it cannot.

## Alternatives considered

- **Lock only the chosen period.** Refused: the overlap rule refuses when any covering period is
  locked, and locking one row leaves the others free to close under the post.
- **Make the close take a table lock.** Refused: it serialises every post against every close in the
  tenant, where a row lock serialises only the posts that touch that period.
- **Also check the settings grant in item 8**, as the brief asked ("cannot create LedgerAccount or
  update settings"). Refused after measuring: the starter chart fills settings through the settings
  store directly, not through the admin route, so the admin grant is not consulted and a check of it
  would warn about nothing that fails.
- **Validate the jurisdiction only when it changes.** Refused: a code whose jurisdiction was since
  deactivated would stay saved and still fail the first invoice. The stated cost is in open question 4.

## Consequences

- A post and a close on the same period are serialised; the post sees the close. A post in a period
  nothing is closing takes a share lock per covering period, which coexists with other posts.
- A caller can no longer create a journal entry numbered like a remittance or its reversal.
- A tenant whose tax rules mark a withholding code `reverse_charge` gets a 409 on posting until the
  rule is corrected, where it got a wrong posting.
- `closed_at` is now server-owned: a client that wrote it gets 422.
- A settings PUT with an unresolvable default jurisdiction is refused rather than saved.
- An enum given a non-string is now `type`, not `enum`; a client keying on the code sees a change.

## Verification

- `@crossengin/operate-runtime`: build, typecheck and **1,938** tests pass (61 files), after review. New tests:
  `posting-period.test.ts` (a recording store sees a `share` lock per covering period in id order; an
  in-memory race where a transaction holds the period exclusively, a concurrent
  `resolvePostingPeriod` waits and answers `locked` after the close commits; a period moved off the
  date during the wait is dropped); `write-guards.test.ts` (the named period is locked; reserved
  numbers refused on create and changed update, admitted unchanged); `tax-determination.test.ts`
  (409 on both sides; the same rule on a VAT code is unaffected; and through the recognition effect
  with a stored withholding `TaxCode`, 409 with no `JournalEntry` written — the test that fails when
  `determineDocumentTax` stops deriving `isWithholding` from the code row, which the unit test, handed
  the reader, cannot); `locked-documents.test.ts` (spec set
  equals compile's calls both ways, `STATE_LOCKED_ENTITIES` equals the old eight, every spec's guards
  refuse a delete in every locked state and a line write under a locked parent on `erp-core` and
  `erp-retail`, retail's `OrderLine` included); `period-stamps.test.ts`; `admin-handlers.test.ts`
  (unknown, inactive, ambiguous refused; known saved; no check without the entity);
  `validation.test.ts` (and, over resolved `erp-core` and `erp-retail`, every declared enum value is
  admitted and the number `7` is `type`, with **0** array fields in either pack — so the element check
  has no shipped member and its reach is an authored manifest); `starter-chart.test.ts` (`erp_viewer` warns, `erp_admin` affirmative,
  secondary role read, `not_served`); `compile.test.ts` (remittance still posts `TR-1-REMIT-1` while a
  request for `TR-1-REMIT-2` or `…-REV` is 422; `closed_at` set, cleared, kept on lock, forged 422).
- Mutation checks: deciding from the scanned row instead of the locked one fails the three race
  tests; dropping the guard's registration in `compile.ts` fails the compiled remittance test;
  dropping the stamp effect fails the compiled `closed_at` test.
- `@crossengin/operate-server`: 6,814 tests pass. Its typecheck reports two errors in `node.ts`
  (`PlatformUserRoutesContext.onUserIdentityChanged`, `CredentialRoutesContext.subjectMemberships`),
  both from another slice's in-progress change to `platform-users.ts` and `credential-routes.ts`; none
  is in this change.
- Live on PG 16 in compose order (migrate, app-role, document-indexes, column-schema) with the API as
  `crossengin_app` (`NOSUPERUSER NOBYPASSRLS`, confined on 115 policied tables on `pg`, 166 on
  `pg-columns`). On both stores, a psql session held the period `FOR NO KEY UPDATE` under tenant
  context, the post was sent, it was **still waiting after 2 s**, the session committed `closed`, and
  the post answered **422 `period_locked`** (2.01 s). Control on `pg`, with the lock removed from the
  built `posting-period.js` and the same steps: **200 at once**, entry `posted`, period `closed`. On
  both stores: `closed_at` stamped on close, cleared on reopen, kept on lock, forged PATCH 422;
  settings PUT `ZZ` 422 with nothing saved, `UK` 200 after the jurisdiction exists;
  `TR-1-REMIT-1` create 422 `entry_number_reserved`; enum `source: 7` 422 `type`. Boot with
  `--job-actor-role erp_viewer` printed the warning; the default printed the affirmative line.

## Open questions

1. `GoodsReceipt` is not in the spec list: its lock guard is built only where the inventory
   accounting is wired (`inventoryShape(manifest).goodsReceipt`), so it stays beside that wiring in
   `compile.ts` and is not in `STATE_LOCKED_ENTITIES`, as before this change. A spec with a wiring
   condition would let it join the list.
2. The `state`-sourced specs (Invoice, TaxReturn, SalesOrder, PurchaseOrder, Bill, Payment) read the
   literal `state` field even if a tenant's own lifecycle drives another field, as before this change.
3. The in-memory lock table has no deadlock detection. The posting path takes only share locks on
   periods, so it cannot form a cycle with a close, but a future path taking a share and then an
   exclusive on one row could wait for ever in tests.
4. Validating the jurisdiction on every save means that once a saved jurisdiction is deactivated, any
   settings PUT that carries it is refused until the code is changed or cleared.
5. `closed_at` is cleared on reopen, so the time of an earlier close survives only on the audit trail.
6. The reserved-number guard's update arm has no member on `erp-core`, where the write surface already
   refuses a changed sequence number; it is for a manifest whose entry number a caller may write.
7. An element's own length or pattern rule is not checked; only its kind is.
8. "Which period states are closed" is now spelled four times — `CLOSED_PERIOD_STATES` here,
   `PostingPeriodConfig.lockedStates`' default, `journalPostingGuard`'s `lockedPeriodStates` default and
   the `FiscalPeriod` spec's `lockedStates` — all `["closed", "locked"]` and compared by nothing.
   ADR-0288's maintained-list shape; deriving the three defaults from the spec is the follow-up.
