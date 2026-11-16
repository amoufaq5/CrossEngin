# ADR-0419: A document's lock and its state are one rule

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0391 (the `paid` edge and `settlementCoverageGuard`), ADR-0360 (the unique index on `JournalEntry.entry_number`, which turns a second posting into a 500 on `--store pg-columns`), ADR-0367 (`journalPostingGuard`'s drained read), ADR-0378 (a wrong figure that balances), ADR-0359 (two stores answering one request oppositely), ADR-0337 (the falsely-complete direction), ADR-0338 (a refusal that changes what a working deployment accepts) |

## Context

An external due-diligence audit examined commit `7bc8db9` (`2b98f46` plus one `.env.example`
edit) and ranked three findings critical. A verification pass re-checked every finding at that
commit and at HEAD `f6faf05`, 119 commits later. Two of the three critical findings are the
accounting core, and the verification's own summary of it is one sentence: *the accounting core,
which is the audit's top risk, is unchanged except for the `paid` edge.*

### C-02: a line could leave a locked document

`lockedDocumentGuard`'s child arm resolved the parent as
`input.after[parentField] ?? input.before?.[parentField]` (`write-guards.ts:228` at `2b98f46`,
`:469` at `f6faf05`, identical; the two commits that touched the file since, ADR-0367 and ADR-0391,
did not touch this arm). On an update `after` is the merged record, so the reference is always
present there and `before` is never read: the guard checked only the parent a line ends up under.
Live test **L13**: `PATCH /v1/journal-lines/{id} {"journal_entry_id": <draft>}` moved the credit
line out of a posted 500/500 entry, answered **200**, and left the entry at **500 Dr / 0 Cr**. The
verification reproduced it at HEAD on all three arms (the non-owner `serving` role, the shipped
compose flags, and the superuser connection the compose actually uses). The same child arm guards
`InvoiceLine`, `SalesOrderLine` and `PurchaseOrderLine`, so a line could leave a posted entry, an
issued invoice, a committed sales order or an approved purchase order.

### C-03: a lifecycle state was an ordinary writable field

A lifecycle's state field is an `enum` field on the entity, and the update handler spreads the body
into the patch. So a `PATCH {"state": …}` skipped the transition's grant and its from-state check,
and the GL recognition effect fires on *entering* a state whatever the operation. Live test **L15**:
a Bill PATCHed `draft → approved → draft → approved → draft → approved` answered 200 each time and
left **three** posted journal entries all numbered `BILL-…-GL`, on all three arms at HEAD. ADR-0391
closed one edge of this (`settlementCoverageGuard` refuses entering `paid` uncovered), which is why
the verification graded C-03 `partly_fixed`, and its residual was everything else: the state still
client-writable; Bill, Payment, Expense, FiscalPeriod and WhtCertificate with no lock guard; and no
per-document idempotency on posting. At HEAD, L17 showed the class directly: `ap_clerk` creating a
Bill `paid` at 999,999 is now 422 `uncovered_settlement`, while `PATCH state=void` answered **200**
for the same role that `POST /void` refused with **403** — the transition's grant was decorative
for any caller who wrote the field instead.

### Two findings in neither the audit nor the register

The adversarial review of this increment measured two bypasses on the shipped packs before the fix.

- **A reversed journal entry's lines were editable.** `postedEntryImmutabilityGuard` locked only
  `posted`, so once an entry was `reversed` — beside a mirror entry negating exactly its lines —
  moving a line out of it returned **200** through the real `erp-core` wiring, and editing a line,
  adding a line and deleting the reversed entry were unguarded too. This is the audit's H-10 clause
  and live test L14 (*edit reversed entry: 200*), which the verification graded open.
- **Retail's sales-order lines were outside the sales-order lock.** In `erp-retail` and
  `erp-grocery` a retail SalesOrder's lines are `OrderLine` (`sales_order_id → SalesOrder`, writable
  by `cashier`), and `compile.ts` attached the child arm only to `SalesOrderLine` — while the guard's
  locked states already listed retail's `placed` and `returned`. So the audit's "line can leave … an
  SO" understated it: a placed retail order's lines could be moved, edited and deleted outright.

