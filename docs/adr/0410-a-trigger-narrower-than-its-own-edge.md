# ADR-0410: A trigger narrower than its own edge

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0391 (key on the state edge, not the operation), ADR-0378 (a wrong figure that balances), ADR-0372 (a defect written down as a specification), ADR-0360 (unique enforcement on `--store pg`), ADR-0366 (a count reduction inside a class is not progress against it) |

## Context

Six write effects in `packages/operate-runtime/src/write-effects.ts` are keyed on a record
**arriving** in a state — an invoice reaching `sent`, a payment reaching `completed`, a fiscal
period reaching `closed`, a withholding certificate reaching `confirmed`. Every one of them opened
with the same line:

```ts
if (input.operation !== "update" && input.operation !== "transition") return;
```

That reads as *a document reaches this state by being transitioned*, and it is false. A lifecycle
state is an ordinary `enum` field with a **literal** default; it carries no field-level permissions
in any of the seven shipped packs; and `lockedDocumentGuard` answers `null` first when the *before*
state is unlocked. So a caller may POST the state directly in one request, reaching the state with
no transition involved and no effect firing.

ADR-0391 found and fixed exactly this reasoning one layer out — its settlement-coverage guard is
keyed on the **state edge** rather than on the operation, and that increment's own notes record that
an operation-keyed guard *"would have closed one path of three"*. The guard was corrected; the
effects behind it were not, and nothing compared the two.

### What it cost, measured live

One cluster (PG 16, port 5490), the shipped store and pack (`--store pg`, `erp-core`), the server
connected as the **non-owner** `serving` role, api-key `erp_admin`. Two ordinary POSTs:

**An invoice created already `sent`** → **201**, and **no journal entry at all**. Revenue was never
recognised, AR was never debited, `sent_at` was never stamped, and `booking_rate` was never stamped
either (`bookingRateStampEffect` carries the identical narrowing, so the FX booking rate that the
period-close revaluation later compares against is simply absent). The AR aging report counted the
invoice regardless, because it derives its open set from the documents:

| surface | says |
|---|---|
| AR aging subledger | **277.00** open |
| general ledger | **250.00** receivable |

The divergence is the whole invoice, and nothing reconciles the two.

**A payment created already `completed`** → **201**, and neither payment-driven effect fired:

| surface | says |
|---|---|
| general ledger | still carries the receivable — no cash debit, no AR credit |
| the invoice record | `state: "sent"`, `paid_at: null` — unpaid |
| AR aging subledger | the invoice is **gone**, settled — it derives `applied` from the Payment rows directly |

Three surfaces, three answers, from one request, and the divergence is exactly the payment.

Each figure balances on its own, so `journalPostingGuard`'s double-entry invariant is satisfied and
no guard, replayer or integrity proof can see any of it — ADR-0378's *a wrong figure that balances*,
which is the class that makes these defects survive.

### Why nothing caught it

**All 1117 tests in `operate-runtime` passed with the defect present**, because every fixture in
`write-effects.test.ts` reaches its state through `operation: "transition"`. The boundary was drawn
at the transition, so a create was unverified by construction — the same shape as ADR-0378's
observation that 952 pre-existing tests were assertion-neutral to a cent-level rounding defect.

## Decision

**One predicate, `entersState(input, stateField, state)`, keyed on the edge and not on the
operation**, read by all six arrival-keyed effects:

```ts
function entersState(input: WriteEffectInput, stateField: string, state: string): boolean {
  if (input.operation === "delete") return false;
  if (input.before?.[stateField] === state) return false;
  return input.after[stateField] === state;
}
```

The edge's two halves do different jobs. `after` must be the state; `before` must not be — and the
second is what keeps a create and a later transition from both firing. **That half was already
present at every one of the six sites.** Only the operation test was narrower than the edge, which
is why this is a one-line change per site rather than a redesign.

