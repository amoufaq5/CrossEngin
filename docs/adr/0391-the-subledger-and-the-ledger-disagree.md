# ADR-0391: The subledger and the ledger disagree

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-28 |
| **Authors** | Claude |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0124 (the generic payment posting effect, retained then withdrawn), ADR-0334 (a remedy that cannot work is worse than none), ADR-0338 (nothing served this correctly, so refusing breaks nothing that was right), ADR-0360 (`unique` enforcement; the 409 gated on caller-supplied keys), ADR-0366 (a retention withdrawn **with its measurement**), ADR-0367 (`drainList`, and `READ_CEILING_EFFECT.guard = refuses`), ADR-0378 (the residual posting measured **harmful**) |

## Context

Register item P0.6b has been re-measured three times and each pass corrected the one before it. The
facts that survive all three:

- Three permission-gated lifecycle transitions reach the `paid` state on resolved `erp-core`, the
  shipped `--pack` default: `Invoice.mark_paid` from `["sent","overdue"]`, `Bill.mark_paid` from
  `["approved","overdue"]`, `TaxReturn.mark_paid` from `"filed"` — **3 transitions, 5
  (transition, from-state) edges**. All six other packs declare **0** of their own and inherit
  core's through `meta.extends`, so those three are the entire population across the seven packs.
- **No write effect `compile.ts` wires triggers on `paid` at all.** Every `triggerState` is `sent`
  or `approved`; `settleableStates` are the states a document is settled *from*. Every
  settlement-side effect is gated on `names.has("Payment")` and fires on the **Payment's** edge.
- Nothing gates any of it: `options.writeEffects` is never set, so `defaultWriteEffects` always
  runs and the GL postings cannot be switched off.

**The harm is not "AR is overstated", and correcting that is the first thing this change does.**
That statement silently picks one of three business facts the edge cannot distinguish — a write-off,
a settlement received off-system, operator error — which post to three different accounts. And each
of the postings that *did* happen is individually correct: recognition debits AR 120 at `sent`,
settlement credits AR 50, nothing posts on `mark_paid`. So the general ledger is not wrong; it says
*70 is owed*, which is **true** if the operator marked it paid in error.

The statement that holds under all three readings is the **divergence**. `openStates` excludes
`paid`, so the aging subledger reports **0 open** while the GL control account carries the residual,
and nothing reconciles or reports the gap. Whichever fact the operator meant, one of the two
surfaces is wrong and they disagree **silently**.

That inverts what a fix is for. The harm is the *silence*, so making the uncovered state
unreachable is a complete answer — and the residual posting is not needed at all, which matters
because ADR-0378 measured that remedy **harmful** (it cannot tell *paid with no Payment rows* from
*paid via payment application*, so on the ordinary ordering it posts the document total on top of
what a Payment already settled: AR net −50, cash +170, silently, because the entry numbers differ
so no constraint fires). Six ledger decisions sit behind a residual posting and one has no derivable
answer.

**And the reachable surface is wider than three transitions.** A plain `PATCH {"state":"paid"}`
reaches `paid` too: `state` is an ordinary `enum` field on all three documents with **no
field-level permissions on any of them**, and `lockedDocumentGuard` returns `null` first when the
*before* state is unlocked — so `PATCH /v1/invoices/{id}` succeeds from `draft`, and
`PATCH /v1/bills/{id}` succeeds from **any** state, because **`Bill` has no locked-document guard at
all** (four `lockedStates` declarations: Invoice, TaxReturn, SalesOrder, PurchaseOrder). On that
path recognition never fired, so a residual effect computing `total − applied` would credit a
control account that was never debited — a sixth ledger decision, and one that is *inexpressible*
for `Bill`, whose record carries no `approved_at` or equivalent.

## Decision

**Refuse the edge rather than posting on it, keyed on the state change rather than the operation,
over one converged definition of what has been applied to a document.**

