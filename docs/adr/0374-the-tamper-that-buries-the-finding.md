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

`proveScopeIntegrity` awaits `checkpoints.latest(scope)` **twice** per pass with no `try` around
either: once inside `verifyChainFromCheckpoint`, to decide whether the bounded path is available,
and once directly, for the truncation check that is the only detector for a chain cut short
(ADR-0287). ADR-0373 gave `PostgresChainCheckpointStore` a parse on read — which is correct, and is
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
`canonicalStoredReport` or `storedReportFrom`: those four must move together or the stored report
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
  - **Why not:** `no_checkpoint` heals on the next scheduler pass and this cannot, because `record`
    is `ON CONFLICT (tenant_id, sequence_number) DO NOTHING` so the refused row stays where it is.
    Answering `null` would hand an operator "run the checkpoint scheduler" as the remedy for a
    condition the scheduler cannot touch (ADR-0334). It is also ADR-0331's conflation inside a
    verification: *nobody anchored this scope* and *somebody edited this scope's anchor* would become
    one value.

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
  is what a required parameter buys and is also 19 test call sites in one file.
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
typecheck clean including tests. Four mutations confirmed and reversed by the same string
replacement, never `git checkout`: the verdict clause (4 failures), the `readEveryRowFound` axis (1),
the escalation list (1), the `chain-verify` catch (2 files).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| 78 tables admit a tenant-scoped `UPDATE` **and `DELETE`** of their own rows through one `ALL`-scope isolation arm, and CLAUDE.md's "`DELETE` is reachable by no policy" is true of the named arms and false of the behaviour. Narrowing them is one decision over the whole catalog. | platform | 2026-11-30 |
| A refused anchor is reported and no CHECK exists for the **other** 505 TEXT / 159 JSONB columns in the same unconstrained state (register P2.12b). This increment fenced two because their unreadability defeats a detector; the general rule compares a contract field's refinement to its column's CHECK, which no workspace rule does. | platform | 2026-12-15 |
| `anchorRowsRefused` is at most one row by construction (`latest()` reads one), so it is a list for uniformity with its two siblings rather than because it can hold two. If `listRecent`'s refusals ever reach a verdict, the three axes should be one shape. | platform | _N/A_ |
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
