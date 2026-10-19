# ADR-0374: The tamper that buries the finding

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-19 |
| **Authors** | platform |
| **Reviewers** | platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0373, ADR-0371, ADR-0332, ADR-0331, ADR-0334, ADR-0363, ADR-0367, ADR-0286 |

## Context

ADR-0373 asked what a multi-row read does with a row its own contract refuses, and answered it: a
sweep whose purpose is to find defective rows must route the refusal into the finding set, because
dropping it is silence one layer in and throwing takes every other row's finding with it. That
increment gave `kernel-pg` a primitive, migrated fifteen reads, added a twelfth workspace rule over
the class, and — in the subsystem that matters most — made a blanked `actor_reference` on a chain
entry read as `compromised` with a paging `sev1`, where before it filed `outcome: "error"` and
produced one log line an hour for ever.

**And one `UPDATE` on a column of a different table cancels that alarm.**

`proveScopeIntegrity` reaches `checkpoints.latest(scope)` with no `try` around either call site:
once inside `verifyChainFromCheckpoint`, to decide whether the bounded path is available, and once
directly, for the truncation check that is the only detector for a chain cut short (ADR-0287). The
count is **per mode and not per pass** — two on `fromCheckpoint: true`, one on `false`, because the
first site is gated on the mode — and that is exactly why Option A below closes nothing: the call a
full fold reaches is the one the chain half never makes. ADR-0373 gave `PostgresChainCheckpointStore` a parse on read — which is correct, and is
the premise the rest of this increment rests on — so a checkpoint row this binary cannot read now
reaches those two `await`s as a thrown `ZodError`. The hourly `IntegrityProofScheduler` catches it as
`outcome: "error"`: no verdict row, no `onFinding`, no `escalate`, **no paging `sev1`**.

So the class is **the increment's own alarm, cancelled by a write it does not fence**. It is
ADR-0373's own graded way (3) — *the tamper disabled the detector* — on a read that increment
migrated and a *table* it did not fence, and the direction is the dangerous one: the cheaper write
buries the finding about the dearer one.

Two facts make it a real attack rather than an operator's mistake.

**It is reachable by the tenant, not only by an owner.** `meta.forensic_chain_checkpoints`' isolation
policy is `ALL`-scope with a NULL `WITH CHECK`, so its `USING` expression doubles as its write check
and a tenant-context session may `UPDATE` its own checkpoint. Measured live as the non-owner
`serving` role: `UPDATE 1`.

**And the column was unconstrained.** `checkpointed_by` is `TEXT NOT NULL` against a contract field
of `z.string().min(1)`, and it carried no CHECK — one of the two columns on that table in that state,
the other being `external_anchor_reference`, which is the sibling nobody was pointed at.

## Decision

Four parts.

1. **`anchor_unreadable` is a fifth `ChainFullReason`.** `verifyChainFromCheckpoint` catches
   `CheckpointRowUnreadable` — and **only** that error — and folds from genesis, naming the reason.
   Anything else from `latest` is a read that did not happen, and a fold claiming to replace it would
   assert a verification over a scope whose anchor state is unknown.

2. **The refusal is also a finding.** `IntegrityProofReport.anchorRowsRefused` is a third refusal
   axis beside `chainRowsRefused` and `anchors.unreadable`, and `integrityVerdictFor` answers
   `compromised` for it — **beside `tampered` and not beside `unanchored`**, on ADR-0373's exact
   argument one table across: `PostgresChainCheckpointStore.record` begins with
   `ChainCheckpointSchema.parse`, so no checkpoint this binary writes can be one it cannot read back,
   and a refused row was therefore written out of band or edited since. It is checked **before**
   `anchors === null`, so the finding does not depend on whether anything else in the scope happened
   to be anchored.

3. **Two CHECKs**, so the blanking is refused at the database:
   `char_length(checkpointed_by) >= 1` and `char_length(external_anchor_reference) >= 1`.

4. **The surfaces that read those figures move with them** — `readEveryRowFound` (so the scheduler
   cannot discard the report as an empty scope), `formatIntegrityProof` (which names the refused
   checkpoint and stops offering a remedy that cannot work), and the escalation audit row (a third
   `checkpointRows` list, so a `sev1` driven by this cause names it).

Nothing is added to `integrityVerdictPayload`, `StoredIntegrityReportSchema`,
`canonicalStoredReport` or `storedIntegrityReportFor`: those four must move together or the stored report
stops being byte-identical to its committed payload, which is the trap ADR-0371 reverted a field out
of. The fact travels in `verdict`, which is both signed and projected; the identities travel in the
line an operator reads.

## Alternatives considered

- **Option A: catch the refusal in `verifyChainFromCheckpoint` alone.**
  - **Pros:** one `try`, in the function whose own doc comment is about which anchors it will trust.
  - **Cons:** closes nothing on the mode that matters.
  - **Why not:** **measured**: on `fromCheckpoint: false` the chain half never calls `latest` at
    all, so the second, direct call for the truncation check is still unguarded and the whole pass
    still throws. That second call is the one `--integrity-proof-config` reaches on every full fold,
    and a full fold is what a deployment whose anchors cannot be trusted does on *every* pass.

