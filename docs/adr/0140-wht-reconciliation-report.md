# ADR-0140: WHT reconciliation report (endpoint + console screen)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0139 (stamp withholding total), ADR-0137 (WHT certificate), ADR-0126/0127 (aging report + screen) |

## Context

Withholding is now booked at recognition (`withholding_total`, ADR-0139) and cleared by
confirmed `WhtCertificate`s (ADR-0137). What's missing is the control view: how much tax
was withheld vs how much has been certified, and the uncertified exposure. This adds that
report, following the `/v1/meta/aging` pattern (pure compute + handler + console screen).

## Decision

**Pure `computeWhtReconciliation` (`wht-reconciliation.ts`).** Given invoices (with
`withholding_total`) and a `certifiedByInvoice` map (summed confirmed certificate amounts),
it emits one row per invoice with positive withholding — `{withheld, certified, gap,
status}` where gap = withheld − certified and status is `certified` (gap ≤ 0) / `partial`
(some certified) / `uncertified` — plus `totals {withheld, certified, uncertified}`. Rows
are ordered largest-gap-first so open exposure surfaces at the top.

**`GET /v1/meta/wht-reconciliation` (`wht-reconciliation-handler.ts`).** Finance-role gated
(fail-closed, like aging). Fetches invoices with `withholding_total > 0` (filter pushed
down, re-checked) and confirmed certificates summed by `invoice_id`, then runs the pure
compute. Registered in `compile.ts` when the manifest models both `Invoice` and
`WhtCertificate`.

**Console screen (`/reports/wht`).** Three totals (withheld / certified / uncertified) and
a per-invoice table (withheld, certified, gap, status badge) with each invoice deep-linked.
A finance-gated **Reports → Withholding Tax** sidebar link, shown only when the schema
models `WhtCertificate`.

## Consequences

- The withholding control loop is now observable: a controller sees total exposure and
  which invoices still lack a certificate, ordered by open gap — the reporting capstone on
  the data ADR-0139 began stamping.
- Reuses the report pattern end-to-end (pure module + role-gated handler + literal route +
  console screen + schema-gated sidebar link), so it's consistent with aging.
- Gated on `Invoice` + `WhtCertificate`, so packs without withholding are unaffected
  (route absent → the screen's sidebar link is hidden).
- 6,592 tests pass (+4: classification + totals, exclusion of zero-withholding, gap
  ordering, over-certification), zero type errors, full build green, `operate-web` compiles.
- Follow-up: currency-grouped subtotals; an `asOf`/period filter; the same on the AP
  (bill) side once payable-WHT is modelled.
