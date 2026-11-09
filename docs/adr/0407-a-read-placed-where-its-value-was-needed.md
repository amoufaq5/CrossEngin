# ADR-0407: A read placed where its value was needed

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Authors** | CrossEngin platform team |
| **Reviewers** | CrossEngin platform team |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0313, ADR-0322, ADR-0331, ADR-0334, ADR-0371, ADR-0373, ADR-0374, ADR-0375, ADR-0399, ADR-0400, ADR-0406 |

## Context

ADR-0406's addendum gave `IntegrityProofScheduler` an in-process overlap guard, because overlapping
passes over one scope forged **32 `compromised` verdicts of 38** on a chain `verify-chain` then
answered OK over. It left one open end: a **cross-process** residual, measured at **19 of 240
(~8%)** across two replicas, with the remedy prescribed as
`pg_advisory_xact_lock(advisoryKeyFor(scope))` — the key the chain's own append path already takes.

This register's standing rule is that **a remedy is a claim too, and it is the one an increment
spends itself on** (P3.1). Measuring that claim before building it found that the prescribed lock is
aimed at the wrong axis, that the bigger of two defects was in no register entry, and that a third
defect sat in the same report telling an operator not to do the one thing that would help.

## The rule the whole increment turns on

`proveScopeIntegrity` takes five reads and then compares pairs of them. The rule that decides
whether a pair is safe:

> **Of two reads whose values are then compared, the side that must be the LARGER is read second.**

It is sound rather than conventional, and the reason is a property of these tables: every one of
them is **append-only**. Nothing in the workspace deletes a chain entry, the Article 17 shared-table
erasure *retains* `meta.forensic_chain_entries` as a `PLATFORM_RECORD_TABLES` member, and ADR-0400
gave that table a restrictive `FOR DELETE USING (false)` policy. So a concurrent **honest** write
between two reads can only ADD rows — which means:

- read the **containing** side second and an honest write in the window only ever *clears* the
  comparison;
- read the **contained** side second and an honest write in the window *forges the finding*.

**Five pairs, of which three were inverted over two reads** — so the count of statements that move
understates the classes closed, which is why this table is by pair and not by read. The third was
added after an adversarial pass found it missing from both this table and the function's own header,
with the increment's own prose claiming it thirty lines below:

| # | what is compared | which side must be larger | pre-fix order | forged, with no tamper |
|---|---|---|---|---|
| 1 | a prior stored verdict's own anchor sequence vs the chain | the chain | chain **first** | **22 of 285** across two replicas |
| 2 | each anchored audit row's anchor sequence vs the chain | the chain | chain **first** | **90 of 140 on ONE replica** |
| 3 | a prior stored verdict's attested **witness** vs the anchor scan | the scan | scan **first** | `witness_regressed` on an honest sibling anchor |
| 4 | the anchor table's witness vs the chain tail | the tail | correct | — |
| 5 | each anchor vs the chain entries (the correspondence) | — order-free | — | — |

Pair 3 is closed by the same statement move as pair 1 and **needs no fence of its own**, which is
the part worth keeping: `auditAnchors` takes `correspondenceChain`, derived from `chainRead`, so the
anchor scan cannot be hoisted above the chain read without a compile error — therefore any order
satisfying pair 1 satisfies pair 3. The compiler is the fence. It is written down because that
implication was stated nowhere, and an edit giving `auditAnchors` its own chain read — which the
comment at the chain read explicitly contemplates refusing — would re-open the forgery with every
test green.

Pair 5 is order-free **by design and not by luck**: `disagreementFor`'s clause 4 treats *the chain
does not reach this anchor* as benign, because that is the truncation check's own subject rather than
a disagreement. That is why the anchors-vs-chain pair needs no ordering argument and the
audit-rows-vs-chain pair does.

## Site 2, which was in no register entry and is the bigger of the two

The audit rows were read **after** the chain, two statements above their consumer. Three facts
compose into a 64% false-positive rate:

- `PostgresAuditEmitter.emit` appends the chain entry and inserts `meta.audit_log` **in one
  transaction**, entry first — so a visible row implies a visible entry.
- `listAnchoredForScope` is `ORDER BY occurred_at DESC, id DESC LIMIT $n` — the **newest** rows,
  which is exactly the population written during the pass's own window.
- `verdictFor` answers `unanchored` only when `anchor === null`. A row whose anchor **sequence** is
  absent from the loaded chain answers `anchor_missing`, which is in the `TAMPERED` set, which makes
  `audit_row_tampered` a `COMPROMISE_CAUSE`.

So an ordinary recorded read, committed during the pass, was read as a **tampered audit row** and
paged as a `sev1`.

**It is not a concurrency defect between passes.** It is a race between the proof and *ordinary
request traffic*, so no lock over passes can reach it — which is the decisive refutation of the
prescribed remedy, and the reason measuring it mattered: the lock would have closed the 8% residual,
left the 64% untouched, and the increment would have reported success.

Measured live as the non-owner `serving` role on PG 16, **one replica, one process, no tamper**,
using `--audit-read-routes` as the emitter because that is the cheapest one there is (every recorded
read writes one anchored audit row, ADR-0313):

- **90 of 140 verdicts `compromised`** while audit rows were being emitted;
- **0 of 84** on the same server, same interval, quiet;
- **0** audit rows whose anchor sequence was really absent from the chain, by direct SQL against
  `meta.forensic_chain_entries`.