1. **One `appliedByRef` definition, three callers.** "Completed payments summed per document" was
   spelled three times independently — `paymentApplicationEffect` (one document, an `eq` filter,
   folded to a scalar), `unrealizedFxRevaluationEffect` (one map per side) and `aging-handler.ts`
   (one map per section) — and the evidence that it is one function is that all three carried
   near-identical comments explaining why the map is keyed **per bucket** and not shared. That
   keying now lives in the helper with its reason, because it is the property a fourth spelling
   would lose: a shared map keyed by document id would merge an invoice's payments with a same-id
   bill's, since records are bucketed per `(tenant, entity)` and a caller-supplied `id` is not
   stripped. The one-document case is the degenerate one-bucket form plus its `eq` filter, which is
   the difference between one index lookup and draining every payment in the tenant. It lives in
   `write-guards.ts` because the dependency direction forces it — `write-effects.ts` already imports
   `WriteGuardInput` from there, so that module is the only one of the three the other two can
   import as a value without a cycle — and the epsilon moved with it so the guard and the effect
   cannot hold two.
   **"Behaviour-identical" turned out not to be achievable, and that is a finding rather than a
   compromise.** `FIELD_TYPE_CHECKS` answers `acceptAny` for a `reference`, so `{"invoice_id": 42}`
   is admitted and the JSONB store round-trips a number — and of the three spellings, **two skipped
   such a row** (`typeof ref !== "string"`) while **one counted it**
   (`String(p[refField] ?? "") === docId`). The three disagreed about a reachable record, which is
   exactly what a convergence is for. Converged on the strict form, which is fail-closed for both
   readers (an understated `applied` makes the guard refuse and the effect decline to settle), and
   pinned by a test; the permissive form would have widened the FX revaluation and the aging report
   in the unsafe direction.
2. **`settlementCoverageGuard`, keyed on `after[state] === paid && before?.[state] !== paid`.**
   That covers the transition, the plain `PATCH` and a `create` alike — and it is the house idiom
   rather than an invention: `journalPostingGuard` is keyed on exactly that shape for the posted
   state. An operation-keyed guard would have closed one path of three. It can never fire on a
   `delete`, and the predicate's *shape* is the exclusion rather than a clause to maintain: the
   handler passes `after: before` there, so the second conjunct is false.
   **It runs LAST, after the locked-document guards, and the first version had it first.**
   `runWriteGuards` returns the first block, so the order decides which refusal a caller sees — and
   measured live, a `PATCH {"state":"paid"}` on a **`sent`** invoice answered `uncovered_settlement`,
   whose remedy (*record the remaining payment*) would **not** let that `PATCH` through, because the
   locked-document guard refuses it whatever the coverage is. ADR-0334 again: a remedy that cannot
   work is worse than none. Last costs nothing, because `lockedDocumentGuard` returns `null` on
   `operation === "transition"`, so `mark_paid` still reaches it.
3. **One epsilon and one comparison.** `settlementIsCovered(total, applied)` is stated as a
   function rather than written twice, so the guard and `paymentApplicationEffect` cannot disagree
   about whether a document is covered — if they did, a document would be simultaneously unmarkable
   and auto-marked.
4. **An exceeded read ceiling refuses.** `READ_CEILING_EFFECT.guard` is `refuses` on the stated
   ground that *a decision from a prefix is not a decision*, and `journalPostingGuard`'s
   `unverifiable_journal_entry` is the precedent — including its deliberate refusal to name a
   remedy, because the ceiling is reachable by no flag and "raise the cap" is an instruction the
   operator meeting it cannot carry out.
5. **The edge no guard can cover is declared and reported, not silently left.** `TaxReturn` has no
   `total`, no `paid_at` and no `Payment` referencing it, so the coverage predicate is
   **inexpressible** for it. It is declared, and a boot survey in the shape this repository has used
   four times — a pure function of the manifest, a verdict enum with a total map, reported and never
   refusing, and **said either way including when there is nothing to report** — names every entity
   with a transition into the settled state and whether a guard covers it.

## Alternatives considered

