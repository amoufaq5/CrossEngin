# ADR-0466: A withheld bill is owed, aged, revalued and settled at the net, and legacy bills are stamped from their own ledger entry

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-23 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0465 (withholding accounts; open question 1), ADR-0139 (stamp withholding total), ADR-0125 (payment application), ADR-0126 (aging), ADR-0391 (settlement coverage), ADR-0421 (server-owned fields), ADR-0428 (entity audit), ADR-0430 (system writer), ADR-0440 (column-schema) |

## Context

ADR-0465 made a withholding line on a bill post to 2210 (withholding payable). Recognition credits
accounts payable at `total − withheld`, so a bill of 100 with 10% withheld posts AP −90, 2210 −10,
expense +100. The bill itself did not record the withholding: `Invoice` stamps `withholding_total`
at recognition (ADR-0139) and every reader of what an invoice owes subtracts it, while `Bill`
declared no such field and its readers used the gross.

The consequences, measured live before this change:

- paying the supplier the net (90) left the bill `approved`, because payment application compared 90
  with 100;
- `mark_paid` was refused (`uncovered_settlement`, ADR-0391) for the same reason;
- the AP aging showed 10 still owed on a bill the ledger said was cleared;
- FX revaluation revalued the gross, so a foreign-currency withheld bill was over-revalued;
- paying the gross (100) settled the bill but left AP 10 in debit.

The ledger was right; the document was wrong. Every bill ever approved with a withholding line
carries the net posting and no stamp, so the defect is also in existing data, not only in new
approvals.

## Decision

### The bill records what was withheld, and every reader subtracts it

`Bill` declares `withholding_total` (decimal 16,2, the same type as its `total`) and `paid_at`
(datetime). The withholding stamp is wired, and every reader subtracts it, exactly when one
condition per document holds: the document, the GL, `TaxCode` and the line entity exist **and the
document declares the field** (`declaresField`, over `resolvedFields`). That one constant
(`billWithholdingStamped`, and `invoiceWithholdingStamped` tightened the same way) drives:

- the recognition stamp and the stamps list, which makes the field server-owned (a client write is
  422 `field_server_owned`, ADR-0421) and read-only in OpenAPI and the UI schema;
- payment application, and through it the refund reopen;
- FX revaluation;
- the settlement coverage guard and AP aging, through `isStamped`.

`paid_at` is declared because payment application already stamped it on bills: the document store
kept it and the column store silently dropped it, so the two stores disagreed about a field nothing
declared.

### Recognition refuses withholding it cannot record

A document whose lines carry withholding but which cannot record it (a tenant's own manifest whose
`Bill` or `Invoice` omits `withholding_total`) used to post the control line net while every reader
expected the gross: the document could never settle. `recognitionGlPostingEffect` now refuses
`409 withholding_unrecorded` before it writes anything. On the shipped packs it cannot fire, because
both documents declare the field.

### The stamp is authoritative

The stamp is written when withholding is above zero, and also when a stored value disagrees with
what the entry netted out (overwritten, with 0 if nothing was withheld). A document carrying no
stored value gets no extra write.

### Legacy bills are stamped from their own posted entry

`operate-server backfill-bill-withholding` stamps bills approved before this change. It reads the
bill's `<bill_number>-GL` entry in **document currency** (`debit`/`credit`, never `functional_*`),
identifies the control line by `BILL_CONTROL_DESCRIPTION` and withholding lines by
`WITHHOLDING_LINE_DESCRIPTION_PREFIX` (exported constants recognition now uses), and requires
`total − control credit = Σ withholding`. Lines are matched by description and never by account,
because before ADR-0465 the withholding went to the input-tax account. It stamps under the bill's
row lock with one audit row (`maintenance:bill_withholding_backfill run:<id>`) in one transaction,
so no audit row means no stamp. A bill that already carries a figure its entry does not support is
**overwritten** with the ledger's figure, and the outcome and the audit row's `before` name what was
replaced: the readers now trust the field, so such a figure (a key a client typed into the
`--store pg` document before ADR-0421 made it server-owned) would otherwise let `mark_paid` through
with nothing paid, and no route can correct a server-owned field on a locked bill. That is the same
rule as recognition's authoritative stamp. It refuses a bill by name and carries on, reports each stamped
bill's coverage (`now_covered`, `settled`, `still_open`, `overpaid`, `unread`), never marks a bill
paid, writes nothing under `--plan`, and exits 1 if anything was refused. It runs as the serving role
under tenant context, refuses a tenant serving its own activated manifest, and refuses a pack whose
bill or journal fields are encrypted rather than asking for the key.

