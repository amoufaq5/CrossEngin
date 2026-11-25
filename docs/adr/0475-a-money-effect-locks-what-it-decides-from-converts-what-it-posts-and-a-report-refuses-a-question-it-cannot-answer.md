# ADR-0475: A money effect locks what it decides from, converts what it posts, and a report refuses a question it cannot answer

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0421 (actor stamps), ADR-0429 (accounting reversals), ADR-0433 (lock and race residuals), ADR-0441 (money converted at a resolved rate), ADR-0465 (starter chart, WHT accounts), ADR-0367 (bounded reads), ADR-0359 (a dropped parameter that widens is refused), ADR-0372 (tests that pin a defect), ADR-0378 (a wrong figure that balances) |

## Context

Nine follow-ups left open by six earlier ADRs, each about a money effect or a money report. Each was
re-measured against the tree before it was changed.

1. **The payment-driven paid mark and the refund re-open did not say who acted** (ADR-0421 Q2).
   `paymentApplicationEffect` writes `state`, `paid_at` and `updated_at` onto the invoice or bill and
   never `updated_by`. The document's attribution stays with whoever last edited it by hand, even
   though the settlement is the act of the principal who completed or refunded the payment.
2. **A refund re-opened a past-due document into `sent` or `approved`** (ADR-0429 Q7, ADR-0441 Q13).
   `reopenState` is a constant. An invoice that fell due on 1 November and was refunded on
   25 November came back `sent`, which reads as not yet due, until the nightly `mark_overdue` job ran.
   That job is one of the jobs no shipped compose runs.
3. **Coverage write skew** (ADR-0433 Q5). `mark_paid` takes FOR NO KEY UPDATE on the document. Its
   `settlementCoverageGuard` reads the payments without a lock. The refund's re-open read the
   document with a plain `get`. So a refund could read `sent` and leave the document alone while
   `mark_paid` read the payment as still completed and marked the document paid. Both committed: a
   `paid` invoice with nothing applied to it. The settle path had the same shape: two partial payments
   completing together could each miss the other and leave a covered document unsettled. Both halves
   are reasoned from the reads, not measured against a pre-change build: ADR-0433 Q5 names the refund
   race and records no measurement, and the in-memory store cannot reproduce either half because it has
   no transaction visibility, so the settle half is fenced only by the lock-mode test.
