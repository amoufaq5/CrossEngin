# ADR-0375: One witness read, and never compared

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-20 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0287, ADR-0331, ADR-0334, ADR-0361, ADR-0367, ADR-0371, ADR-0372, ADR-0373, ADR-0374 |

## Context

ADR-0374 closed a buried alarm: a checkpoint row stored in a shape `ChainCheckpointSchema` refuses
made `proveScopeIntegrity` throw, so the hourly integrity pass filed `outcome: "error"` and no
verdict, no finding, no escalation and no page came out of it. That increment routed the refusal
into the verdict as `compromised`, and — because anchoring a fresh readable checkpoint at the tail
would make `latest()` stop returning the refused row — it made `CheckpointScheduler` **refuse to
anchor** for as long as the row stood. It left two open ends behind: the refusal charges a permanent
fold from genesis (open end 6), and truncation detection goes dark for that scope (open end 7).

Measuring those two found that the detector is narrower than either of them, and that a second
question about the same table was never asked at all.

### Face 1 — the aperture

`PostgresChainCheckpointStore.latest(scope)` reads **one** row. So a refused checkpoint row is a
finding only while it is the *newest*, and on a scope holding N checkpoints the other N−1 can be
blanked with no verdict change. Measured live on PG 16.13 as the non-owner `serving` role, one scope
with five chain entries and anchors at 1, 3 and 4, `checkpointed_by := ''` under that tenant's own
context (one `UPDATE`, `UPDATE 1`):

```
seq 1 blank: verdict=verified     anchorRefused=0 mode=from_checkpoint causes=[]
seq 4 blank: verdict=compromised  anchorRefused=1 mode=full            causes=[checkpoint_row_refused]
scheduler  : outcome=refused_anchor_would_bury refused=[anchor_unreadable] recorded=[]
```

Same column, same role, same table, two different rows, opposite verdicts. The scheduler's
refusal-to-anchor protected exactly the one row a tamperer need not choose, and charged the
permanent full fold and the dark truncation check for it. (Reachable on a deployment that has not
run ADR-0374's standing manual `ALTER` — that increment's own open end 2 — which is the real
population; the harness drops that CHECK as the owner and restores it after.)

### Face 2 — correspondence

Nothing compares a checkpoint's `root_hash` against the chain entry at its `sequence_number`, except
incidentally inside `verifyChainSuffix` for the newest anchor on a bounded pass. That column's only
CHECK is `sequence_number >= 0`, and this table's isolation arm is `ALL`-scope so its `USING` doubles
as its `WITH CHECK` (ADR-0374) — so one `UPDATE` under a tenant's own context edits an anchor into a
**valid-shaped lie**. Measured on a fully converged deployment, every CHECK in place:

```
lowered 4 -> 2 : verdict=verified     truncated=false witness=3  causes=[]
raised  4 -> 99: verdict=compromised  truncated=true  witness=99 causes=[chain_truncated]
                 formatter: "TRUNCATED: checkpoint at 99 but the chain ends at 4"
                 and the bounded fold checked 0 signatures (the suffix after 99 is empty)
```

The raised case is a **false** `chain_truncated`: a paging sev1 telling an operator that audit
history was destroyed while every entry is present, reachable by a tenant against its own scope, and
naming the wrong table.

The sharpest arm is the two composed. A genuine truncation, then two `UPDATE`s lowering the anchors
below the new tail:

```
clean      : verdict=verified     truncated=false witness=4 tail=4 sigsChecked=5
cut >= 3   : verdict=compromised  truncated=true  witness=4 tail=2 sigsChecked=3 causes=[chain_truncated]
cut+lowered: verdict=verified     truncated=false witness=2 tail=2 sigsChecked=3 causes=[]
             formatter: "VERIFIED … integrity valid, signatures valid (3 checked)" and no truncation line
```

Two destroyed entries of a tamper-evident audit log, hidden by editing the witness. And a third arm
needs no sequence edit at all: `root_hash := 'f'*64` on the tail anchor reads `verified` on **both**
modes, the bounded one checking 0 signatures, because nothing compares a checkpoint's root hash to
anything.

## Decision

**Read the anchor table as a set, and compare every readable row against the chain.**