- **Option A: post the residual on the `paid` edge.**
  - **Why not:** measured harmful by ADR-0378 (AR net −50, cash +170) and blocked on six ledger
    decisions, the first of which — which account takes the residual — has **no derivable answer**,
    because the edge alone cannot separate a write-off from an unrecorded settlement from an error
    and the three post to three different accounts. It would also have to decide, on the direct-PATCH
    path, whether recognition was ever posted — a question `Bill`'s record cannot answer.

- **Option B: report the divergence instead of refusing it — a reconciliation reading, or a new
  aging section for paid-but-uncovered documents.**
  - **Pros:** needs no ledger decision and is this repository's established answer where the remedy
    is a judgement the deployment's owner must make (ADR-0357, ADR-0359, ADR-0360).
  - **Why not:** it makes the divergence visible without stopping it, and the cost is real — a
    mature tenant's `paid` documents vastly outnumber its open ones, so draining them per report
    request is the largest read on the page. Refusing is cheaper *and* stronger, and the remedy it
    names (record the payment, or issue a credit note) is the correct business act in two of the
    three readings. The report survives for the one case a guard cannot cover.

- **Option C: a write guard keyed on `operation === "transition"`.**
  - **Why not:** closes one path of three. `PATCH {"state":"paid"}` is an `update`, and a document
    POSTed directly as `paid` is a `create`. The state-edge keying costs nothing and covers all
    three.

- **Option D: coordinate the residual and the settlement effects through a stamped field.**
  - **Why not:** silently inert on the typed store, with a live instance already shipping.
    `ColumnMappedEntityStore` skips a field the entity does not declare, with no error — and
    `paymentApplicationEffect` already stamps `paid_at` on `Bill`, which declares no such field, so
    that stamp lands in the JSONB document on `--store pg` and is **dropped** on
    `--store pg-columns` today.

- **Option E: opt-in behind a flag, with the boot line naming what it would refuse.**
  - **Pros:** ADR-0334's and ADR-0339's shape for a refusal that changes a working path.
  - **Why not:** ADR-0338's premise applies instead — a document reading `paid` while the GL carries
    the receivable and the aging report shows nothing is not a deployment serving this correctly, so
    refusing breaks nothing that was **right**. The hatch exists for the deployment that settles
    off-system and records it later, because that state is degraded but **recoverable**: record the
    payment and it reconciles. That is what earns a hatch where ADR-0340's unevaluated obligation
    did not.

## Consequences

- **Positive:** the writes that produce an uncovered `paid` state are refused on the two documents
  that can express coverage — a write *into* the state, and a write raising the total of a document
  already in it; the aging subledger and the GL control account can no longer disagree for either
  reason; and "applied per document" has one definition, which is the prerequisite the register
  itself named. **Stated as the two shapes and not as "unreachable through every path that reaches
  it"**, which is what this line and the guard's own doc comment said until an adversarial pass
  reached the state in two ordinary writes; see the addendum.
- **Negative:** a 422 where there was a 200, on a transition that worked. A write-off must now be
  expressed as a credit note — which already posts correctly — rather than as `mark_paid`.
- **Neutral:** `TaxReturn`'s edge is unchanged and now declared rather than silent.
- **Reversibility:** the hatch is one flag. The convergence is behaviour-identical and would be
  kept either way.

## Implementation notes

**The divergence, reproduced with the GL seeded.** Two real servers, `--pack erp-core`, real HTTP,
the hatched arm standing in for pre-fix behaviour. After marking an invoice of 120 paid against 50
received:

```
GL journal lines:  Invoice — accounts receivable  D 120.00
AGING subledger:   open = 0
```

120 of AR on the ledger, nothing owed per the subledger, nothing reconciling them. On the guarded
arm the same request is `422 uncovered_settlement`, the AR debit stands, and the subledger reports
it open. Also verified on `--store pg` as the non-owner `serving` role against a real cluster: five
arms, the under-covered `mark_paid`, the `draft` `PATCH`, the Bill `PATCH` and the `create` all 422
with the state unchanged, and a fully covered invoice 200 with the state `paid`.