4. **Inventory posted at `fx_rate` 1** (ADR-0433 Q4, ADR-0441 Q1). `inventory.ts`'s `postEntry` wrote
   `fx_rate: 1` and set the functional amounts equal to the transaction amounts. A EUR 50 receipt at
   1.1 therefore read USD 50 of stock. The entry balanced, because every line was wrong by the same
   factor, so no guard could see it (ADR-0378's class).
5. **The credit-note GL effect kept a two-line `fx_rate` 1 fallback** (ADR-0441 Q2), which
   `compile.ts` never used. Whenever the mirrored recognition entry could not be found, it posted
   AR/revenue at face value.
6. **`convertBalanced` rounded a negative half toward +∞** (ADR-0441 Q8). The test was
   `twice >= divisor` on a floored remainder, while `convertUnits` rounds half away from zero. For
   −0.005 the two disagreed by a cent.
7. **Bill-side revaluation was never tested** (ADR-0441 Q5). That ADR's credit-note revaluation fix
   was measured for invoices only.
8. **The WHT reconciliation counted void invoices** (ADR-0465 Q2). It summed the stamped
   `withholding_total` of every invoice in the period whatever its state. A voided invoice was counted
   as tax the customer withheld, and so was its credit note, which the invoice void copies the
   withholding onto. One voided invoice reported its withholding twice.
9. **A historical aging report was silently wrong** (ADR-0367 Q8). `?asOf=` reached only the
   days-past-due arithmetic. The open set was today's (a document paid after `asOf` was absent) and
   the applied payments were every payment to date (one made after `asOf` was subtracted). So a past
   date answered a figure that was true on no day, under a 200, and understated the receivable on
   both counts. A malformed `asOf` fell back to today with no warning, and
   `aging-handler.test.ts` pinned all three behaviours as the specification. A second defect was found
   while writing the refusal: `Date.parse("2026-02-30")` rolls forward to 2 March in V8, so a parse
   alone would accept a day that does not exist and age against a different one.

The brief named the aging route `/v1/reports/aging`. It is `/v1/meta/aging`.

## Decision

Each change applies one rule: **a money effect decides from what it has locked, posts what it has
converted, and says who did it; a report refuses a question its data cannot answer.**

- **Attribution.** Both the settle path and the re-open stamp `updated_by` from the trigger, which is
  the payment the principal moved, through `attributedToTrigger`, the helper ADR-0421 introduced for
  copied records. If the trigger carries no `updated_by`, nothing is stamped, so a system write cannot
  attribute itself to a person.
- **Past-due re-open.** `PaymentApplicationConfig` gains `overdueState` and `dueDateField`, which are
  configured together or not at all; one without the other throws at construction. `reopenStateFor`
  answers `overdueState` when the due date is strictly earlier than today. A document due today, or
  with no due date, re-opens into `reopenState` as before. `compile.ts` wires both only when the
  document's lifecycle declares an `overdue` state **and** the entity declares `due_date`, both read
  from the manifest. A tenant's own manifest without those keeps the old behaviour.
- **The lock.** Both the settle path and `reopenUncovered` take `getLocked(…, "exclusive")` on the
  document **before** reading the payments. That is the lock `mark_paid` already holds, so one
  request waits for the other and reads what it committed.
- **Inventory FX.** `resolvePostingRate` is exported from `write-effects.ts`. `postEntry` resolves a
  rate per currency group before it creates the entry, converts each group with `convertBalanced`,
  and writes the real `fx_rate`. With a functional currency declared and no rate, it refuses
  `409 exchange_rate_unresolved` before anything is written, which is the same refusal a document
  posting gives. With no functional currency declared, the rate is 1, as before.
- **The credit-note fallback is deleted.** `creditNoteGlPostingEffect` requires
  `recognitionEntrySuffix` and always mirrors the recognition entry. With no posted recognition it
  posts nothing; it does not fabricate a face-value pair.
- **Rounding.** `convertBalanced` rounds each leg half away from zero, `convertUnits`' rule:
  `twice > divisor || (twice === divisor && product >= 0n)` takes the floor plus one.
- **WHT.** `computeWhtReconciliation` takes the lifecycle's `voidedStates`, which `compile.ts` derives
  from the targets of transitions named `void` (not a literal), and an optional credit-note shape. A
  credit-note row is never counted as withholding. A credit note's withholding is **netted** against
  the invoice it names, wherever the credit note falls in the period, and a voided credit note nets
  nothing. A voided invoice with nothing credited against it is dropped. The rule is stated in the
  function's doc comment: what counts is what the customer still withheld, so a partial credit keeps
  its remainder and a full one leaves nothing.
- **Aging.** An `asOf` earlier than today's UTC date is `400 as_of_not_served`, naming the reason and
  the remedy. A malformed value, including a calendar date that does not exist, is
  `400 as_of_malformed`, checked by round-tripping the parsed date. An empty value is treated as
  absent, because a form sends an unset field as `?asOf=`. Today and future dates are served: no
  payment or state change can postdate today, so today's open set is the open set as of a future date
  and only the ageing moves.

## Alternatives considered

- **Exclude every voided invoice from the WHT report, and nothing more.** This is simpler, and it is
  wrong for a partial credit. A partial credit leaves the original invoice `void` while its remainder
  still stands (the aging report nets the same pair), so excluding the voided invoice would drop
  withholding the customer really did withhold. Netting is what makes both cases right.
- **Serve a historical `asOf` from a point-in-time read.** This is the honest fix, but it needs the
  state and payment history as of a date, which no store keeps. Until one exists the request is
  refused by name. That is ADR-0359's rule: a drop that changes which rows come back is refused.
- **Take a share lock in the re-open.** A share lock does not exclude another share lock, so two
  settlement paths could still both read before either writes. The exclusive lock matches what
  `mark_paid` takes, and it is what makes the two paths serial.
- **Convert inventory postings at each item's own booking rate.** Inventory has no booking rate. The
  posting is a measurement at its own date, so the rate in force on the entry's date is the honest
  one. The consequence is recorded below.

## Consequences

- A refunded past-due document re-opens `overdue`. This is a behaviour change, and it broke one
  existing test that relied on the real clock (`compile.test.ts`, *"leaves the whole ordinary flow
  open"*): its bill fell due on 2026-07-01, so the re-open now follows that date. That test is
  updated with the reason.
- A EUR inventory posting refuses where it used to post when the tenant declares a functional
  currency and has no rate. A deployment that posted EUR stock at face value meets the 409 and the
  remedy it names.
- Converting each posting at its own date's rate leaves a functional residue on the inventory
  account when a receipt and a shipment of the same stock happen at different rates. The transaction
  amounts still net to zero. Nothing revalues inventory yet.
- The same holds for GRNI: a receipt credits it at the receipt date's rate and the matched bill
  debits it at the bill's booking rate, so a fully matched EUR order leaves a functional GRNI balance
  equal to the rate difference. Before this change the receipt side was unconverted, so the residue
  was the whole conversion; now it is the rate movement, which a real ledger posts to a purchase
  price or FX variance and this one posts nowhere.
- The WHT report's withheld total drops for every voided invoice, and the report gains a second
  bounded read over credit notes, `credit_notes` in `bounded`.
- The console's aging date picker (`apps/operate-web/app/reports/aging/page.tsx`, owned by another
  slice) still lets a user pick a past date, which now answers 400 and renders as a request-failure
  sentence. Its comment still calls a past date *"a back-dated snapshot"*.

## Implementation notes

- `packages/operate-runtime/src/money.ts`: the `convertBalanced` leg rounding, with a comment on the
  rule it replaced.
- `packages/operate-runtime/src/write-effects.ts`: `actedBy`, `reopenStateFor` (exported),
  `overdueState`/`dueDateField` on `PaymentApplicationConfig` with the both-or-neither throw, the
  exclusive locks, `resolvePostingRate` exported, and the deletion of the credit-note fallback.
  `CreditNoteGlConfig` loses `currencyField`, `ledgerAccountEntity`, `accountCodeField`,
  `resolveAccountCodes`, `arAccountRef` and `revenueAccountRef`, and `recognitionEntrySuffix` is now
  required.
- `packages/operate-runtime/src/inventory.ts`: `InventoryConfig.fx`, with the rate resolved per
  currency before `createPostedEntry`.
- `packages/operate-runtime/src/wht-reconciliation.ts` and `wht-reconciliation-handler.ts`:
  `voidedStates`, `WhtCreditNoteShape`, and the netting with its second drain.
- `packages/operate-runtime/src/aging-handler.ts`: the two refusals and the round-trip check.
- `packages/operate-runtime/src/compile.ts` (shared file):
  - the credit-note effect call drops its `codeResolver` block;
  - new helpers `lifecycleOf` and `voidedStatesOf`;
  - the payment-application wiring adds `overdueState`/`dueDateField` under the manifest condition;
  - the inventory config gains `fx` when Currency and ExchangeRate exist;
  - the WHT handler receives `voidedStates` and, when Invoice declares `document_type` and
    `credit_note_of`, the credit-note shape.
- Tests:
  - `money.test.ts`: negative half.
  - `write-effects.test.ts`: attribution, past-due/future/today/undated re-open, the lock modes, a
    refund serialised behind a held `mark_paid` lock, and the credit-note mirror tests rewritten onto
    a seeded recognition.
  - `inventory.test.ts`: EUR at 1.1, the 409 with nothing written, and the no-functional-currency
    control.
  - `wht-reconciliation-handler.test.ts`: seven netting cases.
  - `aging-handler.test.ts`: the three pinned tests rewritten, plus today, future and empty.
  - New `money-effects.test.ts`: end to end through `compileOperateServer` — refund re-open for
    Invoice and Bill, attribution, bill revaluation, the WHT wiring, and aging.
- Mutation-checked:
  - restoring `twice >= divisor` fails the rounding test;
  - dropping the refund lock fails 2 tests and dropping the settle lock 1;
  - passing `undefined` as the inventory FX config fails 2;
  - un-wiring the overdue condition in `compile.ts` fails 2 end-to-end tests;
  - setting `voidedStates: []` fails the void-without-credit-note end-to-end test. That test was
    added after the first mutation passed: with a credit note present, the netting alone already
    excluded the invoice.
- ADR-0441 Q5's bill-side revaluation needed **no code change**. A voided EUR bill revalues nothing
  and an open one revalues its whole payable; both are tested.

## Verification

Live on PostgreSQL 16 (port 5447). The schema was applied by `crossengin apply` as the owner, the
confined role was made by `deploy/postgres/roles/app-role.sql` (`superuser=f bypassrls=f`, owns 0
tables), and `operate-server` ran as that role on port 8807. The boot line read
`role ce_app is confined on all 115 policied table(s)` on `--store pg`, and 166 tables across
`meta, public` on `--store pg-columns`. The same arms ran on both stores with identical results:

- **Aging.** `?asOf=<yesterday>` → 400 `as_of_not_served`; `?asOf=<today>` → 200;
  `?asOf=2026-02-30` → 400 `as_of_malformed`; absent → 200.
- **EUR item receipt** with an ExchangeRate of 1.1. 201, one movement, three lines at `fx_rate` 1.1:
  inventory 50.00 → functional 55.00, GRNI 60.00 → 66.00, variance 10.00 → 11.00. The control, a GBP
  receipt with no rate: 409 `exchange_rate_unresolved`, 0 movements, 0 journal lines.
- **The race**, 10 rounds of concurrent `mark_paid` and `refund` on a sent invoice covered by a
  completed payment: all 10 ended `mark_paid 200, refund 200, invoice overdue, payment refunded`.
  That is the serialised outcome, and the forbidden one (an invoice `paid` with its payment refunded)
  never occurred. Every round was ordered the same way, so the other legal order (refund first, then
  `mark_paid` refused) was not observed live; it is covered by the unit test.
- **The lock.** A second session held FOR SHARE on the invoice row for 3 s:
  - a GET returned in 4–5 ms;
  - a refund that re-opens a paid invoice waited 2,245 ms;
  - the discriminating arm, a refund whose re-open writes nothing to the invoice (it was `sent`),
    still waited 2,233 ms. Only the exclusive lock the re-open now takes conflicts with FOR SHARE
    there; a plain read would not have waited. This is reasoned from the code rather than measured
    against a pre-change build.

  The first draft of this harness did not await the lock holder, so both requests ran before the
  lock existed and "measured" a 25 ms refund. The holder's own output (the locked row's `xmin`)
  together with the impossible timing is what exposed it.
