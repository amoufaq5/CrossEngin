# ADR-0433: A transition holds the row it decided from, and an approver wrote nothing it approves

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0422 (`updateIf`, the exact balance — its open questions 1, 2 and 3 are closed here), ADR-0421 (`--segregation-of-duties`, `created_by`/`updated_by` — its two open items are narrowed here), ADR-0419 (a document's lock and its state, `lifecycle_state_not_initial`), ADR-0338 (refuse only when nothing correct breaks), ADR-0367 (`journalPostingGuard`) |

## Context

The external due-diligence audit's **H-10**, **H-12** and **H-32** were closed by ADR-0421 and
ADR-0422, each leaving residuals it named. Five are taken here.

1. **Delete racing a transition** (ADR-0422 Q1): a delete and a transition decided on the same
   state both succeeded — delete 204, transition 200 — so the posting fired and the document was
   gone.
2. **A line written into an entry `post` already summed** (ADR-0422 Q2, H-10's remaining hole): a
   `JournalLine` create decided on a draft entry landed after `post` committed, leaving
   **Dr 1009 / Cr 10** posted.
3. **The last editor can approve** (ADR-0421's open item): `--segregation-of-duties` refused only
   the record's creator.
4. **`FiscalPeriod` reopens by PATCH** (ADR-0421's other open item): it had no lifecycle, so its
   `status` was an ordinary field. The pack test titled *"FiscalPeriod has a four-state close
   lifecycle"* asserted only the enum.
5. **Nothing checks functional = amount × fx_rate** (ADR-0422 Q3).

## Decision

**A delete is conditional on the state it read.** `removeIf(tenant, entity, id, expected)` is on all
three stores: the document store reads the row `FOR UPDATE`, checks the expected state, then
deletes; the column store deletes with the state in the `WHERE` and probes for existence afterwards;
the memory store checks under its lock. The delete handler passes the state it read and loses with
**409 `state_changed`**.

**A transition holds its parent exclusively, and a child write holds it shared.** `getLocked(…,
"share" | "exclusive")`: a transition takes the parent `exclusive` before its guards read the lines,
and the child-line guard takes the parent `share`. On Postgres these are `FOR NO KEY UPDATE` and
`FOR SHARE` — READ COMMITTED re-reads the committed row after the wait, so whichever side waits sees
the other's write. In memory it is a re-entrant row-lock table scoped to `withTransaction`. **Both
halves are needed**: ADR-0422 Q2 named only the child guard's share lock, and removing either half
fails the tests. No line-triggered effect updates its parent, so the share-then-update deadlock this
pairing could produce is not reachable today.

**The state precondition covers lock-guarded entities with no lifecycle.** Found by review: a
`state`-field lock guard decides from `WhtCertificate`'s `state`, which has no lifecycle in any pack
and moves by PATCH, so the precondition built from lifecycles did not reach it. `lifecycleStateFieldIndex`
now also covers `STATE_LOCKED_ENTITIES`.

**An approver is neither the creator, the last editor of an un-entered state, nor the author of an
owned line.** Under `--segregation-of-duties` an approve-class transition is refused (422
`maker_cannot_approve`) for:

- the creator, as before;
- the **last editor** (`updated_by`), but only from a from-state that **no transition enters** —
  today `Bill.approve` and `JournalEntry.post` from `draft`;
- the **author of any owned line**: a cascade-composition child (`BillLine`→`Bill`,
  `JournalLine`→`JournalEntry`, `InvoiceLine`, `PurchaseOrderLine`). A line with no recorded author
  is refused as unverifiable rather than passed.

The from-state restriction is the rule, not a narrowing of convenience: in a state a transition
enters, `updated_by` is whoever fired that transition, so refusing it would block every two-person
flow — the approver of an `Expense` could not reimburse it.

**`FiscalPeriod` has a lifecycle on `status`**: `start_close`, `close`, `reopen` (closed→open) and
`lock` (closed→locked), `locked` terminal, all granted to the GL writers (`erp_admin`, `controller`).
Closed and locked periods are locked against edits and deletes where a lifecycle exists. A PATCH of
`status` is 422 `lifecycle_state_not_writable` (ADR-0419's rule), and a PATCH of a closed period's
dates is 422 `fiscal_period_locked` naming `reopen`. `apps/operate-web`'s `closePeriod` calls the
`close` transition, since the PATCH it sent is now refused.

**`journalPostingGuard` checks functional = amount × fx_rate exactly**, through `multiplyDecimal`
and `withinOneUnitAtScale`, refusing a mismatch with 422 `functional_amount_mismatch`. Both the
truncated and the rounded product are admitted, so a preparer can adjust one line by a cent to
balance an entry. A line carrying no functional legs is exempt.

## Alternatives considered

- **ADR-0422 Q2's own remedy: a share lock in the child-line guard alone.** Refused on measurement:
  without the transition's exclusive lock, `post` reads the lines without waiting for an in-flight
  child write. Mutation-checked — dropping the exclusive lock fails 3 tests.
- **Refuse `updated_by` unconditionally (ADR-0421's wording).** Refused: every state a transition
  enters records the transitioner as last editor, so the two-person `Expense` flow would be refused.
  The mutation that also reads entered from-states fails the two-person `Expense` test and the
  derivation test.
- **Stamp the parent's `updated_by` on every child write**, which would close the line-delete bypass
  below. Refused for now: two concurrent line writes would each hold `FOR SHARE` on the parent and
  then need to `UPDATE` it, which deadlocks.
- **Check every line's functional amount, with no exemption.** Refused under ADR-0338: the
  depreciation job writes journal lines with no functional amounts (`erp-job-handlers.ts:611`), so a
  full check would refuse every depreciation posting.

## Consequences

- **Positive:** a document cannot be posted and deleted from one state, a posted entry cannot gain a
  line, a `WhtCertificate` cannot be confirmed twice, a period cannot be reopened by PATCH, and a
  manual entry whose functional amount disagrees with its rate is refused.
- **Negative:**
  - A PATCH of a lock-guarded entity with no lifecycle now loses with 409 if a concurrent write
    changed its `state`. Nothing correct breaks.
  - Creating a `FiscalPeriod` already `closed` or `locked` is refused (422
    `lifecycle_state_not_initial`), with no flag. Nothing in the repo seeds one; a deployment loading
    historical periods must create them open and then `close` them, which fires the FX revaluation.
  - `functional_amount_mismatch` is a new 422 for a manual entry; the data it refuses was
    inconsistent, so nothing correct breaks.
- **Neutral:** `erp-core` goes from 19 to 20 lifecycles and 79 to 83 transitions; producible entity
  event names rise by 4 per pack (230 → 234 on `erp-core`, union 294 → 298, confirmed against
  `resolveManifest`). The implementer measured list filter parameters 1,783 → 1,792; review did not
  re-measure it.
- **Reversibility:** `removeIf`, `getLocked` and the guard checks are additive and removable; the
  `FiscalPeriod` lifecycle is a pack change, and undoing it would make `status` writable again.

## Implementation notes

- Changed: `packages/operate-runtime/src/` (`store.ts`, `decimal-store.ts`, `datetime-store.ts`,
  `handlers.ts`, `write-guards.ts`, `decimal.ts`, `maker-checker.ts`, `compile.ts`, new
  `row-lock-race.test.ts`); `packages/operate-runtime-pg/src/` (`entity-ops.ts`, `entity-store.ts`,
  `column-store.ts`, `tenant-store-registry.ts`); `packages/pack-erp-core/src/` (`workflows-ext.ts`,
  `permissions-ext.ts`, `pack.ts`); `apps/operate-web/lib/period-close.ts`.
- In process: operate-runtime 1425/1425, operate-runtime-pg 794/794, pack-erp-core 62/62,
  testing 796/796, operate-server 5675/5675, the other six packs green; typecheck 0 on
  operate-runtime, operate-runtime-pg and operate-server.
- Mutation-checked, each reversed: plain `get` in the child-line guard (2 fail); no exclusive lock on
  the transition (3); delete without `removeIf` (1); `misconverted` check removed (3); rounding
  admits only the truncated figure (3); last-editor check removed (1); child-line check removed (2);
  entered from-states also read (2); a line with no author passes (1); `FiscalPeriod` lock removed
  (2); `lifecycleStateFieldIndex` skipping `STATE_LOCKED_ENTITIES` (both `WhtCertificate` tests).
- **Measured before, in process on `erp-core` as `erp_admin` (review):** two concurrent PATCHes of a
  `WhtCertificate` to `confirmed` answered 200 and 200 with the clearing effect fired twice; a delete
  racing a confirm answered 200 and 204 with the effect fired and the certificate gone. After:
  200/409 `state_changed` with one effect, and a racing delete 409 with the certificate `confirmed`.
- **Live on PG 16 as `crossengin_app`, through HTTP, both stores** (independent live run):
  - Delete racing `send`, 20 tries: `--store pg` 17 × (send 200 / delete 409 `state_changed`) and
    3 × (send 404 / delete 204); `pg-columns` 18 / 2. Never both succeeded; no GL entry was left for
    a deleted invoice.
  - Line racing `post`, 20 tries without jitter: `post` always won and the line got 422
    `posted_entry_locked_lines`. With jitter: `pg` 2 post-first and 18 line-first (post 422
    `unbalanced_journal_entry`), `pg-columns` 1 and 19. **0** posted unbalanced entries on either
    store.
  - `FiscalPeriod`: PATCH `status` 422 `lifecycle_state_not_writable`; PATCH `end_date` while closed
    422 `fiscal_period_locked`; `reopen` 200.
  - Segregation of duties: last editor 422; author of a `BillLine` 422; a third person 200.
- The implementer's earlier live run (PG 16.15, non-owner `serving` role) drove the store methods
  rather than the handlers: line-first then post, the post blocked and counted the line; post-first
  then line, the line blocked and read `posted`; the old plain read neither blocked nor saw the line.
  Where it and the HTTP run differ in method, the HTTP run is the one cited above.
- The FX revaluation lines were confirmed live as violating the new rule: currency EUR, `fx_rate`
  1.2 or 1.3, amount 10.00 equal to the functional amount. Effect-written postings skip the guards,
  so they are never checked.

## Open questions

1. **Deleting or moving another person's line bypasses segregation of duties**, confirmed live on
   both stores: Bob creates a bill with lines 1.00 and 100000.00, Alice deletes the 100000 line (204)
   and approves (200). A delete leaves no authorship on the remaining lines and does not touch the
   parent's `updated_by`. Closing it needs a delete trail (for example the entity-audit recorder of
   ADR-0428) rather than parent stamping, which deadlocks. Not yet named at boot.
2. **The last-editor rule is last-writer-only**: Alice edits, Bob makes a trivial edit, Alice
   approves.
3. **Nine approve-class transitions still admit their last editor** because their from-state is
   entered by a transition — `Bill.mark_paid`, `Expense.approve`, `Expense.reimburse`,
   `Invoice.mark_paid`, `LeaveRequest.approve`, `Payment.complete`, `PurchaseOrder.approve`,
   `TaxReturn.mark_paid`, `Timesheet.approve`; ten in `erp-government`, adding `Case.approve`.
   Closing these needs per-transition actor history. The boot line names them.
4. **The FX revaluation lines violate functional = amount × fx_rate**, and recognition lines with
   `fx_rate: 1` are likewise unchecked, because effects skip the guards.
5. **Coverage-guard write skew**: a `Payment` refund racing `mark_paid` takes no lock.
6. **`STATE_LOCKED_ENTITIES` mirrors the state-lock guard list by hand** and can drift from it.
7. **`reopen` shares its grant with `close` and `lock`**; separating it is a product decision.
8. **Nothing stamps `closed_at` on a period.**
9. **The in-memory row-lock table has no deadlock detection** (Postgres detects its own), and on a
   non-transactional store `getLocked` guarantees nothing. On `--store memory` the locks add
   interleavings to the existing hazard that a failed transaction restores a snapshot taken before
   another transaction committed — dev only, and not new.
10. ADR-0422 Q4 (a lifecycle state field encrypted at rest) is untouched.

## References

- `packages/operate-runtime/src/store.ts` (`removeIf`, `getLocked`), `handlers.ts`,
  `write-guards.ts`, `maker-checker.ts`, `decimal.ts`, `compile.ts`, `row-lock-race.test.ts`,
  `transition-race.test.ts`
- `packages/operate-runtime-pg/src/entity-ops.ts`, `entity-store.ts`, `column-store.ts`
- `packages/pack-erp-core/src/workflows-ext.ts`, `permissions-ext.ts`
- ADR-0419, ADR-0421, ADR-0422, ADR-0428, ADR-0338