## Decision

**A document's lock and its state are one rule: a child write checks every parent it touches, and a
lifecycle state moves only by a declared transition.**

1. **Both parents.** `childParentRefs(input, parentField)` returns the distinct parent ids a child
   write touches — the stored record's, then the written one — and is the one place a child arm
   reads its parent reference, so the before-parent cannot be checked on one child entity and
   forgotten on another. The child arm checks each; a refusal says *"cannot move a line out of a
   …"* when the locked parent is the one being left and *"cannot modify the lines of a …"*
   otherwise, under the existing child error code (`posted_entry_locked_lines`,
   `sales_order_locked_lines`, …).
2. **State moves only by transition.** `lifecycleStateGuard`, one per `entityLifecycle` workflow
   whose entity the manifest declares, is the **first** guard `defaultWriteGuards` builds. A create
   may leave the field unset or set it to the workflow's `initialState`, and nothing else
   (`lifecycle_state_not_initial`); an update may not change it — a value equal to the stored one is
   not a change, which is what a client re-sending a whole record does
   (`lifecycle_state_not_writable`); a `transition` is the declared path and is not inspected; a
   `delete` carries no new state. The refusal names the shortest chain of declared transitions that
   makes the move (*"from 'draft' fire 'post'"*) or says that none exists, because the remedy is a
   route the manifest defines and the caller may not know it. It runs first so that a state the
   caller may not write is refused before any other guard reads it as a fact — otherwise a
   `PATCH {"state":"paid"}` from `sent` would reach `invoice_locked … void it instead`, which is true
   and is not the remedy.
3. **`reversed` is locked.** `postedEntryImmutabilityGuard` locks `[posted, reversed]`, keeping the
   one allowed update edge `posted → reversed`.
4. **Every sales-order line entity gets the child arm.** Each of `SalesOrderLine` and `OrderLine`
   present in the manifest gets its own `lockedDocumentGuard` child config; a resolved retail
   manifest carries both.
5. **The form agrees with the server.** `buildUiSchema` marks a lifecycle state field that has a
   default read-only, since an update may not change it and a create lands in the initial state; one
   with no default stays editable, because a create must then be able to name the initial state.

`settlementCoverageGuard` stays as it was. On the shipped packs both plain-write routes into `paid`
are now refused upstream, so it is reached by the transition and by a write raising a settled
document's total; its state-keyed arms remain for a document whose state is not a lifecycle field and
for a deployment passing its own `writeGuards`.

## Alternatives considered

- **Extend ADR-0391's per-edge guard to the other edges (Bill `approved`, Payment `completed`, …).**
  - **Pros:** no change to what a transition-free client may write elsewhere.
  - **Cons:** one guard per edge per graph; L17's `PATCH state=void` is an edge nobody had named.
  - **Why not:** ADR-0391 closed one edge of one graph, and the verification found the class intact
    around it. The field is what has to be read-only.
- **Strip the state from an update instead of refusing it.**
  - **Pros:** no 422 for a client that sends the field.
  - **Cons:** the caller is told 200 for a write that did not happen as asked — ADR-0359's
    dropped-surface class.
  - **Why not:** a refusal that names the transition is the honest answer. An equal value is still
    admitted, so a client re-sending the stored record is unaffected.
- **The audit's full C-03 remedy: transitions under a row lock and postings idempotent per document.**
  - **Pros:** closes H-12 (two concurrent transitions both pass the from-state check and both run
    effects) and the double posting at its source.
  - **Cons:** a store-layer change on both stores, and per-document idempotency is not sufficient:
    the review measured that *"recognition fires at most once per document"* is true per document
    record and **false per bill** (see Consequences).
  - **Why not taken here:** recorded as open questions; this increment removes the plain-write route,
    which is the one the audit reproduced.