- **Option B: fold from genesis and let the pass read `verified`.**
  - **Pros:** no contract change at all — `ChainFullReason` plus one `catch`.
  - **Cons:** the verification is correct and the report is a lie by omission.
  - **Why not:** a full fold over a sound chain answers `ok: true`, so the pass reads as a healthy
    full verification and the anchor's refusal reaches nobody. That is ADR-0337's falsely-true
    direction, and it is the worse half of it here: the row that refuses was *written by somebody*,
    and treating it as a mode change makes the write free.

- **Option C: grade it `unproven` rather than `compromised`.**
  - **Pros:** an unreadable anchor is arguably an absence of evidence, and ADR-0286 deliberately does
    not page on `unanchored`.
  - **Cons:** the premise is wrong.
  - **Why not:** ADR-0373's argument, unchanged by the table: an unanchored row is the absence of
    evidence (a deployment upgrading from before ADR-0286 has such rows for ever), while a row this
    deployment's own reader refuses is evidence of something, because the write path parses. And
    rewriting a row into a shape the contract refuses is **easier** than rewriting it into a valid
    one, so grading it below `compromised` would leave the cheaper attack as the one that does not
    page — which is this increment's whole subject.

- **Option D: answer `null` from `latest()` for a refused row instead of throwing.**
  - **Pros:** no new reason, no new axis; the bounded path already handles `null` by folding.
  - **Cons:** it conflates two facts with opposite remedies and it is unfixable downstream.
  - **Why not:** it is ADR-0331's conflation inside a verification — *nobody anchored this scope*
    and *somebody edited this scope's anchor* would become one value, with opposite remedies.
  - **Correction, and it is the one this ADR got most wrong.** The first version of this entry
    argued that `no_checkpoint` heals on the next scheduler pass "and this cannot, because `record`
    is `ON CONFLICT (tenant_id, sequence_number) DO NOTHING` so the refused row stays where it is",
    and concluded that answering `null` would offer a remedy the scheduler cannot touch. **`DO
    NOTHING` blocks replacement at *that sequence*; the scheduler anchors at the *tail*, which is a
    different sequence.** The row stays and the finding does not — so running the scheduler was
    precisely what silenced this condition, and the reasoning that called it unhealable was the same
    mistake that let the fix bury its own alarm (see the addendum). The conclusion survives on the
    conflation argument alone, which is why it is kept rather than withdrawn.

- **Option E: narrow the isolation policy so a tenant cannot `UPDATE` its own checkpoint.**
  - **Pros:** addresses the write rather than its consequence, and would cover every column at once.
  - **Cons:** it is a decision spanning the catalog, not this table.
  - **Why not:** **measured live — 78 tables in `meta` carry an `ALL`-scope `*_tenant_isolation`
    policy with a NULL `WITH CHECK`**, so every one of them is in the same state, and **0 of the 78
    carry a `DELETE`-scoped policy** while all 78 admit a tenant-scoped `DELETE` through that same
    arm. Narrowing one table would leave 77, and narrowing 78 changes what every tenant write path
    in the platform may do. Reported rather than fixed; see *Open questions*.

