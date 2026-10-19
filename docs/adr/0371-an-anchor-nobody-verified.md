# ADR-0371: An anchor nobody verified

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-19 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0252/0255 (bounded verification against a checkpoint), ADR-0286 (the audit row and its anchor are each half a proof), ADR-0287 (truncation needs a checkpoint to witness it), ADR-0332 (the proof and the checkpoint are one decision), ADR-0351 (a stored record must be able to say what its bytes cover), ADR-0358 (a mismatched Ed25519 pair signs and announces different keys), ADR-0331 (a gap is not a claim) |

## Context

`apps/operate-server/src/chain-verify.ts`'s `verifyChainFromCheckpoint` states its own soundness
condition, in its own doc comment:

> Trust in the anchor comes from the earlier verification that produced it (ADR-0252/0255); this
> does not re-fold the prefix.

That premise was false for every checkpoint any deployment has ever held. `CheckpointScheduler.runOnce`
reads the chain tail and anchors it — `tail()`, `createCheckpoint()`, `record()` — and **verifies
nothing**. It is not one writer among several: `createCheckpoint` and `checkpointStore.record` have
exactly one non-test caller each in the workspace, both in that file. So there was no verified path
the scheduler was an unsound alternative to. There was only the scheduler.

Three other facts compose with it, and each was read in the source and then measured.

**The bounded mode is the default.** `fromCheckpoint: z.boolean().default(true)`, with the comment
*"On by default so the cost of a pass stays bounded as a chain grows"*. Nothing alternates it and
there is no full pass on boot.

**An empty suffix is vacuously valid.** `verifyChainSuffix` opens with
`if (entries.length === 0) return { valid: true, brokenAt: null }` — its comment says "An empty
suffix is vacuously valid" — and `verifyChainSignatures([])` returns `{valid: true, checked: 0}`
because `allOk` starts true and the loop never runs. `ok = integrity.valid && signatures.valid` is
therefore true over zero entries.

**The signature is the only check that binds an entry's stored columns to its content.** This is the
load-bearing fact and it took reading all four verifiers to establish:

| check | what it compares |
|---|---|
| `verifyChainIntegrity` (full fold) | `e.priorEntryHash` against the previous row's `e.entryHash` — stored column against stored column |
| `verifyChainSuffix` (bounded fold) | the same, anchored at the checkpoint's `rootHash` |
| `verifyAuditAnchors` | the audit **row**'s recomputed payload digest against the entry's `payload_sha256` column |
| `verifyChainEntrySignature` | `canonicalEntryBytes(sequenceNumber, kind, recordedAt, actorReference, payloadSha256, payloadSizeBytes, priorEntryHash)` against the stored Ed25519 signature |

`hashChainStep` and `canonicalEntryBytes` occur in exactly two places in the workspace: the write
path in `packages/forensics/src/sealing.ts`, and inside `verifyChainEntrySignature`. **No fold ever
recomputes an entry hash.** So an edit to an entry's `payload_sha256` breaks no link — `entry_hash`
and the next row's `prior_entry_hash` are untouched — and the anchor half cannot see it either,
because making the row consistent with the edited column is exactly what satisfies that check.
`audit-anchor.ts` says so itself: *"a chain whose entries were forged wholesale would satisfy this
check alone, because the forged entry would commit to the forged row."*

### What that produces, measured

Unprompted, on a real 344-entry tenant chain on PG 16.13, through the shipped `verify-chain`
subcommand with no intervention of any kind:

```
verify-chain --tenant X                    chain verification: X [full] — FAILED
                                             integrity: valid
                                             signatures: INVALID (344 checked)
                                               seq 323: bad_signature (fp 04ae9a8e5b42)
                                               seq 324: bad_signature (fp 04ae9a8e5b42)
                                               seq 325: bad_signature (fp 04ae9a8e5b42)

verify-chain --tenant X --from-checkpoint  chain verification: X [from checkpoint seq 337] — OK
                                             integrity: valid
                                             signatures: valid (6 checked)
```

The same chain, at the same moment, answers **FAILED** and **OK** depending on the mode — and the
mode the proof pass uses by default is the one that answers OK. Three entries carry signatures no
registered key can verify; the bounded mode examined 6 of 344 and none of the three, because a
checkpoint was written over the top of them at 337 by a scheduler that verified nothing.

Then the mechanism in isolation, on a clean 8-entry chain with no checkpoint. One pass of the real
`CheckpointScheduler` at the tail, then the real `proveScopeIntegrity`:

```
                        VERDICT      mode             cp   chain.ok  sigs.valid  sigs.CHECKED
before the pass  false  verified     full             null true      true        8
                 true   verified     full             null true      true        8
after the pass   false  verified     full             null true      true        8
                 true   verified     from_checkpoint  7    true      true        0
```

`sigs.CHECKED=0`, `chain.ok=true`, verdict `verified`. The proof is not *wholly* vacuous — the
anchor half reads the whole chain regardless, by design and with a comment saying why — but the
link-and-signature half examines nothing.

And then the forgery, which is what makes this a security finding rather than a hygiene one. An
Article 17 audit row at sequence 4, below the checkpoint at 7, rewritten from
`platform.tenant_delete_refused` to `platform.tenant_deleted` — the record of a *refused* deletion
rewritten to say the tenant was deleted — with the entry's `payload_sha256` made consistent and
`entry_hash` / `prior_entry_hash` left untouched:

```
fromCheckpoint=false  VERDICT=compromised  sigs.CHECKED=8  anchors{checked=7 verified=7 tampered=0}
fromCheckpoint=true   VERDICT=verified     sigs.CHECKED=0  anchors{checked=7 verified=7 tampered=0}
```

Note `anchors{tampered=0}` in **both** rows. The anchor half reports the forged row as *verified*,
exactly as its own doc comment predicts, so it is not a mitigation for this attack — it is the check
the attack is shaped to satisfy. The signature is the only thing that catches it, and the default
mode does not run the signature on anything at or below the checkpoint.

The write is reachable from the ordinary serving credential, not only from the table's owner. As the
non-owner `serving` role with `app.current_tenant_id` set to the tenant, the `UPDATE` against
`meta.forensic_chain_entries` reports `UPDATE 1`: that table's isolation policy is `ALL`-scope, so a
tenant session may rewrite its own chain entries.

And the steady state is worse than "one window was missed". `node.ts` starts the checkpoint
scheduler immediately before the proof scheduler, both default `runOnStart` to true, and both
default to 3,600,000 ms — so within each tick the checkpoint anchors at the tail *first* and the
proof then verifies the suffix after it. An hour's entries are therefore anchored before anything
examines them, and the suffix the proof examines is the handful written between the two passes. **In
the steady state, the chain half of the proof verifies approximately nothing, every hour, for the
life of the deployment** — and exactly nothing whenever the chain is quiet between the two.

