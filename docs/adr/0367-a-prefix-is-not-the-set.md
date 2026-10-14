# ADR-0367: A prefix is not the set

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-14 |
| **Authors** | moufaqblog@gmail.com |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0153, ADR-0332, ADR-0333, ADR-0334, ADR-0336, ADR-0338, ADR-0342, ADR-0345, ADR-0346, ADR-0353, ADR-0359, ADR-0360, ADR-0366 |

## Context

Every money reader in `@crossengin/operate-runtime` issued one `listPage` with a hardcoded `limit`
and discarded the `nextCursor` beside it. The caps differ by three orders of magnitude — 500
document lines for the tax split, 1000 journal lines, 1000 payments per document, 5000 for the FX
revaluation and the two finance reports — and `compileOperateServer` overrides none of them, so every
one runs at its default in every deployment. Nothing in `packages/` follows a keyset cursor in a
loop; the workspace's only programmatic drain is the web client's CSV export.

The item on file read *"money readers read one capped page and silently under-report past it"*. The
survey found that sentence right about six sites and wrong about seven, which write a wrong row into
the general ledger rather than under-reporting an answer — and the worst member was not on the list.

**`journalPostingGuard` is the double-entry invariant for the whole ledger, and the cap made it wrong
in both directions from one read.** Both measured against the built tree at the real default of 1000:

- **Fails open.** A 1001-line entry, true totals debit 59 999 / credit 50 000, unbalanced by 9999,
  whose first 1000 lines happen to balance → the guard returns `null` and the entry **posts
  unbalanced**. A balancing prefix is the ordinary shape here rather than a contrivance, because
  every GL posting effect writes its lines as a balanced group and `journalReversalEffect` mirrors
  them pairwise.
- **Fails closed, wrongly.** A genuinely balanced 1001-line entry (1000 debits of 10, one credit of
  10 000) → `422 unbalanced_journal_entry: debits (10000.00) must equal credits (0.00)`. A false
  refusal of correct data, whose detail is a lie about the entry.

So the verdict was a function of which arbitrary 1000 of the lines came back: neither sound nor
complete. The field's own doc comment said *"a single entry should be well under this"* — an
assertion with nothing behind it, and false for the two sources the entity model names, since
`JournalEntry.source` enumerates `payroll` and `depreciation` and both jobs are declared. A payroll
run for 5000 employees at five lines each is 25 000 lines. **The cap sat below an artifact the
manifest had already committed to.**

### The measurement that decides the design

One site read safest, and it is the reason there is exactly one rule rather than a per-site
judgement. `paymentApplicationEffect` sums completed payments against a document and settles it once
they cover the total, so an under-reported sum can only *fail* to settle — losing a capability and
misstating nothing. That argument rests on payments being non-negative, which rests on
`Payment.amount`'s declared `min: 0`.

**Nothing in the workspace enforces a `min`.** `FieldErrorCode` is
`"required" | "type" | "enum" | "maxLength" | "precision"` with no range member, the derived
`FieldRule` carries no range field either, nothing in `validation.ts` reads a min, and the emitted DDL
carries no CHECK. `type.min`/`type.max` are **read in exactly two places**, both in
`kernel/ddl/diff.ts`, and both only to throw when the declared value *moves* — nothing reads them to
validate a value. So the premise was a declaration nobody checks, and the conclusion is false. Measured:
an invoice of 400 with three payments of 200 and a correction of −300 — true applied **300** — is
written **`paid`, with a `paid_at` stamp**, at a cap of 3, and correctly left `sent` at a cap of 99.

That is the worst outcome in the census, because nothing downstream can see it: the write sets
`state: paid` directly through the store, bypassing the issued-document lock by design, so the
document reads settled and drops out of **both** the aging report and the FX revaluation's open set.
A live receivable disappears from the books.

