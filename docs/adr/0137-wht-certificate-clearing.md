# ADR-0137: WHT certificate entity — withholding receivable clearing

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0133 (withholding-tax lines), ADR-0132 (per-TaxCode GL account), ADR-0121 (real CoA mapping) |

## Context

ADR-0133 books withholding at recognition: a withholding `TaxCode` on a sale debits a WHT
receivable (the slice the customer withholds and remits to the authority on the seller's
behalf) and reduces AR. That receivable then sits on the books until the seller *claims* it
— in practice when the customer provides a withholding certificate proving remittance,
which converts the receivable into a formal income-tax credit. This adds that clearing step
as a first-class record (the option chosen over a TaxReturn offset / payment-time clearing).

## Decision

**`WhtCertificate` entity (`pack-erp-core`, Finance module, entity #51).** Auto-numbered
(`WHT-{YYYY}-{SEQ}`), references the originating `Invoice` + the `Account` (customer),
carries the authority's `certificate_ref`, the withheld `amount`, currency, `issue_date`,
and a `draft → confirmed → void` `state` (no lifecycle workflow — confirmation is a plain
status update the write-effect observes, like `FiscalPeriod` close). Served by the operate
`EntityStore`, so no kernel meta-schema table is needed.

**`whtCertificateClearingEffect` (`operate-runtime`).** On the `→confirmed` edge it posts
one balanced `JournalEntry` (`<cert>-WHT`, posted) reclassing the withheld amount: **debit
income-tax-recoverable, credit WHT-receivable** — both assets, no P&L impact. Accounts
resolve from two new finance settings codes (`taxRecoverableAccountCode` →debit,
`whtReceivableAccountCode` →credit), falling back to placeholder refs. Fires once per edge,
skips a zero amount, written through the store inside the confirming transaction.

**Wiring (`compile.ts`).** Gated on the manifest carrying `WhtCertificate` + a GL, the
effect is registered with the settings-driven account-code resolver.

## Consequences

- The withholding lifecycle is now complete: recognition debits WHT receivable (ADR-0133)
  → the customer pays the net (AR cleared by normal settlement) → confirming the WHT
  certificate reclasses the receivable into an income-tax credit. The asset no longer sits
  unreconciled.
- Standard-flow assumption: the certificate clears the tenant's configured WHT-receivable
  account; a withholding code with a *bespoke* per-code `gl_account_code` (ADR-0132) that
  differs from the settings code would need that account aligned — documented, not enforced.
- 6,586 tests pass (+3: the reclass posting, the once-on-confirmed-edge guard, the
  zero-amount skip), pack entity count 50→51, zero type errors, full build green.
- Follow-ups: link the certificate's clearing account to the originating line's TaxCode
  account; a console action to raise a certificate from a withheld invoice; remittance to
  the authority on the tax return.
