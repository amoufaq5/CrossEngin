# ADR-0432: Tax is determined by the rule in force, and a refused create spends no number

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0421 (sequence numbers allocated after validation and before the transaction; the pool deadlock), ADR-0422 (`transactionSettingsScope`), ADR-0423 (references enforced on `--store pg`), ADR-0419 (the guard refusals a create can meet), ADR-0378 (exact tax arithmetic), ADR-0338 (when a refusal may be introduced), ADR-0430 (the job boot surface) |

## Context

The external due-diligence audit ranked **H-15** high and it is three claims in one entry: no tax
localisation or e-invoicing (Egypt ETA, KSA ZATCA, UAE, EU); `TaxRule` and `TaxJurisdiction` read by
nothing; and sequences that are not gapless, with live test L20 showing a refused create spending a
number (`JE-2026-00030` → 422 → `JE-2026-00032`).

Measured before designing:

- **L20 is now partly false.** That 422 was a validation failure, and since ADR-0421 a validation
  422 allocates nothing. What still spent a number was the **guard** refusal and the **id-conflict**
  refusal. On a compiled `erp-core` server in memory, the sequence ok → validation 422 → guard 422 →
  ok → id-conflict 409 → ok stored numbers 1, 3 and 5: the guard refusal burned 2 and the id conflict
  burned 4.
- **The tax claim was true and incomplete.** `TaxRule` and `TaxJurisdiction` were read by no code,
  and `finance.defaultTaxJurisdiction` — which the audit did not mention — was read only by the web
  settings page. Tax posted at the tax code's own rate.

## Decision

**Tax is determined from `TaxRule`s once a tenant names a jurisdiction.** Determination is wired into
Invoice recognition (sales, dated by `issue_date`) and Bill recognition (purchase, dated by
`bill_date`), only when the manifest declares `TaxRule` and `TaxJurisdiction` and a settings store
exists, and it switches on per tenant when `finance.defaultTaxJurisdiction` is set. A tenant without
the setting posts exactly as before.

- A rule in force on the document's date (inclusive bounds, open end allowed) sets its code's rate,
  overriding the code's own rate.
- An uncoded line takes the code of the single `standard` rule in force. Codes whose `TaxCode.kind`
  is `withholding` are never candidates: `rate_category` defaults to `standard`, so a withholding
  rule written with the defaults would otherwise have made every uncoded line ambiguous, or, alone,
  been given to it.
- Reverse charge sets a sales line to 0%; on a bill it posts Dr input tax and Cr self-assessed tax
  payable, which balances, and the self-assessed amount is not counted in the document's tax total.
- A rule whose `rate_pct` is outside 0–100 is unreadable: the declared bound is enforced on no write.
- Every refusal is raised before anything is written:

  | Status | Code | When |
  |---|---|---|
  | 422 | `tax_code_not_applicable` | the line's code has no rule in force, or the code is inactive |
  | 409 | `tax_rule_ambiguous` | more than one rule, or more than one standard code, applies |
  | 409 | `tax_jurisdiction_unresolved` | the setting names no single active jurisdiction |
  | 409 | `tax_rule_unreadable` | a rule row cannot be read (including a rate above 100) |
  | 409 | `tax_reverse_charge_unposted` | a reverse charge has no self-assessment account to post to |
  | 422 | `tax_total_disagrees` | the determined tax does not match the document's tax total |

What the model does not express is not read: `priority` declares precedence but not its direction,
so conflicting rules are refused rather than ranked; `is_compound` is moot with one code per line;
`tax_regime` and the non-standard `rate_category` values are unread.

**A refused create spends no number.** In the create handler the id-conflict check and the write
guards run **before** the number is allocated, outside any transaction — so ADR-0421's pool deadlock
does not return — and both are re-checked inside the write transaction. The tax lookups go through
the transaction's settings snapshot, so ADR-0422's deadlock does not return either. "Is a number
about to be allocated" is one predicate, `isSequenceFieldBlank`, exported from `sequences.ts` and
read by the handler rather than spelled twice.

**E-invoicing is stated as not shipped.** The e-invoicing job description and the `erp-core` pack
description now say no clearance client ships, and the operate-server boot surface already reports
the job as absent (`ERP_JOB_ABSENCES`, ADR-0430). An integration needs, per portal, its own API
client, the tenant's portal registration and signing certificate, the portal's document format
(UBL/Peppol, ZATCA XML with QR and stamp, ETA signed JSON), and storage for the clearance reference.
None of that exists here.

## Alternatives considered

- **Rank conflicting rules by `priority`.** Refused: the field says rules have a precedence and not
  whether higher or lower wins, so ranking would be a guess posted to the general ledger.
- **Allocate the number on the write transaction's own connection.** This is what strict gapless
  numbering needs. Refused for this slice: the allocator is `PostgresSequenceAllocator` in
  `operate-runtime-pg`, which commits on its own pooled connection, and moving it is a store
  contract change outside the slice.
- **Determination behind its own explicit setting.** Not taken; see the regression under
  Consequences, where it is one of the remedies.

## Consequences

- **Positive:** a tenant naming a jurisdiction gets the rate in force on the document's date, and a
  document that cannot be taxed coherently is refused by name with nothing posted. A guard or
  id-conflict refusal no longer leaves a gap.