The same gap flipped the other "safe" verdict. `recognitionGlPostingEffect`'s tax split *does* fail
safe on its ordinary path — the gate reconciles `breakdown.netTotal + breakdown.taxTotal` against the
document's own header total, so a short prefix fails it and the posting falls back to the document's
subtotal and tax. But `withholdingTotal` is not in that reconciled quantity, and the code says so in
its own comment: *"withholding is a contra, not part of total"*. A truncated set whose dropped tail
nets to within `EPSILON` of zero therefore passes the gate and applies a truncated withholding figure
to the control line, the WHT line and the document stamp. Measured with a dropped tail of
`{+1000 withholding-coded, −1000 untaxed}`: `AR 360 / Revenue 400 / Withholding 40, stamped 40`
against the full set's `AR 260 / Revenue 400 / Withholding 140, stamped 140` — AR overstated by 100,
the WHT line understated by 100, the stamped figure (which prefills a certificate and feeds the WHT
reconciliation report) wrong by 100, **and both entries balance.** A negative `line_total` is
strictly required to reach it, and `InvoiceLine.line_total` declares `min: 0`.

## Decision

**A prefix is not the set, whatever is in the tail.** Every money read drains its cursor to a declared
ceiling, and no site may argue its way to an exception by reasoning about whether a dropped term could
be negative, or by leaning on a `min` or a `unique` that nothing checks. Reasoning site by site is
precisely what produced the one wrong verdict in the survey.

`drainList` in `list-drain.ts` is the primitive: it loops on `nextCursor !== null`, hands each page to
an `onPage` fold, and returns `{complete, records, pages, haltedBy?}`. `onPage` rather than a returned
array, because the caller decides what it holds — the balance guard folds two running sums over an
entry of any size, the reports fold payments into a per-document map, and only the two
mirror-the-rows effects need the records themselves. There is deliberately **no early stop**: a caller
summing toward a threshold cannot halt when it crosses one, because a later page may carry a negative
term that takes it back under, which is the measured defect above rather than a hypothetical.

**Each site keeps its config field — `maxLines`, `maxRows`, `maxPayments` — and the field changes
meaning** from "read this many rows" to "read up to this many, and report rather than truncate past
it", with the doc comment saying so. Not renamed: a rename would fill the diff with renames and hide
the behaviour change, and the name is honest under both meanings.

**What the ceiling does when it is reached is a property of the position, not of the site**, and
`READ_CEILING_EFFECT` is a total map over three so a fourth has to say what it does rather than
inherit whichever branch a chain ended on:

- a **guard** `refuses`, because a decision from a prefix is not a decision. `journalPostingGuard`
  needed no new mechanism — it is a `WriteGuard` already answering 422 three times in the same
  function — so it gained a fourth, `unverifiable_journal_entry`;
- an **effect** `aborts`, throwing `ReadCeilingExceeded`, because a row written from a prefix is a
  wrong row that balances. The throw is sufficient rather than merely available: effects run inside
  the handler's own transaction, so it rolls the document, the entry and the lines back together;
- a **report** `declares`, carrying `complete: boolean` and `bounded: readonly string[]`, because a
  bounded reading that says how far it looked is honest where silence is not — and an aging report
  over the first N open documents is still the only view an operator has, where a "probably balanced"
  verdict and a "probably right" GL row are not degraded versions of the real thing.

The report arm is convergence rather than invention: `usage-handler.ts` already emits
`overflow: len > probeCeiling` beside `used`, and `read-state-routes.ts` sets
`truncated = page.nextCursor !== null`. Both fields are **always present**, happy path included,
because an absent field reads as *nobody looked* — ADR-0331's distinction, in a response body.

**Two sites are not drained, because they are not scans.** `lookupPeriodEndRate` read up to `maxRows`
exchange rates for one currency pair with `sort: []` and then picked the latest `rate_date <= endDate`
in JavaScript — and because `sort: []` leaves `ORDER BY <id> ASC` and ids are time-ordered, the page
keeps the **oldest** rates and drops the newest, exactly the ones nearest the period end. Past the cap
it returned a stale rate and multiplied the entire revaluation by it. It asks the right query now:
`lte` on the date, `direction: "desc"`, `limit: 1`. Exact, one row, and strictly better than draining
5000. And `resolveAccountId`'s `?? page.records[0]` positional fallback is dropped, converging on its
sibling `resolveCurrencyId`, which declines instead — not latent, because ADR-0360 measures the
document store enforcing **0 of 32** unique declarations and `--store pg` is the compose default, so
two `LedgerAccount` rows can share an `account_code` there and `limit: 1` with `sort: []` returns an
arbitrary one.

