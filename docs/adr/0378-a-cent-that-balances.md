# ADR-0378: A cent that balances

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-20 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0124 (the settlement effects this one's withdrawal is about), ADR-0332 (the decimal wire type), ADR-0337 (the falsely-true-control direction), ADR-0366 (withdraw a retention with its measurement), ADR-0367 (the read ceiling, and the mutation-test rule) |

## Context

Register item P0.6 reads: *"`Currency.decimal_places` has zero readers while the accounting core
hardcodes two."* One hit in the whole workspace — its own declaration — against nine
`Math.round(x*100)/100` sites in `write-effects.ts` and a `0.005` balance tolerance in
`write-guards.ts`.

Two of that item's three clauses do not survive measurement, and the third is sharper than it reads.

**`Currency.decimal_places` is inert and reading it could not change a figure.** No money *amount*
field in any of the seven packs exceeds `scale: 2` — every `total`, `subtotal`, `tax_total`, `debit`,
`credit` and line amount is `decimal(_,2)` — so a 3-decimal currency cannot be *stored* at three
decimals anywhere, and a reader of `decimal_places` would have nothing to round to. The field is a
P1.2-shaped declaration (authored, validated, hashed, read by nobody), not a money defect. It is
recorded as such rather than wired.

**The hardcoded `100` is not the defect either.** It is correct for every declared amount field, and
it is the same choice `packages/billing/src/tax.ts:84` already made — that module computes
`Math.round((input.subtotalCents * rate.ratePercent) / 100)`, in integer minor units, and has done
since it was written.

**The defect is the *rate*.** `computeLineTaxBreakdown` computed a line's tax as
`Math.round(net * (rate / 100) * 100) / 100` — a double times a double — and that is wrong on exactly
one class of input and always in one direction. Measured over **60,000,000** (rate, net) pairs, every
`decimal(6,3)` rate from 0.001 to 30.000 against nets 0.01 to 20.00, the per-line error is **exactly
0 or −1 cent, 764 times under, never over**. The mechanism: when the true tax is an exact half-cent,
half-away-from-zero owes the cent up, and the double sometimes lands a hair below the midpoint, so
`Math.round` takes it down.

That one-directional, one-cent property is what decides which figures were actually reachable, and it
makes the honest finding both narrower and worse than the register's.

### Regular tax: the amount was never wrong, only the account moved

`recognitionGlPostingEffect` accepts the line-derived split only when
`|netTotal + taxTotal − total| <= EPSILON (0.005)` (`write-effects.ts:916`); otherwise it posts the
document's own `subtotal`/`tax_total`, themselves gated against `total` at `:849`. Because no line's
tax can be a cent **high**, a line-derived total that ties to an exact stamped total implies every
line was already exact — no combination of tax codes can compensate for a deficit. So the gate could
not admit a wrong per-code amount, and in both branches the posted regular tax ties to the document.

What *was* wrong is which GL account it landed on. A document whose stamped total was computed
exactly failed a reconciliation against an incorrect line-derived figure, so its **per-code split was
silently discarded** and the tax posted as one aggregate line on the document's default tax account
instead of the TaxCode's own `gl_account_code`.

### Withholding: the one reachable money defect

Withholding is deliberately **not** part of `taxTotal` (`:650`), so a withholding line passes the
reconciliation gate either way and the cent lands unmitigated on two figures:

- `controlAmount = total − withholdingTotal` (`:949`) — the AR/AP control line
- the document's stamped `withholding_total` (`:984`), which `whtCertificateClearingEffect` prefills
  a WHT certificate's amount from

The direction is the bad one: the receivable is **overstated** by a cent and the statutory
withholding figure **understated** by a cent. And the entry **balances** — 0.70 debits against 0.70
credits — which is why no reconciliation gate, write guard or replayer could ever have caught it.
`journalPostingGuard`'s double-entry invariant is satisfied by a wrong set of numbers.

## Decision

**A line's tax is computed in integer minor units, with the rate scaled to an integer too.**

`lineTaxCents(netCents, rate)` scales the rate by `RATE_SCALE = 1000` and divides once:

```ts
const scaled = rate * RATE_SCALE;
const rateScaled = Math.round(scaled);
if (Math.abs(scaled - rateScaled) >= 1e-6) return Math.round((netCents * rate) / 100);
return Math.round((netCents * rateScaled) / (100 * RATE_SCALE));
```

`computeLineTaxBreakdown` accumulates `netTotalCents`, `taxTotalCents` and `withholdingTotalCents` as
integers and divides by 100 once, at the return — so the three `Math.round(x * 100) / 100`
re-roundings on the totals are deleted rather than kept beside integer arithmetic.

Three things about it are decisions rather than mechanics.

**`RATE_SCALE = 1000` is the widest declared scale, and representability is checked rather than
assumed.** Both rate fields that reach this function are covered: `TaxCode.rate_pct` is
`decimal(6,3)` and `InvoiceLine.tax_rate_pct` is `decimal(5,2)`. Scaling every one of their
100,001 + 10,001 declared values deviates from an integer by at most **7.3e-12**, six orders inside
the `1e-6` guard.

**An unrepresentable rate falls back to the faithful cents form rather than truncating.** Truncating
is *not* the conservative failure: `1234.56 @ 0.0625%` truncates to `0.063%` and answers `0.78` where
the exact figure is `0.77` — wrong, and in the **over** direction this change exists to stop. No
declared field can produce a fourth decimal, so the branch is a fence rather than a feature, and it
keeps the rate the caller stated.

**The headline is the mechanism, not a frequency.** Three independent measurements of the same defect
give 1 in 376, 1 in 174 and 1 in 306, because the rate is a property of the (rate, net) population
and not of the code — it swings ~450x between a real-rate rectangle and the full declared rate
domain. The comment records the mechanism and the direction, which are durable, and deliberately not
a rate, which is not.

### P0.6b is withdrawn, with its measurement

Register item P0.6b — *"a document marked paid by hand clears no control account, on three declared
edges"* — is real and its proposed fix is **harmful as specified**. The facts stand: `compile.ts`
wires every GL effect on `triggerState: "sent"` or `"approved"` and **none on `paid`**, while five
declared transitions reach `paid` (`Invoice.mark_paid`, `Bill.mark_paid`, the two timer transitions,
and `TaxReturn.mark_paid`), so a document hand-marked paid leaves its control account uncleared.

What does not survive is the remedy. Re-wiring a residual posting cannot tell *paid with no Payment
rows* from *paid via payment application*, so on the ordinary ordering — hand `mark_paid`, then a
Payment completes — it posts the document's full total on top of what the Payment already settled:
measured **AR net −50.00 / cash +170.00** for an invoice of 120 with a Payment of 50. Silently,
because the entry numbers differ so no unique constraint fires. This is ADR-0366's finding one
increment on: the retention was withdrawn there *with its measurement*, and the same discipline
applies to a proposed addition.

So P0.6b stays open and its register entry carries the refutation and the shape of a correct fix: a
new effect whose predicate is *no completed Payments cover this document*, which is a ledger question
about how two effects share one notion of an open control balance, not a wiring step.

## Alternatives considered

- **Option A: scale only the net to cents (`Math.round((netCents * rate) / 100)`).**
  - **Pros:** one operand integral; it is what `billing/src/tax.ts` does; an independent refutation
    of this increment's design measured it at **0 divergences** and recommended it.
  - **Cons:** measured here at **52 divergences in 1.8M real-rate pairs** — `12.50 @ 2.28%` answers
    0.28 where the exact figure is 0.29.
  - **Why not:** the refutation's rate population evidently did not include a 3-decimal rate; mine
    did. A recommendation backed by a measurement is still only as wide as its population, so the
    broader sweep decides. Kept as the **fallback** branch, where its imprecision is strictly better
    than a truncated rate's wrongness.

- **Option B: read `Currency.decimal_places` and round to it.**
  - **Pros:** closes the register item as written; the field stops being inert.
  - **Why not:** no money amount field in any pack exceeds `scale: 2`, so there is nothing for it to
    change — a 3-decimal currency's minor unit cannot be stored. It would be a reader with no effect,
    which is the P1.2 shape rather than a fix for it. The field's own problem is a schema question.

- **Option C: widen `EPSILON` so the reconciliation gate stops flipping on a cent.**
  - **Pros:** the account-moving behaviour change in existing data disappears.
  - **Why not:** the gate's job is to refuse a split that does not reconcile. Widening it would
    accept a breakdown that disagrees with the document by more than a rounding artefact — buying
    stability by weakening the one check that was doing its job. With the arithmetic correct, the
    gate now fails exactly on documents whose stamped total is wrong, which is the gate working.

- **Option D: a decimal library (`decimal.js`, `big.js`).**
  - **Pros:** correct by construction for every scale; no representability guard; no 2^53 bound.
  - **Why not:** a runtime dependency in `operate-runtime`, which has none, for a problem whose
    operand scales are **declared** — so the scaled-integer form is exact over the whole declared
    domain and the bound is provable. It would also diverge from `billing/src/tax.ts`, leaving two
    money idioms in one repo.

- **Option E: fix the per-line rounding and leave the totals accumulating as major-unit doubles.**
  - **Pros:** a strictly smaller diff; the per-line rounding is the entire *live* defect.
  - **Why not:** measured, summing 2-dp doubles and rounding once first disagrees with an integer sum
    at **10^6 lines of ~1000 units** — unreachable, but the asymmetry is the wrong way round: keeping
    three `Math.round(x * 100) / 100` re-roundings beside integer arithmetic is a second idiom in one
    function, and the integer accumulation costs nothing. Taken as belt-and-braces, and recorded as
    such rather than claimed as the fix.

## Consequences

- **Positive:** the withholding figure a WHT certificate is prefilled from, and the control amount a
  customer is billed, are exact. A correctly-totalled document keeps its per-code tax split, so tax
  reaches the TaxCode's own GL account instead of the document default. One money idiom in the repo.

- **Negative, and stated precisely:** the reconciliation gate's verdict moves for documents sitting on
  the knife edge, and it moves in **both** directions. A document whose stamped total was computed
  exactly now has its split **accepted** where it was discarded; a document whose stamped total was
  computed with the old arithmetic now has it **discarded** where it was accepted. Measured live, B
  and C below are an exact swap: **the amount is identical in both and only the account moves**, so
  the behaviour change for existing data is which GL account a tax line lands on, never a figure.
  Nothing in the workspace computes `tax_total` — it is a declared field with a literal default of 0
  and no in-repo producer — so there is no second site to fix in step.

- **Bounded:** exact while `netCents * rateScaled` stays inside 2^53, i.e. to ~900.7e6 major units at
  the declared maximum rate of 100%; past that it degrades to measured-good rather than proved.

## Verification

**Offline.** 5 new boundary tests. The **952 pre-existing `write-effects` tests are
assertion-neutral** to the change, because every existing fixture uses a round net against a round
rate — which is the honest statement of why 20k tests never saw this. Mutation-checked by restoring
the double form: **4 of the 5 new tests fail and none of the 952 do**; the fifth guards the
unrepresentable-rate fallback the mutation does not touch. The mutation was reversed by the inverse
string replacement, never `git checkout --` (ADR-0367).

The oracle is an independent BigInt rational over the operands' declared scales —
`round_half_up(n/d) = (2n + d) / (2d)` floored — rather than a re-derivation of the code under test
(ADR-0362's retired truth table).

**Live.** Throwaway PG 16.13, catalog applied (964/964 statements, 0 failed), served as the
**non-owner** role `serving` on `--store pg --pack erp-core`, real HTTP with an `erp_admin` api-key,
before and after on the same cluster.

| A. withholding, 0.70 net @ 5% WHT | AR control | WHT line (2155) | stamped `withholding_total` | balance |
|---|---|---|---|---|
| before | **D 0.67** | D 0.03 | `"0.03"` | 0.70 = 0.70 |
| after | **D 0.66** | D 0.04 | `"0.04"` | 0.70 = 0.70 |

| B. 13.40 @ 7.5%, total stamped at the exact 14.41 | tax line | account |
|---|---|---|
| before | C 1.01 | `tax_payable` — document default, split discarded |
| after | C 1.01 | `2210` — the TaxCode's own `gl_account_code` |

| C. same, total stamped with the old arithmetic at 14.40 | tax line | account |
|---|---|---|
| before | C 1.00 | `2210` — the code's own account |
| after | C 1.00 | `tax_payable` — document default, split discarded |

The live path also exercises something the unit tests cannot: `rate_pct` crosses the wire as the
string `"5.000"` (ADR-0332's decimal wire type), so the rate reaches `lineTaxCents` through `num()`'s
parse rather than as a literal.

## Open questions

1. **P0.6b: nothing posts on a document's own `→paid` edge**, on five declared transitions, and the
   obvious fix is measured harmful (above). A correct one needs an effect whose predicate is *no
   completed Payments cover this document*, which means the settlement effects and the residual
   effect sharing one notion of an open control balance.

2. **Arithmetic is still `double` arithmetic everywhere else.** `num()` returns a number and the
   reports' totals are `readonly total: number`, so summing scale-2 amounts still drifts in
   `aging.ts`, `wht-reconciliation.ts` and the FX revaluation. This increment fixed the one site that
   *multiplies*; the sites that *add* are a wider change and their drift needs the same
   60-million-pair treatment before anyone claims a figure for it.

3. **`fx_rate: 1` is hardcoded at every surviving GL posting site** (ADR-0366 measured the proportion
   at 100% after its deletions), so a foreign-currency document's functional amounts equal its
   transaction amounts. Independent of rounding and larger.

4. **`type.min`/`type.max` are enforced by nothing** — `rate_pct` declares `min: 0, max: 100` and
   `FieldErrorCode` has no range member — so a rate outside the declared domain is storable and the
   representability guard is what stands between it and a wrong figure. Register P1.2's shape inside a
   money column (ADR-0367's open end 6).

5. **`Currency.decimal_places` remains inert**, and closing it honestly is a *schema* increment: the
   amount fields would have to carry a scale the currency decides, which reaches `resolvedFields`,
   the DDL emitter and both stores. Recorded rather than wired.

6. **The `group.tax <= EPSILON` skip at `:970` is now provably dead**, since an integer-cents group is
   either 0 (excluded from the totals as well) or at least 0.01. It was dead before too — the old form
   also produced multiples of 0.01 — so this is a latent condition made legible, not a change.