The report printed `integrity valid, signatures valid (64 checked)` one line above `COMPROMISED`.

**The `verify-chain` arbiter in that arm did not run, and the reason is this increment's other
defect landing on its own measurement**: the harness invoked it as `verify-chain --full`, a flag that
has never existed, so it exited **2** — a usage error — and the harness correctly reported that check
as a FAIL. So what establishes the chain was healthy in the pre-fix arm is the `dangling=0` SQL
above, plus the post-fix arm's `verify-chain` exit 0 over an equivalent chain. **A nonexistent flag
silently disabled an arbiter**, which is why correcting the two `--full` occurrences is load-bearing
rather than cosmetic.

An earlier attempt to reach this through ordinary request traffic **failed its own premise** and the
failure is worth recording: 25 requests of four kinds produced 25 `kind=audit_event` chain entries
and **0** audit rows, because the per-request observer (`auditChain.observer.asExecutionSink()`)
appends a chain entry while `PostgresAuditEmitter.emit` is called only from named surfaces. **A
per-request chain append is not an audit row**, so the audit-row half of this proof is vacuous on a
deployment whose only activity is traffic, and the defect needs an *emitter* to fire.

## Site 1, the named open end

The prior verdict was read **last**, inline inside `compareWitnessMemory`'s argument object. Because
`recordVerdict` appends the chain entry and only then stores the verdict row, a verdict visible to
this pass has its entry visible too — but only if the chain is read **second**. Read the chain first
and another replica's verdict, landing in the window, names a sequence this pass's snapshot does not
hold → `prior_verdict_contradicted` → `compromised`.

Measured on this increment's own harness, controlled by applying the pre-fix ordering as a reversible
mutation and rebuilding: **22 of 285 across two replicas** (22 × `prior_verdict_contradicted`)
against **0 of 210** on one replica, and **0 of 303** across two replicas after the fix. The
independent agreement with ADR-0406's 19 of 240 (7.7% against 7.9%) is what makes both trustworthy.

## What the reorder costs — before the decision, because it is what the decision weighs

An earlier draft of this ADR claimed the reorder **strictly dominates** — that it loses no true
positive and in fact gains one. An adversarial pass refuted that for comparison 1 with a
measurement, and the refutation is the most useful thing in the increment, because the two
comparisons come apart for a reason worth stating:

> The directional rule is a **soundness** rule and says nothing about completeness. It establishes
> that a baseline cannot attest anything this pass does not also see — and that same premise is what
> reduces sensitivity, because a baseline read **earlier attests less**, and both memory detectors
> fire on *the attestation exceeding the reading*.

**Comparison 2 (the audit rows) was then claimed to strictly dominate, and a second adversarial pass
refuted that too — so neither comparison dominates, and the whole gain is the false positives.**
Two things were offered for it: those rows are the **subjects being checked**, and
`listAnchoredForScope` is newest-first under a `LIMIT`, so reading earlier examines an *older*
population, which is the one at risk of having been tampered; and reading earlier catches a mid-pass
chain destruction the old order missed. What the claim missed is the mirror image on the row side,
measured by driving `verifyAuditAnchors` and `compareWitnessMemory` with both orderings' value-sets
over one pair of instants: **four genuine tampers the old order reported this pass are now clean** —
an audit row rewritten (`hash_mismatch`), repointed (`anchor_repointed`), a forged row inserted
(`anchor_missing`), a forged baseline inserted (`prior_verdict_contradicted`).

**And once the symmetry below is stated, both of those two "advantages" dissolve into it**, which is
worth writing out because they read like gains and are not. The window of rows examined slides at
the same rate under either order and only its *phase* differs, so a row that slides out of the
`LIMIT` before any read reaches it is missed equally often either way; and a chain destruction is
caught iff it precedes the chain read, which is also one interval under either order. Both are phase
shifts. What is left of the first is the thing already credited as the whole gain — under the old
order a row written during the fold was *in* the rows set and its entry was *not* in the chain set,
which is the 64%, and under the new order that state is unreachable.

**The symmetry resolves cleanly and it is the right way to state the whole trade.** A persistent
tamper is caught by the first pass whose *relevant* read follows it — the claim-side read for a row
or verdict edit, the containing-side read for a chain edit — and under **either** order there is
exactly one such read per interval, so the expected detection latency is half an interval both ways.
Moving a read shifts *which* pass catches a given instant and changes no class's guarantee. So the
reorder's entire gain is the removal of the 64% and 7.7% false positives, and its cost is that each
order defers the other's class by one pass.

One asymmetry in that trade is **not** in the reorder's favour and is worth knowing: the deferred
class is the one with a single detector. `canonicalAuditEntryPayload` has exactly two non-test call
sites in the workspace — the writer at `audit-log-store.ts:383` and the recompute at
`audit-anchor.ts:128` — so `verifyAuditAnchors` is the only function that can detect an edited audit
row at all, while a chain edit also fails `verifyChainIntegrity` as a sequence gap or
`verifyChainSignatures` over bytes that cover `payloadSha256`. The reorder therefore gains coverage
on a doubly-detected class and defers a singly-detected one. It is still the right trade, because a
64% false-positive rate on a paging `sev1` destroys the detector's usefulness outright where a
one-interval deferral does not — but it is a trade, and this is the third time this increment has
had to withdraw a dominance claim.

