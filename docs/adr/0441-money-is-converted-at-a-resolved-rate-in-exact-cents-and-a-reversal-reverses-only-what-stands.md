# ADR-0441: Money is converted at a resolved rate in exact cents, and a reversal reverses only what still stands

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0429 (credit-note tax, void/refund reversals, FX auto-reverse — most of its open questions are closed here), ADR-0433 (its open question 4, FX revaluation lines that break functional = amount × fx_rate), ADR-0422 (the exact journal balance per transaction currency and in functional currency), ADR-0378 (per-line tax in integer cents; `Currency.decimal_places` inert), ADR-0332 (a `decimal` crosses the wire as a canonical string), ADR-0338 (refuse only when nothing correct breaks), ADR-0367 (`journalPostingGuard`, draining a read), ADR-0431 (inventory postings, left at `fx_rate` 1), ADR-0423 (the unique indexes that made a period-close comment stale) |

## Context

Three findings of the external due-diligence audit, as verified against the tree at `f6faf05`:

- **H-11** (*float money, hard-coded 2 dp, `fx_rate` 1*): true, partly fixed by ADR-0378's per-line
  tax in integer cents. Still open: `Currency.decimal_places` read by nothing, `fx_rate` 1 on the
  auto-posting sites, and control, FX and report sums still computed as doubles.
- **H-13** residuals, named by ADR-0429 as its open questions.
- **M-08** (*client-side money*): true, partly fixed by ADR-0367's period-close drain. Still open:
  2 dp hard-coded in the console, the tenant's currency labelling every amount, money detected by
  field name, float client totals, and the period-close page reading periods with `?limit=200` and
  accounts with `?limit=500`.

Measured before the change, each reproduced red in process at HEAD:

- A EUR invoice posted to the GL at `fx_rate` 1, and a foreign-currency document with no exchange
  rate posted anyway (200).
- Payment settlement mixed currencies on one entry.
- FX revaluation lines stated the functional amount as a transaction amount (EUR, rate 1.2, amount
  equal to the functional amount) — ADR-0433's open question 4.
- A credit note created through the API posted nothing (GL AR 110 against aging 55).
- Voiding a credit note issued by a void answered 200 and did nothing.
- A partial credit followed by a manual reverse left AR at −50.
- Voiding a partly paid bill answered 200 and left AP in debit.
- Voiding a WHT certificate left `income_tax_recoverable` at 500.

The adversarial review found four more, by an offline probe through the real handlers and effects:

- **Revaluation treated a credit note as a receivable.** A EUR 100 invoice booked at 1.1, fully
  voided, then a period close at 1.2 posted +10.00 against an AR balance of 0; an API credit note of
  EUR 40 against a EUR 100 invoice revalued 14.00 where 6.00 is right. This predates the slice.
- **A partly reversed entry could be reversed again.** Reversing the invoice's `-AR` entry after a
  partial credit and then reversing `-CN-GL` answered 200 and left AR 50 on a void invoice; a
  full-credit `-CN-GL` could also be reversed, reinstating the receivable.
- **Instalments left a cent.** 33.33 + 33.33 + 33.35 against a EUR 100.01 invoice at 1.0731 left AR
  at −0.01 on a paid invoice.
- **The console labelled base-currency amounts with the record's currency**: journal-line
  functional debit and credit, and a payment's `cash_amount`, showed `EUR` beside USD figures.

Three of the audit's claims are corrected rather than repeated:

- *"`fx_rate` 1 on four auto-posting sites"* at the given line numbers no longer matches the tree.
  At HEAD the sites were the credit-note fallback, recognition, settlement, WHT clearing, and
  `inventory.ts:469`, which ADR-0431 added after the audit.
- *A 3-decimal currency needs a rounding decision* is false: every currency-bearing amount field in
  `erp-core` has scale 2, so such a currency could never be stored at three decimals at all, which
  is ADR-0378's finding.
- The period-close page carried a comment citing ADR-0360's "0 of 32" unique indexes enforced on
  `--store pg`; ADR-0423 made that false, and the comment is removed.

## Decision

