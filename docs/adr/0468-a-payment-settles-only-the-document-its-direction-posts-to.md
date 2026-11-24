# ADR-0468: A payment settles only the document its direction posts to, once, in that document's currency, and never by a negative amount

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-24 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0391 (settlement coverage), ADR-0466 (bill withholding settles at the net), ADR-0467 (tax remittance), ADR-0367 (no record values in refusal details; drains), ADR-0378 (a wrong figure that balances), ADR-0372 (tests that pin a defect), ADR-0419 (locked documents and lifecycle state), ADR-0441 (foreign-currency settlement) |

## Context

Register P2.20 and P2.21 recorded two ways a `Payment` could mark a document paid while the general
ledger said otherwise: an outbound payment naming an invoice, and one payment naming both an invoice
and a bill. Both were found while scoping ADR-0467. Before designing, every reader of a payment's
`invoice_id`, `bill_id`, `direction` and `amount` was mapped at HEAD `278cdf0`, and each case was run
end to end against `erp-core` through the real `compileOperateServer`.

1. **One reader interprets `direction`.** `paymentSettlementGlPostingEffect` reads it and posts to AR
   (inbound) or AP (outbound). Every other reader — the coverage guard, the application effect and
   its reopen, aging, FX revaluation, `clearedAtBookingRate`, the bill-void check and the
   bill-withholding backfill — sums by **reference** alone through one fold, `foldCompletedPayments`.
   So the posting and the readers disagreed whenever the reference and the direction disagreed.
2. **There were five bad shapes, not two.** With an invoice or bill of 100:
   - **outbound naming an invoice**: the invoice reads `paid`, the GL carries AR +100 and AP +100
     (debit), and aging drops the invoice;
   - **inbound naming a bill** — a shape neither register entry named: the bill reads `paid` with AP
     still owed and AR in credit;
   - **one payment naming both**: one `cash / AR` entry and **both** documents `paid`. This is
     implied by the first two: whatever its direction, such a payment names one document on the
     wrong side;
   - **a negative amount**: accepted, because `Payment.amount`'s `min: 0` is enforced by nothing.
     The posting skips amounts ≤ 0 while the fold counts them, so a negative row lowers the figure
     the readers see and posts nothing. `+60` then `−60` left aging at 100 open over GL AR 40;
     `+50`/`−50` on a bill let a void through with AP in debit 50;
   - **a currency other than the document's** (found by review, below).
3. **Every entry balances.** As in ADR-0378, no guard, replayer or integrity proof could see any of
   this. The harm is the divergence between the document state, aging and the GL.
4. **The intended rule was already written down.** `entities-finance.ts`'s comment on the references
   reads "one of, by direction", and nothing enforced it.
5. **Refund undoes a bad row.** Measured: refunding an outbound payment that named an invoice
   reverses its settlement entry and reopens the invoice. So there is a remedy for rows already
   stored, and it is the one path the new check must never block.

## Decision

**A completed payment counts toward a document, and may name it, only when its amount is positive,
it names exactly one document, its direction posts to that document's control side (inbound → an
invoice, AR; outbound → a bill, AP), and its currency is that document's currency. Every reader
counts exactly what the settlement posting cleared.**

### One declaration

`SETTLEMENT_COVERAGE_DOCUMENTS` (`write-guards.ts`) gains a required `settledBy: "inbound" |
"outbound"` — Invoice inbound, Bill outbound. It is the one place that says which reference settles
which document, and the guard, the fold specs, the application effects, the FX specs, `settledDocuments`
and the bill-void check are all derived from it in `compile.ts`. `PAYMENT_DIRECTION`
(`{field: "direction", inboundValue: "inbound"}`) and `paymentDirectionOf(record, direction)` — both
arguments required, fenced by a `@ts-expect-error` — are the one reading of a payment's direction.
The settlement effect calls it, and `directionField` / `inboundValue` are **removed** from
`PaymentSettlementGlConfig`, because an overridable direction field is a second spelling that could
disagree with the guard. `paymentNamesDocument(v)` (a non-empty string) is the one reading of "names
a document".

### The fold counts what the posting cleared