`delete` is excluded **explicitly** rather than left to fall out. A delete passes `after = before`
(`WriteGuardInput`'s own contract), so the `before` clause already refuses every delete of a record
in the state and the `after` clause every delete of one outside it — but that is a property of
*another* module's contract, and an effect that fires or not depending on it is the implicit
coupling this repo keeps finding.

**Three sibling effects are deliberately not converted.** `journalReversalEffect`
(`!wasPosted || !nowReversed`), `invoiceVoidCreditNoteEffect` and `creditNoteGlPostingEffect` (both
`!wasIssued || !nowVoid`) require a **specific prior state**, and a create has none — so a record
created already `reversed` or `void` was never posted and never issued, and ignoring it is the right
answer rather than a missed edge. Widening those would reverse an entry that was never posted and
credit-note an invoice that was never sent. **The split is *arrival* versus *prior state*, and it is
the whole of why this is six sites and not nine.** Each retained site carries a comment saying so,
so the next reader does not "complete the sweep".

Beside it, one pack fix the same measurement turned up: **`WhtCertificate` was the one entity of
`erp-core`'s 51 with no `permissions` entry at all**, so all five of its CRUD routes answered 403 to
every declared role — `erp_admin` included — while `whtCertificateClearingEffect` wrote those
records through the store, which runs no RBAC. The entity was writable by the engine and readable by
nobody. It is granted `crud(TAX_READERS, TAX_WRITERS)` beside its `TaxReturn` sibling, with no
`transitionsFor` because it declares no lifecycle workflow (0 of the pack's 19 name it) — which is
also why the `entersState` widening is load-bearing there: a create or a PATCH is the *only* path to
`confirmed`.

## Alternatives considered

**Refuse a one-step terminal `state` at validation.** The cheaper half, and it is not sufficient:
it closes the *create* path and leaves the effects still unable to answer for one, so the next
caller who sets the state through a PATCH on an entity with no lifecycle (`WhtCertificate` is
exactly that) reproduces the defect. It is also a behaviour change to a surface that works —
`erp-core` has no field-level permission on any state field, so a one-step create is a documented
capability rather than an abuse. Refused as a *replacement* and not ruled out as an addition.

**Widen all nine sites to one operation rule.** Measured, and this is where the increment nearly
went wrong: the three prior-state effects' operation test is **redundant**, because their
`!wasPosted` / `!wasIssued` clause already refuses a create. So widening them is behaviourally
identical today, and it is still refused — the operation test is the thing that makes the inertness
true *for a stated reason* rather than as a consequence of a clause whose purpose is something else.
Keeping the narrow test plus the comment is what makes the arrival/prior-state split legible to the
next reader, which is what stops the sweep being "completed" wrongly.

**Give `recognitionGlPostingEffect` the fix and leave the rest.** ADR-0366's rule: a count
reduction inside a defect class is not progress against the class. The census found 9 sites sharing
one line, of which 6 were wrong; fixing the sharpest one would have left five.

## Consequences

**What is fixed**, verified live on the same cluster after the change, both arms:

- An invoice created already `sent` posts `accounts_receivable` dr 77.00 / `revenue` cr 77.00 under
  one entry `INV-BORN-SENT-AR`.
- A payment created already `completed` posts `cash` dr 77.00 / `accounts_receivable` cr 77.00, the
  invoice becomes `paid` with a `paid_at` stamp, and the aging report reads **0 open**.
- So the GL's net AR, the subledger's open total and the document's own state all read the same
  thing, where before the fix two of the three were wrong and in opposite directions.
- `GET /v1/wht-certificates` as `erp_admin` goes **403 → 200**, and a `POST` of a certificate
  already `confirmed` answers 201.

**What is pinned.** Nine new tests. Six drive a `create` into the trigger state through the real
effect and assert the posting; one drives a create **and** a later transition into the same state
and asserts exactly one entry between them, which pins that the widening did not introduce a second
posting; three assert the prior-state effects stay inert on a create. Mutation-checked in three
directions, with the source restored byte-identical (md5 compared) after each:

| mutation | result |
|---|---|
| `entersState` narrowed back to `update \| transition` | **6 of the new tests fail** |
| the three prior-state sites widened to exclude only `delete` | all 1126 pass |
| those three widened **and** their `!wasPosted` / `!wasIssued` clause dropped | **3 of the new tests fail** |

The second row is the finding worth carrying: **a first draft of that test block's comment claimed
the three inert tests "fail if somebody completes the sweep", and the mutation says that is false.**
A create is refused twice over at those sites — by the operation test *and* by the prior-state
clause — and either alone suffices, so no single mutation reaches them. The comment is corrected in
place to say that they fence the **conjunction**, which is the right property to pin for an
inertness claim (what matters is that something refuses the create, not which) and is a weaker fence
than a single-mutation one. This repo's documented-the-hazard-and-checked-nothing class, caught by
the mutation rather than by reading, in the comment claiming the check.

**What is not fixed.**

1. **A one-step terminal `state` remains a surface.** This change makes the effects answer for it
   correctly; it does not decide whether a caller *should* be able to POST `{"state":"paid"}` on a
   document with a lifecycle. ADR-0391 already guards the one edge where the answer is a money
   divergence (`→paid` on a settleable document); the general question — field-level permissions on
   a state field, or a validation refusal — is open and is a pack-authoring decision.
2. **`unrealizedFxRevaluationEffect` is converted and its arm is unverified live.** It fires on a
   `FiscalPeriod` reaching `closed`, which needs a fiscal calendar this measurement did not build.
   Its test is in-memory and it shares the one predicate, so the behaviour follows from the six;
   what is not shown is a live period close.
3. **The GL posts to placeholder account refs and nothing says so at boot.** With no tenant finance
   settings, `resolveAccountId` answers `null` and every `JournalLine` stores the literal ref string
   (`accounts_receivable`, `revenue`) in `ledger_account_id` rather than a `LedgerAccount` record
   id. `write-effects.ts` declares this deliberate ("a wrong-but-named account rather than a
   wrong-and-unnamed one"), so it is a documented degradation — but **every other degradation of
   this class in this binary has a boot survey** (`[unique]`, `[list]`, `[settlement]`, `[cursor]`,
   `[sensitive]`, `[views]`) and this one does not, so a deployment's general ledger does not join
   to its own chart of accounts and the only way to find out is to read a `JournalLine`. A pure
   function of `(manifest, settings)` naming which finance account codes are unresolved is the
   shape; it is not in this increment.
4. **Nothing checks that an entity serving routes has a `permissions` entry.**
   `validatePermissions` checks the coherence of a grant that *exists* (ADR-0348's three rules), and
   `WhtCertificate` had none, so every one of those rules was vacuous for it. A fourth kernel rule
   — *an entity with routes has a grant* — would have refused exactly one entity across all seven
   packs before this change and refuses **zero** after it, which is the cheapest moment it will ever
   have (ADR-0348's own argument for where such a rule belongs: a property of the manifest alone, so
   decidable by a pack author, by `crossengin validate` and by the reviewer). The `pack.test.ts`
   assertion added here fences `erp-core` and nothing else.
5. **The test that pinned the gap is corrected rather than deleted** —
   `it("has 50 entity permission sets")` against 51 entities was ADR-0372's class, a defect written
   down as a specification, and a bare count cannot say *which* entity is missing so it reads as
   deliberate. It asserts the **relation** now (every entity is granted) and names the offenders
   when it fails: the mutation reports `expected [ 'WhtCertificate' ] to deeply equal []` where the
   count reported `expected 51 to be 50`.

## Open questions

1. **Should a lifecycle state field carry a field-level permission by default?** Consequence 1. The
   measured population is every state field in all seven packs (none has one today), so the honest
   first step is a report rather than a refusal.
2. **The boot survey for the finance account bridge** (consequence 3), which is the one of these
   that is landable now and needs no decision.
3. **The fourth kernel permission rule** (consequence 4), which is landable now at a measured cost
   of zero and is the fence that would have caught `WhtCertificate` at authoring time.
4. **Does `unrealizedFxRevaluationEffect`'s arm want a live fiscal-period close?** It is the one
   converted site with no live arm (consequence 2), and the figure it produces — a revaluation at a
   period-end rate — is the kind this repo has twice found wrong in a way only a live run showed.
