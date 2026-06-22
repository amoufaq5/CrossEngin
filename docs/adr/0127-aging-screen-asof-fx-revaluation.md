# ADR-0127: Console aging screen, historical aging (asOf), unrealized FX revaluation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0126 (aging report), ADR-0124 (settlement + FX), ADR-0107 (fiscal periods) |

## Context

The three remaining finance follow-ups from ADR-0126, delivered together (two
parallel agents on disjoint packages — `apps/operate-web` and
`packages/operate-runtime` — on the live tree; their output was reviewed and
integrated here).

## Decision

**1. Console aging screen (`apps/operate-web`).** A `/reports/aging` page calls
`GET /v1/meta/aging` and renders the AR and AP sections: a bucket-summary row
(current / 1-30 / 31-60 / 61-90 / 90+ + total open) and a per-document table
(number, due date, days overdue, bucket, open), money/dates via the tenant
formatting. Loading / 403 ("no access to finance reports") / empty states handled.
A finance-gated **Reports → Aging** sidebar link (shown when the viewer holds a
finance role; fail-open in dev).

**2. Historical aging — `?asOf=YYYY-MM-DD` (`aging-handler.ts`).** The aging
endpoint reads an optional `asOf` from the query (validated to the date shape; a
malformed value is ignored and falls back to the clock), so a caller can pull a
back-dated snapshot — the same document ages into different buckets at different
`asOf` dates.

**3. Unrealized FX revaluation at period close (`write-effects.ts`).**
`unrealizedFxRevaluationEffect` fires on a `FiscalPeriod`'s →`closed` edge: it sums
open foreign-currency AR/AP (document total − completed applied payments, by
currency/side), looks up each currency's period-end `ExchangeRate` (latest
`rate_date` ≤ the period `end_date`, foreign→functional), and posts ONE balanced
`<period>-FXREVAL` `JournalEntry` — per currency, an AR/AP control line vs the
**unrealized FX** account, with the correct gain/loss sign (AR up = gain → debit
AR; AP up = loss → debit FX). Functional currency is the tenant's
`defaults.currency`; the unrealized-FX account from a new
`finance.unrealizedFxGainLossAccountCode` setting (codes resolve to real
`LedgerAccount` ids, placeholder fallback). Documented approximation: with no
stored original booking rate, the foreign balance is treated as carried at rate 1
and revalued to the period-end rate. Skips currencies with no eligible rate and
periods with no foreign exposure.

## Consequences

- Verified end-to-end: the aging screen builds and renders AR/AP; `?asOf=2026-03-01`
  vs `2026-12-01` buckets the same invoice as `1-30` vs `90+`; closing a period
  with a €1000 open AR at rate 1.1 posts a balanced FXREVAL entry (debit AR 100 /
  credit unrealized FX 100).
- The finance engine is now fully observable and period-aware: recognition →
  settlement → application → aging (live + historical) → period-close revaluation.
- 6,569 tests pass (+15 aging-handler/FX cases), zero type errors, `operate-web`
  build green.
- Follow-ups: a console screen for the period-close revaluation run; storing the
  per-document booking rate so revaluation compares against the true original rate
  (removing the rate-1 approximation); and an `asOf` control on the aging screen UI.