- **Option F: an upper bound on both CHECKs, matching the catalog's majority
  `char_length(x) BETWEEN 1 AND N` idiom.**
  - **Pros:** consistency with 500-odd sibling columns.
  - **Cons:** it would refuse what the contract permits.
  - **Why not:** `ChainCheckpointSchema.checkpointedBy` and `.externalAnchorReference` are
    `z.string().min(1)` with **no maximum**, and a CHECK narrower than its contract is the same
    defect pointing the other way (ADR-0373's rule, inherited).

## Consequences

- **Positive:** the alarm ADR-0373 built cannot be cancelled by blanking a checkpoint column. The
  verdict, the unattended log line and the escalation audit row all name the cause. The two CHECKs
  make the write itself fail, so on an upgraded deployment the attack is refused rather than merely
  reported. And the bounded proof's soundness condition gains its third honest answer: an anchor
  that cannot be read is not an anchor, said by name rather than by a thrown pass.

- **Negative:** three things.
  **(a)** Two CHECKs are **standing manual SQL** on every existing deployment. The plan reports them
  as `constraint_widening_unproven` with the `BEGIN`/`ALTER`/`COMMIT` triple, because the live
  constraint set implies nothing about a new one and ADR-0363's prover answers `not_implied`. They
  will succeed on any deployment whose checkpoints were written by this binary.
  **(b)** `integrityVerdictFor` gained a fifth parameter, so every call site had to be named — which
  is what a required parameter buys and is also **21** test call sites in one file (an earlier
  version of this line said 19 and was simply miscounted; `grep -c 'integrityVerdictFor('` on
  that file answers 21, all of them genuine calls).
  **(c)** A refused anchor now makes the pass `compromised` for a scope whose chain is sound, which
  is the correct answer and is a paging `sev1` an operator must be able to act on. The remedy is in
  the log line (the identity and the field path) and nowhere else, because the durable record carries
  only what the digest covers.

- **Neutral:** `CHAIN_FULL_REASONS` is five members and `CHAIN_FULL_REASON_PHRASES` is a total map
  over it, so a sixth is a compile error. The three declining reasons remain unreachable from
  `CheckpointScheduler`, the workspace's only checkpoint writer, which is deliberate rather than an
  omission — see that constant's doc comment.

- **Reversibility:** the verdict clause, the formatter line and the escalation list are each a few
  lines and individually revertible. The two CHECKs are not, in one direction: once applied, a
  deployment holding a blanked row cannot re-apply them, and the plan says so with the violator
  `SELECT` alone rather than offering a `DROP`/`ADD` pair that would leave the table with no rule
  (ADR-0363). `anchorRowsRefused` is a **required** field on `IntegrityProofReport`, so removing it
  is a contract change with the same call-site cost as adding it.

## Implementation notes

- `apps/operate-server/src/chain-verify.ts` — `anchor_unreadable` plus its phrase, and a typed
  `try`/`catch` around the one `latest()` call. The catch tests `err instanceof
  CheckpointRowUnreadable` and rethrows otherwise.
- `apps/operate-server/src/integrity-proof.ts` — `anchorRowsRefused` on the report, an accumulator
  around the **second** `latest()` call, the fifth parameter and `compromised` clause on
  `integrityVerdictFor`, the fourth conjunct in `readEveryRowFound`, and two formatter changes.
  The `truncation: not checkable` line is now a pair, because for a refused anchor both halves of the
  original sentence are false.
- `apps/operate-server/src/integrity-escalation.ts` — `unreadable.checkpointRows`, through the same
  `recordedRefusal` cap (20 identities, full count beside them). No `detail`, for
  `MAX_RECORDED_UNREADABLE_IDENTITIES`' own stated reason.
- `packages/forensics-pg/src/checkpoint-store.ts` — `CheckpointRowUnreadable`, `readOne`, and
  `listRecent` answering `{records, unreadable}` (ADR-0373's verifier shape, because a checkpoint
  history is read to be checked).
- `packages/kernel/src/bootstrap/meta-schema.ts` — the two CHECKs, with the whole-table invariant
  asserted in `meta-schema.test.ts`: exactly four columns of that table may carry none, each fully
  constrained by its declared type.
- `packages/testing/src/strategy/pg-unreadable-rows.ts` — the `listRecent` declaration is **deleted**,
  not weakened: an `overtaken` declaration's fix is removing the line.

### Verified live

On PG 16.13, as the non-owner `serving` role, against a real cluster, on a fresh scope per run
(mandatory — every run mints an ephemeral keypair and a chain entry's signature stays in the table
for ever, so reusing a scope makes the full fold cover a previous run's unresolvable signatures and
the baseline reads `compromised` for a reason that has nothing to do with the finding):

**15 of 15.** The healthy anchored chain verifies in both modes; a tenant-context `UPDATE` blanks
`checkpointed_by` (`UPDATE 1`); `latest()` refuses the row by name (`CheckpointRowUnreadable:
identity=3 detail=checkpointedBy: too_small`); the chain half folds from genesis reading
`[full: anchor is stored in a shape the contract refuses] — OK`; **both** proof modes answer
`compromised` with `anchorRowsRefused=1`; the truncation check reads
`checkpointSequence=null truncated=false` — unanswerable rather than cleared; the unattended line
reads `unreadable checkpoint 3 (checkpointedBy: too_small)` and
`truncation: not checkable (the latest checkpoint cannot be read — see below)`; repairing the row
restores `verified / from_checkpoint` exactly; and the **sibling column behaves identically**
(`externalAnchorReference: too_small`, same verdict), which is why it is fenced in the same change.

The migration, measured on the **populated** cluster, exercised **both** of ADR-0363's arms at once
— and the other arm is the sharper result:

- the two new CHECKs report `constraint_widening_unproven` with the `BEGIN`/`ALTER`/`COMMIT` triple;
- `forensic_chain_entries.actor_reference` — ADR-0373's own CHECK, on the same cluster — reports
  **`constraint_violated_by_existing_rows`** with the violator `SELECT` **alone and no `ALTER`**,
  because that cluster really holds the blanked row ADR-0373 measured. **The migration finds a tamper
  rather than merely preventing the next one.**

Pasting the two reported statements verbatim applies them (`ALTER TABLE` ×2), after which: the
re-plan drops both (`unreconciled` 5 → 3, the remaining three being ADR-0373's own standing SQL); the
same blanking as the non-owner is refused `violates check constraint
"forensic_chain_checkpoints_checkpointed_by_check"` and likewise for the sibling; and
`external_anchor_reference = NULL` is still `UPDATE 1`, so the absent anchor — the claim this column
makes for every checkpoint that is not externally anchored — is admitted with no guard, because a
CHECK passes when its expression is NULL. A fresh database gets both inline out of `emitCreateTable`
with no manual SQL.

The `DELETE` census is the reported finding: 78 tables, 0 `DELETE`-scoped policies, and a
tenant-context non-owner deleted **its own checkpoint (`DELETE 1`), its own 12 chain entries
(`DELETE 12`) and its own 3 audit rows (`DELETE 3`)**, rolled back. The empty-scope control matters
and was run: the same statement for a scope holding nothing answers `DELETE 0`, which is
byte-identical to a refusal — ADR-0333's silent zero, in the measurement that would otherwise have
read as protection.

### Offline

`operate-server` 4862 (126 files), `forensics-pg` 109, `kernel` 767, `kernel-pg` 806, `testing` 663;
typecheck clean including tests. Mutations confirmed and reversed by the same string replacement,
never `git checkout`: the verdict clause (4 failures), the `readEveryRowFound` axis (1), the
escalation list (**2** failures — an earlier version of this line said 1, measured in isolation as
`integrity-escalation.test.ts` two cases), the `chain-verify` catch (2 files), and
`proveScopeIntegrity`'s own accumulator (2 files) — **five, not four**. The fifth was omitted from
the first count and is the one Option A's entire argument rests on, so leaving it unlisted made the
weakest-looking claim in this ADR the one with no stated evidence; it is in fact fenced.

## Addendum — what an adversarial pass over the commit found

Ten findings, four of them live wrong answers. **Three of the four were introduced or made reachable
by this commit**, and the first is the increment's own class reproduced inside its own fix — which is
the useful shape of it: routing a refusal into a verdict changes what every surface that *consumes*
that verdict means, and the consumers do not move with it.

### The fix erased its own alarm, through the platform's own scheduler

`CheckpointScheduler` consumes `verifyChainFromCheckpoint` as its `verify` seam and decides whether
to anchor on `if (!verification.ok)`. This commit made that function answer `ok: true` on a refused
anchor instead of letting the store's throw escape — right as a *verification*, and it moved the
scheduler from `outcome: "error"` (loud, writes nothing) to `outcome: "recorded"`, writing a
**readable** checkpoint at the current tail. `latest()` orders by `sequence_number DESC`, so the new
row masks the refused one and `anchorRowsRefused` goes back to empty.

Measured live as the non-owner `serving` role, additive writes only:

```
a. latest() refuses the anchor            : YES (checkpointedAt: invalid_string)
b. integrity pass BEFORE the scheduler    : verdict=compromised anchorRowsRefused=1 callbacks=[onPass,onFinding,escalate]
c. one CheckpointScheduler pass           : outcome=recorded seq=4 provenance=verified_full fullBecause=anchor_unreadable callbacks=[]
d. integrity pass AFTER the scheduler     : verdict=verified   anchorRowsRefused=0 callbacks=[onPass,escalate]
e. refused row still on disk              : 3@infinity  4@2026-10-19 22:27:49+00
```

Pre-commit, letting the throw escape: `outcome=error callbacks=[onError] wroteCheckpoint=false`. **So
the commit converted a loud scheduler error into a silent success that erases its own new finding,
with no callback at all.** The bound is exact and is why this is not a narrow race: the finding
survives only while the tail is at or below the refused anchor's sequence, where `DO NOTHING` fires,
and is buried the moment the chain gains one entry — every audited request, on a serving deployment
(ADR-0286). `node.ts` also starts the checkpoint lifecycle *before* the integrity proof, both
`runOnStart` and both hourly by default, so on the paired configuration the burial happened
milliseconds before the proof looked and the alarm could never fire once.

**It refutes this ADR's own Option D reasoning**, corrected in place above: `DO NOTHING` blocks
replacement *at that sequence* and the scheduler anchors at the *tail*, a different sequence. "The
refused row stays where it is" is true of the row and false of the finding — running the scheduler is
precisely what silenced it.

`CHAIN_FULL_REASON_BLOCKS_ANCHORING` is the fix: a total map over the five reasons, with only
`anchor_unreadable` true. It is named for what it decides rather than for ADR-0371's
finding-versus-gap split, which it deliberately does not re-litigate — `requested` and
`no_checkpoint` have nothing to bury, and for `anchor_unverified` and `anchor_provenance_absent`
anchoring **is** the heal, since a row stating that nothing vouched for its prefix is *superseded* by
a vouched anchor rather than hidden by it. Only a row this binary cannot read costs a detector when
masked. The scheduler refuses with its own fifth outcome rather than reusing `refused_unverified`,
because that one means *the chain was read and did not verify*, which is false here and would report
a sound chain as broken. The price is stated: such a scope folds from genesis on every pass until the
row is corrected (~152 µs of Ed25519 verify per entry, ADR-0371), which is the right price because
the alternative silences the alarm, and it is self-healing in the correct direction. It also makes
`node.ts`'s start order **irrelevant** rather than merely safe, which matters because ADR-0371
refused to let soundness depend on a start order in a third file.

### `verify-chain --from-checkpoint` exited 0 for a refused anchor

This ADR's Option B rejection names the hazard exactly — *a full fold over a sound chain answers
`ok: true`, so it reads as a healthy full verification* — fixes it for the hourly
`proveScopeIntegrity` through the new axis, and leaves it standing in the by-hand auditor command,
whose help text frames the exit code as the verdict. Measured against a pre-fix worktree at the
committed tree, on a sound chain whose anchor is refused:

```
PRE-FIX  verify-chain --tenant <t> --from-checkpoint  ->  EXIT=0  "[full: anchor is stored in a shape the contract refuses] — OK"
FIXED    verify-chain --tenant <t> --from-checkpoint  ->  EXIT=1
FIXED    verify-chain --tenant <t>                    ->  EXIT=0   (full fold: never consults the anchor, so it claims nothing about it)
FIXED    no_checkpoint on a sound chain               ->  EXIT=0   (the three non-finding reasons are untouched)
```

The predicate is `anchoringWouldBury(report.fullBecause)` and not `fullBecause !== null`, so the same
total map decides the scheduler's refusal and the command's exit code — the two cannot come to
disagree about which anchors are a finding. The full fold staying 0 is deliberate and is the
asymmetry worth stating: it does not read a checkpoint at all, so exiting 0 for "the entries fold and
verify" is honest there; the defect was specifically the mode that *consulted and refused* the anchor
and then reported OK.

### The claim about a chain tamper was never measured, and measuring it said something better

Two comments asserted that blanking `checkpointed_by` "cancelled the alarm about a genuine chain
tamper one table over" and that the hourly pass "went from `compromised` + escalation to a single log
line". **No scope on the cluster held both tampers** — the only blanked `actor_reference` sits on a
scope with zero checkpoint rows — so the pairing was asserted rather than taken.

Performed, on one scope holding both (a blanked `actor_reference` at sequence 1 *and* its own anchor
refused), as a non-owner:

```
0. baseline, both readable          : verdict=verified     chainRefused=0 anchorRefused=0 mode=from_checkpoint
1. ADR-0373's finding alone         : verdict=compromised  chainRefused=1 anchorRefused=0 mode=from_checkpoint
2. both tampers, bounded mode       : verdict=compromised  chainRefused=1 anchorRefused=1 mode=full fullBecause=anchor_unreadable
3. both tampers, full fold          : verdict=compromised  chainRefused=1 anchorRefused=1 mode=full fullBecause=requested
```

The result is sharper than the claim it replaces: a chain-row finding is a **field of a verdict**, so
a pass that throws does not *cancel* it — it never computes it. Post-fix the two coexist and the
unattended line names both (`unreadable chain entry 1 (actorReference: too_small)` and `unreadable
checkpoint 3 (checkpointedAt: invalid_string)`). The second tamper does not cancel the first on this
code; it used to erase the pass that would have reported it.

That run also demonstrated the next finding, because the tamper it uses is a **third** column:
blanking `checkpointed_by` is now refused by this increment's own CHECK, so the measurement had to
reach for `checkpointed_at = 'infinity'`, which is admitted.

### A proven truncation was discarded as an empty scope

`isEmptyScope` tested `tailSequence === null && noAuditRows && readEveryRowFound` and
`truncation.truncated` was **not** a conjunct — while `integrityVerdictFor` checks truncation
*first* and answers `compromised`. This commit added a fourth axis to `readEveryRowFound` and wrote
a long comment about which axes fire there **without re-examining the other two conjuncts against
the verdict function**. Measured live on a scope with no chain entries, a readable checkpoint at 3
and no audit rows:

```
pre-fix   verdict=compromised truncated=true  outcome=skipped_empty  callbacks=[]
post-fix  verdict=compromised causes=["chain_truncated"]  outcome=proved  onPass:1 onFinding:1 record:1 escalate:1
control   (same scope, checkpoint deleted)    outcome=skipped_empty  callbacks=[]
```

The asymmetry is the sharp part: the **weaker** evidence (an anchor that cannot be read) was kept
and the **stronger** — a proven total truncation, the thing ADR-0287 built the check for — was
thrown away. Only the *maximal* truncation was lost; with one surviving entry the tail is non-null
and the first conjunct already fails, which is why a partial cut was visible and a total one was not.

The fix is one level up: the question is asked of the **verdict**, which is total over every
condition, rather than of a conjunct list that must be revisited whenever a condition is added.
`readEveryRowFound` stays, and **the reason given for keeping it in the brief was wrong**. The brief
claimed nothing could reach it any more; it is still evaluated on every idle pass, and **two tests
across three fixtures reach it with a differing answer** — each overrides a refusal axis on a
fixture whose `verdict` stays `verified`, and deleting the call is measured to fail exactly those
two. So the honest statement is that it can no longer change the answer *for a report
`proveScopeIntegrity` builds*, and the retention argument is concrete rather than hypothetical:
`verdict` is a **claim** on the report and `prove` is a seam, while the refusal lists are the
**content** — ADR-0331's distinction inside one predicate. Likewise `unproven` cannot reach
`skipped_empty` from the producer (`checked` *is* `results.length`, so one unanchored row gives
`{checked: 1, unanchored: 1}` and `noAuditRows` already excludes it) and **can** from the seam,
measured: with the clause removed a hand-built `unproven` report of the empty shape was discarded.

### The "one test per branch" fence fenced nothing

`integrity-escalation.test.ts` claimed a seventh cause arriving with no payload key would fail
there. Refuted by mutation in an isolated worktree: a seventh `compromised` branch with no key gave
**83 passed (83)**, zero failures, because nothing enumerated the branches and the tests were
hand-written `it`s. ADR-0288's maintained list, and ADR-0351's *documented the hazard and checked
nothing*. The claim was also false on its own count — six branches, five branch-covering tests.

So the fence is built rather than the claim corrected down. `COMPROMISE_CAUSES` enumerates the six
conditions, `COMPROMISE_CAUSE_HOLDS` is a total map of predicates over it, and
**`integrityVerdictFor` is implemented through `compromiseCauses`** — six `return "compromised"`
became one — so the branch list *is* the cause list. The mechanism is measured rather than claimed:

```
M1a  7th entry in COMPROMISE_CAUSE_HOLDS alone   -> TS2353, the entry does not exist in the Record
M1b  + the 7th enum member                       -> TS2741 x3: the payload key, and both fence fixtures
M1c  a bare `if (…) return "compromised"` in the body -> typechecks CLEAN, fails the text fence
```

So a seventh cause cannot compile until the escalation row gains a key that explains it. M1c is the
one gap no type can see, and a text fence over the function body covers it — which **caught a
vacuity hazard on its own first run**: the prose two functions above quotes `return "compromised"`,
so the raw-source count was 2, and the lazy fix is to write the expectation down to 2, after which
the fence checks nothing. It drops whole-line comments and requires the semicolon, and says so.

Three of the dictated design's details were refused with reasons worth keeping. The **elementwise
truth-table test** was refused because writing the old `if` sequence into the test to compare
against is ADR-0362's retired test verbatim — a rule compared against a derivation of itself; the
golden is the 21 existing `integrityVerdictFor` call sites, written against the `if`s and untouched.
`chain_broken_or_unsigned` stays **one cause for two facts**, because splitting it would be a
seventh condition and would leave `ok: false` with both sub-flags set unrepresented. And
`causes` was added to the `after` payload beyond the brief, for a reason the live row shows: on
`chain_truncated` the six evidence keys read `chain.ok: true`, `tampered: []` and all three refusal
counts `0`, so `truncated: true` is the single bit an operator must spot.

### A third column, and the one ADR-0373 exempted by name

`checkpointed_at` carries the same attack: `TIMESTAMPTZ` admits two infinities and years to 294276,
`Iso8601` admits none, and `'infinity'` arrives from node-postgres as the **number** `Infinity`, so
`asIso`'s `instanceof Date` is false and `String()` yields `"Infinity"`. `UPDATE 1` as a non-owner.
So this ADR's claim that the two CHECKs "make the write itself fail" was false, and the whole-table
invariant it added was false under its own predicate.

**And ADR-0373 missed the same shape on its own table, having exempted it by name.**
`META_FORENSIC_CHAIN_ENTRIES.recorded_at` was in exactly the state `actor_reference` and `signature`
were in, and that ADR's test comment called it *"the TIMESTAMPTZ that `Iso8601` parses to"*. It is
inside `canonicalEntryBytes`, so a tamper there is signature-breaking exactly as `actor_reference`
is.

**Neither is a buried alarm, and that lowers the severity of both** — the correction this addendum
has to make about its own framing. ADR-0373's read-path fix covers the entries table (`loadChain`
answers `entries=11 unreadable=1`, graded `compromised`), and `readOne` catches **any** throw rather
than only a `ZodError`, so `latest()` answers `CheckpointRowUnreadable` on both proof modes. The
**write fence** was missing, on two tables, not the detector.

The class is **444 TIMESTAMPTZ columns across 146 tables with zero CHECKs between them**, so these
are the catalog's first temporal ones; 165 distinct reads across 53 files parse such a column
against a contract that refuses infinity, and 49 of those in 11 files sit in a detector subsystem —
8 of the 11 already `guarded_by_primitive`. The sharpest remainder is on **neither** table fenced
here: `meta.audit_integrity_verdicts.verified_at`, whose `isoOf` helper is a different shape
(`new Date(String(value)).toISOString()`), so the same tamper becomes a bare `RangeError: Invalid
time value` rather than a `ZodError`, in a `record_throwing` conversion with no wrapper, in the store
that holds the verdicts.

Three things about the expression are measured, and **two refute what this increment first proposed**:

- The lower bound is **1 BC and not 1 AD**. `toISOString()` renders JS year 0 as
  `0000-01-01T00:00:00.000Z` and zod **admits** it, and JS year 0 is Postgres 1 BC — so an
  `0001-01-01` AD bound refuses a value the reader accepts, which is ADR-0373's no-upper-bound rule
  pointing the other way.
- The explicit **`+00` on both bounds is load-bearing**, and the first proposal's worry that a
  literal `BETWEEN` might be *structurally illegal* is refuted — Postgres constant-folds the cast at
  parse time, so the stored node holds a `timestamptz` `Const`. The real hazard is the **bare**
  literal, which folds in the applying session's `TimeZone`: measured across three zones the
  offset-bearing form is epoch −62167219200 in all of them, while bare `'0001-01-01 BC'` gives
  −62167219200 / −62167252739 / −62167190822, and under `Asia/Tokyo` it folds to
  `0001-01-01 00:00:00+09:18:59 BC` — it **crosses the era boundary** and moves the bound by
  9h18m59s. The reconciler stays clean either way, because `pg_get_constraintdef` renders at read
  time so both sides render in one session and agree, which is exactly why simplifying the offsets
  away would go unnoticed. There is a test for that mutation.
- The upper bound is **half-open**, and there is deliberately no `isfinite()` (the range bounds
  refuse both infinities on their own, so it could never fire) and no `extract(year from …)` — which
  Postgres *accepts* in a CHECK and which is **STABLE**, so the constraint would mean different
  things in the writing session and a later validation (`9999-12-31T23:30:00Z` is year 9999 under
  UTC and 10000 under Tokyo). `extract` does not raise on infinity either; it returns `Infinity`.

The two tables migrate on **opposite arms of ADR-0363**, confirmed twice independently:
`recorded_at` has no violating row and gets the `BEGIN`/`ALTER`/`COMMIT` triple, while
`checkpointed_at` reads `constraint_violated_by_existing_rows` with the violator `SELECT` **alone
and no `ALTER`**, because the cluster really holds four rows at `infinity`. **The migration finds
the tamper** — the second instance in this increment. The test's three exempt columns are exempt for
a measured reason now rather than an assumed one: `READ_COLUMNS` names neither `id` nor
`created_at`, nothing in `forensics-pg` reads `created_at`, and neither schema has a field for it —
so the rule is *a column is owed a CHECK iff a reader parses it against a contract narrower than its
type*, which is what replaced "fully constrained by its declared type".

One finding for the rule directory rather than for here: `pg-record-reads.ts` runs
`blankStringBodies` before matching, so `asIso(row["checkpointed_at"])` has the column name blanked
and the read vanishes — **neither fenced column appears in its 66 reads**, against ~1,270
bracket-access reads of a catalogued column in the workspace, 100 of them temporal.
Conservative-only, and wide.

### Six documented claims were false, and the pattern is the finding

Each is corrected in place above and in CLAUDE.md. They are listed because the *shape* recurs: a
figure asserted without re-deriving it, and a sentence whose next clause already contradicts it.

- **"the 23 tables in the same state"** in `meta-schema.ts`, in the same commit whose ADR, message
  and CLAUDE.md entry all say **78**, in a sentence pointing the reader at that figure. 23 is no
  census of anything measurable here (the candidates are 78, 73, 37, 33, 13 and 5).
- **`storedReportFrom` names nothing.** The "four that must move together" listed three real symbols
  and one phantom; the function is `storedIntegrityReportFor`. Inherited from ADR-0373 and restated
  in a comment this commit wrote, so a reader grepping it finds nothing.
- **"three read paths go through one private `readOne`"** — two do, and the next clause of the same
  sentence says `listRecent` uses the other shape.
- **The `DELETE` triple was stitched from two tenants.** `1 / 12 / 3` is answered by no scope.
  Re-derived per scope with the **owner's row count as the control**, which the triple lacked: on
  **6 of 6** scopes the non-owner's `DELETE` equalled the owner's count on all three forensic
  tables, which is both the honest form and a stronger statement.
- **"awaits `latest` twice per pass"** is per *mode*, not per pass — two on `fromCheckpoint: true`
  and one on `false` — and that is precisely why Option A closes nothing.
- **"19 test call sites"** is 21, and **"four mutations"** is five: the omitted one is
  `proveScopeIntegrity`'s accumulator, which Option A's whole argument rests on, so leaving it
  unlisted gave this ADR's weakest-looking claim no stated evidence. It is in fact fenced.

### Survived the attack

The branch/axis work and the digest parity hold. `integrityVerdictFor` really answers six
`compromised` branches with every one named in the escalation payload; `anchorRowsRefused` is
checked before `anchors === null`; the formatter prints what this ADR says it prints; the nullable
CHECK admits NULL with no guard and `check-admission.ts` classifies it `unclassified` so the boot
survey reports nothing false about it; and the parity claim is **mutation-proven** rather than
reasoned — adding `anchorRowsRefused` to `integrityVerdictPayload` alone fails the parity test.
`record` really does begin `ChainCheckpointSchema.parse`, and no value it writes was found that it
cannot read back.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| 78 tables admit a tenant-scoped `UPDATE` **and `DELETE`** of their own rows through one `ALL`-scope isolation arm, and CLAUDE.md's "`DELETE` is reachable by no policy" is true of the named arms and false of the behaviour. Narrowing them is one decision over the whole catalog. | platform | 2026-11-30 |
| A refused anchor is reported and no CHECK exists for the **other** 505 TEXT / 159 JSONB columns in the same unconstrained state (register P2.12b). This increment fenced two because their unreadability defeats a detector; the general rule compares a contract field's refinement to its column's CHECK, which no workspace rule does. | platform | 2026-12-15 |
| **Widen the detector so the scheduler can anchor again.** `listRecent` already returns records beside refused rows, has zero non-test callers, and ADR-0373's own doc comment on it predicts this consumer verbatim. Measured: `ChainCheckpointSchema.parse` is 4.09 µs/row, so a year of hourly passes is 36 ms to scan the whole history, against 15.2 s/pass at 100k chain entries for the fold the refusal now makes permanent — and the ratio improves with scale, the checkpoint table growing one row per *pass* and the chain one per *audited request*. Blocked on `listRecent` being `ORDER BY … LIMIT $1` with no cursor, default 50, so at hourly cadence the refused row leaves the window in ~2 days (ADR-0367's "a prefix is not the set"). Relaxing afterwards is one line — the map member flips to `false` — and the scheduler's tests re-aim themselves. | platform | 2026-12-31 |
| **Truncation detection is dark for a scope whose anchor is withheld.** `checkpoint` stays null, so `truncated` is always false while the row stands. No alarm is lost (the axis answers `compromised` regardless), but a dimension of the diagnosis is — and the symmetry is the argument for the item above: pre-fix the burial *accidentally restored* truncation detection while destroying the refusal finding, post-fix it is the reverse, and only the widened read gives both. | platform | 2026-12-31 |
| `meta.audit_integrity_verdicts.verified_at` is the sharpest member of the temporal class and is on **neither** table fenced here: its `isoOf` helper is `new Date(String(value)).toISOString()`, so the same tamper is a bare `RangeError` rather than a `ZodError`, in a `record_throwing` conversion with no wrapper, in the store that holds the verdicts. Two more: `tombstone-store.deleted_at` and `report-store.generated_at`. | platform | 2026-12-15 |
| `pg-record-reads.ts` blanks string bodies before matching, so a bracket-access read of a catalogued column vanishes — neither column fenced here appears in its 66 reads, against ~1,270 such reads workspace-wide, 100 of them temporal. A thirteenth-rule finding, conservative-only. | platform | _N/A_ |
| `anchorRowsRefused` is at most one row by construction (`latest()` reads one), so it is a list for uniformity with its two siblings rather than because it can hold two. The item above would make it genuinely plural. | platform | _N/A_ |
| The bounded path discards the `UnreadableRow` it catches, so `fullBecause: "anchor_unreadable"` can coexist with an empty `anchorRowsRefused` if the two reads see different rows. Left open on three measurements: it needs a third party writing the checkpoint table mid-pass and `CheckpointScheduler` now refuses to be one; the *other* ordering already answers `compromised`; and on a full fold the chain half never calls `latest`, so there is no divergence to have. Closing it needs `ChainVerificationReport` to carry a checkpoint identity, which is the merge ADR-0373 argued against. | platform | _N/A_ |
| The remedy for a refused anchor is in the log line only. An operator holding a `sev1` has the identity and the field path and no route to the row — the diagnostics console (ADR-0364 Q6) is where that would live. | platform | 2026-12-31 |

## References

- ADR-0373 — a sweep one bad row stops; the parse on read this rests on, and the alarm this protects.
- ADR-0371 — an anchor nobody verified; `CheckpointProvenance` and the bounded proof's soundness.
- ADR-0332 — the platform write split; why this store is append-only and `DO NOTHING` cannot heal.
- ADR-0363 — `predicate_implied_by`; why both CHECKs are reported rather than planned, and why the
  conclusive arm hands over the violator query alone.
- ADR-0334 — a remedy that cannot work is worse than naming none.
- ADR-0331 — a claim is not an absence; why `no_checkpoint` and `anchor_unreadable` stay apart.
- ADR-0287 / ADR-0286 — the truncation check's witness, and why `unanchored` does not page.
