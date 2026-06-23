# ADR-0138: One-click WHT certificate from an invoice + create-form prefill

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0137 (WHT certificate entity), ADR-0134 (reference picker) |

## Context

ADR-0137 added the `WhtCertificate` entity + clearing effect, but raising one meant opening
the generic create form and retyping the invoice id, customer, and currency. This adds a
one-click action from the source invoice, built on a generic create-form prefill.

## Decision

**Generic create-form prefill (`/e/[slug]` list page).** The create form now seeds its
initial values from URL query params whose names match editable field names — so
`/e/<slug>?new=1&invoice_id=…&account_id=…&currency=USD` opens a pre-populated form.
`CreateForm` takes an optional `initialValues` and initializes its state from it; reusable
for any entity, not just certificates.

**"Raise WHT certificate" action (`/e/[slug]/[id]` detail page).** When the record is an
`Invoice` and the manifest models `WhtCertificate`, a button links to the certificate's
create form prefilled with `invoice_id` (this invoice), `account_id` (the customer), and
`currency`. The withheld **amount is left for the user** to enter from the physical
certificate — the customer's certificate is the authoritative figure, which can differ from
the computed withholding — so the action prefills the context, not the amount.

## Consequences

- Raising a WHT certificate is now one click from the invoice: invoice/customer/currency
  arrive prefilled and resolve to labels via the reference picker (ADR-0134); the user adds
  the certificate ref + amount and confirms, which fires the clearing effect (ADR-0137).
- The query-param prefill is a generic building block — any "create a related X from this Y"
  link can reuse it (future: bill→payment, order→invoice).
- Shown only when `WhtCertificate` is in the manifest, so packs without it are unaffected.
- `operate-web` build green; no package/server change.
- Follow-up: prefill the computed withheld amount (needs the invoice's withholding total,
  e.g. stamped at recognition or a small report endpoint).