**The boot line, both arms**, which is where the unguardable edge is declared:

```
[settlement] settleable documents: 2 of 3 guarded
  guarded: Invoice (mark_paid), Bill (mark_paid)
  1 unguarded (no_total_field): … TaxReturn (mark_paid)
  1 unguarded (no_payment_reference): … TaxReturn (mark_paid)
[settlement] settleable documents: 0 of 3 guarded
  3 unguarded (coverage_disabled): --allow-uncovered-settlement was passed …
```

**The cost of defaulting it on is measured at zero**: the whole `operate-runtime` suite passed
959/959 immediately after wiring, so **no existing test marked a document paid without full
coverage** and no fixture asserted the defect. That is also zero prior coverage of the path, which
is why the increment adds 38 tests; the suite is 997 after.

**`server.ts` needed two lines that were not in the plan**, and shipping without them would have
made the flag inert: `buildOperateHttpServer` forwards options one named field at a time, which is
ADR-0386's defect exactly — so an inert flag would have reproduced this run's most-found class
inside the increment whose own survey is about inert mechanisms. Fenced in `node.test.ts` by reading
`server.ts` as text, because the subject is one wiring chain and splitting it across two test files
is how half of it gets forgotten.

**One of the increment's own tests was vacuous and the mutation check is what found it.** The
guard-order test used a *fully covered* invoice, so the coverage guard was transparent and both
orders answered `invoice_locked` — only a document failing **both** guards can observe the order.
And the `TaxReturn` compile test's 200 cannot distinguish *no guard* from *a guard that checks
nothing*, because `num(undefined)` is 0; the vacuity is shown empirically in the guard's own test
now, and the compile test says what its 200 does and does not establish.

Three bounds are stated at their sites rather than left to be discovered:

- **`Payment.amount`'s declared `min: 0` is enforced by nothing** (`FieldErrorCode` has no range
  member; `type.min` is read in two change-detectors and nowhere else), so the coverage predicate is
  computed from a quantity whose sign is unbounded and is approximately sound. A negative correction
  can defeat it.
- **`paymentSettlementGlPostingEffect` never reads the referenced document at all** — not its state
  and not its existence — so a completed Payment naming a deleted, void or nonexistent document
  still credits the control account. Reported, not fixed.
- **`paid_at` is stamped on `Bill`, which declares no such field** — see Option D. Reported, not
  fixed: adding the field is a pack change that emits a column.

## Addendum — the adversarial review, and the invariant that was false

An adversarial pass over the commit returned `sound_with_defects` with five findings, one of which
blocks, and the blocking one is **the claim rather than the code**: this ADR's Consequences and the
guard's own doc comment both said the uncovered state was unreachable *"through every path that
reaches it"*, and it was reachable in **two ordinary writes** as `ap_clerk` on the shipped pack with
no flags.

Create a Bill `state=approved, total=0`; `POST /v1/bills/{id}/mark_paid` → **200**, correctly, by the
nothing-owed arm, because nothing was owed; then `PATCH {"total":120}` → **200**, because the
edge-only predicate's second conjunct (`before?.[state] !== settledState`) is false when the document
is *already* paid. The bill is then `paid` with 120 owed and no payments, AP aging's
`openStates: ["approved","overdue"]` drops it, and the GL control account keeps the residual — the
divergence this increment exists to close, verbatim. `Bill` is the member nothing else covers:
`Invoice` is incidentally protected because `paid` is one of its `lockedStates`, and `Bill` has no
locked-document guard at all, which is this ADR's own headline measurement. The role set is exactly
the population the guard refuses (`ap_clerk` holds both `Bill.mark_paid` and `Bill.update`).