### Why the obvious fix is the wrong one

Defaulting `fromCheckpoint` to `false` is honest and simple, and it does not scale, which is the
measurement that chose this design. Ed25519 verification measures **152 µs** on this machine, and
`loadChain` loads the whole chain into memory:

| chain length | signature CPU per pass per scope | loaded |
|---|---|---|
| 10k | 1.5 s | ~5 MB |
| 100k | 15.2 s | ~45 MB |
| 1M | 152 s | ~450 MB |

With `allTenants` on and the hourly default, a deployment with fifty tenants at 100k entries each
would spend over twelve minutes of CPU per pass. The bounded mode is genuinely needed. So the fix is
to make its anchor sound rather than to stop using it.

Both the CPU and the memory columns were **understated** when this table was first taken, and a
reviewer found it: `foldFromGenesis` called `reader.verify` (which loads the chain) and then
`verifyStoredChainSignatures` (which loads it again), so a full fold was two table reads and two
whole-chain copies. The signature CPU figure is unaffected — the same entries were verified once —
but the loaded column was double, which matters because this increment makes the full fold the
steady state for every scope whose anchor cannot be trusted. It is one load now, with
`verifyChainIntegrity` and `verifyChainSignatures` run as pure functions over that one array, so the
table above is accurate rather than optimistic.

## Decision

**A bounded verification is only as good as the anchor it trusts, so the thing that writes the anchor
is the thing that verifies it — and an anchor that cannot say who verified it cannot anchor
anything.**

Four parts.

**1. A checkpoint carries its provenance.** `CHECKPOINT_PROVENANCES` is
`verified_full` / `verified_suffix` / `unverified`, with
`CHECKPOINT_PROVENANCE_ANCHORS_A_BOUNDED_PROOF` a total map over it — a fourth member must be a
compile error at the one place that decides, rather than a value inheriting whichever answer an
`if`-chain ended on. `checkpointAnchorsBoundedProof(p: CheckpointProvenance | undefined)` answers
`false` for `undefined`, which is deliberately **not the same fact** as `unverified` (ADR-0331):
`unverified` is a row *stating* that nothing checked its prefix, while absent means this row's
columns do not cover the question — every checkpoint written before the column existed. Both refuse
to anchor; they differ in what an operator is told.

The column is nullable with **no default**, for `tenant_tombstones.record_storage`'s reason
(ADR-0351): all three values are claims, so defaulting one would assert something about rows whose
writer asserted nothing.

**The write path is the asymmetric half, and it is required.** `CheckpointMeta.provenance` — what a
caller hands `checkpointFromTail` or `createCheckpoint` — has no optional form, where the contract
field does. The two optionalities answer different questions and only one has a safe absence: on a
stored row, absent means *an older binary wrote this*, and a current writer permitted to omit it
would make a new row indistinguishable from one of those, so absent would stop meaning what the
refusal reads it as meaning. A caller holding no verification is therefore not excused from
answering; it says `unverified`, which is a refusal **by name** rather than by silence. That is also
what gives the member a producer — see part 5.