- **The audit's C-02 second half: a database-level balance invariant on posted entries.**
  - **Why not taken here:** the guard is enforced in the handler layer for both stores, and on the
    shipped `--store pg` entity records live in one JSONB document table, so a trigger has no
    per-entity table to attach to. Left open, with H-10's functional-amount and float-tolerance
    clauses beside it.
- **Lock Bill (and decide the same for Payment and Expense) in this increment.**
  - **Why not:** it changes ADR-0391's tested behaviour, so it is a decision rather than a fix. It is
    the remedy for the delete-and-recreate route below and is left open with that measurement.

## Consequences

- **Positive:** the two critical accounting findings the audit reproduced live are refused on both
  stores. A transition's grant and from-state check are no longer decorative.
- **Negative:** a client that created a document directly in a later state (201 at HEAD, measured by
  ADR-0391 for Invoice and Bill) or moved a state by PATCH now gets a 422. ADR-0338's rule applies
  read the other way: each of those answers was wrong — a journal entry born posted, an approval
  skipped, a GL entry posted three times.
- **Neutral:** the OpenAPI document still publishes the full state enum as writable (open question 4).
- **Reversibility:** each part is one entry in `defaultWriteGuards` or one line in a guard config;
  undoing any of them reopens the measured route.

### Verified

**Per-package suites**, `operate-runtime` rebuilt with these changes and consumers run against that
build: `@crossengin/operate-runtime` 1165/1165 (typecheck and build exit 0),
`@crossengin/operate-server` 5446/5446, `@crossengin/operate-runtime-pg` 724/724,
`@crossengin/architect-cli` 212/212.

**Mutation checks**, each restored by reversing the exact edit: the lifecycle guard's create arm
neutralised → 3 tests fail; its update arm → 8 fail; the UI read-only marking removed → 1 fails;
`reversed` dropped from the locked states → 1 fails (the new test covers move, edit, add and delete);
the sales-order line list reverted to `["SalesOrderLine"]` → exactly the retail `cashier` test fails.

**Shipped-pack facts the change relies on**, measured by the review: all 137 resolved lifecycles
across the seven packs have a required state field with a literal default equal to `initialState`,
and no entity has two lifecycles; the only cyclic states in any pack are Project
`active`/`on_hold`, FixedAsset `in_service`/`under_maintenance` and TaxReturn `filed`/`amended`, none
of which posts; `operate-web` sends only changed, non-read-only fields, and its one state PATCH is
`period-close.ts` setting FiscalPeriod `status`, an entity with no lifecycle; `operate-server`
overrides no `writeGuards`.

**Live, on PostgreSQL 16 as the non-owner `serving` role, `--pack erp-core`, on both `--store pg`
and `--store pg-columns`**, with three tenants provisioned through `POST /v1/platform/tenants` and each
tenant's GL accounts and finance account codes configured first so posting resolves real account ids.
The "before" column is the verification's audit arm at HEAD `f6faf05` on `--store pg`. Both stores
answered identically on every arm below except the last.

