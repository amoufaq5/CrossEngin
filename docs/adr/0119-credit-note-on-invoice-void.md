# ADR-0119: Credit-note auto-effect on invoice void

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0115 (auto-reversal), ADR-0118 (invoice locking), ADR-0116 (transactional effects) |

## Context

ADR-0118 made an issued invoice immutable, corrected by **void** (a lifecycle
transition). But voiding only flipped the state; the AR-side correction document —
a credit note that reverses the invoice's effect — still had to be created by
hand. The journal already auto-generates its reversal (ADR-0115); invoices should
auto-generate their credit note the same way.

## Decision

Make the credit note a first-class invoice variant and emit it on void.

**Marker fields on `Invoice` (`pack-erp-core`).** A `document_type` enum
(`invoice` | `credit_note`, default `invoice`) and a self-reference
`credit_note_of` → `Invoice`. Totals keep `min: 0`, so the credit note is a
*positive* document whose `credit_note` type denotes the reduction (not a negative
invoice). `tryValidateManifest` still passes; entity/relation counts unchanged.

**`invoiceVoidCreditNoteEffect` (`operate-runtime/write-effects.ts`).** On the
issued→void edge (`before.state ∈ {sent, overdue}` → `void`) it writes, directly
through the store:
- a `document_type = credit_note` invoice numbered `<original>-CN`, linked via
  `credit_note_of`, carrying the original's account/currency/subtotal/tax/total,
  issued today (state `sent`), noted "Credit note for <original>";
- one credit-note line per original line (`description` prefixed "Credit: ").

Voiding a never-issued **draft** creates nothing, and a credit note is never
itself credit-noted. Bypassing the handler (direct store writes) means no
recursion, and — because effects run inside the void's transaction (ADR-0116) —
the void and its credit note commit atomically.

Auto-wired by `defaultWriteEffects` when the manifest has `Invoice` (lines mirrored
when `InvoiceLine` is present); opt out with `writeEffects: []`.

## Consequences

- Voiding an issued invoice now produces its credit note automatically: verified
  through the real gateway — `POST /v1/invoices/:id/void` flips the original to
  `void` and creates `INV-…-CN` (`credit_note`, linked, mirrored total + line
  `Credit: Widget`).
- AR now matches the GL: post/issue → correct by reverse/void, with the mirror
  document generated for you and committed atomically.
- The credit note is a normal invoice, so it lists, renders, and locks (ADR-0118)
  like any issued invoice, and its `credit_note_of` link is queryable.
- 6,5xx tests pass (+4 credit-note cases), zero type errors, `operate-web` build
  green.
- Follow-ups: post the matching GL reversal entry when a credit note is issued
  (AR ↔ GL bridge), and a `creditNoteAmount < original` partial-credit path.