**2. The scheduler verifies before it anchors, and anchors what it verified.**
`CheckpointSchedulerOptions.verify` is a
**required** seam — an optional verifier defaulting to "do not verify" is this exact defect restated
as a default (ADR-0364's `onFailedAttempt` rule) — mirroring `IntegrityProofScheduler`'s `prove:`.
A pass anchors only when the verification reports `ok`; otherwise the scope yields a
`refused_unverified` outcome and the pass continues to the others, because a refusal is a verdict
and not an error. The provenance written is **derived from the verification's own `mode`** through a
total map, never passed in: a caller who could choose it could assert a verification that never
happened.

**And the anchored sequence must be the verified sequence**, which the first draft of this increment
got wrong — so this clause is the correction of its own fix rather than a note about it. The pass
read the tail, verified, and then called `PostgresChainLogReader.createCheckpoint`, which issued its
own `loadChain` and anchored at the **then**-current tail. Every entry committed in between was
therefore stamped `verified_full` by a fold that never saw it, and because the next bounded pass
starts at `checkpoint.sequenceNumber + 1`, that band is skipped forever: this increment's own defect,
narrowed from *the whole prefix* to *one band per pass*, and reopened on every pass. The window is
not theoretical — every audited request anchors a row (ADR-0286), so writers into it are continuous
on a serving deployment, and on the first post-upgrade pass the window is the duration of the whole
full fold.

So `checkpointFromChain(entries, meta)` is replaced by **`checkpointFromTail(tail, meta)`**, and the
scheduler builds the anchor from the `ChainTail` it read *before* verifying. Anchoring at the
pre-verify tail is conservative in the only direction that is safe: a row appended during the
verification is simply not covered yet, and the next pass covers it. The replacement is exact rather
than approximate — `lastEntryHash(entries)` on a non-empty chain **is** the tail row's `entry_hash`,
so no assertion on the resulting checkpoint can tell the two apart, which is why the test pins which
*read* is made. `createCheckpoint` survives for the caller that holds no tail, and now reads one row
instead of the chain; the emptiness refusal moves there, because a `ChainTail` cannot represent an
empty chain and the builder is left with no failure mode to forget. The pass went from three full
chain loads per scope to one.

The verifier the deployment injects is `verifyChainFromCheckpoint` itself, and that composition is
what makes the whole thing self-healing:

- first pass of a new chain → no checkpoint → full fold → anchored `verified_full`;
- every pass after → bounded fold of just the new suffix → anchored `verified_suffix`;
- first pass after an upgrade, where the latest checkpoint has no provenance → part 3 declines the
  anchor → full fold, paid once → anchored `verified_full` → bounded from then on.

The induction is the point: checkpoint *N* is trustworthy because *N−1* was, plus a suffix that was
folded and signature-checked, back to a full fold at genesis.

**The upgrade case heals on one condition, and the condition is worth stating** because an earlier
draft of this ADR and the code comment beside it both asserted it unconditionally. The healing pass
computes an anchor at the current tail and `record` is
`ON CONFLICT (tenant_id, sequence_number) DO NOTHING` — deliberately, so a provenance cannot be
promoted in place — so a legacy provenance-less row sitting **at** the tail is not replaced,
`latest()` returns it again, and the next pass folds fully again. A serving tenant's chain grows on
every audited request and so heals on the next pass; an **idle** tenant chain re-folds until
something appends to it. That is a cost and not an unsoundness — a full fold is the stronger check —
and it is reported rather than worked around, for the reason in alternative H.

The **platform** scope is the exception and inverts it, which part 6 found live: the conflict arm
never fires there, so an idle platform chain writes a fresh anchor every pass and heals, at the price
of growing without bound. So the two scopes fail in opposite directions from one `DO NOTHING`, and
neither was known when this ADR was drafted.

**3. A bounded verification refuses an anchor it cannot trust.** `verifyChainFromCheckpoint`
consults `checkpointAnchorsBoundedProof` and, when it answers false, falls back to the full fold —
the same thing it already did when no checkpoint existed, for the same reason: an anchor nothing
vouched for is not an anchor. `ChainVerificationReport.fullBecause` is required and names which of
`requested` / `no_checkpoint` / `anchor_unverified` / `anchor_provenance_absent` applies, `null`
exactly when the mode is bounded. `mode: "full"` could not previously distinguish *the caller asked
for full* from *the bounded path declined*, which is the difference between a configuration and a
finding.

**4. The reason reaches the one path that runs unattended, and the count does not reach the record.**
This part was built the other way round first — the signature count was added to the stored verdict —
and both halves of that were wrong in ways worth recording, because the argument for the count was
careful and it expired inside this increment.

*The count's justification was the defect.* It read: `verifyChainSuffix([])` and
`verifyChainSignatures([])` are both vacuously valid, so a bounded pass over an unchanged tail
reports `signaturesValid: true` having examined nothing, and a stored verdict could not reveal it.
True before this increment, and part 3 eliminates it: `mode: "from_checkpoint"` is now reachable
**only** when `checkpointAnchorsBoundedProof` admits the anchor, so `checked: 0` beside it means *a
sound bounded proof found nothing new since a verified anchor* — the healthy steady state — and
`mode: "full"` with 0 means an empty chain. After the fix there is no combination in which zero is
an alarm, and the schema comment calling it "the alarming value" would have shipped as advice to
treat the normal case as a finding.

*And the JSONB was the wrong place.* `record()` stores `JSON.stringify(report)` while
`payload_sha256` is derived from `canonicalStoredReport`, which deliberately excluded the new field —
so the stored report stopped being byte-identical to the committed payload, and
`integrity-verdict-routes.ts`' `toVerdictView` instructs a reader that the two "let a reader confirm
the row's content *is* the committed content". That sentence was false for every row the pre-revert
binary would write, in the module whose doc comment opens *"The row is not the proof"*.

So the count is reverted out of the record, the stored report is byte-identical to the committed
payload again, and three further findings retire with it — an overclaiming `storedReportMismatches`
comment, an unenforced absent-versus-zero claim on the write path, and two false clauses in the new
doc block.

What is a finding is the **reason**: `CHAIN_FULL_REASONS`' own doc calls a declined anchor one, and
both reviewers found independently that the integrity proof — the only consumer that runs unattended
— dropped it, printing the bare `mode`. A deployment whose anchors cannot be trusted therefore folds
from genesis on every pass, reports `verdict=verified` every time, and nothing anywhere says that the
anchor was refused or that it is paying an unbounded cost. `IntegrityProofReportLike.chain` gains a
required `fullBecause`, `formatIntegrityProof` and `node.ts`'s hourly `onPass` line both render the
mode, the reason and the signature count, and **none of the three goes into the durable record**. One
rule, stated once: a diagnostic belongs where diagnostics are read, and the durable record carries
only what the digest covers. Committing the reason is a versioned decision — it would change the
bytes every stored verdict is checked against and need a second domain tag beside
`audit_integrity_proof` — and is open question 2.

**5. `unverified` is written by a hand-placed anchor and by nothing in a deployment.** An earlier
draft asserted that the scheduler writes it on a refused verification. It does not: a refusal writes
**no row at all**, so `anchor_unverified` is unreachable on every deployment and the vocabulary's
producer is the required write-path field of part 1 — a caller placing an anchor with no verification
in hand. Keeping the member and correcting the claim is the decision; giving the scheduler a
refused-branch producer is alternative G, refused on measurement.

Which leaves a gap, stated rather than closed: a scope that has stopped verifying leaves nothing in
the database saying so, only `onRefused`'s log line. `onRefused` is therefore **required** on
`CheckpointSchedulerOptions` — unlike the other two callbacks — because a refusal is the only outcome
here that writes no row, so an optional handler would let a deployment discover that its chain had
stopped verifying by never being told. The durable form is open question 1.

**6. The newest anchor at one sequence wins, because the unique constraint does not cover the
platform scope.** Found by this increment's own live verification rather than by reading, and it is
the sharpest thing in it after the critical fix. `meta.forensic_chain_checkpoints` carries
`UNIQUE (tenant_id, sequence_number)` and `record` is `ON CONFLICT (tenant_id, sequence_number) DO
NOTHING` — and `tenant_id` is **nullable, with NULL meaning platform scope** (ADR-0331). SQL treats
NULLs as distinct, so `(NULL, 3)` and `(NULL, 3)` are two legal rows, the conflict arm **never fires
for a platform checkpoint**, and the table's append-one-row-per-sequence design does not hold there.
Measured: two real rows at platform sequence 3, 546 ms apart, `count(distinct id) = 2`.

`latest()` then ordered by `sequence_number DESC LIMIT 1` with **no tiebreaker**, and ten runs of
that query against those two rows returned the **older** one every time. That is the fail-open
direction, which is what makes this a correctness fix rather than tidying: an anchor's `provenance`
is precisely what a bounded proof takes its prefix on trust from, so a stale `verified_full` masking
a later `unverified` would license the exact skip this whole ADR exists to refuse. Both ordered reads
now carry `checkpointed_at DESC, id DESC` — a later verdict about one sequence supersedes an earlier
one, and a mistake falls toward re-folding. Live on the same two rows: untiebroken returns
`verified_full` 10/10, tiebroken returns `verified_suffix` 10/10.

The **constraint itself** is left alone and is open question 1. `UNIQUE NULLS NOT DISTINCT` is
PostgreSQL 15 and `MIN_POSTGRES_MAJOR` is 14; a partial unique index on
`(sequence_number) WHERE tenant_id IS NULL` works on 14 and is a schema change with its own
migration question — the index cannot be created while duplicates exist, and duplicates exist on
every deployment that has run `--checkpoint-config` with the default `includePlatform: true`.

**7. A mismatched signing key is refused at boot.** `ed25519ChainSigner` refuses a key pair whose
halves do not match. This is ADR-0358's measured
hazard — `signEd25519(seedA, pubB, m)` does not throw, because node builds the key from `d` and
silently discards an inconsistent `x` — reached through `--audit-chain-config`, where the fingerprint
is taken from the public half and the signature made with the private one. A mismatched pair
therefore signs with one key and announces the other, and the only symptom is that every entry it
writes reports `bad_signature` forever: on the full path a `compromised` verdict at a 100%
false-positive rate, which escalates to a paging `sev1`. `ed25519PublicKeyFromSeed` has existed in
`@crossengin/crypto` since ADR-0358 for exactly this and had no caller on this path.

This is the live cause of the three bad signatures above. Fingerprint `04ae9a8e5b42e0` signed exactly
sequences 323–325 in a 39 ms burst and then the chain reverts to its previous key — the signature of
a second server booted with a different `--audit-chain-config` — and its registered public key is
*self-consistent*, verified: `ed25519PublicKeyFingerprint(stored public key)` equals the stored
`fingerprint_sha256` column, so `verifyChainEntrySignature`'s fingerprint pre-check passes and the
Ed25519 verification itself fails. So the two findings compose, and the composition is the increment:
**one of them manufactured a false `compromised`, and the other buried it.** The cause here was an
ordinary boot of mine during ADR-0369/0370 verification, not a tamper — which is worth saying
plainly, because it means the thing a deployment meets first is not an attack but its own
misconfiguration, reported as a page, and then silently forgotten.

## Alternatives considered

**A. Default `fromCheckpoint` to `false`.** Honest, one line, and refused on the measurement above:
152 s of signature CPU per pass per scope at 1M entries, with the whole chain in memory, against an
hourly interval and `allTenants`. The bounded design exists for this and the right answer is to make
it sound.

**B. Swap the two `start()` lines in `node.ts`.** This is the sharpest alternative, and it took the
probe's own observation to see it. `node.ts` starts `checkpoints` immediately before `integrityProof`
and both default `runOnStart` to true with the same 3,600,000 ms period, so within every tick the
checkpoint anchors at the tail *before* the proof runs — which is why the steady-state window the
proof examines is empty: an hour's entries are anchored, and only then is the suffix after them
verified. Run the proof **first** and the same two passes become accidentally sound: the hour's
entries are folded and signature-checked, and the checkpoint then anchors exactly what was just
verified.

Refused on four counts, three of them measured:

- The two periods are **independent configs** — `CheckpointConfigSchema.intervalMs` and
  `IntegrityProofConfigSchema.intervalMs`, separate files, separate JSON — so a deployment that
  checkpoints every fifteen minutes and proves hourly gets nothing verified again, and the ordering
  of two lines cannot say so.
- `--checkpoint-config` **mounts without the proof at all** (`node.ts:3254`, gated only on a
  Postgres store and `--audit-chain-config`), so such a deployment anchors blind for as long as it
  runs, and a proof added later trusts every one of those anchors.
- Soundness would be a property of a start order in a third file, invisible at both sites and
  invisible to `operate-server verify-chain --from-checkpoint` run by hand, which reads a checkpoint
  with no scheduler in sight.
- Two independent `setInterval`s in lockstep is not an invariant; it is a coincidence that holds
  until a pass runs long, a tick is missed, or someone changes one number.

**C. Make every Nth pass a full fold.** Bounds the window in which a forgery is invisible rather than
closing it, keeps the unsound anchor between full passes, and restores the unbounded cost
periodically — the thing the checkpoint exists to avoid. It also leaves `verifyChainFromCheckpoint`'s
stated premise false, so the next reader inherits the same trap.

**D. Verify in the proof pass instead of the scheduler.** The proof would have to re-fold the prefix
to establish what the anchor claims, which is the full fold again. The verification has to happen
*once, at the moment the trusted prefix is extended*, and that moment is the checkpoint write. This
is the ADR-0330 rule — the honest fix sits one level up from where the pain is felt — for the
eleventh time: the pain was a bounded proof that trusted too much, and one level up is the writer
that made the thing it trusted.

**E. A boolean `verified` column rather than a three-value provenance.** Cheaper, and it cannot
express the distinction that decides what an operator does: a checkpoint written by an older binary
and one that *states* nothing checked its prefix are different situations with different remedies,
and ADR-0331's rule is that a gap and a claim must not collapse. (An earlier draft added that the
enum "leaves `unverified` writable by nothing, which is itself the statement that no path may anchor
blind." That was true of the draft and is a weak argument for an enum member — a value nothing can
write is exactly this run's most-found class. Part 1's required write-path field is the better
answer: the member is not unwritable, it is *obligatory* for the one caller that has nothing to
vouch with.)

