# ADR-0145: WHT reconciliation — currency subtotals + period filter

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0140 (WHT reconciliation report), ADR-0127 (aging asOf control) |

## Context

The WHT reconciliation report (ADR-0140) showed a single grand total and a per-invoice
table, with no per-currency breakdown or period scoping. Delivered in the four-agent polish
batch.

## Decision

- **Currency subtotals (`computeWhtReconciliation`).** A new `byCurrency:
  WhtCurrencySubtotal[]` (`{currency, withheld, certified, uncertified}`) aggregates over the
  already-computed rows (row-level `round2`, re-rounded per subtotal), null currency grouped
  under `""`. Ordered by descending `uncertified`, then currency ascending. `totals` + `rows`
  unchanged.
- **Period filter (`wht-reconciliation-handler.ts`).** Optional `?from=YYYY-MM-DD` /
  `?to=YYYY-MM-DD` (validated by `DATE_PATTERN`, malformed ignored — mirrors the aging
  handler's `asOf`). When either is present, the fetched invoices are filtered by
  `issue_date` (inclusive `>= from` / `<= to`; an undated invoice is dropped while filtering);
  certificates are not date-filtered. `issueDateField` is configurable (default `issue_date`).
- **Console (`app/reports/wht/page.tsx`).** From/To `<input type="date">` + an "All time"
  reset, refetching on change; a compact per-currency subtotal table between the totals cards
  and the invoice table (shown when >1 currency). `fetchWhtReconciliation(from?, to?)` appends
  the params.

## Consequences

- A controller can scope the reconciliation to a filing period and see the uncertified gap
  broken down per currency — the report is now filing-ready.
- Pure-function tests cover the currency subtotal ordering, null-currency grouping, and
  rounding (3 new; `operate-runtime` 213 pass). `operate-web` builds green.
- Follow-up: date-filter the certificates too (by issue/confirm date) if period-accurate
  certified totals are wanted.