**All ledger arithmetic is in `bigint` hundredths.** `operate-runtime/src/money.ts` holds it, used by
every posting effect in `write-effects.ts`, by `write-guards.ts`, `aging.ts` and
`wht-reconciliation.ts`; `decimal.ts` gains `quantizeDecimal` and `negateDecimal`. `convertBalanced`
converts the lines of one entry to functional currency so the two legs balance and each line stays
within a cent of its exact product, by largest remainder. Its floor is computed by hand for a
negative product, because `bigint` division truncates toward zero: measured, three debits of −33.33
and a credit of −99.99 at 1.5 otherwise produced a credit of −149.97 against an exact −149.985.
Negative lines reach it from `recognitionGlPostingEffect`, whose subtotal and total less withholding
are not constrained to be ≥ 0.

**A posting converts at a resolved rate, and refuses when there is none.** `resolvePostingRate`
takes the document's stamped booking rate, else the `ExchangeRate` on or before the document date.
With no rate it answers **409 `exchange_rate_unresolved`** when the tenant has declared a functional
currency, and posts at 1 when it has not. Recognition, settlement and WHT clearing all use it.
Settlement clears AR/AP at the document's booking rate on the **cumulative** amount settled and books
the realized difference as a functional-only line, which is what removes the instalment cent.
Revaluation posts `open × period-end rate − open × booking rate` as functional-only lines, and its
open balance subtracts credit notes and adds back the originals they voided (a `creditNote` spec on
the Invoice `fxDocuments` entry in `compile.ts`). `journalPostingGuard` accepts a functional-only
line and still requires the functional legs to balance.

**A reversal reverses only what still stands.**

- An API-created credit note posts as the mirror of recognition; the partial split is exact (50
  against 100 + 10 tax gives 45.45 / 4.55).
- Voiding a credit note reverses its own posting, or refuses **409 `credit_note_issued_by_void`**
  when a void issued it.
- A manual reverse after a partial credit reverses only the remainder, and a source already reversed
  — in part or in full — refuses **409 `reversal_source_already_reversed`**.
- Voiding a bill with completed payments applied refuses **409 `document_partly_settled`**.
- Voiding a WHT certificate posts a `-WHT-VOID` reversal.

**A currency the schema cannot store is refused.** `currencyPrecisionGuard` refuses
`decimal_places > 2` on create, or on a change to it, with **422 `currency_precision_unsupported`**,
parsing a string as well as a number. A row stored before the guard can still be edited and
deleted. This is ADR-0338's rule: no such currency was ever stored correctly, so nothing correct
breaks.

**Aging reports per currency.** `totalsByCurrency` is added; `totalOpen` still sums across
currencies for compatibility and is documented as meaningful only for a single currency.

**The console sums money exactly and labels it with the currency it is in (M-08).**
`apps/operate-web/lib/money.ts` sums exactly. `formatCell` labels a money value with the record's
own currency or with nothing and shows the value's own decimal places, and `moneyFieldCurrency`
labels a base-currency field (functional debit/credit, `cash_amount`) with the base currency.
`isMoneyField` matches all 48 of `erp-core`'s money fields (the old pattern missed 7, journal-line
debit and credit among them). The aging page shows a totals row per currency; the WHT page hides its
headline totals when more than one currency is present. Period close drains fiscal periods and
accounts, says when it stopped short, totals exactly, and shows its revaluation as every
`-FXREVAL<n>` entry of the period with no `R` suffix, ordered by ordinal — since ADR-0429 a period
can hold its own revaluation, re-close differences and the previous period's auto-reversal, and the
page showed whichever came first.

## Alternatives considered

- **Refuse a foreign-currency posting with no rate in every tenant.**
  - **Why not:** a tenant that has declared no functional currency and books in its invoice currency
    has nothing to convert to; refusing would break a working single-currency deployment
    (ADR-0338). Such a tenant still posts at 1.
- **Give a 3-decimal currency a rounding rule.**
  - **Why not:** the amounts cannot be stored at three decimals in the first place. Supporting them
    is a schema change, not a rounding decision.
- **Settle each instalment by converting its own amount.**
  - **Why not:** measured, it leaves a cent on AR on a paid invoice. Clearing the cumulative amount
    at the booking rate puts the rounding cent in `fx_gain_loss`, where it belongs.