1. **`PostgresChainCheckpointStore.scanCheckpoints(scope, onPage, opts?)`** — an ascending keyset
   scan over every checkpoint row of a scope, in one read transaction, handing each page to a
   callback as the ADR-0373 pair (`{records, unreadable}`) and returning only
   `{scanned, refusedCount, complete}` — it counts rows and refusals and says whether it
   finished, and holds no opinion about which sequences are witnesses, because it cannot check
   one.

   The direction is the decision: this table is append-only in sequence order for every writer in
   the workspace, so an **ascending prefix is stable under appends** while a descending one shifts —
   a descending scan with a ceiling would reproduce ADR-0374's burial at ceiling depth instead of at
   depth 1. `id` is the tiebreaker because `UNIQUE (tenant_id, sequence_number)` does not constrain
   the platform scope (ADR-0371), so two rows can share a sequence. `onPage` rather than a returned
   array is ADR-0367's `drainList` rule — the caller decides what it keeps, and the two callers keep
   different things.

2. **`anchor-audit.ts`** folds that scan into an `AnchorAuditReport`: the refusals (capped at 50,
   with `refusedCount` as the figure), the disagreements, and the **truncation witness**.

   The correspondence rule, over two maps built once from the chain, per readable anchor `(S, H)`:
   the chain's entry at `S` carries `H` → agrees, and `S` is a witness; some entry **elsewhere**
   carries `H` → `sequence_relocated` with `matchedAt`, not a witness; an entry at `S` exists and
   differs → `root_hash_mismatch`, not a witness; neither → the chain does not reach this anchor,
   which is **not** a disagreement and **is** a witness, because that is exactly what truncation
   looks like and `ChainTruncationCheck` is its subject.

   `disagreeing: null` means the correspondence was **not asked** — never "none found" (ADR-0331).
   It is asked only over a chain the reader refused no row of, because the maps would otherwise be
   incomplete and an anchor pointing at a refused entry would be named `root_hash_mismatch`: a
   finding attributed to the wrong table.

3. **The truncation witness is `witnessSequence`, not `latest()`.** An anchor the chain contradicts
   at its own sequence is excluded, because its sequence is then not a fact; one the chain does not
   reach is kept. This is strictly stronger than what it replaces: `latest()` answers the *highest*
   sequence, so a single refused newest row left the check with `null` while an older readable anchor
   sat directly beneath it.

4. **A seventh compromise cause, `checkpoint_disagrees_with_chain`**, and an eighth verdict arm:
   `!anchorAudit.complete` answers `unproven`. The first is `compromised` because something is
   disproven; the second is not a cause, because nothing is — a scan the ceiling stopped did not read
   the whole table, so `verified` would claim a reading nobody took (ADR-0372).

5. **`CheckpointScheduler` anchors again**, and reports the audit through a **required**
   `onAnchorFindings`. `CHAIN_FULL_REASON_BLOCKS_ANCHORING`, `anchoringWouldBury` and the
   `refused_anchor_would_bury` outcome are **deleted**.

6. **`verify-chain` audits the anchor table in both modes** and exits non-zero on any finding,
   including an incomplete scan. It previously inferred the anchor's state from `fullBecause`, which
   is a statement about the newest row alone — and in *full* mode read that table not at all, so the
   weaker command caught a refused anchor and the stronger did not.

## Alternatives considered

- **Option A: flip `CHAIN_FULL_REASON_BLOCKS_ANCHORING.anchor_unreadable` to `false`.** ADR-0374
  predicted this as "one line".
  - **Pros:** one line, and the scheduler's tests re-aim themselves because they derive their cases
    from the map.
  - **Cons:** it is refused by the fence shipped beside it. `anchor_unreadable` was the map's only
    `true`, so flipping it leaves every member `false` — which `chain-verify.test.ts` calls a
    silently disarmed fence and asserts against by name.
  - **Why not:** a judgement with no case left is not a judgement. The honest relaxation is a
    deletion, and the prediction is corrected rather than followed.