**F. Add a four-eyes-style CHECK requiring a provenance.** Rejected for the migration: `NOT NULL`
on a populated table is `planSchemaReconciliation`'s documented refusal, and every existing row
would have to be given a value — which is precisely the assertion-about-rows-nobody-checked that the
nullable column exists to avoid.

**G. Write an `unverified` anchor on the refused branch**, giving part 5's member a deployment
producer and the database a durable record of a scope that stopped verifying. Attractive, and refused
on two costs that compose. The first is immediate: `latest()` returns the **newest** row, so an
unverified anchor at the current tail **masks an older verified one**, and a single bad pass converts
a bounded deployment into a full-folding one. The second makes it permanent: `record` is
`ON CONFLICT (tenant_id, sequence_number) DO NOTHING` on a table ADR-0332 made immutable-by-RLS (an
`INSERT` platform arm, no `UPDATE` arm). Trace it — a scope anchors `verified_full` at 100; the chain
grows to 105 and a forgery appears; the pass refuses and writes `unverified` at 105; the forgery is
repaired; the next pass folds fully, succeeds, and tries to write `verified_full` at 105, where the
`unverified` row stands and the insert no-ops. Every pass thereafter folds fully, and the only remedy
is to understand `DO NOTHING` and wait for the chain to grow. A *transient* fault becomes a permanent
cost, which is ADR-0334's rule: a remedy that cannot work is worse than none.

Part 6 narrows the second cost without rescuing the alternative: for the **platform** scope the
conflict arm never fires, so a later good anchor at one sequence lands as a second row and wins the
newest-first tiebreaker — the masking self-heals there and the refusal rests on the first cost alone.
For a tenant scope, which is every scope a deployment actually serves many of, both hold.