### The prerequisite, which is the increment's own class one level down

**A drain on `InMemoryEntityStore` was unsound, and the reasoning that made it look sound was the
reasoning this ADR exists to refuse.** The sort's tiebreaker fell through to
`compareValues(a.id, b.id)` — decimal-aware, then instant-aware, then `localeCompare` — while
`isAfter`'s last clause was a raw `String(row.id) > cursor.id`. Both facts are plainly true of the
file and they are *why it is unsound*, not why it is sound: two orderings of one tiebreaker. Measured
on the pre-change build with `sort: []`:

| ids | `limit` | result |
|---|---|---|
| `rec_m1a0001` … `rec_m1a0005` | 2 | sound, 5 of 5 |
| `["9","10","11","8","100"]` | 2 | visited `["8","9"]` — **3 of 5 silently dropped** |
| `["Zebra","apple","Bravo","cherry"]` | 2 | **the same cursor twice** — a walk that never terminates |

House-minted ids are fixed-width (`rec_` plus a base-36 clock and a counter zero-padded to four
digits), so the two orderings agree on them, which is why it went unnoticed. A client-supplied `id`
reaches the disagreement and nothing strips one: `validateBody` iterates the declared-field plan, so
an unknown `id` key is never examined, and the create handler passes the body through.

`compareIds` is the one comparator both halves use, and it is plain lexicographic rather than
`compareValues` for two reasons, the second decisive. Both Postgres stores order and seek on a TEXT
id column under one collation — `ORDER BY <id> ASC` appended unconditionally, and `<id> > $n` in the
seek — so matching them is what keeps three implementations of one contract agreeing about row order,
which is the rule `store.ts` already states for the `NULLS LAST` placement. And `compareValues` is
**not a total order on ids**: its decimal arm answers 0 for `"0"` and `"00"`, so two distinct ids
would compare equal and the tiebreaker would fail to break the tie.

So the recurring rule holds for the tenth time: **the honest fix sits one level up from where the
pain was felt.** The pain was nine truncating reads; one level up is a drainer; and the drainer is
sound only after the comparator below it became one comparator.

## Alternatives considered