- **Option B: keep the refusal and widen only the integrity proof's detector.**
  - **Pros:** smaller; the proof is the surface that pages.
  - **Cons:** the proof is a separate opt-in process. A deployment running only `--checkpoint-config`
    would then anchor over a finding nothing reports, which is ADR-0371's own rule for this scheduler
    read one notch out: a *finding* whose reporting depends on a separate opt-in process is
    unreported on every deployment not running it.
  - **Why not:** the scheduler already verifies the chain and reports through `onRefused`, so it is
    already a partial detector by design. `onAnchorFindings` is that design extended to the table it
    writes.

- **Option C: use the highest *readable* anchor for the bounded fold, not just for the witness.**
  - **Pros:** a single refused newest row would cost no full fold at all.
  - **Cons:** evidence of tampering in the anchor table invalidates the provenance claim every other
    row in it makes. That table is not hash-chained, so a session that can `UPDATE` one row can
    `UPDATE` all of them, and a bounded fold **skips the prefix** on the strength of exactly that
    claim.
  - **Why not:** the witness and the anchor are asked for different things. A witness is used to
    *detect* (a weaker witness under-detects, which is safe); an anchor is used to *skip* (a weaker
    anchor hides, which is not). `latest()` keeps deciding the fold, and a refused newest row keeps
    folding from genesis until the scheduler anchors a readable row **above** it — which, measured,
    is not simply the next pass: `record` is `ON CONFLICT (tenant_id, sequence_number) DO NOTHING`, so
    a pass whose tail has not moved writes nothing and the fold persists. What relieves it is the
    chain's growth, which on a serving deployment is every audited request (ADR-0286).

- **Option D: cross-check in SQL, so the scan need not transfer rows.**
  - **Pros:** no per-row transfer; the database does the comparison.
  - **Cons:** the refusal is a zod parse, which Postgres cannot evaluate, so SQL can only approximate
    it — and an approximation of a contract is a second spelling of that contract, this repo's
    most-found defect class. The correspondence half *is* expressible as a join, but only over a
    chain the reader has already accepted, which the scan does not know.
  - **Why not:** measured cost makes it unnecessary. The table grows one row per scope per pass, so
    a year of hourly passes is ~8,760 rows per scope and ~36 ms to scan, against the 15.2 s of
    signature CPU per pass at 100k entries the permanent full fold charges.

- **Option E: remember the highest witness seen and scan only above it.**
  - **Pros:** O(new rows) per pass instead of O(all rows).
  - **Cons:** **unsound**, and in the one direction that matters: a row can be edited *below* the
    watermark after it was scanned clean, which is precisely the tamper. The attack this increment is
    about is an `UPDATE`, not an `INSERT`.
  - **Why not:** a detector that trusts its own earlier reading cannot detect an edit.

- **Option F: a third disagreement kind for an anchor the chain does not reach.**
  - **Pros:** symmetrical; three outcomes from two maps.
  - **Cons:** that is the truncation condition, which `ChainTruncationCheck` already names, so it
    would report one fact as two causes — and, worse, it would take the witness away from the check
    that needs it, because a disagreeing anchor is excluded from `witnessSequence`.
  - **Why not:** the kinds are `sequence_relocated` and `root_hash_mismatch` only, and the comment
    says why the third is absent.

- **Option G: detect a **deleted** checkpoint by reading the chain's own memory of a prior witness.**
  - **Pros:** closes the one attack this increment leaves open. `integrityVerdictPayload` already
    commits `truncation.checkpointSequence` to a signed chain entry, so the chain remembers what the
    last verdict saw, and `witnessSequence` is monotone non-decreasing — so a drop is evidence that
    the anchor table lost or lowered a row.
  - **Cons:** it makes one pass's verdict an *input* to the next, which is a new dependency between
    passes; it needs a decision about the no-prior-verdict case; and it is conditional on
    `recordVerdict`, which a deployment can turn off.
  - **Why not:** architecturally its own increment. Measured and recorded as the top open question
    rather than speculated: with all three anchors deleted the pass reads `verified`, `witness=null`,
    and the formatter prints *"truncation: not checkable (no checkpoint yet — run the checkpoint
    scheduler)"* for a scope whose checkpoints were destroyed — a remedy that cannot work (ADR-0334).

## Consequences

