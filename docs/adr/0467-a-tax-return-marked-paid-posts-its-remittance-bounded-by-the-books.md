# ADR-0467: A tax return marked paid posts its remittance, typed and bounded by the books, per tenant and opt-in

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-24 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0466 (open question 1, closed here), ADR-0465 (withholding accounts, starter chart), ADR-0391 (settlement coverage), ADR-0367 (no record values in refusal details; drains with ceilings), ADR-0421 (server-owned fields), ADR-0422 (transition races, the settings deadlock), ADR-0423 (reference refusals on both stores), ADR-0428 (entity audit), ADR-0429 (accounting reversals, the period lock), ADR-0440 (`column-schema`) |

## Context

ADR-0466 left one question open: nothing posts the remittance of output, input or withheld tax to
the authority. `TaxReturn.mark_paid` changed only the state; `output_tax`, `input_tax` and
`net_payable` were typed by whoever prepared the return and read by nothing, and the deployment
documents told an operator to post the remittance as a manual journal entry and then mark the
return paid. Before building it, five measurements were taken against the committed tree.

1. **The return.** `TaxReturn` carries the three figures, a `return_type` over five values (`vat`,
   `gst`, `consumption_tax`, `sales_tax`, `withholding`), a required `fiscal_period_id`,
   `period_start`/`period_end`, a `currency` defaulting to `USD`, and no `total`. `net_payable` has
   no minimum, so a credit position is representable; `paid` was terminal, so a return marked paid
   in error had no way back, and a return with a negative net could be filed and never reach
   `paid` honestly.
2. **The ledger.** Output tax credits 2200, input tax debits 1300, withholding credits 2210, and no
   line carries a tax point, a jurisdiction or a tax code. Every effect dates its entry with the
   server's today while the rate follows the document's own date. `taxAccountsByJurisdiction` is
   keyed by the free-text `TaxCode.jurisdiction` and is shared by invoice and bill recognition, so a
   mapped jurisdiction's output and input tax land in one account. Manual remittances, made as
   ADR-0466 instructed, already sit in the same accounts.
3. **The payment route.** A `Payment` cannot reference a return, and adding `tax_return_id` alone
   makes things worse (probe F: an outbound payment debits accounts payable, not 2210, and settles
   nothing). Making it right needs a reference-keyed control account, a separate VAT netting
   posting because a partial payment cannot split 2200 and 1300, an application instance, a
   coverage entry, an amend-while-settled refusal, and a role decision — `tax_manager` can neither
   create nor complete a `Payment`, and `ap_clerk` cannot read a return. The same probes surfaced two
   pre-existing defects on invoices and bills (an outbound payment settling an invoice while
   debiting AP, and one payment settling both an invoice and a bill).
4. **Tax machinery.** The figures cannot be derived from the ledger for a period: the tax point is
   not on the line, credit notes and reversals land in the period of the reversing act, jurisdictions
   sharing an account cannot be separated, reverse charge posts an equal pair into the same entry,
   and a balance-as-at-`period_end` derivation is a lifetime read that passes the FX precedent's
   100,000-row ceiling for a busy tenant within about a year.
5. **The posting machinery.** An effect on entering `paid` is race-safe through `updateIf`
   (ADR-0422), can post through `createPostedEntry` with the period lock (ADR-0429), can resolve
   accounts and refuse with ADR-0423's 409, and `postingReversalEffect` already mirrors an entry by
   a number field — with `sourceSuffix: ""` working, verified. `kernel/workflow/validate.ts` refuses a
   transition leaving a terminal state, so `paid` has to stop being terminal.

## Decision

**The figures are typed; marking a return paid posts them as one remittance entry, bounded by each
tax account's current balance; and the posting is per tenant and off by default.**