**H. Heal the upgrade case by promoting a provenance in place**, through `DO UPDATE … WHERE
provenance IS NULL` or by keying checkpoints on `(tenant_id, sequence_number, checkpointed_at)`.
Refused in this increment on two grounds. The narrow one: an `UPDATE` arm on
`meta.forensic_chain_checkpoints` would move it out of the 17 append-only platform tables, and
`pg-column-coverage.ts`'s second axis then *requires* that arm for any module emitting an `UPDATE`
against it — so the schema change is the whole of the work and the immutability is what makes an
anchor worth trusting in the first place. The broader one: a full fold is the *stronger* check, so
the cost is a cost and not an unsoundness. Naming the condition is the cheap part and is in part 2;
the mechanism is open question 3.

**I. Give the reason its own column on `meta.audit_integrity_verdicts`.** The table's own catalog
comment argues for exactly this shape — *"without a column, 'which tenants still have unanchored
rows, and how many' is unanswerable in SQL, which is the one thing this table exists for"* — and
`chain_ok` is already a nullable column for the "not recorded" case. Refused because the precedent
does not transfer: `chain_ok` is checkable *because* the report carries `chain.ok` and the digest
covers it, so `storedReportMismatches` compares the column against the report. A `chain_full_because`
column outside the digest would be editable with no digest broken and nothing to compare it to —
`signaturesChecked`'s position again, in a table whose one property is checkability. Putting the
reason inside the digest instead is the versioned decision of open question 2.

### Verified live after the fix, as a non-owner role, on the same cluster

Every figure below is from PG 16.13 as the `serving` role, against the same fixture the finding was
measured on — the forged Article 17 row at sequence 4 of an 8-entry chain, below a checkpoint at 7.

**The headline, on the same forged row.** Before, the default mode answered
`VERDICT=verified mode=from_checkpoint cp=7 sigs.CHECKED=0`. After:

```
fromCheckpoint=false  VERDICT=compromised  mode=full  fullBecause=requested                 sigs.CHECKED=8
fromCheckpoint=true   VERDICT=compromised  mode=full  fullBecause=anchor_provenance_absent  sigs.CHECKED=8
```

The mode the hourly proof uses by default now reports the forgery, examines all eight signatures to
do it, and names why it folded from genesis. `anchors{checked=7 verified=7 tampered=0}` in both, as
before — the anchor half still cannot see this, which is the whole reason the signature had to run.

**The scheduler refuses and writes nothing**, and `onRefused` says so:

```
onRefused: scope=… mode=full fullBecause=anchor_provenance_absent
checkpoint pass: outcome=refused_unverified   (anchor row unchanged: seq 7, provenance (absent))
chain verification: … [full: anchor predates provenance] — FAILED
  signatures: INVALID (8 checked)
    seq 4: bad_signature (fp d8b2f95c5b72)
```

**The self-healing induction**, two consecutive passes of the real scheduler on a clean chain whose
latest anchor predates the column:

```
PASS 1  recorded  seq=3  provenance=verified_full     verification: mode=full  fullBecause=anchor_provenance_absent  sigs.checked=4
PASS 2  recorded  seq=3  provenance=verified_suffix   verification: mode=from_checkpoint  fullBecause=null  sigs.checked=0
```

Pass 2's `sigs.checked=0` is the figure a reverted diagnostic was added to alarm about, and it is
exactly the healthy steady state part 4 argues it now is: the suffix after a *verified* anchor is
empty.

**And the critical property, which a unit test pins and this proves end to end.** An entry appended
*inside* the injected verification, through the real `PostgresChainLogStore` against real Postgres,
with the signing key registered so the bounded fold accepts it:

```
tail before the pass: seq=2
  appended during verify: seq=3
outcome=recorded  anchored=2  provenance=verified_full
tail after the pass:  seq=3
```

The anchor claims **2** — the tail the verification covered — with the chain at 3. The pre-fix code
re-read and would have claimed 3.

**And one boot of the shipped binary gives all three outcomes**, which is what verifies the `node.ts`
wiring rather than the scheduler in isolation:

```
[checkpoint] REFUSED scope=01a1515e-… — not anchored
chain verification: 01a1515e-… [full: anchor predates provenance] — FAILED
  signatures: INVALID (8 checked)
    seq 4: bad_signature (fp d8b2f95c5b72)
[checkpoint] scope=01a15200-… seq=3 root=123e39a87406 provenance=verified_suffix
[checkpoint] REFUSED scope=platform — not anchored
chain verification: platform [from checkpoint seq 3] — FAILED
  signatures: INVALID (1 checked)
    seq 4: unresolved_key (fp a247ba0a7f86)
```

The third is the one worth reading twice, and it was not planned — the entry at platform sequence 4
is one a probe appended under an unregistered key, and the pass caught it **while bounded**, from an
anchor at 3 carrying `verified_suffix`. So the bounded mode is not merely safe because it refuses:
with a verified anchor it examines the suffix and finds a bad signature in it, which is the whole
property the provenance was added to make true. One entry checked, and it was the right one.

## Consequences

A deployment running both flags gets a bounded proof whose anchor was verified, and one full fold on
the first pass after upgrading. The hourly cost is unchanged in the steady state: the suffix the
scheduler verifies is exactly the suffix that is new, which is the same work the bounded proof was
already doing — it has moved, not grown. The pass is in fact *cheaper* than before: three full chain
loads per scope became one, because `createCheckpoint`'s own `loadChain` is gone and `foldFromGenesis`
had been loading the chain twice (once through `reader.verify`, once through
`verifyStoredChainSignatures`) and now loads it once and runs the two pure checks over that array.

**The migration was measured against the pre-migration cluster rather than reasoned about**, which is
the one claim an ADR here must not take on trust. On a populated `meta.forensic_chain_checkpoints`
holding five anchors across three scopes, `crossengin-pg apply --plan` reports exactly
`1 statement(s) to apply: add_column forensic_chain_checkpoints.provenance` — **0 unreconciled** —
`--confirm` reports `total 1, executed 1, skipped 0, failed 0` in 24 ms, and the re-plan comes back
*nothing to do*. The live column is `text`, nullable, no default, with
`CHECK ((provenance = ANY (ARRAY['verified_full'::text, 'verified_suffix'::text, 'unverified'::text])))`
riding along on the `ADD COLUMN` — ADR-0358's rule, and the reason ADR-0330's
widening-versus-narrowing problem cannot reach it. All five existing anchors then read `(absent)`,
which is precisely the state `anchor_provenance_absent` refuses, so the upgrade path is not a
hypothesis: the cluster this ADR was measured on is in it.

A checkpoint is no longer written when verification fails, which is a behaviour change worth stating
plainly: a deployment whose chain has a real finding will stop advancing its checkpoint, and the
finding stays examinable instead of being buried. That is the intended direction, and it means a
chain with an unresolved finding re-folds in full on every pass until it is resolved. On the measured
cluster that is the correct outcome and it is also the expensive one.