- **Positive.** A refused checkpoint row is found wherever it sits, not only at the top. An anchor
  the chain contradicts is a named finding attributed to the anchor table rather than a silent
  `verified` or a false `chain_truncated`. The scheduler anchors again, so a scope holding a refused
  row gets its bounded verification and its truncation witness back once the chain grows past that
  anchor's sequence, instead of folding from genesis for ever. `verify-chain` stops being blind in
  its stronger mode.

- **Negative.** The integrity pass and the checkpoint pass each read the whole anchor table per scope
  per pass, where the first read one row and the second read none: `O(checkpoints)` instead of
  `O(1)`, measured at ~4.09 µs/row, so ~36 ms per scope per year of hourly history. A scan the
  ceiling stops degrades the verdict to `unproven`, which is honest and, at a default ceiling of
  1,000,000 rows, unreachable inside a century of hourly passes.

  **The fix recovers the evidence that a witness was altered, not the truncation itself — and only
  for an edit that leaves `root_hash` behind.** Once a witness is edited the truncation it would have
  proven is unprovable; what survives is proof of the edit, and it survives *because the stale root
  hash is still there*. In the composed arm below, both lowered anchors come back
  `root_hash_mismatch` — their root hashes name entries the cut destroyed — so the verdict is
  `compromised` and names the anchor table, which is where the surviving evidence is. Set both
  columns in the same `UPDATE` and nothing survives: the scope reads `verified` with a report
  byte-identical to a healthy one, measured. So this is a cost-raising fix and not a closure, and the
  residual is open question 1 rather than a line in this section.

- **Neutral.** `verify-chain`'s `--format json` payload gains a level (`{chain, anchors}`); the
  command has no in-repo consumer. `ChainVerificationReport` is unchanged, deliberately: the audit is
  a second report about a second table, and merging them would be the merge ADR-0373 argued against.

- **Reversibility.** The scan and the audit are additive and callerless-safe. Restoring the refusal
  would mean re-adding a one-member map the test suite now refuses, which is the point: the decision
  is recorded in the shape of the fence.

## Implementation notes