| Question (ADR-0466 open question 1) | Decision |
|---|---|
| Typed or derived amounts | **Typed**, checked for internal coherence when the return is filed and again when it is marked paid, and bounded at `mark_paid` by the current balance of each tax account a leg clears. Not derived, for measurement 4's reasons. |
| An effect on `mark_paid`, or a `Payment` | **An effect on `TaxReturn → paid`**, posting one entry. `Payment` is unchanged. |
| Settlement coverage for `TaxReturn` (ADR-0391) | **No.** A return settles through its own posting; the boot survey says so instead of recommending a Payment reference. |
| Supplier-side WHT certificates | **Out of scope.** Clearing 2210 does not need one. |
| *(new)* Who gets the posting | **A tenant that sets `finance.taxRemittancePosting = on_mark_paid`.** Absent means `manual_journal`, today's behaviour. Only a new workspace, approved from an access request with the starter chart, is given `on_mark_paid` without its admin, and only when it declares a default currency and holds no `filed` or `amended` return and no `paid` return without a recorded remittance. The console's starter-chart run on an existing workspace never sets it (`skipped_existing_tenant`), because that workspace may be journalling its remittances by hand. |

The per-tenant mode is what makes the decision safe to ship. ADR-0466 told operators to post the
remittance as a manual journal *and then* mark the return paid, so posting on every deployment
silently would post each of those remittances a second time; and the refusals below would otherwise
break `file` and `mark_paid` calls that work today for tenants the posting cannot serve.

### The posting

With O = `output_tax`, I = `input_tax`, N = `net_payable` in bigint ledger units, and the accounts
resolved from `finance.taxPayableAccountCode` (OUT), `taxInputAccountCode` (IN),
`whtPayableAccountCode` (WHT) and `cashAccountCode` (CASH), with no literal fallbacks:

| `return_type` → shape | Figures | Lines (a zero line is dropped; all zero posts no entry) |
|---|---|---|
| vat, gst, consumption_tax, N ≥ 0 | O, I ≥ 0, N = O − I | Dr OUT O · Cr IN I · Cr CASH N |
| the same, N < 0, `credit_disposition = refund_received` | as above | Dr OUT O · Dr CASH \|N\| · Cr IN I |
| the same, N < 0, `credit_disposition = carried_forward` | as above | Dr OUT O · Cr IN O (the remaining \|N\| stays in IN) |
| sales_tax | I = 0, N = O ≥ 0 | Dr OUT O · Cr CASH O |
| withholding | O = 0, I = 0, N ≥ 0 | Dr WHT N · Cr CASH N |

The entry is numbered `<return_number>-REMIT-<n>`, `n` being the stored `remittance_count` plus one,
so the first is `TAX-2026-00001-REMIT-1`; `source` is `system`, the date is the server's today and
the period lock applies (`period_locked`). The header carries **no `currency` key** — `JournalEntry`
does not declare one, and an undeclared key is kept by `--store pg` and dropped by `pg-columns` —
and the lines are in the functional currency at rate 1, which is why a return in any other currency
is refused rather than posted. After posting, the effect stamps `remitted_at`,
`remittance_entry_number` and `remittance_count + 1`; a nil return stamps `remitted_at` and an empty
`remittance_entry_number`, so no earlier payment's number can be read as this one's.

### `reverse_payment`

`TAX_RETURN_LIFECYCLE` has no terminal state now and gains `reverse_payment` (`paid → filed`),
granted to the same roles as `mark_paid`, and the wiring requires it, so a manifest that can post a
remittance can always undo one. It posts the mirror entry (`…-REMIT-1-REV`) through
`postingReversalEffect`, then clears `remitted_at` **and `remittance_entry_number`**, keeping only the
count, so the next payment is `-REMIT-2` rather than a number a reversal already answers for. The
number is cleared because it names the current payment's entry: a later `mark_paid` that posts
nothing (a nil return, or `manual_journal` mode) writes no new one, and a stale number left behind
made the next `reverse_payment` find the reversed entry and refuse `tax_remittance_already_reversed`
for ever — a return stuck in `paid`, measured by review before this text was written.

