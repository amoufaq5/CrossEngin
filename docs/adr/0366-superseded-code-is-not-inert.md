# ADR-0366: Superseded code is not inert

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-14 |
| **Authors** | moufaqblog@gmail.com |
| **Reviewers** | _N/A_ |
| **Supersedes** | the retention sentence in ADR-0124; the Decision sections of ADR-0122 and ADR-0123 |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0122, ADR-0123, ADR-0124, ADR-0314, ADR-0337, ADR-0351, ADR-0360, ADR-0365 |

## Context

Two GL posting effects in `packages/operate-runtime/src/write-effects.ts` had no caller outside
their own test file: `billGlPostingEffect` and `paymentGlPostingEffect`. Both were superseded —
ADR-0122 and ADR-0123 are the ADRs whose entire Decision sections they are, and ADR-0124 is the
increment that replaced them. The backlog called this a deletion and sized it at one line.

The question was not whether they are callerless (settled) but ADR-0337's: **is each a second
spelling of live code, or a capability nothing replaced?** That ADR deleted two callerless classes
and the test it used was that each was "a second spelling of live code", so the same test applies
here. Three independent adjudications were run, and then four empirical probes against the real
`InMemoryEntityStore` through the real `runWriteEffects`, replicating `compile.ts`'s wiring field for
field. The probes are what decided it, and they moved the answer twice.

**Neither function turned out to be merely dead, and they were not dead in the same way.**

### `billGlPostingEffect` was wrong, not redundant

It posts, on a Bill's →approved edge, two lines: debit expense at the **total**, credit AP at the
total. `recognitionGlPostingEffect` as `compile.ts:436` configures it posts the same entry number
(`${bill_number}-GL`), the same source, the same accounts from the same tenant-settings keys, the
same descriptions, on the same edge — plus the subtotal/tax split. Field for field a subset.

The probe is what made it more than redundant. On a bill of 120 with 20 of input tax, the live
effect posts AP C120 / expense D100 / tax_input D20; the dead one posts expense D120 — **booking 20
of input tax into the expense account.** And the taxed case is the *normal* case: all seven resolved
packs declare both `TaxCode` and `BillLine`, which is the condition `compile.ts`'s Bill site gates
its `taxLines` on, so the live wiring always takes the split branch. Deleting it is a correction.

It is also **unwireable**. Both post an entry numbered `${bill_number}-GL` on the same entity and
edge, and `JournalEntry.entry_number` is `unique: true` with a sequence default
(`entities-finance.ts:34-39`). Since ADR-0360 that emits a real `CREATE UNIQUE INDEX
(tenant_id, entry_number)`, so wiring both means a `23505` inside the approval transaction on
`--store pg-columns` — and because the write goes through an effect's `input.store.create` rather
than a `writeTxn` caller-key path, ADR-0360's 409 arm does not apply and the bill approval fails as
a 500. On `--store pg`, the shipped compose default where ADR-0360 measures **0 of 32** unique
declarations enforced, it instead creates two identical posted entries and double-counts expense and
AP silently.

### `paymentGlPostingEffect`'s retention was a promise the architecture had withdrawn

This one is not accidentally dead. ADR-0124, Accepted, retains it **by name**:

> (The prior invoice/bill →paid settlement wiring is removed; the generic `paymentGlPostingEffect`
> remains for reuse.)

And the reuse route is published and trivial. `CompileOperateServerOptions.writeEffects`
(`compile.ts:169`) *replaces* the inferred list, but `additionalWriteEffects` one line below
(`:170`) is documented *"appended after the resolved base effects — additive"* and `compile.ts:738`
spreads it after the defaults. So reusing the retained export is one line.

That is what makes the retention unsafe rather than merely stale. Measured on a manifest with a
`Payment` entity — which is all seven shipped packs — an invoice of 120, a Payment of 50 reaching
`completed`, then a user hitting `mark_paid`: **AR net −50 and cash +170.** The candidate posts the
document's full total on top of the 50 the Payment already settled. Nothing stops it: the entry
numbers differ (`-PAY` against `${payment_number}-SETTLE`), so no unique constraint fires, and
unlike the bill case this fails **silently**.

One mechanism offered for that double-post is wrong and worth recording, because it was the first
adjudication's central claim: it is *not* reached through `paymentApplicationEffect`. That effect
settles the document via `store.update`, and `runWriteEffects` has exactly one caller
(`handlers.ts:1053`) — a store write runs no effects — and the candidate's
`input.entity !== c.entity` guard rejects a `Payment` input outright. The probe fired it zero times
on that path. The double-post is reached through the user-driven `mark_paid` transition, which is the
scenario the function was wanted *for*.

### The gap the deletion makes visible, which is this increment's real finding

`paymentGlPostingEffect` keys on **the document reaching `paid`**. Every live settlement-side effect
is gated on the `Payment` entity existing — `paymentSettlementGlPostingEffect` at `compile.ts:473`,
`paymentApplicationEffect` at `:488` and `:498` — and **no effect `compile.ts` wires triggers on
`paid` at all**: every `triggerState` is `sent` or `approved`, and `paymentApplicationEffect`'s
`settleableStates` are the states a document is settled *from*.

