# ADR-0124: Tax-split recognition, Payment-driven settlement, realized FX

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0123 (cash cycle), ADR-0121/0122 (AR/AP bridges), ADR-0107 (GL) |

## Context

ADR-0123 closed the cash cycle but recognition posted a single net line at the
gross total (no tax split), settlement fired on the document's own →paid edge (no
partial payments), and there was no realized-FX handling. This addresses all three.

## Decision

**Tax-split recognition (`recognitionGlPostingEffect`).** A new effect posts the
control account (AR/AP) at the gross total on one side and the **net + tax** lines
on the opposite side at subtotal and tax. It reconciles `subtotal + tax == total`
and degrades to a single net-at-total line when there's no tax or the split
doesn't add up. Wired for invoice issue (debit AR; credit revenue + **tax
payable**) and bill approval (credit AP; debit expense + **input tax**),
superseding the previous single-line recognition.

**Payment-driven settlement (`paymentSettlementGlPostingEffect`).** Settlement now
fires on a **Payment** reaching `completed`, not on the invoice/bill →paid edge.
Inbound → debit cash, credit AR; outbound → debit AP, credit cash, **for the
Payment's own amount** — so **partial payments** settle naturally, one entry per
payment. (The prior invoice/bill →paid settlement wiring is removed; the generic
`paymentGlPostingEffect` remains for reuse.)

**Realized FX (`cash_amount` on Payment).** When the Payment's `cash_amount` (the
reporting-currency cash actually moved) differs from `amount` (the AR/AP cleared),
the gap is booked to the **FX gain/loss** account so the entry balances — a gain
when more cash arrives than the receivable cleared, a loss when less.

**Settings.** `FinanceSettings` gains `taxPayableAccountCode`,
`taxInputAccountCode`, and `fxGainLossAccountCode` (joining the AR/AP/revenue/
expense/cash codes), all surfaced in the web Finance & tax section.

## Consequences

- Verified end-to-end: a taxed invoice (subtotal 100 / tax 20 / total 120) posts AR
  120 / revenue 100 / **tax payable 20**; a partial inbound Payment of 50 with cash
  52 settles AR 50, cash 52, and a **2 FX gain** — balanced.
- Recognition now reflects tax as its own ledger line (VAT/GST reporting works off
  the GL); settlement supports partial and multi-payment AR/AP; cross-currency
  settlement books realized FX.
- 6,5xx tests pass (+8 recognition/settlement/FX cases), zero type errors,
  `operate-web` build green.
- Follow-ups: line-level tax codes (multiple tax rates per document) instead of a
  single tax total; linking a Payment to specific invoices for per-document
  application + unrealized FX revaluation at period close.