**Comparison 1 (the baseline) is a sensitivity trade**, measured by driving
`compareWitnessMemory` and `compromiseCauses` through `dist` over ADR-0399's seven anchor-table arms
with a newest baseline (chain seq 5, witness 5) against an older one (chain seq 1, witness 2):

| arm | newest baseline | older baseline |
|---|---|---|
| A1, A4, A6, A7 | unchanged | unchanged |
| A2 — truncation only | `compromised [chain_truncated, verdict_disagrees_with_chain]` | `compromised [chain_truncated]` — verdict holds, one cause lost |
| A5 | `compromised [verdict_disagrees_with_chain]` | `compromised [witness_regressed]` — both `disproves` |
| **A3 — truncation + two-column lowering** | `compromised [verdict_disagrees_with_chain]` | **`verified [-]`** |

**Exactly one arm's verdict weakens, and it is the one arm of the eleven where the memory axis is the
sole detector**, because ADR-0375's two-column lowering suppresses `chain_truncated` (the witness is
lowered onto the surviving tail) and `checkpoint_disagrees_with_chain` (the anchors agree with what
survives) at once. Its reachability is bounded three ways, every one measured: it needs **≥2
processes** (ADR-0406's `inFlight` guard serialises passes within one, and no shipped compose sets
`replicas`); it needs a concurrent pass committing a `verified` verdict inside this pass's window, a
cut removing *that* pass's chain entry and not the older baseline's, and an older attested witness at
or below the lowered one; and in the ordinary sub-case it is **one pass late rather than lost**,
because the weakened pass appends its own verdict entry *below* the destroyed range, so
`latestBaseline`'s `ORDER BY chain_sequence_number DESC` still returns the concurrent pass's row and
the next pass fires.

The sharp sub-case is worse than one pass late and is stated rather than fixed: where the cut removes
exactly the concurrent pass's entry, the weakened pass's own verdict lands at the **same** chain
sequence, the tie is broken by `verdict_id DESC` — a content-hash prefix, so arbitrary — and if the
weakened row wins it becomes the baseline attesting the **lowered** figures, and the laundering is
permanent. Under the old order the first post-tamper pass answered `compromised`, and `latestBaseline`'s
`verdict = 'verified'` clause means a compromised row is never a baseline, so the old order did not
have this sub-case.