`--audit-chain-config` with mismatched halves now refuses at boot rather than running and paging.
Nothing in the shipped compose passes that flag, so the measured blast radius of the refusal is zero
deployments; the deployments it would have refused are the ones that could not verify a single entry
they wrote.

## Implementation notes

### The column, and why its migration is free

`meta.forensic_chain_checkpoints.provenance` is nullable `TEXT` with a three-value CHECK and **no
default**, which is `meta.tenant_tombstones.record_storage`'s treatment (ADR-0351) for its reason:
every checkpoint on disk predates the column and all three values are *claims*, so defaulting one
would assert that something verified a prefix whose writer asserted nothing. The migration cannot
meet ADR-0330's widening-versus-narrowing problem, because a CHECK on a column the plan is *adding*
has no existing rows to validate against — ADR-0358's rule, and the reason the four credential
columns landed free where `proof_version` needed `predicate_implied_by`.

The `INSERT` is
`(tenant_id, sequence_number, root_hash, checkpointed_at, checkpointed_by,
external_anchor_reference, algorithm, provenance) VALUES ($1 … $8)`, appended after `algorithm`
because that is also catalog order, so the statement reads in the same order as the table.
`valid.provenance ?? null` is `external_anchor_reference`'s existing idiom in the same array;
`valid.algorithm` deliberately keeps no `?? null`, because `.default("sha256")` makes it always
present and provenance has no default. `READ_COLUMNS` is one constant feeding `latest`,
`getBySequence` and `listRecent`, so all three read paths carry it.

`rowToCheckpoint` hands a stored value this binary does not recognise to `ChainCheckpointSchema` to
**refuse**, rather than coercing it to `undefined`. Coercing would read a *newer* claim — a fourth
provenance written by a later binary — as the gap that means "predates the column", which is
ADR-0331's distinction failing in the direction that launders an unknown claim into a known one.

`ON CONFLICT (tenant_id, sequence_number) DO NOTHING` is untouched, and after this change that is a
security property rather than append-only hygiene: a `DO UPDATE SET provenance = EXCLUDED.provenance`
arm would let an `unverified` anchor become `verified_full` with nothing having verified the prefix —
this ADR's own defect by another route, reachable by anyone who can write a checkpoint at all. A
better-verified anchor is a **new** checkpoint at the new tail. Pinned by a test.

`createCheckpoint` threads the provenance and deliberately does **not** derive it, with the reason
written at the method. That class holds the whole chain in hand, so deriving `verified_full` there is
tempting and would be ADR-0337's falsely-true control: `verifyChainIntegrity` compares a stored
`priorEntryHash` against a stored `entryHash` and recomputes neither, so it cannot see entries
rewritten wholesale, and this class holds no keys by design so that an auditor can read a chain it
cannot write.

### What derives the provenance, and what refuses

`PROVENANCE_FOR_VERIFICATION_MODE` is a total map from the report's own `mode` (`full` →
`verified_full`, `from_checkpoint` → `verified_suffix`), **module-private and deliberately not
exported**: it is the one place that derives a provenance, and exporting it would let a caller spell
the derivation itself and so assert a verification that never ran.

The tail is resolved **before** the verification, which keeps `skipped_empty` exactly as it was, and
the reason is this ADR's own vacuity one step round: `verifyChainFull` over zero entries is vacuously
`ok`, and `createCheckpoint` then throws *"cannot checkpoint an empty chain"* — so verifying first
would convert every idle scope's clean skip into an error. A test asserts the verifier is never asked
about an empty chain.

`refused_unverified` is a fourth `CheckpointPassResult.outcome` carrying the report, and a verifier
that **throws** stays an `error` with no `verification` field. Both withhold the anchor, so the
difference is entirely what an operator is told, on ADR-0322's conclusive-versus-unestablished split:
a refusal says the chain did not verify and names what failed, an error says the verification could
not be performed and asserts nothing about the chain. Conflating them would report *"this chain is
broken"* when the truth is *"the key registry was down"*. `verification` is present iff a
verification ran — ADR-0331's distinction, pinned in both directions.

The scheduler deliberately does **not** read the latest checkpoint's provenance itself and force a
full verify. That would be a second spelling of the bounded-verify decision, in the one place that
must hold no opinion about *how* the verification was performed: its whole contract is that the
provenance is derived from the report's own mode, and a scheduler that overrode the verifier's choice
of mode could disagree with the report it then stamps.

### Where the seam is, and where it is not

`CheckpointLifecycleOptions` takes `registry: PostgresKeyRegistry` — the **ingredient** — and
composes `verify` internally, while `CheckpointSchedulerOptions` takes the composed seam. That is
`buildIntegrityProofLifecycle` / `IntegrityProofSchedulerOptions.prove` exactly, the house idiom, and
the reason is structural rather than stylistic: the builder owns both chain stores, so composing the
verification there makes it impossible to point the verification at a different chain store than the
one being anchored. A caller supplying its own seam would have to build a second pair at the same
schema, and two spellings of one thing can disagree. The scheduler keeps the seam, which is where a
test wants it.

`verify` is **required**, not optional, for ADR-0364's reason: an optional verifier defaulting to *do
not verify* is this exact defect restated as a default. It is what forced the `node.ts` wiring to be
written rather than remembered — the compile error named the one call site.

### The three mutations that make the critical fix checkable

Each of this increment's load-bearing properties was pinned by breaking the code, watching the right
test fail, and reversing the edit by the same string replacement — never with `git`, because the tree
held four agents' uncommitted work.

1. **`createCheckpoint` reads the tail, not the chain.** Restoring
   `tailOfChain(await this.loadChain(tenantId))` fails exactly one test
   (`createCheckpoint reads the tail and not the whole chain`) and leaves the other 24 in the file
   green — which is the finding, not a flaw: the two reads produce the *same checkpoint*, so only an
   assertion on which read is made can tell them apart. The test spies on the store's own `loadChain`
   and `tail` rather than on the SQL, because the claim is about which question is asked.
2. **The scheduler anchors at the verified tail.** Replacing `checkpointFromTail(tail, …)` with
   `await this.opts.logStore.createCheckpoint(scope, …)` — the pre-fix line, exactly — fails exactly
   one of 35 scheduler tests. That test appends an entry *inside* the `verify` stub, which reproduces
   the window precisely, and asserts the anchor claims sequence 2 of 0‥3 rather than 3.