- `packages/forensics-pg/src/checkpoint-store.ts` — `scanCheckpoints`, `CheckpointScanOutcome`,
  `CHECKPOINT_SCAN_PAGE_SIZE`, `CHECKPOINT_SCAN_CEILING`. The cursor's sequence travels as the raw
  string node-postgres returns for a `BIGINT` and is bound with a `::bigint` cast, never through
  `Number`.

  **The keyset predicate carries a conjunct it already implies, and the reason is the opposite of
  how it reads.** This increment's brief asserted that the explicit disjunction
  `sequence_number > $a OR (sequence_number = $a AND id > $b)` is the index-friendly form and a row
  comparison is not, because `id` is absent from `(tenant_id, sequence_number)`. That is **backwards**,
  measured on PG 16.13 at page 100 of a scan over a 200k-row scope: the planner truncates a row
  comparison into an index condition (`expand_indexqual_rowcompare`) and leaves the bare disjunction
  as a `Filter`, so the disjunction re-reads every row before the cursor — `Rows Removed by Filter:
  100001`, 2745 buffers, 22.2 ms a page, **4.86 s** for the 200-page scan, **quadratic in the page
  count**. Which would have re-introduced, inside this function, the cost ADR-0374's refusal was
  paying. The disjunction is kept for readability — the `id` arm is visible as the thing the platform
  scope's duplicate sequences need — and `AND sequence_number >= $a::bigint` is added beside it: the
  same index condition the row comparison earns, 0.563 ms a page and 0.132 s for the scan, three
  bind parameters either way. It is pinned by a test carrying those figures, because it reads as
  redundant and is not.

  **Both arms must be strict, and the `id` one is the arm that matters.** With `id >= $a` the
  sequence arm is still strict while the `id` arm re-admits the row the cursor was taken from, so
  forward progress drops to `pageSize - 1` rows a page, `scanned` over-counts, a refused row at a
  boundary reaches `onPage` twice — and where one sequence holds `pageSize` rows the page comes back
  full and identical for ever. That is reachable on the platform scope alone, whose duplicate
  sequences are the very thing the tiebreaker exists for, and it is fixtured rather than argued: at
  `pageSize: 1` over three rows at one platform sequence the loose form reads **1,000,000 rows** (the
  first row a million times, bounded only by the ceiling) and reports `complete: false` for a
  three-row scope. Strictness costs nothing — the plans differ by one `Rows Removed by Filter` and
  share an identical `Index Cond`.

  Two further edges came out of the fixtures: `pageSize: 0` would make `LIMIT 0` answer an empty page
  for ever (`0 < 0` is false), so the page size is floored as `drainList`'s is; and a scope holding
  **exactly** `ceiling` rows reports `complete: false`, because proving the end costs one more page —
  conservative, and the arm that makes the verdict `unproven`.

  **And the shared fake was stricter than the real table, in the one way that mattered.**
  `fakeChainPg` deduplicated platform checkpoint rows, so no round trip through it could hold the two
  rows at one sequence that the `id` tiebreaker exists for — the hazard that file's own header
  describes for reads. It models the real NULL semantics now, which made `NEWEST_AT_ONE_SEQUENCE`
  modellable for the first time, so `latest`/`listRecent` sort by it in the fake too; without that the
  fake returned the **older** row of a pair, which is the fail-open order ADR-0371 fixed, and a later
  test could have asserted that defect as the behaviour. The scan arm is matched **first and
  specifically**, because the generic `SELECT` arm regex-matches `sequence_number = $n` and would have
  narrowed a page to the one sequence the cursor sits at; it also reads the `id` **operator** off the
  statement rather than assuming it, which is what makes the loose-predicate mutation fail on
  behaviour instead of on a refusal.

  **The fake also had to stop refusing the mutation by name.** It rejected an unrecognised keyset
  shape, so weakening the `id` arm failed on the fake rather than on the behaviour — a test that
  cannot be wrong about the thing it is written to catch. It reads the `id` **operator** off the
  statement now and applies the predicate as written, keeping the refuse-by-name fence for a
  genuinely different shape. The same sharpening paid again on the cursor: a mutation advancing the
  cursor only off *readable* pages makes a `pageSize: 1` scan over a refused row answer `[1]` where
  the whole scope is `[1, 7]` — **the tampered anchor silently truncating the history it sits in**,
  which is the failure reading the cursor off the raw row exists to prevent.

  **And the field dropped from `CheckpointScanOutcome` was being checked against itself.** Its only
  reader was a test asserting `witnessSequence <= highestReadableSequence` against a maximum its own
  fake store recomputed from the same pages — ADR-0362's retired test verbatim, a rule compared
  against a derivation of itself written in the test, landing on this exact field. The property is
  stated over the fold's own answer instead: two higher anchors contradicted, one lower anchor
  sound, and the witness is the sound one.

  `packages/forensics-pg`'s `exports` map names only `"."`, so `apps/operate-server` cannot import
  `fakeChainPg` and the app's own fakes model the scan statement themselves — routing on
  `ORDER BY sequence_number ASC, id ASC` with params `[cursorSeq (string), cursorId, limit,
  ...scope]`. Adding `"./test-fakes"` would let them share one; left alone, because a package's
  export surface is a wider decision than this increment.
- `listRecent` is left alone, with its own prediction corrected: it predicted "the caller this will
  gain is one computing a verdict", that caller arrived, and it could not use the method — the shape
  it needed is ascending-with-a-cursor and `listRecent` is descending-with-a-limit. The **pair form**
  it argued for is what `onPage` hands over per page, so the principle is exercised and the method is
  not.
- `apps/operate-server/src/anchor-audit.ts` — `auditAnchors`, `anchorAuditDisproves`,
  `anchorAuditHasFindings`, `formatAnchorAudit`, `ANCHOR_DISAGREEMENT_KINDS`. Two predicates and not
  one, because `compromised` and `unproven` are different consequences. `formatAnchorAudit`'s first
  line is labelled `checkpoints:` and **not** `anchors:`, which the live run found the moment those
  lines were indented into `formatIntegrityProof`'s report: that report already carries an
  `anchors: checked N, verified N, unanchored N…` line about `meta.audit_log` rows anchored *in* the
  chain, and two lines reading `anchors:` about two tables is a report an operator has to
  disambiguate before acting on either.
