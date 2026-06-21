# ADR-0125: Per-document payment application + auto-settlement

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0124 (Payment-driven settlement), ADR-0123 (cash cycle) |

## Context

ADR-0124 made settlement Payment-driven (partial payments each post their own GL
entry) but a Payment wasn't linked to a specific document, so partial payments
never *closed* an invoice/bill — the document stayed open even when fully paid.
This adds the linkage and auto-settlement.

## Decision

**Link fields on `Payment` (`pack-erp-core`).** `Payment` gains optional
`invoice_id` → `Invoice` and `bill_id` → `Bill` references, so a payment applies to
a specific document.

**`paymentApplicationEffect` (`operate-runtime/write-effects.ts`).** When a Payment
linked to a document completes, it sums all completed payments for that document and
— once they cover the document `total` — auto-transitions the document to `paid`
(`paid_at` stamped). Partial payments therefore accumulate against the specific
invoice/bill and settle it when fully covered. It only settles from a settleable
state (invoice `sent`/`overdue`, bill `approved`/`overdue`), and writes the document
directly through the store (bypassing the issued-document lock) inside the payment
transaction, so application is atomic with the settlement GL posting.

**Wiring (`compile.ts`).** Added to `defaultWriteEffects` for `Invoice` (via
`invoice_id`) and `Bill` (via `bill_id`) when `Payment` is present.

## Consequences

- Verified end-to-end: a 120 invoice stays `sent` after a 60 payment and
  auto-settles to `paid` after a second 60 — each payment posting its own
  `-SETTLE` GL entry alongside the issue `-AR` recognition.
- Partial payments are now first-class: multiple payments apply to one document and
  close it exactly when covered, no manual "mark paid".
- The link also makes per-document open-balance / AR-aging computable (sum total −
  applied payments per document) — the basis for the deferred aging + unrealized FX
  revaluation work.
- 6,5xx tests pass (+4 application cases), zero type errors, `operate-web` build
  green.
- Follow-ups: over-application guard (reject payments exceeding the open balance),
  partial-state surfacing (an `amount_paid`/`balance_due` on the document), and
  unrealized FX revaluation at period close using the per-document open balances.