- **A not-yet-due invoice** re-opened `sent` after its refund. The re-opened invoices carried
  `paid_at` null and `updated_by` = the acting principal.

Tests:

- `@crossengin/operate-runtime`: build ok, typecheck 0, **1885 tests passed** (58 files).
- `apps/operate-server`: typecheck 0 against the rebuilt runtime (its test suite was not run).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| On `--store pg`, `actedBy` writes `updated_by` onto any settled document, so a tenant manifest whose Invoice or Bill is not `auditable` would carry a stray key; every shipped pack's two documents are `auditable`. | CrossEngin platform | _unscheduled_ |
| Inventory converted at each posting's own date leaves a functional residue between receipt and shipment rates; nothing revalues inventory. | CrossEngin platform | _unscheduled_ |
| The WHT report still ignores a malformed `?from` or `?to` (it reconciles every invoice), which is ADR-0359's class this increment applied to `asOf` only. | CrossEngin platform | _unscheduled_ |
| A WHT certificate issued against an invoice later voided is not surfaced as over-certified; the report drops the invoice and the certificate counts toward nothing. | CrossEngin platform | _unscheduled_ |
| A historical aging report needs a point-in-time read of state and payments, which no store keeps. | CrossEngin platform | _unscheduled_ |
| The console's aging page offers a past date that now answers 400; it needs a `min` on its date input and its comment corrected. The bound is the server's **UTC** date, so a browser west of UTC picking its own local "today" in the evening asks for a UTC past date and is refused too; the `min` must come from the server, not the browser's clock. | CrossEngin platform | _unscheduled_ |
| The refund-first order of the race was not observed live (every round serialised `mark_paid` first). | CrossEngin platform | _unscheduled_ |
| The settle-path half of the write skew (two partial payments completing together) was neither reproduced nor measured after the fix; it is reasoned, and fenced only by the lock-mode unit test. | CrossEngin platform | _unscheduled_ |
| GRNI keeps a functional residue between a receipt's rate and its bill's booking rate (see Consequences); nothing posts it to a variance account. | CrossEngin platform | _unscheduled_ |
| The aging route's new 400s (`as_of_not_served`, `as_of_malformed`) are not declared in the OpenAPI document, which describes `meta.aging.read` with its denials only. | CrossEngin platform | _unscheduled_ |
| `ADR-0441 Q13` is a four-clause item and this ADR closes one clause (a refund re-opening from overdue); its partial credit note's `tax_rate_pct` 0 summary line is untouched. `ADR-0433 Q4`'s structural half — nothing checks `functional = amount × fx_rate` on an effect's lines, because effects skip the guards — also stands; this ADR removed its inventory member. | CrossEngin platform | _unscheduled_ |

## References

- `packages/operate-runtime/src/write-effects.ts`, `money.ts`, `inventory.ts`,
  `wht-reconciliation.ts`, `wht-reconciliation-handler.ts`, `aging-handler.ts`, `compile.ts`
- `packages/operate-runtime/src/money-effects.test.ts`
- ADR-0421, ADR-0429, ADR-0433, ADR-0441, ADR-0465, ADR-0367