| Arm | Before | After |
|---|---|---|
| L13: move a credit line out of a posted entry | 200; entry 500.00/0.00, 1 line | 422 `posted_entry_locked_lines`, *"cannot move a line out of a posted journal entry"*; entry 500.00/500.00, 2 lines |
| Move a draft line into a posted entry | not run | 422 `posted_entry_locked_lines`; entry unchanged |
| L14: reverse, then edit the entry / edit a line / delete the entry | edit 200 | 422 `posted_entry_immutable` / 422 `posted_entry_locked_lines` / 422 `posted_entry_immutable`; lines 50/50, 2 lines |
| L9: PATCH `state:posted` on an unbalanced draft | 422 `unbalanced_journal_entry` | 422 `lifecycle_state_not_writable`, *"from 'draft' fire 'post'"* |
| L12: POST a JournalEntry with `state:"posted"` | 201, born posted | 422 `lifecycle_state_not_initial` |
| L15: Bill PATCH approved/draft ×5 | 5×200; 3 GL entries | approved → 422, draft → 200 (no-op, stored state is draft); state stays draft; **0** GL entries |
| PATCH an approved Bill back to draft | (part of L15) | 422, *"no declared transition leads from 'approved' to 'draft'"*; GL stays 1 |
| POST a Bill with `state:"approved"` | 201 | 422 `lifecycle_state_not_initial` |
| L17: `ap_clerk` POSTs a Bill `state:"paid"`, total 999,999 | 422 `uncovered_settlement` | 422 `lifecycle_state_not_initial` |
| L16: Invoice PATCH `state:sent` | 200, then 422 `invoice_locked`; 1 GL entry | 422 `lifecycle_state_not_writable` |
| POST an Invoice with `state:"sent"` | 201 | 422 `lifecycle_state_not_initial` |
| Control: Bill `/approve`, then again | 200 | 200, GL 1; second 409 `invalid_transition`, GL still 1 |
| Control: Invoice `/send`, then again | 200 | 200, GL 1; second 409, GL still 1 |
| Control: PATCH a draft Bill re-sending the stored state plus a real field edit | — | 200 |
| Control: POST a Bill with `state:"draft"` | — | 201 |
| Control: draft entry's line edit / move between drafts / delete | — | 200 / 200 / 204 |
| Control: post a balanced entry | 200 | 200 |
| Open: delete an approved Bill, recreate it with the same `bill_number`, approve | — | `pg`: 204 / 201 / 200, **2 GL entries for one bill number**; `pg-columns`: 204 / 201 / **500 `write_failed`**, GL stays 1 |

`--store pg-columns` would not boot as `serving` (`permission denied for database crossengin`) until
`GRANT CREATE ON DATABASE crossengin TO serving`; the verification never ran that store, so it never
met this.

### What remains open

**Double posting survives through delete and recreate.** Bill has no lock guard, so an approved Bill
can be deleted; recreating it and approving again posts a second entry for one bill number. Measured
in-process and live: **2 GL entries** on `--store pg`, the first now orphaned. On `--store pg-columns`
the second posting is a **500 `write_failed`** that leaves nothing in the server log; the cause is
inferred as the `journal_entry_entry_number_uniq` index refusing a second `BILL-…-GL` (exactly one row
exists, and 32 of 32 unique indexes are enforced on that store), surfaced through `writeTxn`'s fixed
sentence. The same missing lock lets a `BillLine` be moved out of an approved Bill (**200**).

**An unset state lets any transition fire.** `applyTransition` (`handlers.ts:659`) checks the
from-state only when the stored state is a string, and the create arm admits `null` or an omitted
state. Latent on every shipped pack (137 of 137 lifecycles have a required state field with a
literal default, and `validateBody` refuses `null` on a required field); reachable from a tenant
manifest whose state field is optional with no default.

## Implementation notes

- `packages/operate-runtime/src/write-guards.ts`: `childParentRefs`, the child arm's loop,
  `lifecycleStateGuard` with `LIFECYCLE_STATE_ERRORS`, and `[posted, reversed]` in
  `postedEntryImmutabilityGuard`.
- `packages/operate-runtime/src/compile.ts`: the lifecycle guards at the head of
  `defaultWriteGuards`, and the per-line-entity sales-order child configs.
- `packages/operate-runtime/src/ui-schema.ts`: the read-only marking.
- The guard reads `wf.stateField`, `wf.initialState` and each transition's `from` (normalised to an
  array) and `to` from the manifest's `entityLifecycle` workflows; it holds no list of entities.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| ~~Lock Bill (and decide Payment and Expense): closes the delete-and-recreate double posting and the `BillLine` move, and changes ADR-0391's tested behaviour.~~ **Closed by the addendum**: Bill, Payment and WhtCertificate are locked; Expense is not (no effect posts from its states) and FiscalPeriod is not, by decision. A second Bill with the same `bill_number` while the first exists still double-posts (P0.7). | platform | closed |