`foldCompletedPayments` takes required specs `{refField, settledBy}` and counts a row toward a spec
only when it is completed, its amount is positive (the posting's own skip, mirrored), its direction
equals the spec's `settledBy`, and it names the document. Specs are required, so every call site was
a compile error until updated, and each takes them from the declaration. Its "no early stop" comment
is rewritten: the reason is now that the fold returns a sum aging prints and a ceiling must be
declared, not negative corrections, since negatives no longer count. Two tests that pinned the
negative-correction behaviour as the specification are rewritten rather than deleted (ADR-0372's
class).

### The guard

`paymentAllocationGuard` (new `payment-allocation.ts`) refuses, in this order, all 422 and all literal
text with no record value interpolated (ADR-0367):

| Code | Cases |
|---|---|
| `payment_names_several_documents` | — |
| `payment_direction_mismatch` | `outbound_names_inbound_document`, `unset_names_inbound_document`, `inbound_names_outbound_document`, `inbound_inexpressible` |
| `payment_amount_negative` | — |
| `payment_currency_mismatch` | the one asynchronous check: it reads the named document |

It checks on create; on an update that changes the direction, the amount, the currency or a reference
field; and on any write entering `completed`, where the message gains " — correct it by an update
before completing it". It does **not** check refund, fail or delete. Refund is the only exit for a
stored bad row, so checking it would make every such row permanent. A zero amount, an unreadable
amount (the validator's job) and a missing currency on either side all pass.

It is wired immediately after Payment's `lockedDocumentGuard`, so a write to a completed payment
answers `payment_locked` first. It is wired **unconditionally**: not under
`--allow-uncovered-settlement`, whose hatch is about a degraded-but-recoverable state rather than a
malformed payment, and not gated on the GL being wired, because aging and coverage read the fold
either way. Whether the direction can express "inbound" at all is answered by the write validator's
own `fieldAdmitsValue`, not by an enum-only test. Review found a text-typed `direction` that the
enum test would have read as inexpressible.

### Surfaces

- A `[payment-allocation] mounted: a payment names at most one of invoice_id, bill_id, only one its
  direction settles and in that document's currency, and no negative amount` boot line, read from
  `paymentAllocationShape` so the line and the guard cannot disagree. It also says when the guard is
  not mounted, warns when the direction cannot express inbound, and has a per-tenant form on
  `onSurvey` that is silent when clean (ADR-0397).
- `deploy/README.md` gains *Upgrading to payment allocation checks (ADR-0468)*, which covers:
  - what is refused;
  - that stored rows are not rewritten;
  - which figures move at upgrade and in which direction;
  - that documents already marked paid by a bad row stay paid;
  - the remedy (refund, then record again; `mark_paid` for a document a negative row held short);
  - two read-only census queries, one per store, each verified live below.
- The stale comment in `maker-checker.ts` ("refund posts nothing" — it posts the `-REFUND` reversal)
  is corrected, and the pack comment names the guard.

## Alternatives considered

- **A fold-only fix.** Readers stop counting mis-sided and negative rows, and nothing is refused.
  That makes the figures honest and still lets new bad rows be written, each of which posts a GL
  entry that the readers then ignore. Refused: the fold is necessary for rows already stored, and the
  guard is what stops new ones.
- **A guard-only fix.** Refused because it leaves every already-stored bad row mis-counted by every
  reader, measured above, and those reads recur at every period close and on every later payment.
- **Refuse at the transition only.** Refused: a create already in `completed`, or an update changing
  a reference on a completed row, would pass. The guard checks the record as it will be stored.
- **A `payment-census` subcommand.** Refused for now. The two README queries answer the same
  question, are read-only, and were verified on both stores; a subcommand would be a second
  definition of the bad shapes that a later change to the rule could leave behind.
- **Under `--allow-uncovered-settlement`.** Refused. That hatch admits a document state that is
  degraded but recoverable. A payment naming the wrong side is malformed, and the hatch would then
  silence exactly the defect the guard exists for.
- **A DDL CHECK on `amount >= 0`.** Not taken. It is register P2.12b's general question (a contract
  refinement with no SQL counterpart), and a CHECK on a populated table with a violating row is
  reported rather than planned (ADR-0363). Every deployment that hit this defect holds such a row.

## Consequences

- A new payment cannot mark a document paid that its GL entry did not clear. The four refusals are
  each reachable by the payment writers on the shipped pack.
- **Figures on open documents move at upgrade, toward the GL.** Measured live: AR aging 230 → 200
  and AP aging 100 → 50 over the planted rows. The GL itself does not move.
- **A document already marked paid by a bad row stays paid.** Refunding the bad row reopens it. The
  census query finds the rows.
- A client sending an outbound payment against an invoice, or a negative amount, receives 422 where
  it received 201. Nothing that was correct changes.
- A deployment with a Payment entity whose direction cannot express inbound refuses every payment
  naming an invoice, and the boot line says so.

## Implementation notes

- `packages/operate-runtime/src/payment-allocation.ts`: the shape, the four-code refusal table (a
  frozen literal table whose keys equal the code union), `paymentAllocationViolation`,
  `currencyViolation`, `changesAllocation`, `entersCompleted` and the guard.
- `write-guards.ts`: `settledBy` on the declaration; `PAYMENT_DIRECTION`, `paymentDirectionOf`,
  `paymentNamesDocument`; the direction- and sign-aware fold.
- `write-effects.ts`: the settlement effect calls `paymentDirectionOf`. `settledDocumentRate` skips a
  document on the other side, which only a custom `writeGuards` can now reach.
  `SETTLEMENT_DOCUMENT_FACTS` and `withholdingStampedOf` throw for an undeclared document instead of
  silently skipping it.
- `compile.ts` derives everything above from the declaration. A both-ways test asserts that the
  guard's references, the fold specs and the wired effects are one set, for `erp-core` and for a
  manifest without `Bill`.
- `validation.ts`: `fieldAdmitsValue` over an extracted `ruleOf`.
- `apps/operate-server`: the boot line and the tenant survey in `settlement-coverage-survey.ts`, and
  the backfill's fold call.
- Review confirmed 32 findings. All were applied or declined with a reason. 17 mutations each turned
  at least one test red, with every file restored to its original md5.

## Verification

On PG 16, in compose order, with the API connecting as `crossengin_app` and the shipped compose
command, on **both** `--store pg` and `--store pg-columns`:

1. **The pre-change build planted every shape:** A (outbound → invoice), B (inbound → bill), C
   (inbound naming both), D (−30 on an invoice), a `+50`/`−50` pair V1/V2 on a bill, and a bad draft
   E. The old server accepted all of them and marked A's invoice, B's bill and both of C's documents
   `paid`.
2. **After the upgrade, the census queries found exactly A, B, C, D and V2**, and nothing else.
   - AR aging went 230 → 200 and AP aging 100 → 50.
   - The GL did not move.
3. **Six refusal arms answered 422 with the right code, and no row was stored.** The rows were
   counted both as the app role and as the owner, so the zeros are not RLS confinement.
4. **The controls were accepted:**
   - well-formed payments posted and settled;
   - a zero-amount payment, a EUR payment against a EUR invoice, and an unapplied payment were all
     accepted.
5. **Updates:**
   - a PATCH introducing a bad shape answered 422;
   - on the legacy draft E, an unrelated PATCH was accepted, `complete` answered 422 with the
     suffix, and correcting it then completing answered 200.
6. **Locked rows and voids:**
   - a write to a completed bad row answered `payment_locked`;
   - voiding the V1/V2 bill answered 409;
   - D followed by +100 settled the invoice.
7. **Every refund of a bad row answered 200** and mirrored its settlement entry. The documents
   reopened and the census was then empty.
8. **The final GL on both stores was** `{1000: 100, 1100: 450, 2000: −250, 4000: −700, 6000: 400}`,
   consistent with the open documents.

`--store pg`: all checks passed. `--store pg-columns`: 35 of 35 passed.

## Open questions

1. **The FX cent.** When a foreign-currency document's instalments straddle the upgrade, a pre-upgrade
   negative or mis-sided row that the fold now excludes can move the realized-FX figure by ±0.01.
   This is commented at `clearedAtBookingRate` and in the README, and not corrected.
2. **There is no payment shape for paying out a customer's credit balance.** An outbound payment
   naming an invoice was the only way to express it, and now it is refused. The remedy is a manual
   journal entry, and the message says to refund the original payment. A refund-to-customer shape is
   a domain decision.
3. **Legacy cross-currency rows** are counted at face value by the fold. Only new ones are refused.
4. **The guard and the fold read the literal `state` / `completed`**, not the tenant's lifecycle
   `stateField`. This is the same constant every settlement effect uses, and is correct on all seven
   packs.
5. **Unapplied cash.** An inbound payment naming no document posts `cash / AR`, so GL AR reads 70
   where aging reads 100. This is a correct posting with no document to apply it to, and it wants an
   unapplied-cash report rather than a refusal.
6. **`cash_amount`** has the same unenforced `min: 0` and is not checked here. The general fix is
   enforcing `type.min`, which is register P2.12b.
7. **No census subcommand.** The README queries are the census. If the rule changes, they must change
   with it.
8. **The OpenAPI document declares no 422 on any operation**, so these refusals, like every other
   validation refusal, are undescribed there (ADR-0392 declares 400 on list operations only).

## References

- Register P2.20 and P2.21 (`CLAUDE.md`), closed here
- `packages/operate-runtime/src/payment-allocation.ts`, `write-guards.ts`, `write-effects.ts`, `compile.ts`
- `apps/operate-server/src/settlement-coverage-survey.ts`
- `deploy/README.md`, *Upgrading to payment allocation checks (ADR-0468)*
