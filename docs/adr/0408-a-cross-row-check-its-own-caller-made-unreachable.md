# ADR-0408: A cross-row check its own caller made unreachable

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Authors** | CrossEngin platform team |
| **Reviewers** | CrossEngin platform team |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0289, ADR-0322, ADR-0331, ADR-0337, ADR-0362, ADR-0363, ADR-0372, ADR-0375, ADR-0389, ADR-0403, ADR-0405, ADR-0407 |

## Context

ADR-0407 closed a read-order defect in `proveScopeIntegrity` and, while doing so, surveyed the class
for other members. The survey is recorded as register item **P2.17** and names three sites plus a
structural root. This increment works that item, and the first thing it did was re-measure it — which
is the standing rule this run has paid for eight times (register P3.1).

The re-measurement **refuted all three clauses of the item's first member** and replaced them with
something sharper. P2.17 said:

> `AccessReviewReplayer.replayCampaign` reads the item set before the decisions it must contain and
> fails OPEN behind an `if (item !== undefined)` guard, which also makes a genuinely orphaned
> decision unreportable — and it is wired, through `operate-server replay --access-reviews`.

The guard is real and the wiring is real. What is not real is the premise that the guard was hiding
anything.

### Both cross-row checks in `verifyDecisionRowShape` were structurally unreachable

`replayCampaign` is the function's **only** non-test caller (censused: one site). It read

```ts
const items = await this.stores.itemStore.listByCampaignWithUnreadable(tenantId, campaignId);
const decisions = await this.stores.decisionStore.listByCampaignWithUnreadable(tenantId, campaignId);
const itemsById = new Map(items.records.map((it) => [it.id, it] as const));
…
issues.push(...verifyDecisionRowShape(decision, itemsById.get(decision.itemId), campaign));
```

and the function guarded two findings behind `if (item !== undefined)`:

**`decision_item_mismatch`** compared `decision.itemId !== item.id` — a **map key against the value
used to fetch it**. `itemsById.get(decision.itemId)` either misses, in which case the guard skips, or
returns the entry stored under that very key, in which case `item.id === decision.itemId` by
construction. It could not fire from any caller that resolves the item by the decision's own
reference, which is the only way a caller would get one.

Nor is there a weaker question underneath it. `DecisionRow.item_natural_id` comes from
`i.item_id` of the row joined `ON i.id = d.item_id`, so the reference's integrity is the join's; the
`item_id` foreign key is `ON DELETE CASCADE`, so an orphan cannot persist; and the read is an INNER
JOIN, so one could not be read if it did. P2.17's clause *"which also makes a genuinely orphaned
decision unreportable"* is therefore **true and vacuous** — the row it describes cannot exist, and
the live run measured **0** decisions with no item row.

**`decision_campaign_mismatch`** compared `decision.campaignId !== item.campaignId`, which is a real
question — `d.campaign_id` and `i.campaign_id` are two independent foreign keys into
`meta.access_review_campaigns` with no constraint relating them, and no CHECK on the table mentions
either. It was unreachable for a different reason, and the reason is the caller's own filters. Both
reads carry `WHERE c.campaign_id = $1`, but against **different** campaign joins:

- the decisions read joins `ON c.id = d.campaign_id`, so it returns a decision iff the decision's own
  campaign is the asked-for one;
- the items read joins `ON c.id = i.campaign_id`, so it returns an item iff the item's campaign is.

A mismatch means exactly one of those holds. So whenever the decisions read returns a mismatched
decision, its item is in the other campaign and is **absent from `itemsById`** — permanently, not
because of a window — and the guard skips. And whenever the items read would return the item, the
decision is not in the decision set at all.

**This makes P2.17's "fails OPEN" diagnosis wrong in a way that matters.** A fail-open guard hides a
finding that would otherwise be made; here there was no finding to hide, and the read order the item
flags as inverted costs nothing, because reordering two reads cannot make a comparison answerable
that neither read's population can express.

### Measured live rather than reasoned