| ~~Put `initialState` on `TransitionSpec` (`operations.ts`) so `applyTransition` refuses a record with no state.~~ **Closed by the addendum**, with the opposite reading: `initialState` is on `TransitionSpec` (required) and an unset stored state is read *as* the initial state rather than refused; a set non-string state is refused 409. | platform | closed |
| Transitions under a row lock (audit H-12: two concurrent transitions both pass the from-state check and both run effects). | platform | _unscheduled_ |
| ~~`openapi-schema.ts` publishes the full state enum as writable on create and update while the server refuses all but the initial or stored value — a falsely-complete document (ADR-0337).~~ **Closed by the addendum**: `enum: [initialState]` on create, `readOnly: true` on update; the response schema keeps the full enum. | platform | closed |
| ~~A reversed entry's refusal says *"a posted journal entry cannot be edited; reverse it instead"* — the wrong noun and a remedy that cannot work for an entry already reversed.~~ **Closed by the addendum**; the same wrong-noun defect was also live on PurchaseOrder and Invoice. | platform | closed |
| ~~The create refusal hardcodes the article: *"a Invoice is created in 'draft'"*.~~ **Closed by the addendum**; the same bug was live in `lockedDocumentGuard`. | platform | closed |
| A database-level balance invariant for posted entries, and H-10's functional-amount check and 0.005 float tolerance. | platform | _unscheduled_ |
| `--store pg-columns` needs `CREATE` on the database for its serving role; no deploy document says so. | platform | _unscheduled_ |
| The `pg-columns` double-posting 500 is unlogged, so its cause is inferred rather than read. | platform | _unscheduled_ |

## References

- Corrections to the inputs this ADR is built from:
  - The audit's L17 premise — *"`ap_clerk` (no approve/pay grant)"* — is false; that role holds both
    grants (verification §7). The defect, a Bill created `paid` by a plain write, was real.
  - The implementing slice described *four* child configs; with `OrderLine` there are five, and the
    code comments now say "every child config" instead of a count.
  - *"Recognition fires at most once per document"*, offered by the implementing slice, is true per
    document record and false per bill (the delete-and-recreate arm above).
- The audit report (`ERP_DUE_DILIGENCE_REPORT.md`, findings C-02 and C-03, live tests L9–L17) and its
  verification at HEAD `f6faf05` (§2, §3 and §6) are the sources of every "before" figure here; where
  the verification's audit arm and the live re-run's "before" column overlap, they agree.
- ADR-0391, ADR-0360, ADR-0367, ADR-0378.

## Addendum: closing the batch's own residuals

A second slice took the open questions above that needed no product decision, and an adversarial
review of that slice found one regression it introduced and one defect class it missed in two more
places. Everything here was measured **in-process**; nothing in this addendum was verified live.

### What was closed