- `apps/operate-server/src/checkpoint-scheduler.ts` audits **before** the tail check, and the
  ordering is observable because its member is live: a scope can hold checkpoints with an empty
  chain, and the only thing in the workspace that produces that is the tamper — there is no
  `DELETE FROM forensic_chain_entries` anywhere, the Article 17 shared-table erasure *retains* that
  table as a `PLATFORM_RECORD_TABLES` member, and ADR-0374 measured a tenant-context `DELETE`
  matching the owner's row count on 6 of 6 scopes. An audit placed after the tail check would answer
  the one case it exists for by reading nothing.
- `apps/operate-server/src/integrity-proof.ts` — `IntegrityProofReport.anchorRowsRefused` becomes
  `anchorAudit`; `integrityVerdictFor`'s fifth parameter is retyped. ADR-0374 kept that signature to
  spare 21 call sites, and that convenience expired when the axis grew a second dimension.
  `noAnchorFindings()` is the fixture helper, and it answers `disagreeing: []` rather than `null`
  because it means *asked and clean*.
- `proveScopeIntegrity` moves its existing `loadChain` above the audit rather than adding a second
  read, and deletes the `latest()` call and its `CheckpointRowUnreadable` catch.
- The refusal axes stay **outside** the stored verdict: `integrityVerdictPayload`,
  `StoredIntegrityReportSchema`, `canonicalStoredReport` and `storedIntegrityReportFor` are
  untouched, so the stored report stays byte-identical to the committed payload (ADR-0371 reverted a
  field out of it for exactly this). Confirmed by reading `integrity-verdict-store.ts`, whose
  `IntegrityProofReportLike` names no refusal axis at all; the one forced edit outside the increment's
  own files was a fixture line, and the parity held across an axis growing a second dimension.

- **`!anchorAudit.complete` is an `unproven` arm and not a fourth verdict, and that is a measurement
  rather than a preference.** `INTEGRITY_VERDICTS` is mirrored by `STORED_INTEGRITY_VERDICTS`,
  constrained by `meta.audit_integrity_verdicts`' column CHECK and declared in `VALUE_SET_DOMAINS`, so
  a fourth member is a catalog change, a declaration change and a CHECK re-plan. `unproven` already
  means *nothing disproven, something not established*.

- **Why anchoring can no longer bury a finding is the scan's direction, not its width.** Ascending
  from genesis with a ceiling means a fresh anchor at the tail is the *last* row the scan would
  reach, never one that displaces an earlier finding — and a finding leaves the scanned prefix only
  if ~1,000,000 rows land at sequences *below* it, which this writer never does (it appends above,
  and a lowered sequence moves a finding *into* the prefix).

- **`node.ts` wires `onAnchorFindings` to a log line and deliberately not to a declarer.** A refused
  or relocated anchor is a standing condition that fires on every pass, so a `declare` there would
  open one incident an hour; the integrity proof's escalator is where per-episode adoption already
  happens from durable state (`findOpen`, ADR-0324), and the verdict it escalates on already carries
  the cause.

- **Two additions the brief did not dictate, each argued at its site.** `recordedAnchorRefusal` takes
  its count from the audit rather than from the capped list, because two caps compose and only the
  deepest may be sliced — otherwise the anchored escalation row under-reports by a cap applied
  upstream. And `anchorDisagreements` is capped in the payload, because the scan's own bound is
  `CHECKPOINT_SCAN_CEILING` and uncapped a tamperer writes that many objects into one JSONB column
  inside the escalation path.

- **One split with a stated cost.** `checkpoint_row_refused` and `checkpoint_disagrees_with_chain`
  are exactly `anchorAuditDisproves`' two disjuncts, read apart because each lands at a different
  escalation payload key. A *third* disjunct added there would reach `onAnchorFindings` and neither
  cause, so a verdict could read `verified` beside an anchor finding; a test asserts the two sides
  agree over every shape this report can hold.
- No migration. The four CHECKs ADR-0374 added to this table already fence the write path on a
  converged deployment; face 2 needs none of them, because `sequence_number >= 0` admits every value
  the attack uses.

## Verified live

PG 16.13, catalog applied as the owner, every tamper one statement issued by the non-owner `serving`
role under the tenant's own context. Pre- and post-fix transcripts side by side; `0375-pre-measured.txt`
and `0375-post-measured.txt`.

