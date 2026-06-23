# ADR-0139: Stamp withholding total at recognition + prefill the certificate amount

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0138 (one-click WHT certificate), ADR-0137 (WHT certificate entity), ADR-0133 (withholding-tax lines) |

## Context

ADR-0138's "Raise WHT certificate" action prefilled the invoice/customer/currency but left
the amount blank, because the withheld total isn't stored on the invoice — it's derived
from the lines' withholding `TaxCode`s at recognition. This stamps that computed total onto
the invoice so the action can prefill the amount (and the figure is queryable for
reporting).

## Decision

**`withholding_total` on `Invoice`.** An optional decimal, the tax withheld at recognition
(a contra to AR, not part of `total`).

**Recognition stamps it (`recognitionGlPostingEffect`).** A new optional
`stampWithholdingField` config: after posting, when the computed `withholdingTotal > 0` the
effect writes it back onto the document via a direct `store.update` (bypasses
guards/effects — no recursion, the same pattern as `bookingRateStampEffect`). No write when
there's no withholding, so non-withholding invoices are untouched. Wired in `compile.ts`
for `Invoice` recognition alongside the existing `taxLines` config (gated on `TaxCode`).

**Action prefills the amount (`/e/[slug]/[id]`).** The "Raise WHT certificate" link now
appends `&amount=<withholding_total>` when the invoice carries a non-zero one — so the
certificate form opens fully prefilled (invoice, customer, currency, amount).

## Consequences

- Raising a WHT certificate from a withheld invoice is now truly one click: every field is
  prefilled, the user only adds the authority's certificate ref and confirms (which fires
  the clearing effect, ADR-0137). The user can still override the amount to match the
  physical certificate.
- `withholding_total` is queryable on the invoice — a basis for a future WHT report /
  reconciliation against certificates raised.
- Backward compatible: the stamp only fires when withholding is present and the field is
  configured; the amount query param is appended only when non-zero.
- 6,588 tests pass (+2: the stamp on a withholding invoice; no stamp when there's none),
  zero type errors, full build green, `operate-web` compiles.
- Follow-up: a WHT reconciliation report (withheld vs certified) and the same stamp on
  Bills for the payable side.