- **Negative — a regression for tenants who already filled in the setting.** The implementation
  justified switching on through the existing setting as ADR-0338's case, on the premise that the
  setting "previously did nothing". Review refuted the premise: the console settings page has offered
  "Default tax jurisdiction" as a free-text field since commit `3e67a22` (2026-08-17). A tenant who
  typed anything there now gets 409 `tax_jurisdiction_unresolved` on every invoice or bill with
  lines unless the text matches a `TaxJurisdiction` row, and 422 `tax_code_not_applicable` on every
  coded line if it matches a jurisdiction with no rules — where before both posted correctly at the
  code's own rate. That is what ADR-0338's rule forbids. The damage is bounded (nothing is written on
  refusal, the refusal tells the admin to clear the setting, and the cause is per tenant), but there
  is no boot-time hatch and no announcement. This is left open as a decision.
- **Neutral:** six literals in `write-effects.test.ts` gained `selfAssessed: false`, a shape change
  rather than a pinned defect. A credit note mirrors the posted recognition entry line for line, so
  it stays consistent with the determined tax.
- **Reversibility:** clearing `finance.defaultTaxJurisdiction` returns a tenant to the old behaviour;
  removing the wiring in `compile.ts` returns every tenant to it.

## Implementation notes

In process: `operate-runtime` 50 files / 1394 tests, `pack-erp-core` 61, `testing` 796 and
`operate-server` 5675 (run against the rebuilt `operate-runtime`), all passing with clean typechecks.
Thirteen mutations were caught and reversed — ten by the implementer (no guard pre-flight; no
id-conflict pre-flight; code rate instead of rule rate; no total-disagrees refusal; exclusive end
date; self-assessed counted in the tax total; no sales wiring; no reverse-charge account check;
standard rule picked first instead of refusing; inactive code allowed) and three by review (the
withholding exclusion, the 100% bound, the numbering pre-check).

Live, two runs. The implementer's, on PG 16 as the non-owner `serving` role on `--store pg`: 18
invoices across four runs were stored as INV-2026-00001 to 00018 with no gaps, each run including a
validation 422, a guard 422 (`lifecycle_state_not_initial`) and, on reruns, an id-conflict 409. A UK
invoice posted AR Dr 120.00 / revenue Cr 100.00 / tax payable Cr 20.00 at the rule's 20% rather than
the code's 15%; jurisdiction `XX` answered 409 `tax_jurisdiction_unresolved` with the invoice left
`draft` and nothing posted; no jurisdiction posted the old single tax line. The first send in that
run answered 409 `server_reference_unresolved` until the ledger accounts existed (ADR-0423).

The later cross-slice run on PG 16, `--store pg` as `crossengin_app` and `--store pg-columns` as the
owner, identical on both stores: the coded line at code 15 / rule 20 posted 120 / −100 / −20; an
uncoded line took the standard rule's code (tax 10 on 50); `tax_code_not_applicable`,
`tax_total_disagrees` (header 15 against determined 20) and `tax_jurisdiction_unresolved` were each
refused; no jurisdiction posted at face value (tax 15). In its numbering arm the ok → 422 → 422 →
409 → ok sequence read 00001 then 00003 — that report does not attribute the gap — and a separate
run isolated that the guard and id-conflict refusals no longer spend a number. A dangling
`account_id` answered 422 `reference_not_found` and **did** spend one (00010, then 00012), which is
the residual below. The withholding exclusion and the rate bound were verified in process only.

## Open questions

1. **The regression above**: help text on the console field, validating the setting on save, or a
   separate explicit switch for determination.
2. **Strict gapless numbering is not achieved.** A number is still spent by a race between the
   pre-flight and the transaction, a store refusal (a dangling reference, measured live; a unique
   violation), an effect that throws, a failed commit, and deleting a draft. Closing it needs
   allocation on the entity transaction's own connection in `operate-runtime-pg`; legally gapless
   numbering also wants the number assigned at `send` rather than at create, and a record of voided
   numbers needs a persistence seam this slice does not have.
3. An invoice or bill with **no lines** skips determination and posts its header tax at face value
   even with a jurisdiction declared; refusing it would add refusals for the same tenants as (1).
4. The tax total is checked against what the user entered rather than recomputed from the lines, and
   a line with a flat rate is taken as stated.
5. Nothing validates `defaultTaxJurisdiction` when it is saved; the error arrives at `send`.
6. A comment in `handlers.ts` from another lane says posting refusals carry only literals and
   server-chosen values; the tax refusals carry the jurisdiction code, tax code labels, the document
   date and amounts. None is a classified field and all are the caller's own document, so this is a
   stale comment rather than a disclosure.
7. If a reverse-charge code's account and `taxPayableAccountCode` resolve to one ledger account, the
   self-assessed pair posts on that account; it balances, and the guard only refuses when no
   self-assessment account is configured at all.
8. No e-invoicing portal client exists for any jurisdiction.

## References

- `packages/operate-runtime/src/tax-determination.ts`, `write-effects.ts`, `compile.ts`,
  `handlers.ts`, `sequences.ts` (`isSequenceFieldBlank`), `settings.ts`,
  `tax-determination.test.ts`, `tax-and-numbering.test.ts`
- `packages/pack-erp-core/src/jobs-ext.ts`, `pack.ts`, `entities-accounting.ts`
- Audit H-15 and live test L20