| arm | pre-fix | post-fix |
|---|---|---|
| refused anchor at seq **1** (not newest) | `verified refused=0` | `compromised refused=1 causes=[checkpoint_row_refused]`, the row named as `checkpoint 1 (checkpointedBy: too_small)` |
| refused anchor at seq **4** (the newest) | `compromised refused=1 mode=full` | same |
| scheduler, over a refused anchor | `refused_anchor_would_bury recorded=[]` | `recorded=[4] findings=[refused=1]`, and the next pass still `compromised refused=1` |
| anchor lowered 4 → 2, **`sequence_number` only** | `verified` | `compromised sequence_relocated matchedAt=3` |
| anchor raised 3 → 99, **`sequence_number` only** | `compromised truncated=true causes=[chain_truncated]` (false) | `compromised truncated=false causes=[checkpoint_disagrees_with_chain]`, rendered *"anchor at 99: sequence_relocated, whose root hash is the entry at 3"* |
| `root_hash := 'f'*64` at the tail anchor | `verified` on both modes | `compromised root_hash_mismatch` |
| chain cut, then every anchor lowered, **`sequence_number` only** | **`VERIFIED`**, *"signatures valid (3 checked)"*, no truncation line | `compromised`, two `root_hash_mismatch` |
| chain cut, then every anchor lowered **and its `root_hash` set to the surviving entry at its new sequence** | **`VERIFIED`** | **unchanged** — see below |
| anchor raised 3 → 99 **and `root_hash := 'f'*64`** | `compromised truncated=true causes=[chain_truncated]` (false) | **unchanged** |
| every anchor `DELETE`d | `verified witness=null` | unchanged — the named open question |

**The correspondence rule catches a one-column edit and is defeated by a two-column one**, which an
adversarial pass over this commit established and which bounds every `sequence_relocated` and
`root_hash_mismatch` row above. `disagreementFor` asks three questions — is the entry at this
sequence carrying this hash, does some *other* entry carry it, does an entry exist here at all — and
every "no" falls through to `null`, which is deliberate for the case the truncation check owns (an
anchor the chain does not reach yet) and is also what an edit to *both* columns produces. Measured on
the same cluster, by the same single `UPDATE` as the arms above, as the same non-owner role: lowering
each anchor **and** setting its `root_hash` to the surviving entry at its new sequence reads
`verdict=verified truncated=false witness=2 refused=0 disagree=[] causes=[]`, with a report
byte-identical to a healthy scope's; raising one to 99 **and** setting `root_hash := 'f'*64` reads
`truncated=true causes=[chain_truncated]`, the same false paging sev1 this increment corrects for the
one-column form. Neither costs the attacker anything extra — the destination entry's hash is readable
from the chain, and on a tenant scope `UNIQUE (tenant_id, sequence_number)` only requires the
destination sequence to be free, which it is wherever the anchor is being moved *down* off its own.
So the honest statement is that this closes the cheap, single-column edits and leaves the two-column
one, which is **quieter than the `DELETE` already named below**: a `DELETE` at least leaves
`witness=null` and the formatter's "no checkpoint yet" line for an operator to see. It is the first
open question now, above the `DELETE`.

**The tail-anchor arm is the one that shows all three claims at once.** With the refused anchor *at*
the tail: the pass reads `compromised mode=full fullBecause=anchor_unreadable witness=null`; one
scheduler pass answers `recorded findings=[refused=1]` and writes nothing, because `ON CONFLICT …
DO NOTHING` fires at that same sequence; the next pass still reads `compromised`. Append one chain
entry and the following pass records at the new tail, after which the scope reads
`mode=from_checkpoint witness=3` **and still** `refused=1 causes=[checkpoint_row_refused]`. So the
finding survives the anchor, the bounded verification and the truncation witness come back, and what
relieves the full-fold cost is the chain's growth rather than the pass — which on a serving
deployment is every audited request (ADR-0286).

**`verify-chain`**, on a scope whose signatures the real key registry resolves: a refused anchor at
sequence 1 exits **1 in both modes**, where pre-fix it exited 0 in both — the bounded mode because
`fullBecause` is a statement about the newest row, the full mode because `verifyChainFull` never read
that table. A *relocated* anchor still exits 0 in both, which is the second open question and is now
at least visible in the output: the line reads `checkpoints: 2 row(s) scanned, complete, witness 99
(unchecked)` for a four-entry chain, so an operator can see the anomaly even where the exit code
cannot.