3. **The fake models the new column.** Declaring `assertModelsEveryParam` nine columns wide fails 14
   tests naming the table; dropping `provenance: p[7] ?? null` fails the cross-seam round trip with
   `expected undefined to be 'verified_full'`. Both reversed, 85 of 85 green.

### Three things the adjudication got wrong, found by the agents implementing it

Each was reported rather than quietly worked around, which is what made them visible.

**A field I kept had no reader, in the increment whose subject is fields with no readers.** The brief
kept `signatures.checked` on `IntegrityProofReportLike` "because Part 2 gives it a reader", which is
true — `fullReportFor` reads it — and then kept `fullBecause` beside it on the same sentence, where
Part 2 gives it *none*: `formatIntegrityProof` takes the real `IntegrityProofReport`, whose `chain`
is a `ChainVerificationReport` and never the mirror; Part 4 forbids storing it; and `fullReportFor`
hardcodes `null` for a stated reason. So the mirror would have declared a field written by one test
fixture and read nowhere. The agent offered "faithfulness of the mirror" as a justification and
flagged that it did not believe it, which is right: that is the argument that keeps dead fields
alive. `IntegrityProofReportLike` is the shape `storedIntegrityReportFor` projects *from*, so a field
it does not project does not belong on it, and the field is **omitted**. The loop closes when open
question 2 is answered, not before.

**The log line prints the enum key where `verify-chain` prints prose**, and that is kept, with the
reason at the site. The two are not two spellings of one thing — the key *indexes*
`CHAIN_FULL_REASON_PHRASES`, so they cannot diverge — and the audiences differ: a human running
`verify-chain` wants *"anchor records no verified prefix"*, while an hourly line that a deployment
greps or alerts on wants the stable identifier.

**And a cast in a neighbouring test file made the new rendering wrong everywhere it was already
exercised.** `integrity-proof.test.ts`'s `chainOk()` fixture ends `} as ChainVerificationReport` and
omits `fullBecause`, so after the formatter change every `formatIntegrityProof` call in that file
renders `chain [from_checkpoint: undefined]` — verified by a throwaway probe, and invisible because
none of that file's five formatter assertions reads the chain segment's text. ADR-0362's class with a
live rendering consequence: the cast is deleted, the field supplied, and the two new formatter tests
moved into that file's existing `describe("formatIntegrityProof")`, which is where the next person
looks.

### An assertion I prescribed could not catch what I prescribed it for

Worth recording because it is this file's own recurring class landing on an instruction, and because
a reader comparing the brief with the diff would otherwise draw the wrong conclusion about which
assertion is the fence. `CHAIN_FULL_REASON_PHRASES`' comment claimed a total map stops a reason "that
formats as nothing", which `Record<ChainFullReason, string>` does not — a *missing* key will not
compile, an empty value compiles and renders `[full: ]`, demonstrated by setting one phrase to `""`
and watching all 24 tests pass. My instruction for closing that was to assert the header contains
`` `[full: ${CHAIN_FULL_REASON_PHRASES[reason]}]` ``, and **that assertion passes on the empty
phrase**: the interpolation becomes `[full: ]` and the rendered header contains exactly that. So the
instruction and the mutation check I attached to it were inconsistent, and the agent implementing it
said so rather than reporting a green run.

The two assertions catch disjoint defects and both are kept, each mutation-confirmed separately: an
explicit `expect(phrase).not.toBe("")` is what fails on an empty phrase, while the interpolation is
what fails when `anchorPhrase` renders the enum *key* instead of the phrase — a mutation that passes
both the original `toContain("[full: ")` and the set-distinctness check, since keys are non-empty and
distinct. The comment now says what the type buys and what the test buys, which is the ADR-0351
lesson exactly: a test whose comment names a hazard and whose assertion is true for every input
documents the hazard and checks nothing.

### The fence ADR-0370 built cannot see this class

Adding the column broke the shared fake in a way `assertBindArity` is structurally blind to.
`packages/forensics-pg/src/test-fakes.ts` modelled seven columns of the checkpoints table and read
`p[0] … p[6]`; the statement now binds eight. The ADR-0370 fence compares the statement's `$n` set
against the supplied array, **both of which agree on 8**, so it passes — and the value is dropped on
the floor by the fake's own row model. That is ADR-0333's `fakeCertificationPg` hazard in a new
place, and the consequence is the one that matters: a round-trip test is answered from the fake's
side table and **passes** while a real database stores nothing.

So the fake models the column and gained `assertModelsEveryParam(params, modelled, table)`, per
branch because the two statements bind different counts and a bare total would pass whichever branch
happened to match. Mutation-checked: declaring the model 9 columns wide fails 14 tests with the
message naming the table; reversed, 81 of 81 green.

A second instance of the same gap is worth recording because it was found by the same slice and in a
different package: a round-trip assertion **cannot** catch a `SELECT` that stops asking for the
column, because the fake returns whole rows and so serves the value regardless of the column list.
Only an assertion on the recorded SQL catches it. The two assertions in `checkpoint-store.test.ts`
are therefore not redundant, and trimming the recorded-SQL one as duplicative would make a
`READ_COLUMNS` regression invisible.

And a **second fake was deleted** rather than kept beside the first. `checkpoint-store.test.ts` had
grown a `provenanceAwarePg` wrapper that kept the bound provenance in a side table and patched it
onto the inner fake's rows, written while `fakeChainPg` still dropped `$8`. Once the shared fake
modelled the column that wrapper's whole reason evaporated, and its doc comment — *"`fakeChainPg`'s
checkpoint model stores the seven columns the pre-provenance `INSERT` wrote and drops `$8`"* — became
a false statement about its own sibling, which is the documentation class this run keeps finding, in
a test helper. Three call sites take `fakeChainPg()` and 19 of 19 tests stay green, so the wrapper
was 35 lines and one stale constant of pure divergence risk: two fakes of one table is how the two
come to disagree about what the database does.

The thread `createCheckpoint → checkpointFromTail → record → latest` was covered by nothing before
this: each half had its own test and none crossed the seam, which is also what left the fake's
modelling of the column not load-bearing. `chain-log-store.test.ts` crosses it now over one shared
fake connection, and the mutation is the proof — dropping `provenance: p[7] ?? null` from the fake
fails it with `expected undefined to be 'verified_full'`, where before that deletion was silent.

### A census figure that had gone three behind