`erp-core` meanwhile declares a direct `mark_paid` transition on both documents, gated on a
permission alone and requiring no `Payment` row, plus two timer transitions:

    workflows.ts:30-35    Invoice  mark_paid             -> paid   guard: Invoice.transition.mark_paid
    workflows.ts:147-151  Bill     mark_paid             -> paid   guard: Bill.transition.mark_paid
    workflows.ts:48-50    Invoice  sent_to_paid_30d      -> paid
    workflows.ts:163-165  Bill     approved_to_paid_due  -> paid

So the two settlement paths are not equivalent, and the probe measures the difference: on an invoice
of 120 with a Payment of 50, hand-marked paid, the live chain alone leaves **AR net +70** and cash
+50 on a document that reads `paid`. The AR control account is never cleared. Enumerating all eleven
effects in the file confirms there is no other route: the only AR-clearing postings are the
Payment-gated settlement, a credit note (`creditNoteGlPostingEffect`) and a reversal
(`journalReversalEffect`) — all different business acts.

It is **reachable now**, which is the part that matters and which one adjudication got wrong by
calling it "currently unreachable": the guard is a permission, and ADR-0365 measured `erp_admin`
reaching **79 of 79** declared transitions with `GL_WRITERS = ["erp_admin", "controller"]`. Before
ADR-0365's increment no login could reach `Invoice` at all, which is why the batch plan ordered that
one first.

## Decision

**Delete both**, and record why each went, because a silent deletion loses different things in the
two cases.

`billGlPostingEffect` goes as a **correction**: it misposts input tax on the normal case and cannot
be wired beside the effect that replaced it.

`paymentGlPostingEffect` goes with **ADR-0124's retention sentence explicitly withdrawn**. The
reasoning is not "it is dead" — it is that *"remains for reuse"* plus a one-line additive route is an
export whose easy path is a wrong ledger. There is one deployment shape in which it would be correct
and conflict with nothing: a manifest that declares a GL and a document with a `paid` state and **no
`Payment` entity**, where all three live settlement effects are gated out. That case is real and is
narrow, and it does not justify keeping an export that any embedder can add in one line to get
AR net −50. The implementation stays in git history and this ADR names where.

`index.ts` needs **no edit**: it is `export * from "./write-effects.js"`, so the star export stops
carrying the symbols automatically — which is ADR-0337's stated blind spot working in the harmless
direction. No workspace package imports either name; all three dependents were checked, there is no
`import * as` of `@crossengin/operate-runtime` anywhere, and neither name occurs as a string literal
in any file type. This is still a **public-API removal** and is recorded as one.

**One assertion was ported rather than dropped.** The deleted payment block held the only assertion
anywhere that `skipDocumentType` suppresses a posting, and the *live* copy of that branch was
mutation-proven uncovered: with it commented out, all 852 tests passed. The assertion is now in the
`recognitionGlPostingEffect` block, whose `invoiceRec` fixture had configured `skipDocumentType`
since it was written and asserted nothing about it — and after the port the same mutation fails. The
bill block's account-code test was dropped instead, because `resolveAccountId` keeps three other
coverages.

**The `mark_paid` settlement gap is ranked as its own register item**, not fixed here. The fix is a
new effect that nets off what Payments have already settled, which needs a "no completed Payments
cover this document" predicate; re-wiring the deleted one is measured harmful on exactly that
scenario. That is its own increment with its own correctness argument.

## Alternatives considered

- **Keep `paymentGlPostingEffect` with a source comment carrying the condition.**
  - **Pros:** an Accepted ADR retains it, the Payment-less shape is real, and ADR-0314's per-tenant
    Architect makes that shape authorable by a tenant.
  - **Why not:** this was the position this ADR's author held until reading one line further down the
    options interface. `additionalWriteEffects` makes misuse a one-line change, and a comment is a
    weaker fence than absence against a one-line mistake that produces a silent wrong ledger. The
    asymmetry decides it: the cost of deleting is that a narrow correct use must recover the code
    from git, and the cost of keeping is that an easy incorrect use posts AR net −50 with nothing
    saying so.

- **Delete only the bill effect.** Why not: the same argument. It is the honest reading of the
  adjudications' 2–1 split and of ADR-0124's text, and the probe refuted it on the one scenario the
  retention was wanted for.

- **Wire `paymentGlPostingEffect` to close the `mark_paid` gap.** Why not: measured harmful. It
  cannot distinguish "paid with no Payment rows" from "paid via payment application", so it
  double-books every ordinary payment-driven settlement, and it posts the document total regardless
  of how much was actually paid.

- **Declare them callerless-with-a-reason**, as `pg-unreachable-stores.ts` does for stores.
  - **Why not:** that vocabulary does not reach them, and this was verified rather than assumed. That
    rule's unit is "an exported class, constructed somewhere" and its symbol scope requires a
    capitalised class name; these are lowercase exported functions, structurally outside it. ADR-0337
    measured and refused the general function-shaped fence (82 of 812 modules, mostly contracts
    packages, and it missed three of the six replayers it existed to find). So the third option does
    not exist, and the choice really is delete, wire, or leave a comment.