## Alternatives

- **Derive the withholding at read time** from the entry. Rejected: `amountOwed` is pure and
  synchronous at five call sites, and two sources of truth for one figure is what the stamp exists
  to avoid.
- **Recompute from bill lines and today's tax rates.** Rejected: rates are editable and determination
  is by date, so the figure could disagree with the posted ledger by a cent or more.
- **Stamp lazily at the next payment.** Rejected: misses bills that were already paid at the net.
- **Document the legacy gap only.** Rejected: the field is server-owned and an approved bill is
  locked, so an operator would have no remedy at all.
- **Post the remittance of 2210 in this change.** Deferred (open question 1): it needs decisions
  this change does not need.

## Consequences

- A withheld bill paid at the net settles, ages to zero and revalues on the net.
- Paying the gross still settles the bill and leaves AP in debit by the withheld amount, unreported
  (the invoice side behaves the same). `GO-LIVE.md` says not to.
- A tenant's own manifest whose document omits `withholding_total` now gets 409 on approving or
  sending a withheld document, on both stores. For a bill that replaces a posting that could never
  settle. For an invoice it is stricter than before on `--store pg`, where the stamp landed as an
  undeclared JSONB key and the invoice did settle at the net; on `--store pg-columns` the stamp was
  dropped and such an invoice could never settle.
- On `--store pg-columns` the two new columns need `column-schema` as the owner before the API boots
  as `crossengin_app`; the boot refuses naming the column until then.
- `SystemWriteOrigin` gains a `maintenance` member; `originToken`, the request-id prefix
  (`req_maint_`) and the audit reason are exhaustive over it.

## Implementation notes

- `packages/pack-erp-core/src/entities-finance.ts`: the two fields.
- `packages/operate-runtime/src/compile.ts`: `declaresField`, the two gating constants, the Bill
  stamp and readers, `BILL_CONTROL_DESCRIPTION`.
- `packages/operate-runtime/src/write-effects.ts`: the refusal, the authoritative stamp,
  `withholdingLineDescription`.
- `packages/operate-runtime/src/write-guards.ts`: the Bill coverage entry's `withholdingField`.
- `packages/operate-runtime/src/system-writer.ts`: the maintenance origin and `systemRequestId`.
- `apps/operate-server/src/bill-withholding-backfill.ts`, `bill-withholding-backfill-command.ts`,
  `cli.ts`, `node.ts`, `bin/operate-server.ts`, `entity-audit-recorder.ts`.
- `apps/operate-server/src/deployment-defaults.test.ts`: the serve-command fence skipped a
  maintenance subcommand only by accident of its flags; it now skips any subcommand token.

Verified: full sweep green (build, typecheck, 24,438 tests passed before one documentation fence was
narrowed, then that file 116/116). Live on PG 16 in compose order with the API as `crossengin_app`,
on `--store pg` and `--store pg-columns`, each arm the same on both:

- approval stamps 10, the GL reads 2000 −90 / 2210 −10 / 6000 +100, and a client write of the field
  is 422 `field_server_owned`;
- a 90 payment settles the bill with `paid_at` set and AP 0;
- a 45 payment leaves it `approved` with AP aging 45 open, `mark_paid` is 422 "45.00 of 90.00", the
  second 45 settles it, and refunding that payment reopens it;
- a gross 100 payment settles it and leaves AP 10 in debit (the known gap);
- a bill unstamped by hand (the legacy state) stays open after a net payment; `--plan` reports it
  `stamped / written: false / now_covered` and writes nothing; apply stamps it with exactly one audit
  row; `mark_paid` then answers 200; a rerun writes nothing; a bill whose control line was edited is
  refused `derivation_disagrees` and the run exits 1;
