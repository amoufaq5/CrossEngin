# ADR-0126: AR/AP aging report

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0125 (payment application), ADR-0123 (cash cycle) |

## Context

Per-document open balances became computable once payments link to documents
(ADR-0125): open = total − applied completed payments. The natural payoff is an
AR/AP **aging report** — what's outstanding, by how overdue — which also makes the
whole finance engine observable. This adds it as the first finance report endpoint.

## Decision

**Pure aging computation (`operate-runtime/aging.ts`).** `computeAging` takes the
open documents + a map of applied amounts per document + an `asOf` date and returns,
per document, open balance and days-overdue bucketed by `DEFAULT_AGING_BUCKETS`
(current / 1-30 / 31-60 / 61-90 / 90+), plus per-bucket totals and total open.
Fully-settled documents (open ≤ 0) are dropped; rounding is cents-stable; a
mixed-currency report reports `currency: null`. Deterministic and store-agnostic.

**Report endpoint (`aging-handler.ts`, `GET /v1/meta/aging`).** Computes the report
from the live store: it sums completed payments grouped by each section's link
field and fetches the open documents (state-filtered), then `computeAging` per
section. Sections are configured from the manifest — `ar` ← Invoice (open
`sent`/`overdue`, payments via `invoice_id`) and `ap` ← Bill (open
`approved`/`overdue`, via `bill_id`). Authorized to a finance/admin viewer-role set
(`erp_admin`/`controller`/`erp_accountant`/`ap_clerk`, overridable via
`financeRoles`), fail-closed.

## Consequences

- A finance user can pull a live AR/AP aging report: verified end-to-end — a
  partially-paid invoice shows `open=60` (current), an unpaid overdue invoice
  `open=200` in `90+`, total open 260; a non-finance role gets 403.
- The finance engine is now observable end-to-end: recognition → settlement →
  application → **aging**, all off the same ledger/document data.
- The pure `computeAging` is reusable for a dashboard widget, a scheduled report,
  or a statement run.
- 6,5xx tests pass (+9 aging cases), zero type errors, `operate-web` build green.
- Follow-ups: a console aging screen consuming the endpoint; an `asOf` query
  parameter for historical aging; and unrealized FX revaluation at period close
  using these per-document open balances.