- **Remove `mark_paid` from the packs instead**, so the gap cannot be reached. Why not: it is a
  manifest change with permission and UI consequences and a kernel 1:1 permissions/transitions
  cross-validation to keep satisfied, and "the transition exists and balances nothing" is better
  answered by making it balance than by removing a capability tenants use.

## Consequences

- **Positive.** A posting that misbooked input tax on the normal case is gone; an export whose
  one-line reuse route produces a wrong ledger is gone; 314 lines go with them; and the question the
  dead code was asking — *what settles a document that reaches `paid` without a Payment?* — is
  recorded as a ranked item instead of being deleted along with the function.

- **A public-API removal.** Both symbols were in `@crossengin/operate-runtime`'s surface by star
  export. No workspace consumer and no string-literal reference exists, but an external embedder
  importing either name breaks at compile time — which is the better of the two failures available,
  since the alternative was breaking at the ledger.

- **ADR-0122, ADR-0123 and ADR-0124 now describe code that is gone**, and are deliberately not
  rewritten — they are history. ADR-0124's parenthetical retention is the one sentence this ADR
  supersedes, and it is superseded with its measurement rather than by assertion.

- **The plan's stated justification for this batch does not hold**, and that is worth recording
  because it is a methodological trap rather than an arithmetic slip. It offered "removes 2 of 6
  `fx_rate: 1` sites" and "2 of 7 unstamped entry sites". The first reproduces exactly: six
  (`:453, :573, :682, :1030, :1169, :1741` pre-deletion) going to four (`:453, :819, :958, :1530`).
  But every surviving GL posting effect hardcodes `fx_rate: 1` too — the only site binding a real
  rate is `unrealizedFxRevaluationEffect`, now `:1283` — so the deletion takes the count from 6 to 4
  and the *proportion* of surviving GL-posting sites carrying the defect to **100%**. A count
  reduction in a defect class is not progress against the class.

- **The second figure does not reproduce, and how it fails is the sharpest thing in this
  increment.** The entry-create sites are **8**, not 7, going to 6 rather than 5. The eighth is
  `journalReversalEffect`'s, whose receiver is named `created` rather than `entry`
  (`const created = await input.store.create(input.tenantId, c.entryEntity, reversalEntry)`), so a
  pattern keyed on the variable name excludes it — `grep -c 'const entry = await input.store.create'`
  answers 7 where `grep -c 'await input.store.create(input.tenantId, c.entryEntity'` answers 8. And
  the claim that figure was offered for was *"0 of the 7 entry-create sites sets `book_id` or
  `fiscal_period_id`"* — of which **that excluded site is the sole counterexample**, since the carry
  loop sits at `:126-128`, immediately above it. The matching pattern's blind spot and the claim's
  only refutation are the same line: ADR-0362's class — a predicate deciding from a proper subset of
  the facts that determine its answer — reproduced inside the measurement that argued this deletion.

- **"~380 lines" was 314** (211 source, 101 test, 2 imports), overstated by 21%, and three of the
  brief's line numbers were two to four off.

## Open ends

1. **The `mark_paid` / timer-driven settlement gap**, measured at AR net +70. Needs a new effect with
   a "no completed Payments cover this document" predicate. The sharpest open item this increment
   produced and not in the 66-item backlog before it. It has **three** members, not two:
   `TAX_RETURN_LIFECYCLE` (`workflows-ext.ts:200-213`) declares `mark_paid` from `filed` to `paid`
   and grants it as a transition (`:243`, `permissions-ext.ts:150`), while no effect and no
   `compile.ts` wiring names `TaxReturn` at all — so a tax return reaching `paid` moves cash, leaves
   `tax_payable` uncleared, and posts nothing. Same class, third edge.
2. **No GL posting effect sets `book_id` or `fiscal_period_id`.** Both are declared and indexed
   `JournalEntry` fields (`entities-finance.ts:41-42`). The claim that *every* entry is book-less and
   period-less is **false** and the true statement is narrower: of the six surviving
   `JournalEntry`-create sites, two touch those fields — `journalReversalEffect` carries both from
   the original entry (`:126-128`) and `unrealizedFxRevaluationEffect` sets `fiscal_period_id`
   (`:1305`) — and **four** set neither: `creditNoteGlPostingEffect` (`:442`),
   `recognitionGlPostingEffect` (`:809`), `paymentSettlementGlPostingEffect` (`:948`) and
   `whtCertificateClearingEffect` (`:1520`). So a multi-book deployment posts every document entry
   into no book.
3. **`fx_rate: 1` on every GL posting site**, per the consequence above — four surviving sites, 100%
   of them.
4. **No mechanical fence for a callerless exported function.** ADR-0337 measured and refused the
   general form; this increment confirms the gap is still open and that `pg-unreachable-stores.ts`
   structurally cannot reach it. Two ADRs have now each adjudicated callerless functions by hand.
5. **The live `skipDocumentType` branch was uncovered until this increment's port** — found by
   mutation while verifying a deletion, which is not a reliable way to find uncovered branches. A
   coverage threshold on this package would be the general answer.