PG 16 on a throwaway cluster, bootstrapped from the real `emitMetaBootstrapSql()` (983 statements, 0
failed — ADR-0402's figure, reproduced), seeded through the **real** stores as the **non-owner**
`serving` role (`serving owns access_review_decisions? false`, `row_security_active true`), with
records parsed by the real contract schemas. A decision in campaign A naming an item in campaign B,
plus a consistent control in each campaign:

```
--- what the database holds (the mismatch is real) ---
  ard_ctrlaaaa   d.campaign=arc_aaaaaaaa  i.campaign=arc_aaaaaaaa  mismatch=false
  ard_ctrlbbbb   d.campaign=arc_bbbbbbbb  i.campaign=arc_bbbbbbbb  mismatch=false
  ard_mismatch   d.campaign=arc_aaaaaaaa  i.campaign=arc_bbbbbbbb  mismatch=true

--- replayCampaign: the ONLY caller of verifyDecisionRowShape ---   (pre-fix)
  arc_aaaaaaaa   items=1 decisions=2 complete=true issues=[-]
  arc_bbbbbbbb   items=2 decisions=1 complete=true issues=[-]

--- one query over both tables, per campaign ---
  arc_aaaaaaaa   mismatches=1 ard_mismatch -> item in arc_bbbbbbbb
  arc_bbbbbbbb   mismatches=0
```

Neither campaign reports it, and the mechanism is in the output: `arc_aaaaaaaa decisions whose item
did NOT resolve: ard_mismatch`. One query over both tables answers it for the decision's campaign.

### Why nothing caught it, which is the reusable part

Two tests pinned both kinds as the specification, and each handed the function a pair its only caller
cannot construct — `makeItem({id: "ari_00000099"})` beside a decision naming `ari_00000001`, and
`makeDecision({campaignId: "arc_00000099"})` beside an item in `arc_00000001`. Both prove the
predicate over hand-built inputs and neither says anything about reachability.

**That is ADR-0362's retired-test shape, in the one function whose own doc comment narrates it.**
Twenty-five lines above the signature sits that increment's account of the third check in the same
function:

> The check read … and the third conjunct depends on nothing in the decision … so it is the constant
> `false` and the finding **could not be emitted in any deployment**. Its own test never asserted it
> fires, so nothing noticed.

The rule was written down and the two checks beside it were not re-asked. So this is not a class with
one more member; it is the same member's two siblings, left standing by the increment that found it.

### The other two members of P2.17

`DeletionReconciler.auditDeadlines` reads the four non-terminal statuses and then the absorbing
`rejected` one, concatenating both into one reporter and summing `examined`. A request rejected
between the two reads is `submitted` at the first and `rejected` at the second, so it is **reported
twice and counted twice**, against the disjointness `auditCompleted`'s own comment claims. Each store
read opens its own `conn.transaction` and a bare `BEGIN` is READ COMMITTED, so there is nothing above
the two reads that could make them one snapshot.

`WorkflowReplayer.verifyInstance` compares `stored.sequence_cursor !== expected.sequenceCursor`, an
**equality**, which forges under both orders — compounded by `ProjectingEventLog.append` writing the
event and its projection as two statements with no transaction, so the projection is *expected* to
lag. It is latent: `workflow` is declared in `REPLAY_SUBSYSTEMS` and `REPLAY_SCOPE_SUPPORT` and has
**no runner**, answering `"workflow has no runner wired in this build"`.

### The snapshot primitive, measured

P2.17's structural root is that `SET TRANSACTION ISOLATION LEVEL` and `REPEATABLE READ` appear **zero**
times across `apps` and `packages` and `conn.transaction` is a bare `BEGIN`, so every multi-read
"transaction" is READ COMMITTED. The blocker on file — *the level must be set before `set_config`,
which `withTenantContext` issues first* — was measured on PG 16.15 as the non-owner:

| arm | result |
| --- | --- |
| bare `BEGIN` + `set_config`, concurrent commit between two reads | `read1=1, read2=2` |
| `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` after `set_config` | `ERROR: … must be called before any query` |
| `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ` + `set_config` | `level=repeatable read`, `read1=2, read2=2` |
| `… REPEATABLE READ READ ONLY`, 41 concurrent write batches, 3 reads | stable, **no 40001** |
| snapshot held open | 18,001 dead tuples unreclaimable; 0 once closed |

So the blocker is **real for `SET TRANSACTION` and dissolved by setting the level on the `BEGIN`
itself**, and `READ ONLY` makes serialization failure structurally unreachable for a pure reader. The
cost is a pinned vacuum horizon, which `pg_stat_activity.backend_xmin` attributes.

**And it is necessary but not sufficient, which is what decided this increment's shape.** None of the
three sites shares a transaction across its two reads: each access-review store read wraps itself in
its own `withTenantContext`, `unanswered` and `rejectedAfterDeadline` each open their own
`conn.transaction`, and `instance-store.ts` uses bare `this.conn.query`, which goes through
`pool.query` and so takes an arbitrary client per call. A snapshot primitive fixes nothing at any of
them without restructuring the call site as well. The engineering cost is also dominated by the
fakes: 128 test files type something as `PgConnection` and 138 declare a `transaction:` member, so a
required fifth *method* is unshippable, while an optional *parameter* costs them nothing by
contravariance and makes the snapshot unobservable in tests — ADR-0389's discarded-callback class.

## Decision

**Close each site by the cheapest correct means, and record the primitive with its measurement
rather than building it.**

### 1. The access-review mismatch moves into one statement; the other check is deleted

`PostgresAccessReviewDecisionStore.campaignMismatches(tenantId, campaignId)` answers
*which decisions of this campaign have an item in another one* over four joined relations in one
`SELECT`, with the tenant predicate on each. It returns `DecisionCampaignMismatch
{decisionId, itemCampaignId}` — two business keys read straight off columns, with the decision's
*claimed* campaign deliberately absent because it is the question the caller asked.

`decision_item_mismatch` is **deleted outright** — from the enum, from the function, and with its
refutation written at the site. A judgement with no case left is not a judgement (ADR-0375).

`verifyDecisionRowShape` therefore loses its `item` parameter rather than keeping one nothing reads:
a parameter no longer consulted invites the next caller to believe a cross-row check is made there.
That change is a **compile error at every call site**, which is how all nine were found.

### 2. `auditDeadlines` de-duplicates on the request id, keeping the current order

`new Map<string, GdprDeletionRequest>` filled waiting-first then refusals-last, so a request that
moved between the reads is assessed **once**, under the status it ended at. `examined` is the map's
size.

### 3. `WorkflowReplayer.verifyInstance` is recorded, not fixed

## Consequences

### What moving the comparison into SQL buys beyond reachability

It is **not** a read-order fix, and saying so is the point: reordering the two reads cannot help,
because the absence is produced by the two WHERE clauses rather than by an interleaving. Asking it in
one statement is strictly better than ordering two — a predicate evaluated in a single snapshot has
no order to get wrong, which is ADR-0407's rule read forward. A decision committed after the read is
simply not covered yet, the conservative direction, and the next pass catches it.

It also makes the finding **conclusive** where the old one was inferential (ADR-0322's axis). Nothing
is parsed to produce it, so no refused row can weaken it: a `complete: false` replay still states it.
`ACCESS_REVIEW_DRIFT_ISSUE_KINDS`' doc comment is corrected accordingly — it listed
`decision_campaign_mismatch` among the findings an unreadable row turns into an inference, which has
stopped being true of it.

### Why de-duplicating is the fix at the second site and reordering is not

That site is a **partition** rather than a containment, so ADR-0407's directional rule does not reach
it. Read waiting first and the window produces a duplicate; read the refusals first and the same
window produces a **miss**, because the request was not yet rejected at the first read and is no
longer waiting at the second. Keeping the order and dropping the duplicate answers every
interleaving. Mutation-checked both ways: removing the de-dup fails exactly one test, and inverting
last-wins fails two.

`auditCompleted`'s own disjointness comment is narrowed rather than left: the status sets really are
disjoint **per snapshot**, and because these are two passes on two cadences a request that completes
between them reaches `reportDeadline` from each under a *different* standing. That is two true
statements about two moments rather than a double-report, which is why nothing is de-duplicated
across the passes.

### The fake answered the wrong query's row, and this change made it reachable

`connFor`'s branch order matched `FROM meta.access_review_items i` and then
`FROM meta.access_review_decisions d` — and `campaignMismatches`' statement begins with the second.
So the mismatch probe was handed the **list's** rows and mapped them to
`{decisionId, itemCampaignId: undefined}`, inventing a `decision_campaign_mismatch` on every replay.
That is ADR-0363's defect verbatim — a shape match that is **true of** the statement rather than
**specific to** it — found by the three tests it broke rather than by reading. The branch is now
first and keyed on `d.campaign_id <> i.campaign_id`, the one predicate no other read in the package
carries, and `connFor` takes its own row list for it.

### Measurement defects of mine, each caught by a control

**The raw reads in the live harness set no tenant context**, so RLS confined them and the
cross-check printed `mismatches=0` with an empty "what the database holds" block — while the replayer
read the same rows fine, because its stores set the context inside `withTenantContext`. I was one
step from reporting the probe's silence as the subject's. The tell was free: the control block was
*empty*, which no arrangement of the subject could produce. The three raw reads go through a `scoped`
helper now, and the store test pins that `campaignMismatches` sets the context.

**The mutation harness refused all six mutations on garbage counts.** `grep -F -c` with a multi-line
pattern treats the newline as an OR between patterns and counts matching **lines**, so `count()`
answered `0\n0` for an absent string and `3` for a two-line one. A harness that reports a refusal it
did not establish is this increment's own class. Counting is done in python now.

### The six mutations

| mutation | typecheck | tests failed |
| --- | --- | --- |
| M1 the mismatch read dropped from `replayCampaign` | 0 | 3 |
| M2 the fake's branch no longer specific | 0 | 4 |
| M3 one tenant predicate dropped from the query | 0 | 1 |
| M4 the mismatch read loses its tenant context | TS2322 | 16 |
| M5 the comparison inverted to equality | 0 | 7 |
| M6 the `item` parameter restored, unread | TS2345 **TS2578** | 3 |

M6 is the one worth keeping: restoring the parameter makes the test's `@ts-expect-error` **unused**,
which `tsc` reports as `TS2578` — so the fence is the directive rather than an assertion about it.
Deliberately not `verifyDecisionRowShape.length`, which counts an optional parameter and answers 2
either way; that was my first attempt and it failed, which is how the better fence was found. All six
reversed by the same string replacement, tree byte-identical afterwards by md5.

### Verified live, both arms, on one cluster as the non-owner

| campaign | pre-fix | post-fix |
| --- | --- | --- |
| `arc_aaaaaaaa` (the decision's own) | `issues=[-]` | `issues=[decision_campaign_mismatch]` |
| `arc_bbbbbbbb` (the item's) | `issues=[-]` | `issues=[-]` — correct, the decision is not in it |

with the mechanism visible in **both** arms (`decisions whose item did NOT resolve: ard_mismatch`),
which is what shows the pair never had a chance rather than having been ordered wrongly.

## Alternatives considered

**(A) Reorder the two reads — decisions first, items second.** Refuted by measurement: the item of a
mismatched decision is absent from the item set under **either** order, because the absence comes
from the two WHERE clauses. It would have been a correct application of ADR-0407's rule to a site
where the rule buys nothing, and it would have left the finding unreachable with a comment claiming
it had been fixed.

**(B) Widen the items read so a cross-campaign decision's item is in scope.** This would make the
map-based comparison answerable, at the cost of making a per-campaign replay read items the campaign
does not contain — and resolving each decision's item individually is N+1 reads. It also keeps the
comparison cross-read, so the order question returns. One statement is cheaper and order-free.

**(C) Keep `decision_item_mismatch` and make it reachable.** There is nothing to make reachable: the
question is *does this decision's item reference resolve to the item it names*, which the join, the
foreign key and the CASCADE each answer independently. Measured: 0 orphans.

**(D) Reorder `auditDeadlines` so the absorbing status is read first.** Converts the duplicate into a
miss. A miss is the better error of the two (the next pass catches it, and `examined` stays a
coverage claim) but it is still an error, and the de-dup has neither.

**(E) One query for both halves of `auditDeadlines`.** Refuted: the two predicates differ in kind —
the waiting set is compared against the **clock** and the late refusals against a second **stored**
column — each page needs its own ordering (nearest deadline first; newest refusal first), and one
`complete` flag over one limit could not say which page was cut. The function's own doc already
argued this and the argument survives.

**(F) Build the snapshot primitive.** Measured feasible (`BEGIN TRANSACTION ISOLATION LEVEL
REPEATABLE READ READ ONLY` composes with `set_config` and makes 40001 unreachable for a reader) and
**insufficient at all three sites**, none of which shares a transaction across its two reads. It
would also have to reach `PgConnection`, which 128 test files type something as: a required fifth
method is unshippable and an optional parameter makes the snapshot unobservable in tests. Recorded
with its measurement instead.

**(G) Fix `WorkflowReplayer.verifyInstance` here.** Refused: the equality forges in both orders, so
no ordering or de-duplication closes it, and the honest fix is a semantic decision about whether a
lagging projection is drift — on a replayer with no runner, whose repair half ADR-0337 declares
unsafe to apply. A different increment.

## Open questions

1. **The `>` direction for `verifyInstance`.** A stored cursor that *exceeds* the expected one is
   drift under any reading; one that lags is the normal transient state, because
   `ProjectingEventLog.append` writes the event and the projection as two statements. A one-sided
   comparison is probably right and is a decision about what that replayer reports, not a fix to
   this class.
2. **Three more sites are right with no comment saying so**, the highest-stakes being
   `pruneDanglingLinks`, whose comparison drives a `DELETE`. In three of the four the order is
   *forced* by a data dependency and the unstated premise is a **writer's** ordering in another
   module — the role `emit`'s single transaction plays for the integrity proof, recorded nowhere.
3. **`campaignMismatches` is a third read in `replayCampaign`** and is not counted in `examined`,
   because it assesses no record. Whether a sweep's coverage figure should include the questions it
   asked of the database as well as the records it read is undecided, and the same question applies
   to `auditTombstones`.
4. **Nothing fences a cross-row check against its own caller's population.** This increment found two
   unreachable checks by measuring one; the general question — *can the only caller construct the
   input this guard needs?* — is answerable for a guarded comparison whose operand comes from a
   filtered read, and no workspace rule asks it. It is register P3.3's shape one level up: not *does
   the parser read this fact* but *can the caller supply it*.
5. **The vacuum horizon the snapshot primitive would pin** is measured (18,001 dead tuples held) and
   unbounded in duration, because nothing in the repo caps a transaction's lifetime —
   `idle_in_transaction_session_timeout` appears nowhere. Any future use of `REPEATABLE READ` for a
   sweep wants that cap decided first.