The catalogue census is **781** column-level CHECKs, **288** value sets over 123 tables, 244
distinct value lists — measured from the built catalog objects, which is ADR-0352's method and the
only one that works, since a `grep` for `check: "…"` misses every declaration Prettier wrapped.
This increment adds exactly one of each. The prose carried **777**, attributed *as of ADR-0352*, so
the real pre-increment figure was 780: three column CHECKs landed between ADR-0352 and now —
ADR-0358's credential columns and ADR-0362's `attestation_phrase` — without the figure moving with
them. That is register P3 item 7's class in the place this file is most likely to be read for a
number, and the correction is only worth a paragraph because it was measured rather than
recalculated: an attributed figure still goes stale, and the attribution makes it look current.

## Open questions

1. **Nothing constrains one checkpoint per platform sequence, and the platform table grows without
   bound.** Part 6 fixed which row wins and deliberately not that there are several.
   `ON CONFLICT (tenant_id, sequence_number)` never fires for a NULL tenant, so an hourly pass
   writes a fresh platform row every tick — 8,760 rows a year, on a table ADR-0332 made
   append-only — and `includePlatform` defaults to true, so this is live wherever
   `--checkpoint-config` runs. It also **inverts part 2's healing condition for that one scope**, in
   the direction that is better for soundness and worse for growth: a tenant chain's legacy anchor
   at the tail is never replaced so the scope re-folds, while an idle *platform* chain writes a new
   row each pass and heals. Both measured on the same cluster. The fix is a partial unique index on
   `(sequence_number) WHERE tenant_id IS NULL` (`UNIQUE NULLS NOT DISTINCT` is PG15 against a floor
   of 14), and the migration is the hard part rather than the DDL: the index cannot be created while
   duplicates exist, so it needs a documented de-duplication keeping the newest per sequence — which
   is the order part 6 just made the reads agree with.

2. **A scope that has stopped verifying leaves no durable record.** A refusal writes no row, so the
   only trace is `onRefused`'s log line — now required, which is the cheap half. An operator reading
   `meta.forensic_chain_checkpoints` cannot tell *this scope has not verified since its last anchor*
   from *this scope is idle*. Alternative G shows why the obvious durable form poisons a sequence; the
   two shapes left are an audit row (the scheduler holds no emitter, and the scope is a chain rather
   than a tenant, so this inherits ADR-0331's platform-scope question) or a separate refusal table,
   which is a subsystem rather than a column.

3. **Whether the fold's reason belongs in the signed bytes.** `fullBecause` is rendered on the hourly
   line and in `verify-chain`, and committed to nothing, so an edit to a stored verdict cannot be
   caught claiming a fold was `requested` when the anchor was declined. Putting it in
   `canonicalStoredReport` changes the bytes every stored verdict is checked against and needs a
   second domain tag beside `audit_integrity_proof` — the tombstone-content-tag shape of ADR-0351 —
   so it is a versioned decision and not a field addition. Alternative I explains why a column
   outside the digest is not the cheaper route.

4. **The upgrade case's healing condition has no mechanism.** Part 2 names it; a legacy anchor sitting
   at an idle chain's tail re-folds from genesis every pass, permanently. Alternative H lists the two
   shapes that would close it and why neither belongs in this increment. What would make it *visible*
   is cheaper than what would fix it: `record` reports whether it inserted, so the pass could carry an
   `anchor_unchanged` outcome and say that a deployment's anchor cannot be healed — which is worth
   doing before the schema decision, not after.

5. **A second concurrent pass is dropped, and the drop is silent to the caller's callbacks.**
   `runOnce` returns `[]` when a pass is in flight, which is honest about having performed no pass,
   and neither `onError` nor any other seam says so — so a deployment whose folds routinely outlast
   its interval cannot see that from the logs. The figure that decides whether this matters (how often
   it fires) is exactly the one a counter would give.

6. **Nothing compares a stored integrity verdict against its chain entry.**
   `integrity-verdict-store.ts` checks a verdict row's `payload_sha256` against the digest recomputed
   from its own `report`, and its comment claims that editing both *"still leaves a digest that no
   longer matches the chain entry, which is the point of keeping the proof outside this table"* —
   true only if something makes that comparison, and grep finds no reader that does. The route
   publishes `chainEntryHash` so a human can, and `integrity-verdict-routes.ts` says so explicitly;
   whether the platform should also do it automatically is undecided. It is the main finding's own
   shape applied to the record *of* verification.

7. **`loadChain` is O(chain) in memory on every pass**, for the anchor half, with a comment saying
   why it cannot use the bounded suffix. So the bounded mode bounds CPU and not memory: at 1M entries
   a pass still loads ~450 MB per scope. Bounding it needs the anchor check to load only the entries
   the sampled rows point at, which is a keyed read rather than a scan.

8. **The `recordVerdict` comment claims a protection the fold does not provide.** It argues that a
   verdict belongs in the chain because *"editing it or removing an earlier one breaks a link"* —
   and editing an entry breaks no link, as this ADR measures; only the signature notices. The
   conclusion survives (the chain is still where a verdict is hardest to quietly change) but the
   mechanism named is the wrong one, and the fix is a sentence rather than code.

9. **Three bad signatures remain on the verification cluster** and are the honest demonstration of
   part 4: entries signed under a key whose configured public half did not match. A deployment that
   reaches this state before upgrading has entries nothing can ever verify, and no remedy exists for
   the entries already written — the boot refusal prevents the next one. Whether `verify-chain`
   should report that shape distinctly (a fingerprint that resolves but never verifies, which is a
   misconfiguration) from a genuine tamper (a fingerprint that resolves and verifies for its
   neighbours but not for one entry) is a real distinction nothing currently draws:
   `unresolved_key` and `bad_signature` are the only two reasons, and they are OR'd into one boolean
   by the time a verdict is formed.

10. **`verifyChainSuffix` still answers `valid: true` for an empty suffix**, and after this change
   that is sound rather than vacuous — the prefix really was verified when the anchor was written. It
   is left as it is deliberately, with the soundness now resting on the provenance instead of on a
   comment; the alternative, refusing an empty suffix, would make a quiet chain report a finding
   every hour.

## References

- `apps/operate-server/src/chain-verify.ts` — `verifyChainFromCheckpoint`, `fullBecause`
- `apps/operate-server/src/checkpoint-scheduler.ts` — the one checkpoint writer
- `apps/operate-server/src/integrity-proof.ts` — `proveScopeIntegrity`, `integrityVerdictFor`
- `apps/operate-server/src/audit-anchor.ts` — the half-a-proof comment this ADR relies on
- `packages/forensics/src/tamper-evident-logs.ts` — `CHECKPOINT_PROVENANCES`, `verifyChainIntegrity`
- `packages/forensics/src/sealing.ts` — the only two sites that compute `canonicalEntryBytes`
- `packages/forensics-pg/src/checkpoint.ts` — `verifyChainSuffix`'s vacuously-valid empty case
