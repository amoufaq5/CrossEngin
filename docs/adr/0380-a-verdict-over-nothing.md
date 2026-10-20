# ADR-0380: A verdict over nothing

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-20 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0287 (the truncation check and its witness), ADR-0371 (a bounded proof's anchor), ADR-0374 (its addendum patched this command for one anchor), ADR-0375 (the anchor table read as a set, and its open end 2), ADR-0372 (an absence of evidence is not evidence) |

## Context

Register item P0.9 named, among the backup and restore gaps, one live finding: `verify-chain` exits 0
over an empty chain — a falsely-true control in the command an operator would run to check a restore.

Measured live rather than taken on trust, because two increments had already touched this command.
On a scope holding **zero** chain entries:

```
chain verification: 9999…9999 [full: requested] — OK
  integrity: valid
  signatures: valid (0 checked)
  checkpoints: 0 row(s) scanned, complete, witness none
EXIT=0
```

It survives, and **the sharp case is worse than the item records.** A scope with a checkpoint at
sequence 7 and zero entries — which ADR-0375 says is a state *only the tamper produces*, since
nothing in the workspace deletes a chain entry and the Article 17 shared-table erasure *retains* that
table — reported:

```
chain verification: 9999…9999 [full: requested] — OK
  signatures: valid (0 checked)
  checkpoints: 1 row(s) scanned, complete, witness 7 (unchecked)
EXIT=0
```

**Every fact was on the page and the verdict contradicted them.** `witness 7` beside `0 checked` is
the destroyed-chain signature printed in full, under the word OK.

Three things compose into it, and none is a bug on its own:

- `verifyChainIntegrity([])` and `verifyChainSignatures([])` are **both vacuously valid**, so
  `ok = integrity.valid && signatures.valid` is true over zero entries.
- The anchor audit **deliberately** does not call a witness the chain fails to reach a
  *disagreement*. `anchor-audit.ts`' own doc says why: that is what truncation looks like, so folding
  it in would report one fact as two causes and take the witness away from the check that needs it.
- And **that check was computed in exactly one place.** `ChainTruncationCheck` is declared on
  `IntegrityProofReport` and built inline inside `proveScopeIntegrity` — the hourly scheduler — so
  `verify-chain`, which holds the witness and prints it, never read the tail to compare it against.

So the one condition separating *nothing ever happened* from *the history was destroyed* fell between
a fold that cannot see it and an audit that is right not to claim it. The hourly pass caught it; the
command an operator runs by hand did not. ADR-0374's addendum had already fixed this command for a
refused anchor and ADR-0375 for anchor findings — the truncation check was the third axis and was
missed both times.

## Decision

**`chainTruncation(witnessSequence, tailSequence)` is one definition with two callers, and
`verify-chain` is the second.**

The predicate and `ChainTruncationCheck` move to `anchor-audit.ts`, which owns the witness they
compare — ADR-0371's reason for moving `ChainTail` to the module that owns what a checkpoint is made
of — and `integrity-proof.ts` re-exports the type so no consumer moved. `proveScopeIntegrity` calls
it instead of building the object inline. Extracted rather than spelled a second time in the command,
which is this repo's most-repeated finding: ADR-0362 found four spellings of one confinement rule
with the *accurate* comment describing the defective one.

`VerifyChainReport` is **three** reports now, and the exit code is a three-way conjunction:
`chain.ok && !anchorAuditHasFindings(anchors) && !truncation.truncated`. The tail is read **after**
the audit, so the witness is read before the tail it is compared against — widening that gap cannot
manufacture a finding, since `truncated` needs `tail < witness`, so an append in the window only ever
clears the check while a delete in it is a truncation that really happened. `proveScopeIntegrity`'s
own ordering argument, one caller across.

**And the headline stops saying OK over nothing.** `verificationExaminedNothing(checked, truncation)`
is true when the fold examined zero entries and no witness contradicts that, and the command prints
`NO HISTORY — nothing was examined` instead of `OK`.

That one **exits 0**, which is the decision rather than an oversight. A scope with no witness and no
entries is a question nobody can answer from these two tables: a new tenant and a tenant whose
entries *and* checkpoints were both deleted are byte-identical here. Where a witness survives,
`chainTruncation` separates them conclusively; where it does not, nothing in this table can — closing
that needs the chain's own memory of a prior witness, which makes one pass's verdict an input to the
next (ADR-0375's open end 2). So the state is **named** rather than resolved, and the word an operator
reads as "verified" is withheld.

`formatChainTruncation` gives all three states their own sentence, and the quiet one is the point: a
scope with no witness prints *"not checkable (no checkpoint yet — run the checkpoint scheduler)"* and
never *"not truncated"*, because the second claims a check that never ran (ADR-0372).

## Alternatives considered

- **Option A: exit non-zero when nothing was examined.**
  - **Pros:** a restore-verification script treats non-zero as failure, which is P0.9's use case.
  - **Why not:** it fails every scope before its first audited request — every freshly provisioned
    tenant — so the command stops being usable as a health check, and an operator learns to ignore
    its exit code. The dangerous half is the *witnessed* one and that now exits 1.

- **Option B: a third exit code for inconclusive.**
  - **Pros:** serves both callers without a flag; the verdict is machine-readable.
  - **Why not:** the repo's exit vocabulary is 0 / 1 / 2 with **2 already meaning a usage error** —
    `parseVerifyChainArgs` returns it for a `CliUsageError`. A third meaning on that value would make
    a misconfigured invocation and an unexaminable scope indistinguishable to the caller that cares
    most. The comment this increment edits already said an exit code has no third answer, and it is
    right.

- **Option C: a `--expect-entries` flag that makes the empty case exit 1.**
  - **Pros:** the restore use case gets its failure without penalising a new tenant.
  - **Why not:** it would be built for a consumer that does not exist — P0.9's backup half is still
    unbuilt (no backup service in any compose file, no `pg_restore` anywhere in `deploy/`,
    `BackupRecord` with zero producers), so the only caller would be a hypothetical script. Adding a
    flag for an absent consumer is the shape this repo keeps refusing; it becomes correct the day a
    restore procedure exists.

- **Option D: fold the unreached witness into `anchorAuditDisproves` instead.**
  - **Pros:** no new axis; one predicate already gates the exit code.
  - **Why not:** `anchor-audit.ts`' own doc refuses it in so many words — a witness the chain does not
    reach is the truncation signal and must stay a *witness*, because folding it in reports one fact
    as two causes and takes the witness away from the check whose subject it is. Taking that advice
    is what made the third axis the answer.

- **Option E: have the folds return the tail so no second read is needed.**
  - **Pros:** one fewer statement per invocation.
  - **Why not:** neither fold hands its entries back by design, and for `--from-checkpoint` the
    prefix is defined not to be read. A `tail()` is one indexed row against a table this command
    already walks in full, so the saving is not worth changing two return shapes.

## Consequences

- **Positive:** the destroyed-chain signature is a finding with exit 1 in the command an operator
  runs, not only in the hourly pass. A vacuous pass no longer prints the word that reads as verified.
  One truncation predicate with two callers where there was one caller and one blind spot.

- **Negative:** a scope whose chain was destroyed *along with its checkpoints* still exits 0, now
  labelled `NO HISTORY` rather than `OK`. That is an improvement in what is said and not in what is
  detected, and it is stated as such.

- **Neutral:** one extra indexed row read per `verify-chain` invocation.

## Verification

**Offline.** 10 new tests over `chainTruncation`, `formatChainTruncation` and
`verificationExaminedNothing`, including that an empty chain under a witness is the *strongest* form
rather than a special case, that the boundary (`tail === witness`) is clean, that no witness answers
*nothing* rather than *not truncated*, and that a proven truncation outranks the milder vacuity
verdict. Mutation-checked: narrowing the predicate to `tailSequence !== null && …` — which is the
obvious shape and silently drops the empty-chain case — fails **3 of them**. Reversed by the inverse
string replacement with presence asserted first (ADR-0367).

**Live**, on a throwaway PG 16.13 as the owner, four arms:

| scope | before | after |
|---|---|---|
| checkpoint at 7, **0 entries** | `OK`, exit **0** | `TRUNCATED: a checkpoint witnesses sequence 7 and the chain holds NO ENTRIES AT ALL`, exit **1** |
| no checkpoint, 0 entries | `OK`, exit 0 | `NO HISTORY — nothing was examined`, exit 0 |
| 6 entries, no checkpoint | `OK`, exit 0 | `OK`, exit 0 — `truncation: not checkable` |
| 6 entries, witness at 2 | `OK`, exit 0 | `OK`, exit 0 — `truncation: none — the chain reaches the witness at 2` |

The last two are the non-vacuity controls: a fence that reported TRUNCATED for every scope would pass
the first row and break the deployment.

## Open questions

1. **A chain destroyed along with its checkpoints still exits 0.** ADR-0375's open end 2, unchanged
   by this increment and now the only remaining way to get a quiet zero out of a destroyed trail.
   `integrityVerdictPayload` commits `truncation.checkpointSequence` to a signed chain entry, so the
   chain remembers what the last verdict saw — reading it makes one pass's verdict an input to the
   next and needs an answer for the no-prior-verdict case.

2. **`verify-chain` still asks the correspondence in neither mode**, so `witness N (unchecked)` is
   the best this command can say about an anchor. ADR-0375's open end 3: neither fold hands its
   entries back, and a bounded verification is defined not to read its prefix.

3. **The truncation check has no live producer of a witness on a shipped deployment**, because
   `--checkpoint-config` is not on any compose `command:` (register P0.3). So on the shipped stack
   this axis answers `not checkable` for every scope, and the finding it closes needs the checkpoint
   scheduler running — which ADR-0371 made safe to default on and nobody has defaulted.

4. **P0.9's backup half is untouched**: no backup service in any compose file, no `pg_restore`
   anywhere in `deploy/`, `BackupRecord` with zero producers and `meta.backup_records` declared
   writerless. `deploy/ORACLE.md` ships a dump script and a crontab line, and its *"Test the restore
   now"* block runs `gunzip -c … | head -40`, which restores nothing and proves only that the file
   decompresses. That is the item's real remainder.
