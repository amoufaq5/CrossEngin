# ADR-0429: A posting is reversed by what it posted, in the period it lands in

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0419 (a document's lock and its state; `reversed` is as immutable as `posted`), ADR-0421 (server-owned stamps, `--segregation-of-duties`), ADR-0422 (`updateIf`, the exact per-currency balance), ADR-0367 (`drainList` and the read ceiling), ADR-0378 (exact money arithmetic, withholding), ADR-0391 (`settlementCoverageGuard`), ADR-0366 (the deleted settlement effects), ADR-0423 (`entry_number` uniqueness on `--store pg`), ADR-0433 (residuals: FX functional amounts) |

## Context

The external due-diligence audit ranked **H-13** high (R01-08 … R01-11): credit notes ignore tax,
void and refund post nothing, the period lock skips system postings, and FX revaluation never
reverses. Verified at `f6faf05` as true when written and only **partly fixed** — ADR-0367 closed the
FX read's 5,000-row cap and ADR-0391 closed `mark_paid` with no cash — while all four headline
defects were unchanged (`creditNoteGlPostingEffect`'s logic byte-identical since the audit; no effect
keyed on `Bill → void` or `Payment → refunded`; the lock guard reading only a named
`fiscal_period_id`; the revaluation firing on every `→ closed` edge with no reversal).

Measured before changing anything, in memory on `erp-core` as `erp_admin`:

- **Credit note** on 100 + 10 VAT, after void: AR 0, revenue +10, tax payable −10 — tax never
  reversed, revenue over-reversed by 10.
- **Withholding** 5% on 100: a payment of 95 cleared AR but the invoice stayed `sent`; `mark_paid`
  answered 422 "5.00 of 100.00" (ADR-0391's guard compares the gross total), and aging showed 5 open.
- **Bill** of 200 approved then voided: AP −200 / expense 200 left standing.
- **Payment** of 50 then refunded: AR stayed cleared and the invoice stayed `paid`.
- **Period lock**: sending into a closed June posted anyway, with no `fiscal_period_id`.
- **FX** close, reopen, close: two `2026-06-FXREVAL` entries, the loss doubled (−20 for −10); on
  `--store pg` the second close would be a 500 on the unique entry number (ADR-0423's index).
- **Aging** after voiding an invoice of 80: the credit note showed +80 open against a GL AR of 0.

## Decision

The rule behind every part: **a reversal mirrors what was actually posted, and a posting is dated
today and locked by today's period.**

- **Period.** An effect's posting is dated today and refused **422 `period_locked`** when that date
  falls in a closed period; the whole write rolls back. Today and not the document's date, because a
  document date is typed by the caller and would let anyone backdate a posting — and it means a late
  approval of an old document posts into the current period instead of being refused. A reversal
  takes today's period rather than copying the original's. The handler's posting guard also checks
  the entry **date**, so a manual entry naming no period is still caught. `posting-period.ts` holds
  the rule: an adjustment period counts only where no ordinary period covers the date, any
  overlapping locked period refuses, and — the review's correction — an entry that **names** an open
  adjustment period covering its own date is decided by that period, so the year-end adjusting entry
  into period 13 posts while period 12 is closed. The date rule switches on only when `FiscalPeriod`
  resolves `start_date`, `end_date` and `status` (`postingPeriodsOf`); a named period's status is
  still checked otherwise.
- **FX revaluation is the one exception to "today"**: it posts into the period being closed, because
  the close is the act the lock exists for. Each close posts its revaluation at period end **plus an
  automatic reversal the next day**, so the next close does not count the same gain again. A re-close
  posts only the difference from what the period already holds (`-FXREVAL2`, …). If the next period
  is already closed the close is refused 422, the period stays open, and nothing is written first.
- **Credit notes** mirror the invoice's own posted `-AR` entry line for line, so tax per code,
  withholding and AR reverse exactly. A partial credit is scaled in exact cents with both sides
  summing to the credited amount. A full credit marks the source entry `reversed`, so a later manual
  reverse is 409. The credit-note document carries tax in proportion (it used to carry the whole
  amount as net with zero tax).
- **Bill void and Payment refund**: `postingReversalEffect` reverses the bill's `-GL` or the
  payment's `-SETTLE` entry. A bill voided before approval posts nothing. Two entries carrying one
  number refuse **409 `posting_ambiguous`** rather than guessing. A refund re-opens the document it
  settled unless another payment still covers it.
- **Withholding**: what a payer owes is total minus withholding, in the coverage guard, payment
  application, the FX open balance and aging — **only where the field is effect-stamped**. The
  review measured why: with TaxCode stripped from the manifest, `withholding_total` is caller-typed,
  and an invoice created with `withholding_total = total` was marked paid with no payment (200),
  reopening ADR-0391's divergence. For FX the gate is per document type, so a Bill's field is never
  read. The settled-document guard compares what is owed, so lowering withholding on a paid document
  is refused like raising its total.
- **Aging**: a credit note is negative and is aged together with the voided invoice it credits; a
  fully credited pair drops out, a partial credit leaves the remainder, and a credit note with no
  original shows as a credit balance.
- A refused posting reaches the client as its named 4xx rather than the generic 500.

## Alternatives considered

- **Date a posting by the document's date.** Refused: the date is caller-typed, so the lock would be
  bypassable by backdating.
- **Negate credit notes in aging, alone.** Refused on measurement: the voided original is not in an
  open state, so aging would read −T against a GL of 0. Pairing is what makes the two agree.
- **Rebuild the credit-note posting from the document's own fields.** Refused: the posted entry is
  the record of what was recognised; mirroring it reverses tax per code and withholding exactly,
  where re-deriving reverses what the document says now.
- **Revalue without an automatic reversal.** Refused: the next close's delta against the booking
  rate would count the same movement twice.
- **Find a revaluation's prior entries by period alone.** Refused by the review: every posting now
  carries its period, so that read is the whole month's journal and past the read ceiling a busy
  tenant's close fails with a 500. The lookup also filters on `source = fx_revaluation`.

## Consequences

- **Positive:** the four headline defects close and the GL and aging agree for void-made credit
  notes, refunds and withholding.
- **Negative:** a posting into a closed period is now a 422 where it was a silent post; a late
  approval of an old document posts into today's period, not the document's.
- **Neutral:** a re-close emits a second revaluation pair; the period-close page in `operate-web`
  (`fetchRevaluationEntry`, outside this slice) picks the first `fx_revaluation` entry stamped with a
  period, so it may show a re-close's other entry, or the previous period's reversal as this period's
  revaluation.
- **Reversibility:** effect-level and in `operate-runtime` only; no schema change. Undoing it
  restores the defects.

## Implementation notes

In process: `operate-runtime` 1,312 tests (typecheck and build clean), `@crossengin/testing` 796,
`operate-server` 5,598. Mutation checks, each restored byte-identical: effects ignoring the period
(4 fail), partial credit reversing the whole entry (2), withholding counted as owed (3), FX
difference not subtracted (2), refund not re-opening (1), posting guard ignoring the date (1),
credit note not negated in aging (4), credit-note posting falling back to two lines (2), source entry
not marked reversed (2); the review added fences for both regressions it found (the year-end
adjustment period, the caller-typed withholding) plus the FX write-before-refusal, the read ceiling
and the dateless calendar. Four tests that pinned the old behaviour were rewritten, not deleted.

Live on PG 16 in compose order, both stores (`--store pg` as `crossengin_app`; `--store pg-columns`
as the owner, because it cannot boot as `crossengin_app` — `fatal: permission denied for database
crossengin`, outside this slice):

- Full credit on 100 + 10: after send AR 110 / revenue −100 / tax −10, after void all zero; the
  `-AR` entry is `reversed` and a manual reverse is 409.
- Partial credit of 55: over the arm AR +55 / revenue −50 / tax −5; the document totals
  55.00 / 50.00 / 5.00.
- Bill approve then void nets to zero (`-GL` reversed, `-VOID` posted).
- Refund: invoice back to `sent` with `paid_at` null; over send, pay and refund AR +50 / revenue −50,
  cash 0.
- Send into a closed November: 422 `period_locked`, invoice draft, 0 entries; after `reopen` 200 with
  the entry stamped November. A manual entry dated into a closed October: 422.
- FX close, reopen, re-close at a moved rate: `FXREVAL` (Oct 31) + `FXREVALR` (Nov 1), then
  `FXREVAL2` + `FXREVAL2R`; net GL zero as designed.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A credit note created through the API (`document_type: credit_note`) and sent posts nothing, because recognition skips credit notes: measured GL AR 110 against aging 55. | CrossEngin platform | — |
| Voiding a partly paid bill: AP +50 (a debit balance) against AP aging 0; bills have no credit-note pairing. | CrossEngin platform | — |
| A partial credit leaves the source entry `posted`, so a later manual reverse reverses the whole recognition again (measured AR −40). | CrossEngin platform | — |
| FX revaluation lines carry EUR with `fx_rate` 1.2/1.3 and amount equal to the functional amount, breaking functional = amount × rate; confirmed live, listed in ADR-0433. | CrossEngin platform | — |
| `Bill` declares no `withholding_total`, so purchase-side withholding is not deducted; the withholding line still falls back to `tax_payable` (R01-14). | CrossEngin platform | — |
| Foreign-currency recognition writes foreign amounts as functional with `fx_rate` 1. | CrossEngin platform | — |
| WHT certificate void posts no reversal of its `-WHT` entry; voiding a credit note does nothing; a refund re-opens to `sent`/`approved` even from `overdue`. | CrossEngin platform | — |
| A partial credit note's single summary line carries `tax_rate_pct` 0 while its header carries tax, and the document's split can differ from the GL split by a cent. | CrossEngin platform | — |
| A posting racing a period close can land in the just-closed period (read committed); the guard has the same race. | CrossEngin platform | — |
| Reversals find their source by entry number; `posting_ambiguous` refuses a duplicate rather than guessing (uniqueness on `--store pg` is ADR-0423's). | CrossEngin platform | — |

## References

- `packages/operate-runtime/src/posting-period.ts`, `write-effects.ts` (`postingReversalEffect`,
  credit-note and FX revaluation effects), `write-guards.ts`, `aging.ts`, `aging-handler.ts`,
  `compile.ts`, `handlers.ts`, `accounting-postings.test.ts`
- Audit H-13 (R01-08 … R01-11); verified status in the due-diligence verification report
