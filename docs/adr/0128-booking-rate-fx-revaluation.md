# ADR-0128: Captured booking rate — exact unrealized FX revaluation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0127 (unrealized FX revaluation), ADR-0124 (settlement + realized FX), ADR-0107 (fiscal periods) |

## Context

ADR-0127 shipped unrealized FX revaluation at period close but with a documented
approximation: with no stored original booking rate, each open foreign-currency
balance was treated as carried at rate 1 and revalued to the period-end rate. That
overstates (or understates) the revaluation by the entire historical rate — a
€1000 AR booked at 1.10 and revalued to 1.20 should move 1000×(1.20−1.10) = 100
functional, not 1000×(1.20−1) = 200. This ADR removes the approximation by
capturing each document's foreign→functional rate at recognition and revaluing
against it.

## Decision

**1. Stamp the booking rate at the recognition edge (`bookingRateStampEffect`).**
A new write-effect in `write-effects.ts` fires on a document's recognition
transition (Invoice →`sent`, Bill →`approved`), looks up the foreign→functional
`ExchangeRate` effective on the document date (latest `rate_date` ≤ the date, via
the shared `lookupPeriodEndRate`), and stamps it onto a `booking_rate` field. It
is a no-op when the document is already in the functional currency, when the rate
is already stamped, or when no eligible rate exists — so it never overwrites a
captured rate and never invents one. Configurable: entity, trigger state, date
field, currency field, functional-currency resolver, and the
`Currency`/`ExchangeRate` field mapping.

**2. `booking_rate` fields.** `Invoice` and `Bill` each gain an optional
`booking_rate` decimal (precision 20, scale 10) — the rate at which the document
was carried into the books. Absent (legacy rows, functional-currency documents) it
falls back to the period-end rate, preserving ADR-0127 behavior for un-stamped
data.

**3. Revalue against the captured rate (`unrealizedFxRevaluationEffect`).** The
period-close effect now accumulates each open balance's booked functional value
(`bookedByCurrencySide`, summed from `open × booking_rate`) alongside the open
foreign amount, and computes the revaluation delta as
`open × periodEndRate − booked` rather than `open × (periodEndRate − 1)`. The
posted `<period>-FXREVAL` entry is unchanged in shape (one balanced AR/AP-vs-
unrealized-FX pair per currency, gain/loss sign from the delta); only the
magnitude is now exact.

**4. Wiring (`compile.ts`).** `defaultWriteEffects` derives a `functionalResolver`
from the tenant's `defaults.currency` and, gated on the manifest carrying both
`Currency` and `ExchangeRate`, registers `bookingRateStampEffect` for Invoice
(`issue_date`) and Bill (`bill_date`) ahead of the existing recognition/settlement
effects.

## Consequences

- Verified end-to-end: issuing a €-denominated invoice at a 1.10 period rate stamps
  `booking_rate = 1.1`; closing a later period at 1.20 with €1000 still open posts a
  balanced FXREVAL of 1000×(1.20−1.10) = **100** functional (debit AR 100 / credit
  unrealized FX 100) — the exact revaluation, not the rate-1 overstatement of 200.
- The rate-1 approximation is gone for newly recognized documents; legacy/un-stamped
  rows degrade gracefully to the prior behavior.
- 6,573 tests pass (+ booking-rate stamp + revaluation cases), zero type errors,
  full workspace build green.
- Follow-ups (unchanged from ADR-0127): a console screen for the period-close
  revaluation run; an `asOf` control on the aging screen UI; line-level tax codes.