- **Revalue an invoice's open balance without its credit notes.**
  - **Why not:** it revalues a receivable that a credit note has already removed (+10.00 against an
    AR balance of 0, measured).
- **Detect money from a manifest marker rather than by name.** Not taken here: a money marker on
  the field is a schema decision. The name pattern was checked instead: 48 of `erp-core`'s 80
  decimal fields match, and none of the 32 it skips holds money.

## Consequences

- **Positive:** a foreign document posts at its rate or not at all; the whole ledger balances in
  functional currency to the cent; a credit note, a void and a WHT void each reverse exactly what
  they posted; revaluation stops revaluing credited balances; the console no longer labels a USD
  figure EUR or sums money as floats.
- **Negative:** five new refusals — 409 `exchange_rate_unresolved`, 409 `credit_note_issued_by_void`,
  409 `reversal_source_already_reversed`, 409 `document_partly_settled`, 422
  `currency_precision_unsupported`. Each refuses something that posted or stored a wrong figure, so
  nothing correct breaks; there is no hatch.
- **Neutral:** `totalOpen` keeps its meaning for one currency and is wrong across several, as before;
  `totalsByCurrency` is the answer for several.
- **Reversibility:** the arithmetic and the guards are additive. Removing the rate refusal would
  restore posting foreign amounts at 1.

## Implementation notes

- Changed: `packages/operate-runtime/src/` — `money.ts`, `money.test.ts`, `money-postings.test.ts`
  (new); `decimal.ts`, `index.ts`, `write-effects.ts`, `write-guards.ts`, `compile.ts`, `aging.ts`,
  `wht-reconciliation.ts` and their tests. `apps/operate-web/` — `lib/money.ts` (new),
  `lib/format.ts`, `lib/aging.ts`, `lib/period-close.ts`, `app/reports/aging/page.tsx`,
  `app/reports/wht/page.tsx`, `app/reports/period-close/page.tsx`, `app/e/[slug]/page.tsx`.
- In process, after the review's fixes: operate-runtime typecheck clean and 1474 passed;
  operate-runtime-pg 813 passed; `apps/operate-web` `npx tsc --noEmit` and `npx next build` exit 0.
  operate-server 5770 passed and 6 failed, testing 904 passed and 2 failed, all in the concurrent
  sign-in lane (Stripe-flag, JWKS and JWT `cli.test` cases; a `node.test` boot refused by the new
  weak api-key check; `pg-binding-names` on `credential-store.ts:310`). The implementer's earlier
  counts (1467, 5719 with 3 failed, 906) predate the review and are superseded.
- Mutation-checked, each reversed: the implementer's fences on the rate refusal, the contra
  credit-note flip, the partly-settled refusal, partial-reversal netting, the credit-note void
  refusal, the currency guard, `convertBalanced`, the exact partial credit note and the functional-only
  exemption; plus the negative-floor fix. The review re-ran seven of them (failing tests:
  `exchange_rate_unresolved` 1, contra flip 2, partly settled 1, partial netting 2, currency guard 4,
  `convertBalanced` 3, WHT void wiring 2) and its own five (2, 2, 1, 1, 1). Two first attempts proved
  nothing and were redone: the functional-only exemption passed every test because effects write
  without the guards, so a direct guard test was added; and changing the WHT reversal suffix still
  reverses, so `sourceSuffix` was mutated instead.
- The implementer's live run (PG 16, `--store pg`, non-owner `serving` role): KWD, or raising EUR to
  3 decimals, 422; a EUR invoice with no rate 409 and still `draft`; at 1.1 recognition reads
  `100 / 110.00 @1.1000000000` and its void mirrors it; a partial credit then a manual reverse leaves
  the AR delta 0.00; `/v1/meta/aging` returns `totalsByCurrency`. The review's fixes were not re-run
  live by either.