A return with no entry to mirror moves and posts nothing — a nil return, which carries the
`remitted_at` stamp, and any return in a tenant on `manual_journal`. One case is refused instead: in
`on_mark_paid` mode, a return marked paid with no remittance posted here and no stamp — paid before
the upgrade or while the tenant was on `manual_journal` — is refused
`tax_remittance_paid_outside_posting`, because its remittance was a manual journal, the reversal
would undo nothing, and its next `mark_paid` would post the same period a second time. The remedy is
to set the tenant back to `manual_journal`, reverse the return, and reverse that journal by hand.

Reversing the remittance entry directly through `JournalEntry.reverse` is refused while its return
is `paid` (`tax_remittance_reverse_via_return`), because it would leave the return reading `paid`
against a reversed ledger, which is ADR-0391's divergence in a new place. Reversing a remittance's
*reversal* (`…-REMIT-1-REV` → `…-REV-REV`) is refused too (`tax_remittance_reinstate_via_return`)
whenever the return it names exists: it would re-apply a remittance while the return reads `filed`,
and the return's own `mark_paid`, which posts a new numbered entry, is the route.

### The rule

**Post exactly the declaration, bounded by the books; refuse what cannot be cleared correctly.** A
typed figure is the preparer's statement of what was remitted, and the ledger cannot recompute it;
what the server can do is check that the statement is internally coherent and that it does not
clear more from an account than the account holds, and refuse it when the tenant's configuration
cannot place it in the right accounts.

### Refusals

Every detail is a literal or a server-chosen key, never a record value or a ledger figure — a
`tax_manager` holds no ledger grant, so a balance in a 409 would be a disclosure (ADR-0367). Every
refusal is raised before the first write.