1. **The double-posting route through delete and recreate, by locking what posts.** The GL-posting
   effects in `defaultWriteEffects` were enumerated, and `POSTED_DOCUMENT_LOCKS` locks the three
   that had no lock:

   | Document | Posts on | Locked in | Error |
   |---|---|---|---|
   | Bill | entering `approved` | `approved`, `overdue`, `paid`, `void`, and its `BillLine` lines | `bill_locked`, `bill_locked_lines` |
   | Payment | entering `completed` (settlement) | `completed`, `refunded` | `payment_locked` |
   | WhtCertificate | entering `confirmed` (clearing) | `confirmed`, `void` | `wht_certificate_locked` |

   `void` and `refunded` are locked because nothing in `compile.ts` reverses a posting on bill void,
   payment refund or certificate void, so leaving them open reopens delete-and-recreate one state
   further on. WhtCertificate has no lifecycle, so its state moves by plain update; the one move left
   open is `confirmed → void`. **Expense** stays unlocked: no effect posts from any of its states.
   **FiscalPeriod** stays unlocked by decision: its close posts the FX revaluation, but
   `apps/operate-web/lib/period-close.ts` already documents reopen-and-re-close, so a delete lock
   would either forbid reopening (a decision nobody has made) or be defeated by it; the real fix is
   the revaluation reversing its own prior entry.

   Measured in-process on `erp-core`, the three new locks removed against present:

   | Route | Before | After |
   |---|---|---|
   | WhtCertificate PATCH `confirmed → draft → confirmed → draft → confirmed` | all 200, **3 GL entries** | 200, then 422 ×4, 1 GL entry |
   | Bill approve, then delete | 200, then 204 | 200, then 422 |
   | Payment (`completed`) delete | 204 | 422 |

   **The WhtCertificate re-posting loop was in no report** — not the audit, not the verification,
   not this ADR. It is C-03's class on a document with no lifecycle, which the lifecycle guard cannot
   reach by construction. Three comments asserting that Bill has no lock (one in `compile.ts`, two in
   `write-guards.ts`) are corrected with it.

   ADR-0391's Bill test was **rewritten, not deleted**: it is now *"lets bill_locked win over
   coverage when both refuse an edit of a paid bill"*, plus a complement showing `bill.mark_paid`
   still reaches `settlementCoverageGuard` (`30.00 of 120.00`). The review found the first half
   **partly vacuous**: nothing in it shows the coverage guard would also have refused that edit —
   only the title says so. The complement does exercise the coverage guard.

2. **Remedies now name only transitions declared from the state the document is in.**
   `correctionHints` derives each remedy per locked state through `hintByState`, so an approved bill
   reads *"void it instead — voiding a bill posts no reversal, so reverse its journal entry as
   well"*, a completed payment *"refund it if the money was returned — …"*, and a paid invoice, a
   paid tax return and a void bill carry **no remedy at all**. Four existing remedies were false in
   exactly this way: `void it instead` on Invoice, `amend it instead` on TaxReturn and
   `cancel it instead` on SalesOrder and PurchaseOrder were each offered for locked states those
   transitions cannot fire from (a paid or void invoice, a paid tax return, the later order states).

3. **The reversed entry's refusal.** It reads *"a reversed journal entry cannot be deleted"*, with no
   remedy; a posted entry keeps *"…; reverse it instead"*; the line refusal reads *"cannot modify the
   lines of a reversed journal entry"*. **The same wrong-noun defect was live on two more
   documents**, found by the review: a `submitted` purchase order was refused as *"an approved
   purchase order"* (submission precedes approval) and an invoice voided straight from `draft` as
   *"an issued invoice"* (it never was). `nounByState` gives PurchaseOrder `submitted`/`received`/
   `closed` nouns and Invoice `void: "void invoice"`.

4. **The article.** `withArticle` is exported from `write-guards.ts`, so the lifecycle refusal reads
   *"an Invoice is created…"*. The same bug was live in `lockedDocumentGuard` — *"a issued invoice"*,
   *"a approved purchase order"* — and is fixed there too.

5. **An unset state is read as the initial state, not refused.** This is the opposite of the open
   question's proposal, for a stated reason: the create guard admits an omitted state as meaning
   initial, so refusing at the transition would leave every such record stuck for ever.
   `TransitionSpec.initialState` is **required**; `applyTransition` reads an unset stored state as
   `initialState` and refuses a set **non-string** one with 409 *"holds no state of this
   lifecycle"*. Tested on a synthetic `Claim` manifest: `approve` from an unset state is 409
   *"'approve' cannot fire from 'draft'"*, and `submit` then `approve` is 200.

   **This change introduced a regression, which the review confirmed and fixed.** The lifecycle
   guard's update arm turned only the *stored* side into `initialState`, while the handler builds
   `after` as `{...before, ...patch}` — so an edit that does not name the state leaves it unset on
   both sides, and the guard compared `'draft'` against `undefined` and refused *every ordinary edit
   of a record with no stored state* with *"no declared transition leads from 'draft' to
   'undefined'"*. The slice's own test missed it because it built `after` by hand as
   `{state: "draft"}`, which the handler never produces for such an edit — ADR-0389's shape, a test
   fixture expressing a state the real caller cannot. Both sides now go through one `asState`
   reading, so an unset `after` matches an unset `before` and clearing a set state is still refused.
   Latent on the shipped packs, all of whose lifecycles have a required state field with a literal
   default; tested at the guard and end to end through the real handler on `Claim`
   (`claim.update {title: "t2"}` → 200).

