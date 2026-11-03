# ADR-0399: A check that was single-pass

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-03 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0287, ADR-0318, ADR-0331, ADR-0333, ADR-0334, ADR-0362, ADR-0364, ADR-0371, ADR-0372, ADR-0373, ADR-0374, ADR-0375, ADR-0380, ADR-0386 |

## Context

ADR-0375 left three open ends on the forensic anchor table and named the first two as needing the
same mechanism. The class is **a check that was single-pass over a state two edits make internally
consistent**: every check over `meta.forensic_chain_checkpoints` before this one read
`(anchors, chain)` once, so no amount of care inside one pass can refuse an edit whose result agrees
with itself. Only **history** can.

Measured live as the non-owner `serving` role on PG 16.15, against a real chain of six entries with
anchors at 1, 3 and 5, before any code was written:

| Arm | Verdict |
|---|---|
| clean baseline | `verified witness=5 tail=5 truncated=false` |
| genuine truncation to 2, anchors untouched (the control) | `compromised causes=[chain_truncated]` |
| **truncation + two-column lowering** (anchors moved down onto surviving entries, taking those entries' hashes) | **`verified witness=2 tail=2 truncated=false disagree=[]`** |
| **every anchor `DELETE`d** (3 rows, chain intact) | **`verified witness=null`**, formatter printing *"not checkable (no checkpoint yet — run the checkpoint scheduler)"* |
| truncation + anchors deleted | **`verified`** |
| **chain and anchors both wiped** | **`skipped_empty`, zero callbacks** — no `onPass`, no `onFinding`, no stored row, no escalation |

The last row is the sharpest: **total destruction was quieter than tamper.** `isEmptyScope` discarded
the report as nothing-to-verify, so the pass that should have paged said nothing at all.

The anchor `DELETE` is available because that table's isolation arm is `ALL`-scope with a NULL
`WITH CHECK`, so its `USING` doubles as its `WITH CHECK` and it carries no `DELETE` arm — a
tenant-context session deletes its own rows. The lowering is available because `sequence_number`'s
only CHECK is `>= 0` and `root_hash`'s is a 64-hex pattern that admits any entry's hash.

What refutes both is the deployment's own prior verdict, and the figures were **already in the signed
bytes**: `canonicalStoredReport` and `integrityVerdictPayload` commit `truncation.checkpointSequence`
*and* `truncation.tailSequence`, so a stored verdict attests the **pair**. ADR-0375's open end names
only the witness; the tail is what makes the second detector below possible. `recordVerdict` defaults
to `true`, so the memory exists wherever `--integrity-proof-config` is passed.

The chain stores `payload_sha256` and **no payload column**, so the figures are *pinned* by the chain
and *readable* only from the verdict row. That makes the trust argument three-legged, and the third
leg is the one that had no caller:

1. the row's `report` against its own `payload_sha256` — `storedReportMismatches`, which runs inside
   `rowToRecord` on every read and **throws**;
2. the row's `payload_sha256` against the chain entry it names — **this ADR**, and
   `storedReportMismatches`' own comment is the specification for it: *"editing both still leaves a
   digest that no longer matches the chain entry, which is the point of keeping the proof outside
   this table"*;
3. the chain entry against its hash links and signature — what the pass already did.

## Decision

**A fourth axis on the integrity proof: what a prior verdict attested, compared against this pass's
reading.** `apps/operate-server/src/witness-memory.ts` is pure (no store dependency, so the whole
adjudication is unit-testable) and answers one of nine `WITNESS_MEMORY_OUTCOMES` over a three-valued
`WITNESS_MEMORY_GRADE` — `disproves` / `unproven` / `no_claim`, which is ADR-0372's distinction made
explicit rather than inferred from a boolean.

**Two independent detectors, either of which alone refuses the lowering:**

- `witness_regressed` — a prior verdict attested a higher witness than this pass can find. Nothing
  lawfully removes or lowers an anchor: measured against the committed tree, no checkpoint reaper and
  no chain-entry prune exists anywhere in the workspace, and both forensic tables are
  `PLATFORM_RECORD_TABLES` so the Article 17 erasure *retains* them.
- `prior_verdict_contradicted` — the chain does not hold the entry the prior verdict was anchored in,
  or holds it carrying a different payload digest. This one is independent of the anchor table
  entirely: the prior verdict's own chain entry sits at some sequence, and a truncation that removes
  it is refuted by its absence whatever the anchors were edited to say.

`COMPROMISE_CAUSES` gains `witness_regressed` and `verdict_disagrees_with_chain`, **appended** rather
than placed, because a genuine cut with the anchors left alone exhibits `chain_truncated` and these
two are silent — so an operator meeting a real truncation is still sent to the chain first, and
precedence is what does that.

**`isEmptyScope`'s discard is gated on `witnessMemoryShowsHistory`**, so a scope whose chain and
anchors are both destroyed is published rather than skipped.

**`latestBaseline` and not `latest`** is what the memory reads — see *Implementation notes*, because
this is the correction the increment's own live measurement forced.

**`verify-chain` gets the correspondence**, through a sibling return type
`ChainVerificationWithEntries {report, correspondenceChain}` rather than a field on
`ChainVerificationReport`.

## Alternatives considered

- **Option A: a high-water mark column, or a `MAX()` over the verdict history's JSONB.**
  - **Pros:** a witness never lawfully decreases, so the maximum is the honest baseline, and it is
    immune to the self-erasure below by construction.
  - **Cons:** `MAX((report->'truncation'->>'checkpointSequence')::bigint)` is a cast over untrusted
    JSONB with no CHECK on the report's internals, so a non-numeric value raises `22P02` inside the
    hourly pass. A column would need a migration and a backfill with no honest default.
  - **Why not:** `latestBaseline`'s three clauses give the same durability with no arithmetic over
    stored JSON and no new column. The maximum remains available if a second family of regressions
    ever needs it.

- **Option B: grade `unverifiable_here` as `unproven`.**
  - **Pros:** would have closed the both-destroyed arm without a new clause.
  - **Cons:** a *bounded* pass legitimately answers `unverifiable_here` on every healthy pass, so
    every bounded deployment would read `unproven` for ever.
  - **Why not:** refuted on that measurement. The honest fix was narrower — stop excusing an **empty**
    chain, which is a complete reading rather than an incomplete window.

- **Option C: compare `checkpointed_at` against `sequence_number`'s order.**
  - **Pros:** needs no verdict row and no history.
  - **Cons:** reaches neither arm. The lowering moves the anchors *in order*, so both orders are the
    same permutation; the raising moves one row, which is trivially monotonic.
  - **Why not:** ADR-0375 already recorded this with its refutation; re-measured and unchanged.

- **Option D: thread a pre-read `ChainRead` into `foldFromGenesis` for the `verify-chain` rider.**
  - **Pros:** no new return type.
  - **Cons:** requires every caller to hold a `ChainRead`, which creates the second-spelling hazard
    (ADR-0362) it was meant to avoid, and the bounded path has no such read to hand over.
  - **Why not:** `foldFromGenesis` already loaded the whole chain and discarded it, and **five of the
    six reachable paths go through it** (the full mode plus all four bounded fallbacks), so a sibling
    return type costs no read on any path and leaves `ChainVerificationReport` untouched.

- **Option E: put the memory check in the signed bytes.**
  - **Pros:** the axis would be part of the proof rather than beside it.
  - **Cons:** ADR-0371's parity rule — a field added to `canonicalStoredReport` /
    `integrityVerdictPayload` / `StoredIntegrityReportSchema` / `storedIntegrityReportFor` changes the
    bytes every stored digest was computed over, so every existing verdict row stops verifying.
  - **Why not:** the memory is a *diagnostic about history*, and ADR-0371 already reverted a field out
    of those bytes on this exact ground. It rides on the report and on the escalation payload instead.

## Consequences

- **Positive:** the two cheapest attacks on the anchor table answer `compromised`; total destruction
  is published rather than discarded; the finding is **durable** across passes rather than firing
  once; `verify-chain` gains both a detector and a false-positive suppressor.
- **Negative:** the memory degrades to `unproven` where the tamperer also corrupts the prior verdict
  row — strictly better than the `verified` it replaces, and visible on the hourly line, but a
  cheaper write buys a quieter answer. A scope with a refused *chain* row answers `unverifiable_here`
  on this axis (that scope is already `compromised` for a louder reason).
- **Neutral:** one extra single-row read per scope per pass, on a table the pass already writes.
- **Reversibility:** additive. The axis is a required field on `IntegrityProofReport` and
  `CompromiseEvidence`, so removing it is a compile-error-driven revert; `latestBaseline` is a new
  method with one caller and no behaviour shared with `latest`.

## Implementation notes

**The detector erased its own baseline, and the refuters did not find it — the live after-measurement
did.** `attestedWitnessFrom` read `latest`, and a pass that *finds* the regression records
`checkpointSequence: null`. Measured as four consecutive passes with every anchor destroyed:

```
P1 clean                 verdict=verified     memory=no_prior_verdict
   (every anchor deleted as serving)
P2 anchors gone — ALARM  verdict=compromised  memory=witness_regressed  callbacks=[onPass,onFinding]
P3 next hour             verdict=verified     memory=consistent         attested=(w:null,t:6)
P4 hour after that       verdict=verified     memory=consistent         attested=(w:null,t:7)
```

The alarm fired once and the scope then read healthy for ever. `latestBaseline` is the fix, with three
clauses each closing a measured hole:

- **`verdict = 'verified'`** — a `compromised` row is the record of a finding and an `unproven` one
  established nothing; only a `verified` row is this deployment's own statement that it looked and
  found nothing wrong. After it, P2–P4 all report the finding.
- **`chain_sequence_number IS NOT NULL`** — an unanchored row answers `prior_unanchored` → no claim
  anyway, so skipping it loses no finding, and it stops an unanchored forgery shadowing a baseline the
  chain pins. A tenant-context session can `INSERT` its own tenant-scoped row here. **On real
  Postgres `ORDER BY … DESC` puts NULLs first** (measured: `(6, NULL, 4)` → `NULL, 6, 4`), so without
  this clause the forgery wins *first*.
- **`ORDER BY chain_sequence_number DESC`** and not `verified_at DESC` — the sequence is assigned by
  the chain's own append under an advisory lock while the instant is supplied by whoever wrote the
  row. `storedReportMismatches` compares that column against the report's own `verifiedAt`, so a
  *one-column* bump is already caught; ordering on a figure the writer does not choose is what makes a
  shadow need the chain's cooperation rather than a clock.

A separate read from `latest` rather than a narrowing of it, because `latest` serves
`--audit-verdict-routes` where *the newest verdict* genuinely means the newest.

**Four further claims of this increment were refuted by measuring them, two of them its own code.**

1. An earlier clause excused an **empty** chain as *"absent says nothing"*, so the both-destroyed arm
   answered `verified`. It is the strongest contradiction there is, because `record()` appends the
   chain entry and only then stores the row — **the verdict's own anchor proves an entry existed**.
   The excuse belongs to a *window* (a caller handing the suffix after an anchor), and the guard is
   `lowest > 0` alone.
2. The regression's formatter composed a *sentence* into a sentence, printing *"attested witness 5 at
   …, and this pass found a prior verdict attested a witness and this scope's anchor table now has
   none"* on a line read under a paging sev1. Each detail prints on its own line now, with a shape
   test over every arm so a tenth outcome cannot reintroduce it.
3. `chain-verify.ts`'s byte pair was the **compact** figure labelled as the CLI's. The CLI prints
   `JSON.stringify(report, null, 2)`: measured on real rows, **668 / 692 / 716 B** per entry at
   indentation depths 0/1/2 and 578 B compact, so **66 MiB** at 100k entries one level in and not 63.
4. The same comment's lowering claim described the **pre-fix** CLI, which is now measured both ways
   through the built binary.

**`witnessSequence` is not monotone**, which an adversarial measurement established and which the
`currentScanComplete` gate exists for: `auditAnchors` excludes a contradicted anchor from the witness,
and that exclusion is conditional on a chain being supplied, which `proveScopeIntegrity` decides for
itself. Measured on one *unchanged* anchor table — witness **3** with a chain and **5** without. It is
not a false-compromise path (the exclusion fires only for a disagreement, so the lower reading always
carries `checkpoint_disagrees_with_chain`, already `compromised`), but a regression concluded from a
**lower-bound** witness would page, because a cause outranks `!anchorAudit.complete`. So the
comparison is gated and an unfinished scan answers `witness_not_comparable`.

**`disagreementFor`'s arms were mis-attributed in `anchor-audit.ts`'s own comment and in CLAUDE.md.**
The two-column *lowering* is the **agreement** arm (clause 1, one map lookup) and not the
fall-through; branch 4 is **unreachable** at a sequence the chain holds, verified by handing
`auditAnchors` a foreign hash at a held sequence and getting `root_hash_mismatch`. Both strings were
wrong-when-written (introduced in `feb3a25`). Two more figures corrected: the
`UNIQUE (tenant_id, sequence_number)` availability argument is false as stated (a sibling anchor at
the destination raises `23505`) and the correct one is *stronger* — `sequence_number` has no upper
bound, so the **up**-move is unconditionally available; and the **78** `meta` tables in the
`ALL`-scope-with-NULL-`WITH CHECK` state is **name-filtered**, the structural census being **115**.

**The `verify-chain` rider, measured through the built CLI as the non-owner role, both ways:**

| Arm (chain fully intact) | Before | After |
|---|---|---|
| clean | `OK` exit 0, `witness 5 (unchecked)` | `OK` exit 0, witness checked |
| one-column lowering 5 → 4 | `OK` **exit 0**, `truncation: none` | **exit 1**, `anchor at 4: sequence_relocated, whose root hash is the entry at 5` |
| one-column raising 5 → 99 | **false `TRUNCATED`**, exit 1 | exit 1 with `sequence_relocated` and `truncation: none` — **suppressed** |
| two-column raising 5 → 99 + `root_hash := 'f'*64` | false `TRUNCATED`, exit 1 | **unchanged** — still a false positive |

**Live after-measurement, eleven arms, through the real `buildIntegrityProofLifecycle`:**

| Arm | Before | After |
|---|---|---|
| clean baseline | `verified` | `verified memory=consistent` |
| truncation only (control) | `compromised [chain_truncated]` | `compromised [chain_truncated, verdict_disagrees_with_chain]` |
| **truncation + two-column lowering** | **`verified`** | **`compromised [verdict_disagrees_with_chain]`** |
| **every anchor deleted** | **`verified`** | **`compromised [witness_regressed]`** |
| truncation + anchors deleted | **`verified`** | **`compromised [verdict_disagrees_with_chain]`** |
| two-column raising | `compromised [chain_truncated]` (false) | unchanged, `memory=consistent` — no second false cause |
| **chain + anchors wiped** | **`skipped_empty`, 0 callbacks** | **`compromised`, `onFinding` fires** |
| anchors deleted + verdict row edited | — | `unproven memory=prior_unreadable` |
| + digest rewritten | — | `unproven memory=prior_unreadable` |
| shadow row (unanchored, future instant) + anchors deleted | `unproven memory=prior_unreadable` | **`compromised [witness_regressed]`** |
| four consecutive passes, anchors deleted | alarm once then `verified` | `compromised` on **all four** |

**Mutations, all caught and all reversed byte-identically** (`md5sum`-confirmed, reversed by the same
string replacement rather than by `git checkout`): grading `witness_not_comparable` as `disproves`
(3 tests); repointing `verdict_disagrees_with_chain`'s predicate at `consistent` (4); dropping
`correspondenceChain`'s refusal guard (1); restoring `auditAnchors(…, null)` at the call site — which
**typechecks clean and leaves every `chain-verify` test green**, caught only by the text fence (1);
restoring the composed formatter line (2); and each of `latestBaseline`'s three clauses (3, 1, 1).

**The both-directions fence the code comment promised** is in `integrity-proof.test.ts`: every
`WITNESS_MEMORY_OUTCOMES` member graded `disproves` is named by exactly one cause, and every cause
names a real outcome — driven through `compromiseCauses` and `integrityVerdictFor` rather than by
comparing the two constants, so what is asserted is the behaviour.

The two memory causes read one `outcome` field and are therefore **mutually exclusive**, which makes
"every cause at once" unsatisfiable — asserted explicitly, with the enum-order test's expectation
derived as `COMPROMISE_CAUSES.filter((c) => c !== "verdict_disagrees_with_chain")`.

`COMPROMISE_CAUSE_PAYLOAD_KEY` maps **both** new causes to `witnessMemory`, the first time two causes
share a key; the escalation's `after` payload carries the outcome and the three attested figures and
deliberately **not** the detail, since no value from a stored row may travel.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The two-column **raising** is still a false `TRUNCATED` on both the CLI and the hourly pass; closing it needs an anchor table that is itself chained (ADR-0375 open end 5). | Platform | 2027-01-31 |
| A fully self-consistent forged verdict row with a higher `chain_sequence_number` naming a real entry with matching digests would shadow the baseline. | Platform | 2027-01-31 |
| 115 `meta` tables admit a tenant-scoped `DELETE` through their isolation arm — three of them the forensic tables. Narrowing them is one decision over the whole catalog. | Platform | 2027-03-31 |
| Nothing compares the attested **tail** against this pass's tail, so a chain that lost entries with its anchors untouched is caught by two other detectors and not by a tail regression. | Platform | 2027-03-31 |
| `witness_not_comparable` is reachable only past `CHECKPOINT_SCAN_CEILING` (1,000,000 rows), so it is a reserved answer rather than a live arm. | Platform | _N/A_ |

## References

- ADR-0375 — the three open ends this closes, and the measurements they rest on.
- ADR-0374 — the class (a tamper disabling the detector), which the self-erasure is an instance of.
- ADR-0371 — the parity rule that keeps this axis out of the signed bytes.
- ADR-0372 — an absence of evidence is not evidence; the three-valued grade.
- ADR-0373 — a refused row routed into the verdict rather than out of the answer.
- ADR-0386 — an optional field whose default makes its own omission unobservable.
- `CLAUDE.md` register P3.1 — the discipline this increment's four self-refutations came out of.