- **Independent live run** (PG 16, the API as `crossengin_app`, tenant functional currency USD,
  identical on `--store pg` and `--store pg-columns` row for row):
  - Currency `decimal_places` 3, `"3"`, and a PATCH of EUR to 3: 422 ×3; `"2"` as a string 201.
  - A EUR invoice sent with no rate: 409 `exchange_rate_unresolved`, invoice stays draft. With rate
    1.1: AR Dr 100.00 / revenue Cr 100.00 at 1.1000000000, functional 110.00.
  - An API credit note of EUR 40 against it: AR Cr 40.00 at 1.1, functional 44.00.
  - EUR 100.01 at 1.0731 paid as 33.33 + 33.33 + 33.35: invoice `paid`, AR cleared exactly 107.32
    (35.77 + 35.76 + 35.79), realized 0.01 credited to 7000.
  - The whole GL in functional currency: debits = credits = 658.65.
  - Voiding a bill with a completed payment of 40 applied: 409 `document_partly_settled`; voiding an
    unpaid approved bill: 200.
- Not exercised live: the WHT void, the credit-note void refusals, `reversal_source_already_reversed`,
  the revaluation credit-note fix, and every `apps/operate-web` change.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `inventory.ts` (ADR-0431) still posts at `fx_rate` 1, so a EUR item's stock postings land as USD amounts that still balance. Converting it needs `resolvePostingRate` exported into that module. | CrossEngin platform | _unscheduled_ |
| The credit-note effect's two-line fallback still writes `fx_rate` 1; `compile.ts` never uses that path. | CrossEngin platform | _unscheduled_ |
| An API credit note posts at its own rate rather than the invoice's booking rate; the difference lands in revaluation or realized FX. | CrossEngin platform | _unscheduled_ |
| Manually reversing an invoice's `-AR` entry after an API credit note still credits AR twice, and a void with payments or with API credit notes can still double the credit. | CrossEngin platform | _unscheduled_ |
| The revaluation credit-note fix was measured for invoices only; bills and other documents were not tested for the same defect. | CrossEngin platform | _unscheduled_ |
| Partial-reversal netting finds its source by the `-AR` / `-CN-GL` suffix pair, and was not verified on `--store pg-columns`. | CrossEngin platform | _unscheduled_ |
| Settlement rates are rounded to 10 decimal places, so an amount above about 1e8 can land a cent off. | CrossEngin platform | _unscheduled_ |
| `convertBalanced` rounds a negative half toward +∞ while `convertUnits` rounds half away from zero; they differ by at most a cent. | CrossEngin platform | _unscheduled_ |
| `Number(units) / 100` is exact only below 2^53 hundredths (about 9.0e13), while the `NUMERIC(16, 2)` column reaches 1e14. | CrossEngin platform | _unscheduled_ |
| 3-decimal currencies need a schema change, and a 0-decimal currency still accepts cent amounts. | CrossEngin platform | _unscheduled_ |
| Money is still detected by field name in the console; a manifest money marker is a schema decision. The record detail page shows money unformatted. | CrossEngin platform | _unscheduled_ |
| `apps/operate-web` has no test runner (register P1.3), so nothing executes the M-08 changes, including the period-close revaluation-entry fix; they are checked only by `tsc` and `next build`, and were not run live. | CrossEngin platform | _unscheduled_ |
| ADR-0429's remaining items are untouched: `Bill` declares no withholding, a refund re-opens even from `overdue`, a partial credit note's summary line carries `tax_rate_pct` 0, and a posting racing a period close can land in the closed period. | CrossEngin platform | _unscheduled_ |

## References

- `packages/operate-runtime/src/money.ts` (`convertBalanced`), `decimal.ts`, `write-effects.ts`
  (`resolvePostingRate`, the credit-note, settlement, revaluation and WHT void effects),
  `write-guards.ts` (`currencyPrecisionGuard`, `journalPostingGuard`), `compile.ts`, `aging.ts`,
  `wht-reconciliation.ts`, `money-postings.test.ts`
- `apps/operate-web/lib/money.ts`, `lib/format.ts` (`formatCell`, `isMoneyField`,
  `moneyFieldCurrency`), `lib/aging.ts`, `lib/period-close.ts`
- External due-diligence audit, findings H-11, H-13 and M-08; verified status in the due-diligence
  verification report
- ADR-0429, ADR-0433, ADR-0422, ADR-0378, ADR-0338