- **Drain with no ceiling.** Every figure correct, no refusal to design.
  - **Why not:** this is the shape ADR-0345 refuses. That ADR rejected "re-fill to `limit`" on the
    measured ground that it makes the work per request a function of the policy's selectivity — *"a
    denial of service reachable from a manifest declaration"*. The argument does not reach a bounded
    drain on its own terms, and the distinction is worth stating because it is what makes the ceiling
    non-optional rather than cautious: ADR-0345 **had a sound cheaper alternative** and said so (the
    store's cursor untouched, *"every row is examined exactly once, the total work across a walk is
    unchanged"*), so re-filling spent unbounded work to preserve a cosmetic property. Here there is
    no cheaper alternative — the untruncated answer requires the set, so a drain's work *is* what
    correctness costs. And the bound differs in kind: ADR-0345's was `limit`/selectivity, a quantity
    the request never names that a declaration can make arbitrarily bad with no change to the data,
    paid per page of every walk; a drain's is `|set|`/`pageSize`, determined by the data and paid
    once. But the *generalisation* reaches a drain, which is exactly why the ceiling is not optional.
    A ceiling-less drain is the shape ADR-0345 refuses; a bounded one is not.
- **Probe and refuse: read `cap + 1`, refuse if the extra row arrives.** Cheapest, one round trip,
  and it matches the two existing probes.
  - **Why not:** `cap + 1` is exact for a *cardinality* question and for no figure. ADR-0153 states
    the exactness as a biconditional over counts — `entitlement.ts` asks `length >= cap` and
    `usage-handler.ts` asks `len > probeCeiling`, both questions about how many rows exist — and no
    bounded prefix answers a question over values. So it answers every refusal *trigger* here
    exactly, and it would turn a 1001-line payroll entry into a refusal where a drain posts it
    correctly. It is the honest minimum rather than the right answer, and the ceiling arm *is* this
    shape: the drain stops and says so.
- **A SQL-side `sum`/`aggregate` on `EntityStore`.** Correct and cheap for the threshold cases.
  - **Why not:** four measured grounds, and it is refused *for this increment* rather than in
    general. It closes **no** report site, because each report is a pair of reads and only one half
    is an aggregate — and that half is a *grouped* aggregate, while the other half is the rows
    themselves, since `computeAging` buckets documents by due date and `computeWhtReconciliation`
    renders one row per invoice. It is not O(1) either: no declared index is emitted anywhere, so the
    aggregate is a sequential scan. It touches ~19 exhaustive `EntityStore` positions, including the
    hand-written `guardPlaintextEntities` wrapper. And its return value crosses the ADR-0332 decimal
    boundary **in both directions** — there is no `setTypeParser` in the repo, so node-postgres hands
    back `NUMERIC` as a string while the in-memory store would return a number, and
    `withDecimalWireType` normalises per *record* so it would never see a scalar. That is the exact
    defect ADR-0332 found, whose live consequence was a partial credit note silently becoming a full
    one. It remains the right answer for the two reports and is the top follow-up.
- **Keep the caps and only declare the truncation everywhere.** One field per site, no drain, no
  prerequisite.
  - **Why not:** right for a report and wrong for the rest. `declares` is a usable answer because a
    bounded reading is still a reading; a declared "this balance verdict may be wrong" is not a
    verdict, and a GL row stamped "this amount may be wrong" is not a posting.
- **Route the effects' writes through the write guards**, so a truncated reversal would be caught.
  - **Why not:** measured, it would stop seven effects working. The reversal entry is created
    `posted` *before* its lines are written, so `postedEntryImmutabilityGuard`'s child branch refuses
    **every** line with `422 posted_entry_locked_lines`, not merely a truncated one — and the same is
    true of all six other GL posting effects and of the credit-note lines. It would not even catch
    the thing it was reached for: `journalPostingGuard`'s balance arm derives
    `entryId = input.id ?? after["id"]`, both absent on a create, so it is **structurally dead on
    every create path**. Verified: a create carrying `state: "posted"` and zero lines passes it.

## Consequences

- **Positive.** Every money figure is computed over the whole set up to a declared ceiling, and past
  it says so instead of guessing. The ledger's balance invariant stops being a function of an
  arbitrary prefix in either direction. The FX revaluation stops posting a wrong gain or loss that
  balances. A document stops being marked `paid` for less than its total. The WHT report stops
  returning an empty reconciliation under a 200. And one latent non-termination in the in-memory
  store is closed, with the two orderings it had collapsed into one.
- **Negative.** Round trips scale with the set: at `pageSize` 500 a ceiling of 50 000 is up to 100
  round trips and 100 000 is up to 200, and seven of these sites run inside a write transaction on a
  pool whose `max` is unset (pg-pool defaults to 10) with no `statement_timeout`,
  `query_timeout` or `idle_in_transaction_session_timeout` anywhere in the tree. The two
  mirror-the-rows effects and the two reports still retain rows: measured from the real pack, the
  widest money record is `Invoice` at **777 bytes** of JSON, so a report at its ceiling holds tens of
  MiB. A ceiling refusal from an effect is an undiagnosable 500 beyond its name, because the handler
  layer still has no recorder (ADR-0359's open end). And the ceilings are reachable by no CLI flag,
  no manifest field and no environment variable, so the refusals deliberately name no remedy —
  ADR-0334's rule, since a remedy that cannot work is worse than naming none.
- **Neutral.** `maxLines`/`maxRows`/`maxPayments` keep their names and change meaning. A deployment
  that set one deliberately now gets a refusal or a declaration where it got a silent truncation,
  which is the direction this repo prefers.
- **Reversibility.** High per site: each is a `drainList` call that could become a `listPage` again.
  The `compareIds` convergence is not reversible without reintroducing a measured non-termination,
  and should not be.

## Implementation notes

### The ceilings, and the measurement behind each

Measured from the real `buildErpCorePack()` entities with every declared field filled for its kind
plus the four `auditable` trait columns, serialized as JSON: `ExchangeRate` 423 B, `InvoiceLine`
488 B, `BillLine` 490 B, `WhtCertificate` 577 B, `Bill` 579 B, `JournalLine` 608 B, `Payment` 704 B,
**`Invoice` 777 B**. The heap cost is decided by the **fold**, not by the ceiling: the guard and the
payment sum are O(1) whatever the set, the FX revaluation is O(currencies) plus O(documents with
payments), and only the two mirror-the-rows effects and the two reports retain rows.

| site | was | is | why |
|---|---|---|---|
| journal lines (guard, reversal) | 1000 | 50 000 | a 5000-employee payroll run is 25 000 lines, and both jobs are declared |
| document lines (credit note, tax split) | 1000 / 500 | 50 000 | one population carried two different caps, which was itself a finding |
| payments per document | 1000 | 10 000 | O(1) fold, so the ceiling costs only round trips |
| FX revaluation (two reads) | 5000 | 100 000 | lifetime-cumulative: no purge or archive job for `Payment`, `WhtCertificate` or `ExchangeRate` exists in any pack |
| aging, WHT reconciliation | 5000 | 20 000 | bounded by the **response**, not the fold — see below |

**The report figure is a correction to this increment's own brief.** It was briefed at 100 000 on the
same lifetime-cumulative argument, and that is wrong for a reason in the report contracts rather than
in the heap: `AgingReport` carries `documents: readonly DocumentAging[]` beside its `totalsByBucket`
and `totalOpen`, and `WhtReconciliation` carries `rows: readonly WhtReconRow[]` beside its `totals`.
Both return a row per document, so the ceiling bounds the HTTP response — 100 000 × 777 B is a
~74 MiB body where today's 5000 is ~3.7 MiB. 20 000 is a 4× correctness gain for every tenant between
the two figures at ~4× today's response, and past it the answer is `complete: false` with the bounded
reads named. That is the point: **the figure was wrong because it was silent, not because it was
bounded.** It also sharpens the follow-up — these two surfaces want the aggregate over *everything*
and the rows over *a page*, which is two reads, and a grouped SQL aggregate is exactly what buys it.

### Ordering inside the guard

`unverifiable_journal_entry` sits between the empty-entry check and the balance verdict, and the
`empty` arm gained a completeness conjunct (`lines === 0 && read.complete`). An unread set is not an
empty one — a store that ignored the filter could exhaust the ceiling on other entries' lines and
match none of this entry's — and with the conjunct the two cases partition, so swapping the blocks is
behaviour-identical and dropping it would make the guard call an entry with lines empty.

### Nothing is written before the read, and the transaction is not why

The tempting argument for a throw being enough is that effects run inside the handler's transaction,
so a refusal rolls everything back. It is **false as a general claim**, and an adversarial pass on
this increment's own first commit found it: `writeTxn` falls through to `body(ctx.store)` on a store
that is not transactional, and the two mirror-the-rows effects wrote their document header *before*
their own line read. Measured on that shape — a 5-line reversal at `maxLines: 3` driven outside a
transaction — the throw left a second posted entry behind with no lines, and a retry left a third. A
refusal that leaves a posted entry is the defect the effect was being fixed for, arriving by a
different door.

So both now derive their line payloads first, refuse, and only then write the header and stamp the
new parent's id onto each payload. Every other effect already read before it wrote. "Nothing was
written" is therefore a property of each effect rather than a promise about the caller's store, which
is what lets the 500 body say it.

The same pass caught the other half: four of the six `computing` strings interpolated a value from a
stored record — a document number, a period label, and once a record **id** — in a message
`writeTxn` puts straight into a 500 body, under a comment of mine authorising that on the grounds
that the refusal carries "no row, no value, no tenant". All six are literals now, and the claim is
pinned by a test that reads the construction sites as text and refuses a template literal, with a
vacuity floor so a matcher that stopped matching cannot pass having examined nothing.

### The drain's two fences

A row ceiling alone does not bound the loop, because an empty page with a non-null cursor is legal by
contract. `DrainDidNotTerminate` therefore covers two store faults — a cursor returned twice
(`cursor_did_not_advance`) and a page budget exhausted (`page_budget_exhausted`) — and both are loud,
because they mean the store is not advancing through its own keyspace rather than that the set is
large. The budget is `ceil(ceiling / pageSize) + 9`, and the whole of it is slack for one reason: a
store handing back short or empty pages makes progress through its keyspace without spending row
budget, so a set it reads in full can take more round trips than the division allows, and without the
slack the budget would refuse a healthy drain.

It is **not** what separates *exactly `ceiling` rows, and that is all of them* from *`ceiling` rows
with more behind them*. An earlier draft of this ADR and of the code comment beside it both claimed
that, and the measurement refuted both: cutting the budget to a bare `ceil(ceiling / pageSize)` leaves
those two cases answering exactly as they do now, and breaks only the short-page case. What separates
them is that `records >= ceiling` is tested at the top of the loop *before* the page budget, together
with the `nextCursor` of the page that exhausts the ceiling — both cases read the same rows in the
same number of pages, so the distinction lives in no count at all.

At the store level a short page does imply a null cursor — all three implementations read `limit + 1`
and derive `hasMore` from the overflow — but that is an implementation detail of three expressions
rather than the contract, and a wrapper that filtered rows would break it. The loop reads the cursor
and never the row count.

### What was deliberately not changed

- `type.min` / `type.max` are enforced by nothing — **81 fields in `erp-core` alone** declare one.
  That is the reachability argument for two members above, and it is register P1.2's class in a money
  column. It needs a `FieldErrorCode` member, a `FieldRule` field and a DDL CHECK: its own increment.
- `field.indexed` and `entity.indexes` are authored, merged across lineage, hashed into
  `manifestHash`, resolvable by `computeResolvedIndexes` — whose only caller is the structural diff —
  and **emitted by nothing**. `entity-ddl.ts` emits exactly three index kinds and `EntityTablePlan`
  carries no index field at all. Measured: **162 `indexed: true` + 50 `indexes:` blocks in
  `erp-core`, 219 + 67 across the seven packs.** This is ADR-0360's `unique` finding one declaration
  over, and it is why `lookupPeriodEndRate`'s rewrite is *exact* but not *O(1)*.
- `journalPostingGuard`'s balance arm is structurally dead on every create, so
  `POST /v1/journal-entrys {state: "posted"}` with zero lines passes it. Confirmed, and deferred by
  the plan's own ordering to the increment that owns the decision-and-write split.
- `paymentApplicationEffect` sums payments without consulting `direction`, which the settlement
  config declares, so an outbound payment carrying the same `invoice_id` is counted toward settling
  it. Independent of truncation, and the one fact its former fail-closed claim quietly rested on.
- `lookupPeriodEndRate`'s filter omits `rate_type`, which has four enum values, so the selection
  among same-date rate types is arbitrary. Adding it would change which rows are candidates, which is
  a domain decision.
- `computeAging` uses `asOf` only for `daysBetween`, while the payments and the open-document set
  carry no date bound at all — so `?asOf=` in the past subtracts payments made after it, and a
  document paid in full after it is excluded entirely. Both understate a historical snapshot,
  independently of truncation.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A grouped SQL aggregate for the two reports: the totals over everything, the rows over a page. Refused here on four measured grounds, wanted for exactly these two surfaces. | platform | _unscheduled_ |
| No flag reaches any ceiling, so every refusal names no remedy. One flag per site is nine; one shared flag is wrong because the sites differ in kind. | platform | _unscheduled_ |
| A recorder seam on `HandlerContext`, so an effect's ceiling refusal is diagnosable beyond its name (ADR-0359's open end, now with a second caller). | platform | _unscheduled_ |
| Nothing bounds the fleet: a ceiling bounds one request, and the pool's `max` is unset with no statement timeout anywhere. | platform | _unscheduled_ |
| The two mirror-the-rows effects still retain a document's children. Streaming the reversal's line creation per page would make them O(1) too, at the cost of interleaving reads and writes on one table. | platform | _unscheduled_ |

## References

- ADR-0153 — the `cap + 1` probe and its cardinality biconditional.
- ADR-0332 — the `decimal` wire type, and why a scalar aggregate would cross it.
- ADR-0333, ADR-0334 — the two historical non-terminating walks, and the remedy rule.
- ADR-0345 — the keyset cursor passed through untouched, and the refusal of re-filling to `limit`.
- ADR-0346 — cursor sealing at the handler boundary, which is why a store-level drain sees plaintext.
- ADR-0359 — which-rows versus their-order, and the missing recorder seam.
- ADR-0360 — `unique` emitted at last, and the 0-of-32 measurement on the document store.