**Figures** (at `file`, `refile` and `mark_paid`, `on_mark_paid` mode only), all 422:
`tax_return_type_unsupported`, `tax_return_figures_invalid` (unreadable, or O or I negative),
`tax_return_figures_disagree` (the shape's equations do not hold), `tax_return_withholding_negative`,
`tax_return_credit_disposition_required` (a credit-invoice return with N < 0 and no disposition),
`tax_return_credit_disposition_unexpected` (a disposition on any other return, or outside the enum),
`tax_return_period_invalid`.

**Configuration** (at `mark_paid`; the currency checks also at `file`), all 409:
`functional_currency_undeclared` (no `defaults.currency`, which closes the rate-1 hazard);
`tax_return_currency_not_functional`; `tax_remittance_account_unresolved`, naming the `finance.*`
key; `tax_remittance_routing_unsupported` — the tenant has any `taxAccountsByJurisdiction` entry, or
a regular `TaxCode` with its own `gl_account_code`, or a withholding `TaxCode` whose
`gl_account_code` is not `whtPayableAccountCode`, because one remittance cannot clear tax routed to
several accounts.

**State**, all 409: `tax_return_period_overlaps` (at `file`, `refile` and `mark_paid`: another
`filed`, `amended` or `paid` return of the same type and jurisdiction overlaps the
`[period_start, period_end]` range, checked under an exclusive lock on the jurisdiction row, with the
return then the jurisdiction as the lock order); `tax_remittance_number_taken`;
`tax_remittance_already_reversed`; `tax_remittance_paid_outside_posting`;
`tax_remittance_reverse_via_return`; `tax_remittance_reinstate_via_return`; and `posting_ambiguous`
when more than one journal entry carries the remittance's number, or more than one return names one
entry.

**Ledger bound** (at `mark_paid`), 409: `tax_remittance_exceeds_ledger` when a clearing leg — Dr
OUT, Cr IN, Dr WHT — exceeds the account's balance on its normal side, read over posted and reversed
entries in the functional currency (transaction amounts where a line is in the functional currency,
functional amounts otherwise); and `tax_ledger_unconverted` when a foreign-currency line carries a
transaction amount and no functional amount, so the balance cannot be read. The drain is bounded at
200,000 lines per account and refuses past it as `read_ceiling_exceeded` (500).

The bound is a read followed by a write, so two returns clearing one account from **different**
jurisdictions — which the jurisdiction lock does not serialise — could each read the same balance
and together clear more than it held. Before reading any balance the effect takes an exclusive
(`FOR NO KEY UPDATE`) lock on every `LedgerAccount` a non-zero leg clears, in account-id order so
two such payments cannot deadlock. The lock is compatible with ADR-0423's `FOR KEY SHARE` reference
check, so ordinary postings to those accounts are not blocked by it; for the same reason it does not
serialise a concurrent **manual** journal against the account, which can still land between the read
and the write.

### Gating, on both stores

- **Manifest**: nothing posts unless `taxRemittanceWiring(manifest)` is non-null — the six entities,
  every required field and every stamp declared, a lifecycle state field, transitions into `filed`
  and `paid`, and a `reverse_payment` transition from `paid` to `filed`. Without the last, a manifest
  would register the posting and the journal-reverse guard and no undo, so a remittance posted in
  error could be reversed by neither route. `taxRemittanceUnwiredReasons` names what is missing and is `[]` exactly when
  the wiring is non-null, so the effect gate, the settlement survey and the boot line are three
  readers of one predicate.
- **Tenant**: no new refusal and no posting unless the mode is `on_mark_paid`.
- **Row**: a reversal posts a mirror only when the row carries a posted `remittance_entry_number`.
- **Both stores**: every stamp is declared and server-owned (ADR-0421), the header carries only
  declared keys, and there is no enum change.

The boot prints `[tax-remittance] wired: TaxReturn.mark_paid posts when a tenant sets
finance.taxRemittancePosting=on_mark_paid (default manual_journal)` or `[tax-remittance] unwired:
<reasons>` (a warning when the manifest declares a `TaxReturn`), and each tenant's own activated
manifest prints its line through `onSurvey` only when it declares a `TaxReturn` and cannot post. The
`[settlement]` survey reports `TaxReturn` under its own mechanism — *settled by its own posting* —
or as `tax_remittance_unwired` with the same reasons, and never with the Payment-reference remedy.

## Alternatives considered

- **A `Payment` referencing the return.**
  - **Pros:** reuses settlement, refunds and the coverage guard; allows partial payment.
  - **Cons:** measured harmful on its own (probe F: AP debited, nothing settled); needs a
    reference-keyed control account for inbound and outbound, a separate VAT netting posting
    because a partial payment cannot split 2200 and 1300, an application instance, a coverage entry
    whose detail would disclose applied payments to `tax_manager`, an amend-while-settled refusal,
    and a direction guard that does not exist for invoices or bills either.
  - **Why not:** seven pieces to make a route correct that the role model already forbids to the
    role that files the return.
- **Derive the figures from the period's ledger.**
  - **Pros:** no typed figure to trust.
  - **Cons:** the ledger carries no tax point, no jurisdiction and no tax code; credit notes land in
    the reversing period; manual remittances sit in the same accounts.
  - **Why not:** the derivation would be wrong in ways the server cannot detect, which is worse than
    a typed figure it can bound.
- **Bound by the balance as at `period_end` rather than the current balance.**
  - **Pros:** absorbs later activity.
  - **Cons:** still a lifetime read, and still wrong on tax point and shared accounts.
  - **Why not:** the current balance answers the one question the bound exists for — does this clear
    more than the account holds — and is the same read.
- **A `supplements_return_id` for a supplementary return.**
  - **Why not:** verified bypassable and undefined; the overlap refusal blocks a second return for a
    covered period instead, and a real additional payment stays a manual journal (open question 1).
- **Match routing by jurisdiction key.**
  - **Why not:** verified wrong — `taxAccountsByJurisdiction` is keyed by the free-text
    `TaxCode.jurisdiction`, not `TaxJurisdiction.code`, so any entry at all is refused instead.
- **Post on every deployment, with no per-tenant mode.**
  - **Why not:** every remittance already journalled as ADR-0466 advised would be posted a second
    time, and working `file` and `mark_paid` calls would start refusing.

## Consequences

- **Positive:** a remittance has a posting; a tax return marked paid in error can be reversed; a
  credit position can reach `paid` by refund or carry-forward; the boot and the settlement survey
  stop recommending a Payment reference for a return.
- **Negative:** four new `TaxReturn` columns are standing work on `--store pg-columns`
  (`column-schema`); `mark_paid` now performs a ledger read proportional to each tax account's
  history; an older binary refuses a finance document carrying the new setting.
- **Neutral:** an existing tenant behaves exactly as before until its admin sets the mode; the
  starter chart sets it only for a new workspace's approval. In `on_mark_paid` mode a return paid
  outside the posting can no longer be reversed until the tenant is switched back.
- **Reversibility:** setting the mode back to `manual_journal` stops posting at once; entries
  already posted stay and can be reversed with `reverse_payment` while their return is `paid`.

## Implementation notes

- `packages/pack-erp-core`: `TAX_RETURN_ENTITY` gains `credit_disposition` (no default),
  `remitted_at`, `remittance_entry_number` (`indexed`) and `remittance_count`; `TAX_RETURN_LIFECYCLE`
  has no terminal state and gains `reverse_payment`; a fence asserts `ERP_EXT_TRANSITIONS` equals
  each lifecycle's transitions.
- `packages/operate-runtime/src/tax-remittance.ts`: the pure contract — shapes, `planTaxRemittance`,
  the refusal map, `taxRemittanceWiring` and `taxRemittanceUnwiredReasons`, `taxRemittanceEntryNumber`.
  `settings.ts` adds `taxRemittancePosting` and `taxRemittancePostingMode`; `starter-chart.ts` fills
  the mode under the chart's locked read-modify-write only when its caller passes the required
  `requestRemittancePosting: true`, and reports `remittancePosting` (`filled` / `already_set` /
  `skipped_existing_tenant` / `skipped_returns_outstanding` / `skipped_functional_currency_undeclared`
  / `skipped_unwired`, or `null` when the run ended before the settings write). A `paid` return with
  no `remitted_at` counts as outstanding, and the outstanding read refuses past 1,000 rows by counting
  as outstanding.
- `CompiledOperateServer.taxRemittance` (and the HTTP server's getter) exposes the wiring of the
  manifest a server compiled, so a caller provisions a tenant against the manifest that serves it.
- `packages/operate-runtime` `write-effects.ts`, `write-guards.ts`, `compile.ts`: the filing check,
  the posting effect, the reversal check, the stamp clear and the journal-reverse guard, registered
  in that order; the three stamps pushed as server-owned; the `paid` noun and correction hint on the
  locked-document guard. Settings are read only through the injected settings scope (ADR-0422).
- `apps/operate-server`: `settlement-coverage-survey.ts` gains the `own_posting` mechanism and the
  `tax_remittance_unwired` gap, and its headline counts the two mechanisms separately (*N of M
  payment-settled guarded; K of L settled by its own posting wired (per tenant)*), because summing
  them read "3 of 3 covered" on a deployment whose only guarantee was the two payment guards;
  `node.ts` prints the `[tax-remittance]` line at boot and per tenant, and the starter-chart
  provisioner passes the serving manifest's wiring and `requestRemittancePosting` — `true` from the
  access-request approval, `false` from the console route.
- `deploy/README.md` (*Upgrading to tax remittance posting*) and `deploy/GO-LIVE.md` carry the
  upgrade steps, the posting table and every refusal's remedy.

## Verification

Verified live on 2026-11-24 on PG 16. The API ran the shipped compose `command:` and connected as
`crossengin_app` (`NOSUPERUSER NOBYPASSRLS`, owning nothing). Every arm ran on both `--store pg`
and `--store pg-columns`, after `document-indexes` and, for the column store,
`column-schema --grant-to crossengin_app`. Each store had its own approved workspace, and each ran
31 checks with 0 failures. Balances were read as the owner. After the first remittance they were also
read as `crossengin_app` under the tenant's context, and the two readings matched.

1. An access request approved with `defaultCurrency: USD` reports the starter chart `complete` and
   `remittancePosting: "filled"`. The tenant's settings then read
   `finance.taxRemittancePosting = on_mark_paid`.
2. The ledger was seeded with an invoice (tax 160) and two bills (input tax 140, and withholding 30 on
   a coded line): 2200 −160, 1300 +140, 2210 −30. A VAT return O 120 / I 20 / N 100 went through
   `mark_ready`, `file` and `mark_paid`. It posted `TAX-2026-00001-REMIT-1` as exactly Dr 2200 120 /
   Cr 1300 20 / Cr 1000 100 and set the stamps (`remittance_count` 1). A client `PATCH` of
   `remittance_count` is 422 `field_server_owned`.
   - Each transition writes one audit row (`taxReturn.mark_paid` and the others). The journal entry
     the effect creates writes none, which is the open item below.
3. A withholding return with N 30 posted Dr 2210 30 / Cr 1000 30.
4. Negative returns:
   - With N −50 and no disposition, `file` is 422 `tax_return_credit_disposition_required`.
   - With `refund_received`, it posted Dr 2200 30 / Dr 1000 50 / Cr 1300 80.
   - A `carried_forward` return (O 10 / I 40 / N −30) posted Dr 2200 10 / Cr 1300 10.
   - After the four remittances the balances were 2200 0, 1300 +30 (the credit carried forward),
     2210 0 and 1000 −80.
5. A sales-tax return with I ≠ 0 is 422 `tax_return_figures_disagree` at `file`.
6. An O 5000 return against 40 in 2200 is 409 `tax_remittance_exceeds_ledger`. It stays `filed` and
   no entry is written.
7. With `finance.taxAccountsByJurisdiction` set, `mark_paid` is 409
   `tax_remittance_routing_unsupported`.
8. With `cashAccountCode` removed, it is 409 `tax_remittance_account_unresolved`, naming
   `finance.cashAccountCode`.
9. Currency:
   - A EUR return on the USD tenant is 409 `tax_return_currency_not_functional` at `file`.
   - With `defaults` removed, `mark_paid` is 409 `functional_currency_undeclared`.
10. With the current FiscalPeriod closed, `mark_paid` is 422 `period_locked` naming the posting date,
    and the return stays `filed`.
11. A second VAT return for the same jurisdiction, with a period overlapping the first, is 409
    `tax_return_period_overlaps` at `file`.
12. Concurrency:
    - Ten concurrent `mark_paid` calls on one return: one 200, nine 409, and one entry.
    - Two returns in **different jurisdictions** each clear 15 against 20 in 2200 at the same time
      (the review's race, finding A). One is 200 and the other 409 `tax_remittance_exceeds_ledger`,
      and 2200 never goes into debit.
13. Reversal:
    - `JournalEntry.reverse` on the paid return's remittance entry is 409
      `tax_remittance_reverse_via_return`.
    - `reverse_payment` is 200: it posted `-REMIT-1-REV` as the exact mirror (Dr 1000 100 /
      Dr 1300 20 / Cr 2200 120), moved the return to `filed` and nulled `remitted_at`.
    - `amend`, `refile` and `mark_paid` then posted `-REMIT-2`, with `remittance_count` 2.
    - Reversing the `-REV` entry directly is 409 `tax_remittance_reinstate_via_return`.
14. With the setting removed, a `mark_paid` is 200 with no entry and no stamp, which is the default
    `manual_journal` path. The boot line reads `[tax-remittance] wired: … (default manual_journal)`,
    and the `[settlement]` line reads "2 of 2 payment-settled guarded; 1 of 1 settled by its own
    posting wired (per tenant)".
15. **Not run live.** The unwired line and no posting for a tenant manifest without the stamp fields
    are covered by `compile.test.ts`, `settlement-coverage-survey.test.ts` and the `node.test.ts`
    fences, not by a booted per-tenant manifest.
16. The invoice and bill entries present before the first remittance read back line-for-line
    identical after every arm (`INV-…-AR`, `BILL-…-GL` ×2). `verify-chain --tenant` exits 0 with
    125–127 signatures valid.

The run also caught two harness errors, both mine and neither in the product.
- The column store needs `column-schema --grant-to crossengin_app`. Without it the API refused to
  boot and named the flag.
- The journal-entry route is `/v1/journal-entrys` (register P3.9).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A supplementary or additional payment for a paid period: the overlap refusal blocks a second return, so it stays a manual journal; `reverse_payment` is for a remittance recorded in error. A delta-return model is a separate decision. | platform | open |
| Mapped jurisdictions and per-code accounts are refused, not served; serving them needs a jurisdiction or tax-code dimension on `JournalLine`. | platform | open |
| Routing is checked against the current configuration only, so tax routed through a mapping later removed is invisible to the check. | platform | open |
| The ledger bound reads each tax account's whole history; a tenant with more than 200,000 lines on one tax account cannot use posting mode until a checkpointed balance exists. | platform | open |
| Tax point versus posting date, and cash-basis withholding. | platform | open |
| A filing currency other than the functional currency, at the authority's rate. | platform | open |
| No payment date, partial payment, penalties or interest, because a transition takes no body. | platform | open |
| Supplier WHT certificates. | platform | open |
| Roles: `tax_manager` posts cash through the effect without a ledger grant (as other effects do); `reverse_payment` is not approve-class; ADR-0433's editor residual still applies. | platform | open |
| No audit row for the entry the effect creates (ADR-0428's open item). | platform | open |
| Payment defects C (an outbound payment settles an invoice while debiting AP) and D (one payment settles both an invoice and a bill), measured while scoping this, are pre-existing and recorded in CLAUDE.md's register as P2 items 20 and 21. | platform | open |
| A return reversed while the tenant is on `manual_journal` carries no marker saying its remittance was journalled, so if the tenant then switches to `on_mark_paid` without reversing that journal, marking the return paid posts the period a second time; the ledger bound catches it only when no later tax has refilled the accounts. | platform | open |
| `tax_remittance_already_reversed` is reachable only from an entry reversed outside this server (the guard refuses the journal entry's own `reverse` for a paid return); such a return cannot leave `paid` by any route, and its correction is a manual journal. | platform | open |
| The `LedgerAccount` lock does not serialise a concurrent manual journal against a tax account, so the ledger bound is exact only against other remittances. | platform | open |
| A caller can create a journal entry numbered like a remittance (`…-REMIT-n`), which surfaces later as `tax_remittance_number_taken` rather than being refused at create. | platform | open |
| Three spellings of "jurisdiction" (`TaxCode.jurisdiction` free text, `TaxJurisdiction.code`, the return's `jurisdiction_id`); converging them is a pack or kernel change. | platform | open |
| The settlement survey's operand check reads the total as `total`, not the coverage declaration's `totalField`, so a document declared with another total field would be reported `no_total_field` while a guard is built. No document is in that state today. | platform | open |

## References

- `packages/pack-erp-core/src/entities-accounting.ts`, `workflows-ext.ts`
- `packages/operate-runtime/src/tax-remittance.ts`, `settings.ts`, `starter-chart.ts`,
  `write-effects.ts`, `write-guards.ts`, `compile.ts`
- `apps/operate-server/src/settlement-coverage-survey.ts`, `node.ts`
- `deploy/README.md` ("Upgrading to tax remittance posting"), `deploy/GO-LIVE.md`
- ADR-0466 open question 1