6. **The OpenAPI document agrees with the server.** `entityLifecycleShape` feeds `entitySchemas` a
   lifecycle argument (required, may be `null`), and the state field is `enum: [initialState]` on
   create and `readOnly: true` on update, each described as moving only through transitions; the
   response schema keeps the full enum. Tested on Invoice, on `Opportunity.stage` and on the `null`
   control. That retires this ADR's **Neutral** consequence above.

7. **ADR-0420's hook comment.** `.githooks/pre-commit` now says `secret-values.ts` reads the index —
   staged paths from `git ls-files --stage` and content from `git cat-file --batch` — while the other
   rules read the working tree. `sh -n` passes.

### What the review refuted

- *"The locks break the write effects."* Guards run only on the handler path (`runWriteGuards` has
  one caller, `handlers.ts`), and `paymentApplicationEffect`, `journalReversalEffect`, the
  booking-rate stamp and the FX revaluation write through `input.store`, which is not guarded. A
  control test runs the whole flow — create a bill, approve, create a payment, submit, complete —
  and the effect marks the locked bill `paid`, `payment.refund` fires from the locked `completed`
  state, and exactly **2** journal entries exist (recognition and settlement).
- *"A GL-posting document was left unlocked."* Every effect in `defaultWriteEffects` was enumerated
  against the locks; FiscalPeriod is the one unlocked poster, and by decision.
- *"A legitimate flow is now refused."* Transitions pass both guards, draft bill and line edits pass,
  pending payments stay editable, and a WhtCertificate can still go `confirmed → void` by update.

### Verified

| Package | Typecheck | Tests |
|---|---|---|
| `@crossengin/operate-runtime` (rebuilt) | clean, build clean | 1184/1184 (1165 when this ADR was written; 1180 after the second slice; 1184 after its review) |
| `@crossengin/operate-server` | clean | 5446/5446 |
| `@crossengin/operate-runtime-pg` | clean | 724/724 |
| `@crossengin/architect-cli` | clean | 212/212 |

**Mutation checks**, each restored by reversing the exact edit with md5 verified — all twelve caught:

| Mutation | Tests failing |
|---|---|
| Bill lock removed | 4 |
| Payment lock removed | 1 |
| WhtCertificate lock removed | 1 |
| `void` dropped from Bill's locked states | 1 |
| One noun for posted and reversed entries | 1 |
| Remedies ignore the from-state | 4 |
| Transition skips an unset state | 1 |
| OpenAPI state branch disabled | 2 |
| Article always "a" | 4 |
| Update arm ignores an unset stored state | 2 |
| Update comparison reads only the stored side as initial (the regression restored) | 2 |
| PurchaseOrder and Invoice `nounByState` maps removed | 1 |

### What remains open

- **A second Bill with the same `bill_number`** while the first still exists, then approved, still
  posts a second entry on the in-memory store and on `--store pg` — measured at **2** bill entries
  in the after run. That is P0.7's unenforced unique index, not delete-and-recreate.
- **FiscalPeriod's revaluation** is not idempotent across reopen-and-re-close; the honest fix is the
  revaluation reversing its own prior entry, not a lock.
- **Nothing in this addendum was verified live**; the earlier live table in *Verified* predates it.
- The other open questions above (H-12 row locks, a database-level balance invariant, the
  `pg-columns` `CREATE` grant, the unlogged `pg-columns` 500) are untouched.