**The obvious improvement is refuted, and the refutation is why the trade is irreducible here.** One
could keep the newest baseline and discriminate instead — fire `prior_verdict_contradicted` only when
the attested sequence is *within* the range the chain snapshot covers, treating an attestation above
the tail as "not comparable" rather than as a contradiction. That separates nothing: after a
truncation the destroyed sequences are **above the surviving tail**, which is the identical shape an
honest concurrent append produces, so the race and the tamper are indistinguishable from the pair
*(attested sequence, this pass's chain)*. Separating them needs evidence the chain does not hold,
which is ADR-0375's own open end — an anchor table that is itself chained.

So the honest cost line is: **the reorder trades a 64% (one replica) and 8% (two replicas)
false-positive rate for a cross-process-only loss of one of eleven detector arms, ordinarily one pass
late, latent on every deployment this repository ships.** That is a trade worth making — a paging
`sev1` at a 64% false-positive rate trains an operator to ignore the one detector that matters — and
it is a trade, not a free win.

## Decision

**Move the two claim reads above the chain read.** Nothing else: the same five reads, the same number
of round trips, no lock, no new interface, no transaction change.

Beside it:

1. **The advisory lock is refused**, on three measured grounds. It does not reach site 2 at all
   (wrong axis). It is dearer than the defect: `advisoryKeyFor(scope)` is the *append path's* key, so
   holding it across a fold blocks every append to that scope — and ADR-0406 measured the fold
   unbounded in the chain's length. And it is unnecessary, because the ordering closes the
   cross-process residual the lock was prescribed for: the ordering makes the axis sound **under** the
   interleaving, where the lock makes it sound by **excluding** the interleaving.
2. **Pair 4 (the tail) is pinned by a test**, because the fix moves two reads around it and it must
   not move with them. An anchor ahead of this pass's chain snapshot counts toward the witness
   (clause 4 is benign), and `truncated` is `tail < witness` — so a tail read one statement too early
   answers `true` on honest appends alone. **Pair 3 is deliberately not pinned**, for the reason
   above: the data dependency makes it a compile error rather than a test, and a test over it would
   assert what the type system already refuses.
3. **The rule is stated once, at the top of the function**, with each site naming which of its two
   sides must be the larger — over all five pairs and all four tables, with the premise's scope
   (*every writer that ships*, not *everything a tamperer can do*) stated rather than implied.

## Why the rule was known and applied inconsistently

The three sites' pre-fix state is the finding worth carrying furthest, because it is not "somebody
forgot".

- **Site 3, correct**, carried a comment arguing exactly this rule: *"After the audit, so the witness
  is read before the tail it is compared against … `truncated` needs `tail < witness`, so an append
  in the window only ever clears the check and a delete in the window is a truncation that really
  happened."*
- **Site 2, wrong**, was a bare statement with **no comment at all**, placed immediately above its
  consumer `verifyAuditAnchors` — which is the natural place to put a read, and is wrong for any
  value that must be compared against a *later* read.
- **Site 1, wrong**, was an **inline `await` inside an argument object**, under a comment that argued
  the ordering and argued it wrongly: *"Read **after** the anchor audit and the tail, so the
  comparison is against figures this pass has already settled."* That sentence is **true of three of
  that call's four arguments** — `current: truncation`, `chain: correspondenceChain` and
  `currentScanComplete` genuinely are this pass's settled figures — and **false of the one whose read
  it governs**, `read:`, the stored verdict.

So the rule was written down at exactly the one site that had it right, and the site that had it most
wrong carried a comment claiming a virtue that *sounds* like rigour. Two statements of the mechanism,
and the second is the sharper one:

- **A comment that justifies a statement's position justifies the position of every value in that
  statement, and a statement that reads four values can be right about three.**
- More precisely: that comment **gives a reason about when the comparison is made, for a sentence
  whose subject is when the value is read.** Those come apart because `compareWitnessMemory` is a
  pure, later call — so its stated property (*compare against figures this pass has already settled*)
  is preserved **exactly** under the reorder, which the fix demonstrates. The reason was true and was
  a reason for something else.

There was also no data or control dependency forcing the read late: `WitnessMemorySource` is
`(scope) => Promise<…>`, one parameter which is `proveScopeIntegrity`'s own first parameter, so the
seam **cannot express** a dependency on anything the pass computed; and the function performs zero
writes, so no write between two reads can create one either. An inline `await` in an argument list
also makes the ordering invisible: there is no statement to move and no line a comment could have been
written on.

## Third finding: the remedy was inverted for the one operator who should act

`formatIntegrityProof`'s truncation arm was gated on `witnessMemoryShowsHistory`, which is
`attestedTail !== null || attestedWitness !== null`. A scope with a chain, a stored verdict and **no
checkpoint ever written** stores exactly that — a tail and a null witness — so the arm printed:

> truncation: not checkable, and this scope HAD anchors — do NOT run the checkpoint scheduler, which
> would anchor past the gap and make this unprovable

**False in both halves**, and it withholds the remedy from precisely the operator whose remedy it is.
`witnessMemoryShowsAnchors` is the narrower question (`attestedWitness !== null`) and is the one that
arm needs; `showsHistory` keeps its own reader, where the question is whether a report is *published
at all* (ADR-0399's `isEmptyScope` gate) — two questions with opposite consequences, which is why
there are two predicates and each carries a doc comment saying which is which.

The state is reachable on the **first boot** of any deployment that runs the proof before anything is
anchored, and `CheckpointScheduler` **skips an empty chain by design** (ADR-0371: a full fold over
zero entries is vacuously `ok`), which is exactly the state a fresh deployment is in. This
increment's own harness hit it by accident — seeding 40 entries with a boot-time checkpoint pass
produced **0 anchors**, because the boot pass runs before any request has appended anything.

The arm is reached from `onFinding` and from the escalation's `detail`, so the inverted remedy lands
in the **sev1 incident an on-call engineer reads**.

**Why nothing caught it: the branch had no test coverage at all.** `report()` defaults to
`noWitnessMemory()`, so every one of the five pre-existing truncation-line tests had both attested
figures null, and the branch ADR-0399 added was never reached with a realistic prior verdict. It has
two tests now — the never-anchored scope, and the destroyed-anchors control that stops the first
being satisfiable by deleting the arm.

## Alternatives

**(A) `pg_advisory_xact_lock(advisoryKeyFor(scope))` — the prescribed remedy.** Refused three times
over, and the first refutation is the one nobody expected: **as literally stated it is not
expressible.** `proveScopeIntegrity` opens **7 separate transactions** (6 on `fromCheckpoint: false`)
and takes zero advisory locks, while the verdict append takes that key in an 8th transaction of its
own — and an xact-scoped lock dies at its own commit, so there is no transaction to hold it across
load-compute-append. Implemented anyway it **self-deadlocks**, reproduced live on PG 16.15 through
the repo's own `createNodePgConnection`: the lock-holding transaction sits `idle in transaction` on
`Client/ClientRead` while the append waits on `Lock/advisory`, so `pg_blocking_pids(holder)` is `{}`,
Postgres's wait-for graph has **no cycle**, and the deadlock detector — measured breaking a genuine
crossed advisory deadlock in 1,332 ms — has nothing to find. Still pending 12 s past a 1 s
`deadlock_timeout`, with **no `statement_timeout`, `lock_timeout` or
`idle_in_transaction_session_timeout` anywhere** in `kernel-pg`, `forensics-pg`, `operate-server` or
`api-gateway-runtime` to break it. Beyond that it is the wrong axis (it cannot reach site 2 at all,
which is a race against request traffic) and the suspected latency is confirmed within 10% (13.8 s
measured at 100k entries against 15.2 s suspected).

**(A′) A lock as a cost optimisation rather than a soundness requirement.** Once the ordering lands,
this is all a lock would buy, and the cost it would save is real and unreclaimable three ways:
**1,665.4 B per pass per scope** measured, **+13.6 GiB/yr at 1,000 scopes**, and every duplicate
verdict entry permanently enlarges every later full fold. Three legs of the steelman are refuted —
heap pressure does not transfer cross-process, double escalation is already prevented by a partial
UNIQUE index, and the content-addressed `verdict_id` dedupes only same-millisecond collisions. The
cheap non-blocking shape already exists in the repo: `PgConnection.withAdvisoryLock` pins a client
and releases on the same one, and needs only a `try` variant. Not taken here, because it is a cost
decision on a configuration no shipped compose sets.

**(B) A session-scoped `pg_try_advisory_lock`.** Refuted on measurement, and the measurement is worth
keeping for whoever needs a lock for a different reason: `PgConnection.transaction` pins one pooled
client, so a session lock taken and not released **wedges that key for the life of the client** — and
it passes a quiet probe, leaking only under concurrency. The **xact-scoped** form inside
`conn.transaction` *is* reachable with no interface change.

**(C) `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` across the whole pass.** The textbook answer,
and it would make all five reads one snapshot. Refused on **structure**, not on cost: the proof's
reads are five separate transactions through `conn.query`, these stores expose no `*Within(tx, …)`
seam, and `BEGIN` is bare — so the level cannot be set after the first statement (`25001`). It is the
right long-term shape and is this ADR's first open question.

**(D) Re-read and re-compare whenever a finding appears.** Refused: it turns one false positive into
two reads plus a retry and still answers `compromised` whenever the second read also races. The
ordering removes the race rather than sampling it.

**(E) Widen `verdictFor` so a row naming a sequence above the snapshot is `unanchored` rather than
`anchor_missing`.** Refused on the axis that matters: it would stop a *genuinely* missing anchor above
the tail being a finding — a true positive traded away to suppress a false one, which is the opposite
of what the measurement above shows the reorder achieving.

**(F) Move `chainRead` up to immediately after the audit read, so the claim-side deferral spans one
round trip instead of the whole fold.** Proposed by a reviewer with a real measurement behind it —
there is genuinely no data dependency between the fold and `chainRead`, and the fold costs 709 ms at
5,000 entries (142 µs/entry, consistent with ADR-0371's 152 µs) extrapolating to ~14 s at 100k, which
is the steady state for any scope folding from genesis every pass. **Refused, because the window it
names is not the window that governs the deferral, and the move would reduce detection.** Write the
claim read at Tr and the containing read at Tc. A row tampered at X is seen pristine by this pass iff
X > Tr, so the deferral set is (Tr, Tr + I) — **width one interval, independent of where Tc sits**.
What the Tr→Tc gap does govern is the opposite class: a chain entry destroyed at X is caught by this
comparison iff X < Tc, so the gap is exactly the set of instants where comparison 2 catches a chain
destruction *the fold has already passed over*. Moving `chainRead` up shrinks that set and leaves the
row-side deferral untouched — it gives up the only non-redundant part of comparison 2's gain and buys
nothing. The reviewer's own scenario makes the arithmetic visible once stated this way: the 14 s is
14 s of an hourly 3,600, and every row edit in the other 3,586 is deferred by this pass too.

**(G) Route the proof through `verifyChainForAudit` so the chain is loaded once.** Not refused —
genuinely wanted, and it would dissolve (F)'s question entirely by leaving one snapshot — but it is
not free, for two reasons measured here rather than assumed, and it is the open end below rather than
part of this change.

## Consequences

- Two reads move. The false-positive rate on site 2 goes from 64% to 0, and site 1's cross-process
  residual from 7.7% to 0, with no lock and no additional round trip.
- `witnessMemoryShowsAnchors` joins `witnessMemoryShowsHistory`; each has one reader and each states
  the other's question in its doc, because the two differ exactly where a scope has been verified and
  never anchored.
- Five new tests: three ordering fences and two for the remedy arm, every one mutation-checked.
- ADR-0406's cross-process open end is **closed for the forge**, and `advisoryKeyFor` is left where
  it is: after this, a lock is a cost optimisation (A′) and not a soundness requirement.

**What this closes a window in, and does not close.** An interleaving harness built around
byte-identical copies of `witness-memory.ts` and `anchor-audit.ts` plus a verbatim
`integrityVerdictFor`, stepping real passes against each other, against a `CheckpointScheduler`
anchoring at the tail it read before verifying, and against continuous audited appends, measured the
old order forging `prior_verdict_contradicted` in **1,446 of 4,000** passes at two replicas and in
**6 of 15** placements of an exhaustive search, against the new order's **0 of 8,000** across four
replicas and **0 of 70** reachable placements. So the ordering is not refuted on that surface — and
it **closes a concurrency window rather than the axis**:

- **One tenant-context `INSERT` into `meta.audit_integrity_verdicts` forges both memory outcomes
  deterministically, on either read order**, and a third payload *disables* the regression detector.
  That table's isolation arm is `ALL`-scope, so a tenant-context session can write its own verdict
  row, and `chain_sequence_number` carries no reference to the chain. ADR-0399's `latestBaseline`
  clauses narrow this and do not close it. **This is the top open end** and it is a different kind of
  problem: it needs the baseline to be evidence rather than a row.
- The ordering's soundness premise is **append-only writers**, which no mechanism enforces — it is a
  census of today's workspace plus ADR-0400's `DELETE` fence, and a tenant-context `UPDATE` is
  reachable on both tables. Relaxed, the harness forges 20.99%.

**Three smaller findings from enumerating `compareWitnessMemory` rather than reading it**, each left
open because each is a deletion or a narrowing with its own argument: `WitnessMemoryCheck.attestedTail`
is **carried into the comparison and compared against nothing** — only `current.checkpointSequence`
and the row's anchor triple decide anything, so the tail attestation is a stored figure with no
reader on this path; `unverifiable_here`'s head-truncation branch is **unreachable from
`proveScopeIntegrity`**, which always `loadChain`s the whole scope and whose first entry is sequence
0, so `lowest > 0` is false for any chain that was not head-truncated; and **two of
`prior_unanchored`'s three disjuncts are unreachable through the production baseline read**, because
`latestBaseline` filters `chain_sequence_number IS NOT NULL` and a half-present anchor throws in
`rowToRecord` (answering `prior_unreadable` instead), leaving only a non-null anchor pair with a NULL
`payload_sha256`, which no current writer produces since `record()` always derives it. Nine outcomes
over **12 return sites**, so three outcomes are reached by two clauses each — and in two of those the
two branches have *opposite* time-ordering sensitivity, which is why the analysis had to be per
branch rather than per outcome.

**A second adversarial pass over the committed change, with one refuter aimed at the soundness claim
and one hunting for a hazard the increment created, could not refute the central claim and returned
eight findings — six taken, one refuted as (F) above, and one that is this increment's own class in
its own contract.** That one is the sharpest and it is **three pairs over two reads, not two**: the
header listed `(priorVerdict, chain)`, `(audit, chain)`, `(anchorAudit, tail)` and the order-free
`(anchor, chain)`, and omitted `(priorVerdict, anchorAudit)` — which `compareWitnessMemory` makes
twice, and which the pre-fix order was measured forging on, a **second** false-positive class from
the same inverted read (`witness_regressed` / *"ANCHORS LOST"*, OLD `compromised` at
checkpointSequence 3 against NEW `verified` at 7, every entry and every anchor present in both
arms). It needs no test, and the reason is the useful part: `auditAnchors` takes
`correspondenceChain`, derived from `chainRead`, so the scan **cannot be hoisted above the chain
read without a compile error**, and therefore any order satisfying the first pair satisfies this one.
The compiler is the fence — and that implication was stated nowhere, so an edit giving `auditAnchors`
its own chain read, which this file's own comment contemplates refusing, would have re-opened the
forgery with all 5,360 tests green. So an enumeration short by one, in the contract of the increment
whose subject is that class, with the omitted member already claimed thirty lines below it.

Two of the other five are the file's most-found documentation shape and both are now fixed with
their refutations in place: `formatIntegrityProof` and its test both justified a placement with
*"the anchor table is read before the audit rows are looked at"*, **which this change inverts** —
and the conclusion survives because the real reason was never the ordering (the field is required and
computed unconditionally, and an ordering cannot establish that a field is present); and
`witnessMemoryShowsAnchors`' stated population was **self-contradictory**, naming *"a checkpoint pass
that found nothing to anchor"* when that scheduler skips on `tail === null` and nothing else, so such
a scope attests no tail either and the arm is never reached. The configuration that does reach it is
the two schedulers covering different scopes, which is now named in all three places that carried the
wrong mechanism. The append-only premise was **substantiated for two of the four tables this function
reads**, and the two omitted were precisely the claim sides of the two comparisons that moved; it is
measured for all four now (one `INSERT`, zero `UPDATE`/`conflict_update`, no delete reference, both
`record`s `ON CONFLICT … DO NOTHING`, all four fenced and retained) with the scope of the claim stated
— *every writer that ships*, not *everything a tamperer can do*. And two residuals on the new
predicate are stated rather than closed, because **neither predicate is total over the question an
operator is asking**: `attestedWitness` is null for three outcomes, so a scope whose newest baseline
was *tampered* gets the destructive remedy offered (no regression — the wide predicate did the same),
and the narrowing is strict, so a scope whose anchors were destroyed and whose newest verified
baseline predates its first anchor now reads as never-anchored. Answering *did this scope ever have
anchors* needs the chain's memory of a prior witness, which is ADR-0375's open end 2.

**A fourth probe asked the question this ADR could not answer about itself — does the class have
other members in the workspace — and the answer is yes, with three subclasses the rule treats
differently.** It scanned 301 async bodies with two or more awaited reads followed by a comparison,
narrowed to the 34 comparing two distinct awaited locals, and hand-read every named hunting ground
(all six replayers, the deletion reconciler's four directions, the reconciliation probe, the
checkpoint scheduler, `verify-chain`, `anchor-audit`, `witness-memory`, `certification`,
`dr-readiness`, metering, the link sweep, the read-state store, the shared-table erasure, the
rekey). Every claim below was re-verified against the tree before being written down.

**Two sites are wrong by this rule and one is unfixable by it.** `AccessReviewReplayer.replayCampaign`
reads the item set *before* the decisions it must contain, and it fails **open** rather than forging:
`verifyDecisionRowShape` guards its cross-row block with `if (item !== undefined)`, so a decision
whose item the earlier read did not see produces **no issue at all** and both
`decision_item_mismatch` and `decision_campaign_mismatch` go unasked — and `undefined` is also what a
*genuinely orphaned* decision looks like, so that replayer can never report an orphan. Reading items
second would make `undefined` conclusive, which the foreign key from `item_id` licenses. It is wired:
`access_reviews` has a runner in `operate-server replay`. `DeletionReconciler.auditDeadlines` reads
the four non-terminal statuses before the absorbing `rejected` one and concatenates both lists into
one reporter, so a request rejected between the two reads is **reported twice and counted twice in
`examined`** — against the disjointness `auditCompleted`'s own comment claims as *"a property of the
two queries rather than of a filter either applies"*, which is true of one snapshot and false of two.
That one is a **partition rather than a containment**, so no order makes it exact: reading the
absorbing side first turns the duplicate into a one-pass miss, and the duplicate is the worse error
because `examined` is a coverage claim (ADR-0372) while the miss is caught next pass — so it is a
trade with an argument, not a free swap. And `WorkflowReplayer.verifyInstance` compares
`stored.sequence_cursor !== expected.sequenceCursor`, an **equality**, so it forges in *both*
orders and this rule cannot repair it; it is compounded by `ProjectingEventLog.append` writing the
event and its projection as two statements with no transaction, so the projection is *expected* to
lag, and it is latent because that replayer has no runner. Its honest fixes are a one-sided
comparison or a real snapshot.

**Four more sites are right with no comment saying so, and the highest-stakes one drives a
`DELETE`.** `pruneDanglingLinks` reads the link rows and then the record-id sets it tests them
against — the containing side second, correctly — and inverting it would delete links whose endpoints
were created in the window. In three of the four the order is *forced* by a data dependency and the
real unstated premise is a **writer's** ordering in another module: the gateway's stage-10 decision
against end-of-request capture, and the deletion pipeline's in-transaction tombstone against its
later status write. That is exactly the role `emit`'s single transaction plays for this function, and
it is recorded nowhere.

**Five sites state the reason, and the rule is better understood in this repo than this ADR
suggested** — `runVerifyChain` cites `proveScopeIntegrity`'s argument by name, `CheckpointScheduler`
argues tail-before-verify at length, `probeForReconciliation` asks confinement before counting,
`scanCheckpoints` states the READ COMMITTED fact with a measurement, and `IncidentReplayer`
**refuses a second read outright** with what is probably the sharpest statement of the rule anywhere
here: *"a `count(*)` beside the read would be a second question answered at another moment."*

**The structural root is that there is no snapshot primitive**, and it is measured:
`SET TRANSACTION ISOLATION LEVEL` and `REPEATABLE READ` appear **zero** times across `apps` and
`packages`, and `conn.transaction` is a bare `BEGIN`, so every multi-read "transaction" in the
workspace is READ COMMITTED and **one transaction is not one snapshot**. Read order is therefore the
only lever available, which is why this rule exists at all — and why several sites that look
protected by a transaction are not. That is open question (C) above, now with a figure.

**None of the three is fixed here, and the reason is the subject.** This increment is about
`proveScopeIntegrity`; each of those three is a behaviour change in a different subsystem with its
own verdict question (should an orphan decision be reported, and as what? is a one-pass miss
preferable to a double count? should the workflow comparison become one-sided or wait for a
snapshot?), and shipping three cross-subsystem changes unverified at the end of this increment is
the opposite of the method it is written to defend.

**And the comparison this increment reordered reads a *second* whole-chain snapshot, which is the
adjacent finding and corrects my own first reading of it twice.** In **full** mode `foldFromGenesis`
loads the chain, folds twice over that one array and — through the report-only wrapper
`verifyChainFull` — **discards the entries**, after which `chainRead = await loadChain(scope)` loads
the same table again: two whole-chain reads, two snapshots, one pass. The entries-returning sibling
already exists (`verifyChainForAudit`, whose `correspondenceChain` null rule is *byte-identical* to
this function's and whose comment says so in those words), and the CLI is its caller — so the obvious
move is to route the proof through it. **It cannot be dropped in, for two measured reasons.** It hands
back `readonly ChainedLogEntry[] | null` and not the `ChainRead`, so `chainRowsRefused` and
`verifyAuditAnchors`' fourth argument — ADR-0373's and ADR-0374's refusal axis, which answers
`compromised` — would be lost; and its `null` means *this mode did not read the prefix*, where this
function's means *a row was refused*, so a bounded pass would take the fold's `null` and **silently
withhold the anchor correspondence on the steady-state path**. Two conditions, one `null`, opposite
consequences. So it is a cost-and-single-snapshot finding rather than a correctness defect — B ⊇ A
under append-only, so the two snapshots cannot forge anything — and the honest scope is narrow: the
second read is **not** redundant in bounded mode, where the fold reads only `loadFrom(anchor + 1)` and
this is the only whole-chain read there is (the comment above it says so), so the redundancy is the
first post-upgrade pass plus every pass on a scope whose anchors cannot be trusted, which ADR-0371
makes the steady state for exactly those scopes. Closing it means widening the seam to carry the
`ChainRead` and keeping the two `null`s apart, which also answers half of (C) by removing a snapshot
that would otherwise need the shared transaction.

Still open: the `REPEATABLE READ` shape (C) above; the misattribution follow-up already named in the
`loadChain` comment; and — the cheapest of them — **a second baseline read taken after the chain,
whose disagreement grades `unproven` rather than `disproves`**. That costs one read, cannot forge a
`compromised` (the grade is what the race degrades to), and would turn the A3 cross-process loss from
`verified` into *cannot say*, which is the direction ADR-0372 exists to defend. It is not taken here
because it is a new axis with its own test surface over a configuration no shipped compose reaches,
and shipping it on the strength of one unmeasured argument is the thing this increment is about.

## Verification

Live, as the non-owner `serving` role, PG 16, on throwaway clusters torn down after each run. The
pre-fix arms were produced by applying the pre-fix ordering as a **reversible** mutation (ADR-0390's
bijection rules: each `old` unique in its input, each `new` unique in the result, no empty side) and
rebuilding, with the file confirmed byte-identical to its pristine md5 afterwards.

| arm | pre-fix | post-fix |
|---|---|---|
| site 2 — one replica, audit rows emitting | **90 / 140** compromised | **0 / 126** (193 rows emitted) |
| site 2 — same server, same interval, quiet | 0 / 84 | 0 / 99 |
| site 1 — one replica (the control) | 0 / 225 and 0 / 210 | 0 / 218 |
| site 1 — two replicas, one scope | **22 / 285**, all `prior_verdict_contradicted` | **0 / 303** |
| arbiter — `verify-chain` over the same chain | OK, exit 0 (site 1); **exit 2, did not run** (site 2 — see above) | OK, exit 0 (561 / 668 signatures) |
| arbiter — audit rows whose anchor is really absent | 0 | 0 |

Offline: **123 tests** in `integrity-proof.test.ts`, `tsc -p tsconfig.typecheck.json` clean, and each
of the three ordering mutations failing **exactly its own fence** (1 failed, 122 passed) with
`md5` byte-identical to pristine after every revert.

## Notes for the next reader — the measurement defects, which cost more than the fix

1. **A fixture that creates the concurrent state before the call pins nothing.** The first draft of
   the tail fence appended the fourth entry *before* invoking `proveScopeIntegrity`, so both reads saw
   the same value under either ordering and the test **passed under its own mutation**. The concurrent
   event has to land *at* the read being moved — here, inside the `scanCheckpoints` fake. Caught by
   the non-vacuity floor, not by reading.
2. **A negative assertion on a phrase the opposite sentence also contains discriminates nothing.**
   `"do NOT run the checkpoint scheduler"` contains `"run the checkpoint scheduler"`, so
   `not.toContain` on the bare phrase is satisfied by neither arm. Assert on the discriminating
   halves (`"no checkpoint yet — …"` against `"do NOT …"`).
3. **A measurement must not rest on a build that errored.** The first pre-fix arm's mutation left an
   unused `const`, so `noUnusedLocals` made `tsc` exit 2 — and it **emitted anyway**, so the arm ran
   on mutated output by accident. The mutation is `void 0;` now, the build is clean under it, and the
   mutation's presence in the emitted file is grepped rather than assumed. (The emitted path is
   `dist/src/…`, not `dist/…`, because `rootDir` is `.` — the first grep for it looked in the wrong
   place and reported "NO".)
4. **`CheckpointScheduler` skips an empty chain**, so a harness whose boot-time checkpoint pass runs
   before any request seeds **0 anchors**. Two boots: serve, then boot again with the checkpoint flag
   so the anchor lands mid-chain with entries above it.
5. **`--checkpoints` and `--checkpoint-config` are mutually exclusive** since ADR-0406 made the first
   a boolean; passing both is refused at parse and the server never listens. Likewise
   `--integrity-proof` and `--integrity-proof-config`.
6. **`grep -c` prints `0` *and* exits 1 on no match**, so a trailing `|| echo 0` fires too and yields
   `"0\n0"`, which `[` then rejects — on exactly the control arms whose zero *is* the result. Put
   `|| true` **inside** the command substitution.
7. **A `/proc` scan that excludes `$$` still matches its own parent**, because the pattern sits in the
   parent shell's eval'd command line. Resolve each hit's PID before believing it — this file already
   records the `pgrep -f` version of the same trap.
8. **`verify-chain --full` does not exist and never has.** The full fold is that command's default and
   `--from-checkpoint` is the opt-in. Two occurrences, both introduced by ADR-0406's own commit
   (`git log -S`), so **wrong when written** rather than drifted; both corrected, including in that
   ADR's own text. It was not cosmetic: a harness invoking it **silently lost its arbiter**, which
   exited 2 instead of verifying the chain.
9. **A read-only brief that forbids editing says nothing about creating.** An adversarial agent built
   its interleaving harness as ten files at the package root, five of them matching `*.test.ts`, so
   the workspace suite **collected them** — 5 failed files and 9 failed tests attributable to nothing
   in the diff, including a text fence (`COMPROMISE_CAUSES > is the only route to a compromised
   verdict, which no type can fence`) that the copies break by construction. `git status` separated
   them in one command. Next time: name the scratchpad in the brief, and run `git status` before
   believing a sweep's failures.
10. **A census summary can disagree with its own list.** One agent reported *"four outcomes are
    reached by two distinct clauses each"* and then listed three; 12 return sites over 9 outcomes is
    **three**. The figures it measured were right and the sentence over them was not, which is this
    repository's P3.1 class at one remove — so the three-branch figure here is counted from the
    enumeration, not quoted from the summary.
11. **`stat -c %y` before believing a test result, because a reviewer can read a half-written
    tree.** A reviewer running concurrently with the edit measured `integrity-proof.test.ts` at
    15:31:21 against `integrity-proof.ts` at 15:32:09 and got test 1 failing with
    `prior_verdict_contradicted` / `tailSequence: 2` — which is exactly what the **pre**-change order
    produces — and was two steps from reporting *"the change ships a failing test"*. On the settled
    tree the same file is 123/123 and the app 5,360/5,360. This is the register's own
    read-the-mtime-before-the-contents rule one artifact across: there it was a stale **log**, here a
    source file mid-write, and in both the stale content claimed a failure.
12. **A plausible improvement can be backwards about which window it shrinks** — alternative (F)
    above, refused with the arithmetic rather than with a preference. The reviewer's measurement was
    sound (no data dependency; 709 ms at 5k entries) and the inference was not: the claim-side
    deferral set is one interval wide whatever the gap, and the gap is where the *other* class is
    caught. Worth keeping because the proposal reads as free and would have given up the only
    non-redundant part of comparison 2's gain.