**And through the real binary**, booted with `--audit-chain-config --checkpoint-config
--integrity-proof-config` against that cluster, with a refused anchor at sequence 1 — both surfaces
fire, and the scheduler anchors anyway:

```
[checkpoint] ANCHOR FINDINGS scope=af506172-…
  checkpoints: 2 row(s) scanned, complete, witness 3 (unchecked)
    REFUSED: 1 checkpoint row(s) the contract refuses
      checkpoint 1 (checkpointedBy: too_small)
[integrity-proof] scope=af506172-… verdict=compromised chain=from_checkpoint sigs=0
[integrity-proof] COMPROMISED
  checkpoints: 2 row(s) scanned, complete, witness 3
    REFUSED: 1 checkpoint row(s) the contract refuses
      checkpoint 1 (checkpointedBy: too_small)
[checkpoint] scope=af506172-… seq=3 root=c7f9105c8d55 provenance=verified_suffix
```

Two lines of one boot log also settle whether the `(unchecked)` marker earns its place: the
scheduler's witness carries it and the proof's does not, because the scheduler passes no chain and
the proof passes the whole one.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| **A two-column `UPDATE` defeats the correspondence rule**, measured both ways above: setting `sequence_number` and `root_hash` in one statement hides a truncation under a report byte-identical to a healthy one, and manufactures the false `chain_truncated` sev1 the one-column form no longer produces. Quieter than the `DELETE` below and no dearer to the attacker. Closing it needs evidence the anchor table does not hold — the chain's own memory of a prior witness (Option G, which also closes the `DELETE`), or an anchor table that is itself chained. | Platform | 2026-11-30 |
| A tenant can `DELETE` its own checkpoint rows, which leaves no witness, no finding and a remedy that cannot work. Close it by reading the chain's own memory of a prior `truncation.checkpointSequence` (Option G)? | Platform | 2026-11-30 |
| **`checkpointed_at` is compared against nothing** — not against `sequence_number`'s order, not against the entry it anchors — so a reordering the correspondence rule cannot see leaves a timestamp that disagrees with it. Recorded with its refutation attached, because the obvious detector does **not** reach the two arms it would be built for: in the lowering arm the anchors move *in order* (3→1, 4→2), so sequence order and time order are the same permutation and a monotonicity check passes; in the raising arm one row moves, which is trivially monotonic. Building it on that justification would be a control that reports health it never established. | Platform | _N/A_ |
| `verify-chain` does not ask the correspondence in either mode, because neither fold hands its entries back. Worth a shape change, or a second chain load for the manual auditor? | Platform | 2026-11-30 |
| The scan is a sequence of per-statement snapshots, so a row whose `sequence_number` is edited between two pages can fall between them. Worth `REPEATABLE READ`, which `withTenantContext`'s statement order currently makes impossible to set? | Platform | 2026-12-31 |
| `root_hash_mismatch` cannot say whether the anchor or the entry was altered. A chained anchor table would, at the cost of a second chain. | Platform | _N/A_ |
| ADR-0374's standing manual `ALTER`s remain unrun on existing deployments, which is the population face 1 is reachable on. | Platform | 2026-11-30 |

## References

- ADR-0374 — the tamper that buries the finding (open ends 6 and 7, and the refusal this relaxes)
- ADR-0373 — a sweep one bad row stops (the refused-row pair form, and `unreadableDetail`'s rule)
- ADR-0371 — an anchor nobody verified (provenance, and the platform scope's unconstrained sequence)
- ADR-0372 — an absence of evidence is not evidence (the vacuous axis)
- ADR-0367 — a prefix is not the set (`drainList`'s `onPage`, and the declared bound)
- ADR-0361 — a reader whose aperture is narrower than the writer's
- ADR-0331 — a claim is not the absence of a reading
- ADR-0334 — a remedy that cannot work is worse than naming none
- ADR-0287 — the truncation check and its checkpoint witness
- ADR-0286 — the audit row and the chain entry that commits to it