- a bill whose stored figure was set to 100 by hand (the shape of a pre-ADR-0421 client write) reads
  `would stamp 10.00 … replacing 100.00 that no entry supports` under `--plan` with the row
  unchanged, is corrected to 10 on apply with an audit row whose `before` is 100.00 and `after`
  10.00, and reads `already stamped` on a re-run (on `pg-columns`, after the final review);
- `verify-chain` exits 0 for the tenant afterwards;
- on `pg-columns`, with `bill.withholding_total` dropped, the boot as `crossengin_app` refuses naming
  `column_absent public.bill.withholding_total` and the `column-schema` remedy; after it, the boot
  succeeds.

The legacy state was produced by removing the stamp from a bill approved by this build, not by
approving under the previous build; the database state is the same except for the column on
`pg-columns`, which the upgrade arm covers separately.

## Open questions

1. **Nothing posts the remittance of withheld or output tax to the authority.** `TaxReturn.mark_paid`
   changes only state; its `output_tax`, `input_tax` and `net_payable` are typed by the caller and
   read by nothing. `Payment` cannot reference a return, and an outbound `Payment` with no document
   debits accounts payable rather than 2210. A correct remittance debits 2210 (and, for VAT, debits
   2200 and credits 1300) and credits cash. Before that can be built, someone must decide whether
   the amounts are derived from the period's ledger or typed, whether cash moves through an effect
   on `mark_paid` or through a `Payment` referencing the return (and so whether settlement coverage
   covers `TaxReturn`, ADR-0391), and whether certificates the workspace issues to suppliers are
   modelled (`WhtCertificate` is customer-side only). Until then, record a remittance as a manual
   journal entry, never as a `Payment`.

   **Closed by ADR-0467.** The figures are typed and bounded by each tax account's balance, cash
   moves through an effect on `mark_paid`, settlement coverage does not cover `TaxReturn`, and
   supplier certificates stay out of scope. The instruction above now reads: in `on_mark_paid` mode,
   `mark_paid` posts the remittance; in `manual_journal` mode (a tenant's default), or for the cases
   the posting refuses, a manual journal still applies; never as a `Payment`.
2. **A gross payment leaves AP in debit, unreported**, on bills and invoices alike:
   `settlementIsCovered` is `applied ≥ owed`.
3. **A transition's response body is the record before its effects ran**, so `approve`'s response
   carries no `withholding_total` (nor an invoice's `send` its `booking_rate`); a read-back has it.
   Pre-existing for every effect stamp. The audit row's `after` has the same gap.
4. **Purchase-side withholding is reconciled by nothing.** The WHT reconciliation report, the
   certificate link and the certificate clearing effect stay invoice-only.
5. **A withholding-kind code under a reverse-charge rule** becomes self-assessed and its withholding
   is lost silently; refusing it by name is a separate change.
6. **The backfill matches lines by description**, so a deployment passing its own recognition effect
   with other descriptions is refused `control_line_absent` rather than guessed at; and a tenant
   serving its own activated manifest is refused on every run, with no subcommand that stamps its
   bills.
7. **Bills paid while the backfill runs**: payment application reads the bill without the backfill's
   lock, so a bill paid mid-run may report stale coverage; re-run to re-check.
8. **Bills whose withholding was entered by manual journal**, as `GO-LIVE.md` advised under
   ADR-0465, carry no withholding line in their entry, so the backfill stamps nothing and they stay
   owed the gross: `mark_paid` is refused and the AP aging shows the withheld amount for ever. No
   surface stamps them (the field is server-owned and the bill locked), re-entering one means
   refunding its payments first because voiding a partly settled bill is refused, and
   `--allow-uncovered-settlement` is deployment-wide. A maintenance stamp from an operator-named
   manual journal entry would close it, and needs a rule for proving that entry is the bill's.

## References

- `packages/operate-runtime/src/compile.ts`, `write-effects.ts`, `write-guards.ts`, `system-writer.ts`
- `packages/pack-erp-core/src/entities-finance.ts`
- `apps/operate-server/src/bill-withholding-backfill.ts`, `bill-withholding-backfill-command.ts`,
  `cli.ts`, `node.ts`
- `deploy/README.md` ("Upgrading to bill withholding settlement"), `deploy/GO-LIVE.md`