So the code was a strict improvement and the **claim** about it was false on the one entity that most
needed it — which is ADR-0337's falsely-true direction, in the durable record, inside an increment
whose whole subject is a silence. The predicate is *a write that leaves the document settled and
owing more than it did*: `settledAfter && (!settledBefore || owesMore)`, with `owesMore` a
**comparison** rather than a presence test, so a correction *downward* on a paid document is still
allowed and the existing "passes a write of an already-settled document" test is the control (it
leaves the total unchanged). The refusal's wording moved with it — *"cannot leave …"* rather than
*"cannot mark …"*, because on the new arm the document is already settled and the caller is raising
what it owes, so the old sentence described a write nobody made.

Three further findings were real:

- **The guard read its state field by name and the name was hardcoded.** `stateField` fell back to
  `state`, so a manifest whose lifecycle drives `status` — accepted by `validateWorkflows` since
  ADR-0359, and the normal shape for `Opportunity.stage` in all seven packs, `WorkOrder.status` and
  `Project.status` in `erp-construction` and `Enrollment.status` in `erp-education` — got
  `after["state"] === undefined`, a guard that returned `null` for every write, **and a boot line
  naming the entity as guarded.** Falsely-true again, on the surface built to make the gap legible,
  and reachable from a tenant's own activated manifest, which is the path this guard is wired into.
  The fix is the half one level up rather than the reviewer's cheaper one: `defaultWriteGuards` holds
  the manifest, so it reads the lifecycle's `stateField` and sets it on the config — and
  `lifecycleStateField` is **exported from `list-query.ts`** rather than spelled a second time, which
  is what keeps *which field holds the state* a single answer. The survey then needs **no** sixth
  gap, because survey-says-guarded and guard-can-fire become the same fact: a gap for the difference
  would be a verdict with no producer (ADR-0336's class), and that reasoning is written where the
  next reader will look for it.
- **`num()` collapses an unreadable total to 0**, so a document whose stored `total` is `"n/a"` took
  the nothing-owed arm, was marked paid, and was dropped by the aging report in silence. That is a
  **fourth** cause of an unreadable figure and the only one where allowing is the wrong answer, so it
  refuses `settlement_coverage_unverifiable` — ADR-0367's rule, which the ceiling arm beside it
  already follows. Reachable only from a row `validateEntity` would have refused on the wire (an
  effect, a migration, an import), and `paymentApplicationEffect` returns early on `total <= 0` so it
  will not auto-settle such a row either: the two stay consistent.
- **A role count that does not reproduce**: the disclosure argument said `Payment.list` holds *four*
  of those roles where the union of Invoice's and Bill's write grants is **three** distinct roles.
  The substance held exactly as written — both subset relations are true and `Payment.list` contains
  all three — so the only cost was a reader having to re-derive the paragraph to find out whether the
  error was in the count or the claim. P3.1's class, again.

And one cosmetic finding worth taking for its reason: both zip sites guarded a positional map with
`?? new Map()` over an array `foldCompletedPayments` builds one bucket per ref field for, so index
`i` always exists — an unreachable arm, and ADR-0361's stated reason for deleting one is that a dead
arm reads as a handled case. They use the `!` the fold itself uses one scope in.

Four tests cover the new behaviour and each was mutation-checked: reverting the predicate to the edge
form fails the raised-total test, reverting the `stateField` wiring fails exactly one compile test,
and the write-down and unchanged-total controls keep answering `null`. Five tests, 997 → **1,002**
in `operate-runtime` — and the figure in the first draft of this sentence was 1,001, asserted from
the count of findings rather than measured, which is P3.1's class for the second time in one
addendum.

## Addendum — the option hop this increment's own open question named

Written in the same session, because the open question below it turned out to be one assertion wide
and the defect it guards against **fails in the permissive direction**.

The chain is `cli.ts` → `node.ts` → `server.ts` → `compile.ts`, and the last hop is a forwarding
literal of the exact shape ADR-0386's dropped field lived on — a conditional **spread**, which
bypasses TypeScript's excess-property check, into an **optional** field with a default. Here the
default is `?? false`, and `false` means *do not build the settlement-coverage guard*, so a dropped
spread silently disarms the whole increment. Worse than ADR-0386's case, where the default was the
strict one and the drop produced a safe wrong answer. Measured by deleting the three lines: `tsc`
exits **0**.

`compile.test.ts`'s fence (ADR-0386) reads `compile.ts` and covers `buildOperateGateway` →
`GatewayRuntime`, one hop further in. The new sibling in `server.test.ts` covers this one, and the
unit is the **intersection of the two interfaces' field names** rather than everything the app
accepts: `BuildOperateHttpServerOptions` declares 29 options, the gateway's two interfaces declare
30, **16 are shared**, and only a shared one can be dropped here. That is what keeps it free of a
maintained list — the `notForwarded` form `compile.test.ts` uses would need **13** entries in this
position, and ADR-0288's lesson is that such a list is the thing that goes wrong. `compile.ts` is
read by relative path as **text**, the idiom `deployment-defaults.test.ts` in this app already uses
for `deploy/`, so no build output is consulted and the fence answers on a fresh checkout; a path
that stopped resolving fails by name through the `indexOf` assertion rather than silently emptying
the population. Three floors beside it (both interfaces, and the intersection at 16), because this
fence's whole failure mode is a reader that stopped matching.

**Two claims in the first draft of its own comment were wrong, and both were caught by running the
mutation rather than by re-reading it.** It said the hop was *"covered by nothing"* — it is covered
**per field**, by this increment's own `node.test.ts` block, which pins `allowUncoveredSettlement`
by name and states that the general rule is somebody else's open end. So the honest statement is
that the *class* was uncovered, the two compose rather than duplicate, and the placement of each is
right for its subject: a per-field pin belongs with the wiring chain it is part of, the class with
the literal it is about. And it claimed *"every one of this app's 5,078 tests passes"* under the
mutation, where **2 of 5,080 fail** — this fence and that per-field pin, which is the pair working.
That figure was asserted from an earlier slice's number instead of measured, which is register
P3.1's class committed inside a fence about a dropped field.

One operational note, because it cost three repairs in one session: **a mutation must never be
expressed as a replacement with the empty string.** Every reversal path degenerates — a guard that
refuses an empty `old`, an `if (NEW)` that skips, an inverse lookup that matches everywhere — and
all three happened here, leaving the tree mutated until it was repaired by hand and confirmed
byte-identical by `md5sum`. A mutation reversed by string replacement has to be a bijection in both
directions: non-empty, and unique.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `TaxReturn` has no coverage predicate to apply. Either model a payment link to it, or decide that a tax return's `paid` means the authority was paid in full — a *different* ledger claim from an invoice's, and whether that asymmetry is acceptable is a human call. | unassigned | — |
| `Bill` has no locked-document guard at all, where Invoice, TaxReturn, SalesOrder and PurchaseOrder each have one, and no comment anywhere explains the omission. Bill credits AP to the GL on `approved` and is then freely updatable and deletable. | unassigned | — |
| Nothing reconciles the aging subledger against the GL control balance. The guard removes the one cause this item is about; it does not establish that the two agree. | unassigned | — |
| `Payment.amount`'s `min: 0` wants enforcement — a `FieldErrorCode` member, a `FieldRule` field and a DDL CHECK — which bounds the soundness of this guard and of `paymentApplicationEffect` (register P3, the `type.min` item). | unassigned | — |
| ~~The `server.ts` → `compile.ts` option hop has no general fence~~ — **closed in this increment's own commit**, see the addendum below. | — | done |
| The survey's gap granularity is the **entity**, not the transition, so an entity with two transitions into the settled state where only one is unguardable is reported once. | unassigned | — |
| `FIELD_TYPE_CHECKS` answers `acceptAny` for a `reference`, which is what let `{"invoice_id": 42}` round-trip and made the three former spellings disagree. The convergence is fail-closed about it; the field type is not. | unassigned | — |

## References

- `packages/operate-runtime/src/write-guards.ts`, `write-effects.ts`, `aging-handler.ts`,
  `aging.ts`, `compile.ts`
- CLAUDE.md, *The register* item P0.6b
