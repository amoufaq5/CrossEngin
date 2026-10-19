# ADR-0373: A sweep one bad row stops

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-19 |
| **Authors** | platform |
| **Reviewers** | platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0372, ADR-0289, ADR-0322, ADR-0331, ADR-0351, ADR-0362, ADR-0367, ADR-0371 |

## Context

ADR-0372 found three reads in `deletion-request-store.ts` whose mapper ends in a zod `.parse`, and
whose page therefore **threw** on one stored row the contract refuses — so a single defective row
stopped the sweep that exists to find defective rows. It gave those three a required `onUnreadable`
reporter and established the rule: **report and carry on.** Its own Q2 asked how many other members
that class has.

It has **82**, and the rule as stated is only half of it. The missing half is what this increment is
about:

> **Where a sweep's purpose is to find defective rows, an unreadable row *is* the finding — so it
> must be routed into the finding set, not out of the answer.**

Dropping the row is the same silence one layer in; throwing takes every other row's finding with it.
Both land on the reassuring side, and the two live members found here show the two ways that silence
is reachable: one makes the **row** unreadable (the sweep stops), the other makes the **evidence**
unreadable *in a way the contract tolerates* (the detector answers "cannot say", which is not a
defect).

A single-row read that throws is correct — the caller asked about that row, and ADR-0289's rule is
that a parse failure means a row edited into a state the contract forbids and a CHECK permits, which
the caller must not be served past. So the class is counted on the **array** anchor: a conversion
applied to a row *page*, which is what `pg-unreadable-rows.ts` fences. Measured by running that
module over the committed tree before and after, which is the only figure here worth carrying
because it is the one the rule itself produces:

| | sites | needing a declaration |
|---|---|---|
| before (`HEAD~1`) | 112 | **82** — 66 throwing, 11 asserting, 3 dropping, 2 self-guarding |
| after | 110 | **67** — 51 throwing, 11 asserting, 2 dropping, 3 self-guarding |

So **15** sites are closed and 67 are declared, 44 of them an explicit backlog naming what a refused
row costs today.

An earlier draft of this paragraph said *"63 single-row reads excluded, 51 multi-row sites, of which
13 are a sweep or an audit"*, and that triple is **the refused anchor's**, not the class's: anchoring
on *every invocation* of a row mapper gives 114 sites of which 63 are single-row reads doing the
right thing, which is precisely why `REFUSED_ROW_PAGE_ANCHORS` refuses it. It is kept here as what
it is — the measurement that justified the anchor — rather than as a count of the class.

### The three reachable ways to defeat the Article 17 / forensics audit, graded

1. **Blank a tombstone's `attestations` to a non-array** → the detector answers "cannot say" → **no
   defect**, record reads `ok`.
2. **Make any tombstone row unparseable** → `scanAll` throws → **the whole sweep aborts**, so every
   other stored proof goes unverified.
3. **Blank `actor_reference` or `signature` on a chain entry** → a genuine signature-breaking tamper,
   **and** `loadChain` throws → the integrity pass files `outcome: "error"` → no verdict row, no
   `onFinding`, no `escalate`, **no paging sev1**, one log line per hour for ever.

In (1) and (3) the tamper disables the detector that exists to catch it.

And a fourth, which is not about an audit at all and is the worst of the four:
`loadEngineDefinitions` **threw**, and `node.ts` awaits it with no `try` — so **one stored workflow
definition row the contract refuses took the whole API down at boot.** Not the workflow engine: the
process. A test defended that behaviour by name (*"raises on an unreadable row rather than serving a
shorter map"*), on a premise it did not have — that the alternative was a *silent* short map.

### A scoping refusal, measured

From the built catalog, as it stood **before** this increment: **505 TEXT columns and 159 JSONB
columns carried no CHECK**, **57** of the latter `NOT NULL DEFAULT '[]'::jsonb` with no array
constraint. After the three added here, 503 and 158, with 56 of that shape. (An earlier draft stated
the before-figures in the present tense and put the last one at "36+", which understated it by 20 —
the count is of JSONB columns that are `NOT NULL` with an empty-array default and no CHECK, and the
predicate reads `default`, not `defaultExpression`.) So "every contract refinement gets a CHECK"
is a separate increment — and probably a twelfth workspace rule, since ADR-0362 established that
none of the ten compares a *contract field* to a *catalog column*, and this is that question's other
half. This increment's fix is at the **read**, where the consequence lives, with CHECKs only on the
three columns whose unreadability defeats an audit.

That is ADR-0372's own shape read again: its guard went in the *adapter* and not the metric, because
the metric was right and reading it over an empty scope was wrong. Here the mapper's strictness is
right and *dropping or throwing* the unreadable row is wrong.

## Decision

**One primitive, in `packages/kernel-pg/src/read-rows.ts`**, and two shapes over it chosen by what
the store's consumer is:

- `readRows(rows, map, identify, onUnreadable)` — the **reporter** form, for a store whose consumer
  is a scheduler or a route. The caller decides what a finding is worth. This is ADR-0372's shape,
  lifted.
- `readRowsWithUnreadable(rows, map, identify)` — the **pair** form, for a store whose consumer is a
  **verifier**. There the unreadable row is not a note on the side: it is part of the answer, and a
  verdict computed over the readable rows alone is a verdict about a different set of rows than the
  one on disk.

Lifted into `kernel-pg` rather than copied per store for `scopeFilter`'s reason (ADR-0334): eight
copies of one rule is where two of them eventually disagree, and that module is the one every `*-pg`
member already imports for `PgConnection`.

Three rules carry the rest.

**`identify` is separate from `map`.** It reads the business key straight off the raw row, so it
still answers for the row the mapper refused — which is the one field a finding needs and the one
the mapper cannot supply. It runs **inside the catch**, so a throw from it costs only its own row's
identity (`null`) and not the rows after it.

**`unreadableDetail` names the field path and the issue code, and no value from the row** — and that
is a **correction to ADR-0372**, found by generalising it. That module argues at length that no
other column of a refused row may be reported, and then reports `err.message`; a `ZodError`'s
message is the JSON of its issues, and an `invalid_enum_value` issue carries `received`, which is
the stored value. It travels from there into a log line, an HTTP body and an incident note — the
disclosure ADR-0367 converted six interpolated refusal strings into literals to stop. The issues are
sorted and de-duplicated, so the same defect reads the same whatever order zod walked the object in;
a detail that varies run to run cannot be compared across two sweeps.

**An unreadable row fails the verdict, as its own axis and never as a new enum member.** On
`ChainSignatureVerdict` and `AuditAnchorReport` the field is `unreadable: readonly UnreadableRow[]`
and the parameter supplying it is **required**, so the compiler names every caller that has loaded a
page and must now say what in it did not read; an optional parameter defaulting to `[]` would be the
silence restored as a default (ADR-0364's addendum, ADR-0371's `onRefused`). It is an axis rather
than a verdict for two reasons, and the first is structural: a refused row never becomes an
`AnchoredAuditEntry`, so it cannot be *in* the results at all. The second is that `TAMPERED` is a
`ReadonlySet` over the verdict enum, so a sixth member added to it and to nothing else compiles and
silently reads as neither disproven nor unproven — ADR-0351's defect, where a `'v4'` added to an
enum and to neither membership list typechecked and regressed two refinements at once.

**`checked` stays the number examined.** `checked: 2` beside one unreadable row says what happened,
where `checked: 3` would claim an examination that did not occur (ADR-0371).

**The integrity verdict's new clause sits beside `tampered`, not beside `unanchored`**, and that is
the one judgement here that had to be argued rather than copied. An unanchored row is the *absence*
of evidence — a deployment upgrading from before ADR-0286 has such rows for ever, which is why it
answers `unproven` and pages nobody. A row this deployment's own reader refuses is evidence of
something: `assertEmittable` now ends in the same `AuditLogEntrySchema.parse` the reader runs, so no
write this binary can perform produces one. Deliberately **not** softer than `hash_mismatch`,
because rewriting a row into a shape the contract refuses is *easier* than rewriting it into a valid
one — so grading it below `compromised` would leave the cheaper attack as the one that does not page.

**Three columns get a CHECK** — `forensic_chain_entries.actor_reference`,
`forensic_chain_entries.signature` (`char_length(x) >= 1`) and `tenant_tombstones.attestations`
(`jsonb_typeof(attestations) = 'array'`) — and only those three, because they are the columns whose
unreadability defeats an audit. The upper bound is deliberately left off: both contracts are
`z.string().min(1)` with no maximum, and a CHECK refusing what the contract permits is the same
defect reversed.

**In a keyset sweep the refused row's identity *is* the cursor**, which is why `scanAll`'s page
carries `lastTombstoneId` and `rowsRead` rather than letting the caller derive them from the
records. ADR-0327's tombstone sweep is the member that forced it: its guarantee is a completed
**lap** over the `tombstone_id` ordering, and a refused row occupies a position in that ordering. A
caller taking the cursor from the last *record* asks the next page from before the refused row and
reads it for ever; one treating a short record list as the end of the table steps over every row
behind it. Both break the lap, in opposite directions, and neither is visible from the records.

**The refused rows are named where diagnostics are read and nowhere else.** `formatIntegrityProof`
and `formatChainVerification` print the ids; the durable record carries the fact through `verdict`,
which is both signed and projected. Adding a count to the stored report would have to move
`integrityVerdictPayload`, `StoredIntegrityReportSchema`, `canonicalStoredReport` and
`storedReportFrom` together or the stored report stops being byte-identical to the committed
payload — the exact trap ADR-0371 reverted a field out of.

## Alternatives considered

- **Option A:** keep throwing, and let the caller catch per page.
  - **Pros:** no contract change; the refusal is loud.
  - **Cons:** the loudness is at the wrong granularity. A caught page is a page with no rows, so
    every other row's finding is lost and the catch cannot say which row cost them.
  - **Why not:** it is what the chain reader did, and the live measurement is that the integrity
    pass filed `outcome: "error"` with no verdict row, no `onFinding` and no page — one log line per
    hour, for ever, for a genuine signature-breaking tamper.

- **Option B:** keep dropping, and report nothing.
  - **Pros:** zero change; the page survives.
  - **Cons:** the dropped row is absent from the detector that exists to find it.
  - **Why not:** measured live — a blanked `operation` on an anchored audit row read `verified`,
    while the same row rewritten into a *valid* shape read `compromised`. The two rewrites answered
    oppositely and the one that did not page is the easier one.

- **Option C:** one shape for every store — the reporter form everywhere.
  - **Pros:** one signature; no judgement per store.
  - **Cons:** a callback hands the fact to whoever called *that method*, and for a verification the
    fact has to reach the function that computes the verdict, which is often two layers up and pure.
  - **Why not:** `readRowsWithUnreadable` is `readRows` plus a collecting callback, so a store whose
    consumer is a verifier can be written either way — but `.records` is visible in review and in a
    grep where a discarded callback is not. Both are kept, and the store's contract picks.

- **Option D:** make every contract refinement a CHECK, so no stored row can be unreadable.
  - **Pros:** closes the class at the source rather than at the read.
  - **Cons:** measured before this increment, **505 TEXT and 159 JSONB columns** with no CHECK (503
    and 158 after the three added here).
  - **Why not:** a separate increment, and probably a twelfth workspace rule — ADR-0362 established
    that none of the ten compares a *contract field* to a *catalog column*, and this is that
    question's other half. It also would not retire this increment: a CHECK added to a populated
    table is reported rather than planned when the rows violate it, so a deployment already holding
    a refused row still needs the read to behave.

- **Option F:** make the remaining `requireIso`-only mappers parse, so every refusal is a zod issue.
  - **Pros:** one kind of refusal; a stored row that the contract forbids is caught everywhere.
  - **Cons:** measured per predicate against the real schemas, **6 of 10** of
    `access-reviews-runtime-pg`'s drift kinds become **unreachable** — the schema refuses the
    triggering row first — and `verifyCampaignRowShape` becomes entirely dead code. The messages
    degrade with them: `counter_overflow`'s *"resolved 7 exceeds totalItems 5"* becomes
    `unreadable_campaign_row` / *"totalItems: custom"*, because zod renders a `superRefine` issue as
    the opaque code `custom`.
  - **Why not:** that is exactly the fate `incident-response-runtime-pg`'s
    `terminal_without_timestamp` already suffered, and a label is not what is lost — a specific,
    actionable finding is. The reporting landed on those stores anyway; the gap is **declared** on
    `verifyCampaignRowShape` with the honest remedy, which is a `contract_violation` kind **beside**
    the six rather than instead of them.

- **Option G:** rewrite the typed row mappers as `requireText(row, "col")` accessors, so a wrong
  column type is caught at runtime rather than asserted by `tx.query<Row>`.
  - **Pros:** 18 fields in `event-log.ts` alone gain runtime validation.
  - **Cons:** built, measured, and **reverted**, because rule 9 refused it: replacing
    `interface Row` + `row.event_id` made all 18 reads invisible to `pg-record-reads.ts`, which
    failed with `alias_overtaken` and `business_key 6 < 7`.
  - **Why not:** a runtime type check cannot see a transposition between two columns of the **same
    type**, which is that rule's entire purpose (ADR-0355's `input_data_class`/`output_data_class`
    pair, both TEXT under one six-value CHECK). So the accessor form trades a static fence that
    catches the invisible defect for a runtime one that catches the loud one. Only the `kind` parse
    was kept, because an unknown kind is *ignored* by the fold rather than raising — a hole the fold
    cannot see, which is this increment's class and not a type assertion.

- **Option E:** grade an unreadable audit row `unproven` rather than `compromised`.
  - **Pros:** cannot false-positive on a contract that narrowed after rows were written.
  - **Cons:** `unproven` does not page, and the attack it would shelter is the cheaper of the two.
  - **Why not:** the write path's parse makes the premise conclusive rather than inferred
    (ADR-0322's axis), so there is no honest-row population to protect — see the stated cost below,
    which is a *forward*-compatibility hazard rather than a current false positive.

## Consequences

- **Positive:** the two live members are closed. A refused chain entry fails both halves of the
  chain verification instead of throwing out of it, so the hourly pass files `compromised` and the
  escalation fires; a refused audit row is the anchor check's own finding instead of being dropped,
  so the two ways of rewriting an audit row now answer alike. The `meta.audit_log` write path's
  refusals are a **superset** of its read path's for the first time — they were two hand-written
  spellings with neither nesting the other, which is ADR-0353's `META_DEPLOYMENTS` shape and makes
  every "the writer is stricter" test structurally blind.
- **Negative:** three `ALTER`s of standing manual SQL on every existing deployment, reported by
  `apply`/`--plan` with the exact statement until an operator runs them. And one forward-
  compatibility hazard, stated rather than mitigated: `ActorSchema` is `.strict()` with five
  required keys, so adding a sixth to `AuditActor` would make every stored row unreadable and
  therefore every scope `compromised` — a paging sev1 caused by a schema evolution. Before this
  increment the same change was silent. The remedy belongs to the contract change, not to this read:
  a new actor field must be `.optional()`, or arrive with a migration, which is ADR-0351's
  versioning rule one table over.
- **Neutral:** `listForTenant` still answers a bare array and still drops the refusal. The reason
  first written here — *"because its consumer is a reader and not a verifier"* — names a consumer
  that **does not exist**: it has zero non-test callers, which is the stale-claim class this
  repository's own register has an item about. The decision stands on the honest ground instead:
  it is the reader-shaped sibling of a verifier-shaped method on the same store, and when it gains
  a caller that caller's kind decides, not this note. `audit-read-store.ts`'s own `rowToEntry` keeps **throwing**, with its reasoning
  already in place — *"the caller turns it into a refused page, not a shorter one"* — which is the
  increment's thesis confirmed in-repo: two opposite choices for one mapper in one app, decided by
  whether the consumer is serving a page or computing a verdict.
- **Reversibility:** cheap for the reads (the primitive is additive and the pair form is one field),
  expensive for the CHECKs (a `DROP CONSTRAINT` each, and a deployment that has applied them holds
  rows that satisfy them).

## Implementation notes

`unreadableEntryVerdict(unreadable)` is the one place the chain's precedence lives, applied as
`unreadableEntryVerdict(read.unreadable) ?? verifyChainIntegrity(read.entries)` in both
`PostgresChainLogReader.verify` and `verifyChainFromCheckpoint`. Unreadable rows take precedence
**unconditionally**, because a fold over a chain with a row missing is not a fold over that chain —
and the sharpest case is the refused row at the **tail**, where what reads back is a contiguous
genesis-anchored chain the fold pronounces `{valid: true, brokenAt: null}`. Without the precedence,
`verify()` calls a chain carrying a signature-breaking tamper healthy. Its `brokenAt` is the first
unreadable row's sequence, and the ordering belongs to the read's `ORDER BY sequence_number ASC`
rather than to the function; a test pins it so a read that ever came back unordered fails there.

`apps/operate-server/src/certification.ts`'s `PostgresForensicChainReader` is **deleted** —
`forensicChainReaderFor` over `PostgresChainLogReader` replaces it. That closes a defect of a
different class in passing: its `SELECT` carried **no `WHERE` clause in either branch** while its
own doc comment claimed *"a null tenant reads the platform chain"*, so as the owner — which the
shipped compose is, connecting as the role that ran `migrate` — it read every scope's entries
interleaved, `verifyChainIntegrity` saw `0,0,1,1,2,…` and reported a `sequence gap`, and the
`audit.tamper_evident_log` control read **not satisfied** on a perfectly healthy chain. That is
ADR-0331's defect in the second spelling that increment did not reach.

`forensicChainSource`'s vacuity guard is now `entries.length === 0 && unreadable.length === 0`:
**every row refused is not an empty chain**, and reading it as empty would leave the control
`not_assessed` for a chain whose every entry the contract rejects — ADR-0372's "an absence of
evidence is not evidence" in the place this increment is about.

`replay.ts`'s DR section counts the refused rows in both `scanned` and `complete`, because both
answer about the table rather than about the subset the contract could represent — omitting them
would make `complete` read true at the limit, claiming a whole scope was covered. The access-review
section's `complete: true` was unconditional and is now `unreadableCampaigns.length === 0`, for the
same reason.

**The primitive is generic in the row type**, and that was not the first shape: it typed its mapper
`(row: Record<string, unknown>) => T`, and a store that declares its rows (`tx.query<Row>`) could
not use it — a function parameter is contravariant, so an `interface Row` with no index signature
reaches neither that parameter nor `Record<string, unknown>` itself. Two slices wrote a local copy
of the loop rather than widen their mappers, each with a comment saying a generic primitive would
retire it. Two are retired: `access-reviews-runtime-pg`'s `readTypedRows` is deleted and
`workflow-runtime-pg`'s `readEventRows` is a four-line wrapper keeping only the identity expression,
which is the one part that has to know the row's own shape. A **third** copy — ADR-0372's own
`readRequestRows` — was missed by the first pass and is retired too; it had `requestIdOf(row)` inside
the catch but **not** in its own `try`, so a throw from the identity would have cost every row behind
it, which is the property `readRows` keeps and the reason one spelling is worth the churn. Its
`requestIdOf` was byte-identical to `textIdentity(row, "request_id")`, a fourth spelling of that
predicate.

**A refused row makes a cross-row finding an inference rather than an observation**, and three
places say so now. `verifyIncident` passed `historyIsComplete: true` on the ground that
`listForIncident` is unbounded — true of the *window* and false of the *rows*, because a refused row
is an absence **this pass caused**, so `ongoing_without_open` would fire on a log whose
`breach_opened` was the unreadable row. `CampaignReplay.complete` and
`summarizeEnforcement(…, unreadable)` carry the same fact, the second **required** because it is
handed an array and so cannot otherwise tell *found nothing* from *nobody looked*. `duplicate_open`
stays ungated deliberately: presence is conclusive in any subset (ADR-0322).

Two things found by reading rather than by the census. `replayCampaign` called `getByCampaignId`, a
**point lookup that also threw**, so an unreadable campaign row still killed that replay — it is
caught and reported with `found: true`, because a refused row *is* a row and "cannot be represented"
is not "no such campaign". And that store's test fake answered the point lookup with **every**
campaign row; it honours `campaign_id = $1` now, which is the `fakeCertificationPg` shape this
file's *Tests* convention already records.

**ADR-0372's own three reads now use `unreadableDetail`.** That module computed
`detail: err.message` at three sites — the list reporter and the two
`DeletionRequestCommittedUnreadable` throws, whose message reaches an HTTP body and the runner's
log — so the rule it argues for three paragraphs above its own `UnreadableRequestRow` was broken by
its own implementation. The *field name* stays `requestId` rather than converging on `identity`,
deliberately: a reporter there is handed a request, and that is what its three audiences act on.
What must not diverge is the detail, and that now has one definition.

## Addendum — what an adversarial pass over the commit found

An adversarial read of `102cad5` found nine things: four wrong on a deployment, five claims false or
overstated, and five gaps. The claims are corrected in `f3948d0` and in CLAUDE.md; this section is
the behaviour. **Three of the four were introduced or made reachable by this increment**, which is
the useful shape of them — routing a refused row into an answer changes what every figure beside it
means, and the readers of those figures do not move with it.

### The route that reported clean over a proof it could not read

`GET /v1/platform/tombstones/unproven` answered **`clean: true`** over an Article 17 proof the
contract refuses, and wrote that claim into the forensic trail as an anchored audit row reading
`status: clean`. The route file was simply not touched when `auditTombstones` stopped throwing: its
structural mirror `TombstoneAuditPageLike` had no `unreadable` member, and **a missing member on a
structural mirror does not fail to compile — it discards the field.** Before the increment the same
database state hit the `catch` whose own comment reads *"do not treat this as an absence of
findings"* and answered **503**.

Reproduced against the real producer as the non-owner `serving` role, one planted
`scope='null'::jsonb` row: `examined: 0, findings: 0, unreadable: [{identity:
"tomb_slice3probe001", detail: "anchors: too_small, scope: invalid_type"}]` → `clean` is `false`
under the fixed rule and **`true`** under the one it replaced.

`clean` is **one predicate with two readers** now, the body's field and the audit row's `status`,
because deriving them separately is how they came apart. The refusals ride **beside** `findings` (a
refused row carries no reference state and no verify verdict, so it is not expressible as one) and
**not** inside `examined`, which counts rows verified. They are deliberately **not** escalated:
`escalateTombstone` keys its episode on the tombstone id, and a refused row's identity may itself be
the refused column. The mirror's new member was mutation-checked by **renaming** it, which makes
`node.ts` fail to compile — so it is bound to the real `DeletionReconciler` rather than decorative.

`buildUnprovenHandler` over `auditCompleted` has the same shape and is **declared rather than
fixed**: that function returns findings alone and sends a refused row to a *constructor-level*
`onUnreadableRequest` that `node.ts` wires to `console.error`, so the refusals never reach the
handler. Closing it needs `auditCompleted` to return its refusals beside its findings — the shape
`auditTombstones` now has — plus its callers. The tempting shortcut is **worse than the silence**: a
per-call reporter on the *mirror* alone would have the store ignore the extra argument, so the route
would report `unreadable: []`, a falsely-true control replacing an honest gap.

And a test surface that was vacuous in every one of its cases, found while writing the escalation
assertion: the sweep harness never wired `escalateTombstone`, so
`for (const finding of page.findings) await ctx.escalateTombstone?.(finding)` was a **no-op in every
sweep test** — nothing could tell an escalated finding from a dropped one. Wired, with a positive
control beside the new negative one.

### The report the scheduler computed and threw away

`isEmptyScope` read `tailSequence === null && (anchors === null || anchors.checked === 0)`. This
increment made `checked` the number of rows **examined** — readable rows only — so `checked === 0`
stopped meaning *there were no rows* and started coexisting with `unreadable.length === 1`, while
the clause went on reading the new figure with the old meaning. `skipped_empty` is the one outcome
from which nothing escapes: the scheduler pushes it and `continue`s past `onPass`, `onFinding`,
`record` and `escalate`, so the verdict was computed, found `compromised`, and discarded — not even
`formatIntegrityProof` ran.

Reproduced end to end as the non-owner `serving` role on PG 16.13, both arms, by rebuilding the
binary with and without the fix. One `meta.audit_log` row with `operation = ''` (`text NOT NULL`, no
CHECK) for a scope holding no chain entries:

| | before | after |
|---|---|---|
| outcomes | `["skipped_empty"]` | `["proved"]` |
| callbacks | none | `onPass`, `onFinding`, `record`, `escalate` |

`readEveryRowFound` is the third conjunct and it asks **all three** refusal axes rather than the two
this was found through. `chain.signatures.unreadable` cannot fire as the code stands — `tail()` reads
raw columns, so a chain holding any row answers a non-null `tailSequence` and never reaches here —
and it is asked anyway, with the reason at the predicate: an unfireable axis can only turn a skip
into a proof, which is the direction this function must fail in, while an axis omitted on the
strength of what a read one layer down happens to do today is this same defect again the day that
read starts parsing.

### The sev1 whose durable record named nothing

The escalation's anchored audit row carried `after: {verdict, truncated, tampered}`.
`integrityVerdictFor` has five `compromised` branches and that row named two, so a paging sev1
driven by either new axis read `truncated: false, tampered: []` — asserting the trail was provably
altered and naming nothing. This increment added exactly that cause-naming to
`formatIntegrityProof` and `formatChainVerification` and left the durable row alone.

It carries `chain: {ok, integrityValid, brokenAt, signaturesValid}` and
`unreadable: {chainRows, auditRows}` now, each a count with its identities. Four decisions:

- **Counts and identities only, no `detail`.** An identity is a business key, which is what a `WHERE`
  clause and a remedy need, and it is the one column of a refused row of established provenance.
  `unreadableDetail`'s non-zod arm passes a mapper's own `Error.message` through on a convention
  nothing fences — ADR-0367 found that convention failing in four of six refusal strings, one of
  them an id — so a log line may carry it and a durable, anchored, chain-committed row may not.
- **Two lists and not one**, because they are different tables with different identity namespaces (a
  `meta.audit_log` id against a chain sequence number), and merging them hands an operator a list
  they cannot act from. Deliberately no third list for the chain *half*'s own refusals: in bounded
  mode they are a subset of the whole-chain read's and in full mode the same read, so it would be one
  fact under two names, and that it fired arrives as `integrityValid: false`.
- **A cap of 20 with the full count beside it.** `anchors.unreadable` is bounded by `auditRowLimit`,
  which the store clamps at 500; `chainRowsRefused` comes from a whole-chain read and is bounded only
  by the chain, so uncapped a scope whose entries the contract refuses writes its entire chain into
  one JSONB column, inside the escalation path, at the moment the deployment can least afford it. The
  count is the whole figure and the identities are the first of them, so `count > identities.length`
  is how a reader sees the cap with no flag to interpret. *First* means the first its own read
  returned, and the two reads are ordered oppositely — `loadChain` ascending, so the chain names kept
  are the earliest, which is where `brokenAt` points and so where a remedy starts;
  `listAnchoredForScope` descending, so the audit names kept are the most recent, which is the half
  of a trail an operator is asked about first. What matters is that the slice is defined **by the
  read** rather than chosen here, so two passes over unchanged rows name the same identities.
- **All five branches named, not four.** `!chain.ok` was unnamed too, and stopping at four would have
  left ADR-0286's oldest cause as the one that explains nothing.

The payload is the free-form audit `after` and **not** the verdict's signed bytes:
`integrityVerdictPayload`, `StoredIntegrityReportSchema`, `canonicalStoredReport` and
`storedReportFrom` must move together or the stored report stops being byte-identical to its
committed payload, which is the trap ADR-0371 reverted a field out of. None is touched.

### The detail that quoted the row

`unreadableDetail` exists so that no stored value travels into a log line, an HTTP body or an
incident note — and `path.join(".")` is a **disclosure**, because a path component is not always a
field name. For a `ZodObject` it always is: an undeclared key is either stripped or reported as
`unrecognized_keys` at the *parent's* path with the keys in `issue.keys`, which this never prints.
For a `z.record` the component **is the stored key**, and the contract bounds neither the key nor
the value.

Verified live as a non-owner on PG 16.13 through the real `PostgresAccessReviewDecisionStore`, one
hand-edited `meta.access_review_decisions` row — a shape the `jsonb` column takes with no CHECK
against it:

| | detail |
|---|---|
| before | `modifiedGrantAttributes.employee_ssn_123-45-6789: invalid_type` |
| after | `modifiedGrantAttributes.<withheld>: invalid_type` |

and that string is also the text of that store's own `UnreadableRowsError`, so it reaches a caller.

**The measurement eliminated the obvious fix.** A `ZodError`'s own keys are `stack, issues,
addIssue, addIssues, name` — it carries no reference to the schema that produced it — and a
record-key issue is byte-identical to a declared-key one in `path`:
`["grantAttributes", "employee_ssn_123456789"]` against `["actor", "kind"]`, both `string`, with no
marker on the issue. So *render only what the schema declares* needs the schema, which means a
parameter: ten call sites would pass nothing, and an **optional** parameter defaulting to the old
render is the disclosure restored as a default — the shape ADR-0364's addendum and ADR-0371's
`onRefused` exist against. A shape test over the component (identifier-like, bounded) is refused on
ADR-0355's grounds: a record key is *precisely* a plausible field name, so every cutoff is unsound
rather than merely imprecise — `department` and `ssn123456789` are both identifiers.

So the rule is **positional**, and it is what the detail's job actually needs — *which column to
look at*. `path[0]` renders, being the key the mapper's own source names, and every multi-segment
path in the workspace heads a real JSONB column (`meta.audit_log.actor`,
`meta.dr_drill_executions.record`). Every deeper **string** collapses into one `<withheld>` and the
tail stops there, since a record's value may itself be an object. A **numeric** component renders
wherever it sits — an array index is a position, never stored text — so `attestations.0.<withheld>`
still says which element, where bare truncation would say only `attestations`. And `record` stays
distinguishable from `record.<withheld>`: *the JSONB column is not an object* and *a field in it is
wrong* are two remedies.

**The precision lost on declared nested keys is a real cost, and it is paid in the open.** Five
assertions in three packages read `record.<withheld>` and `actor.<withheld>` now, each carrying the
reason at the assertion, and each writes the literal out rather than reading
`WITHHELD_PATH_COMPONENT`, so changing the constant fails there. One of the five was this
increment's own and was **inverted rather than deleted**, because the fact under it — a nested
refusal must still name its column — is still worth pinning.

Two corrections to the brief, both now comments at the code. `AccessReviewItem.grantAttributes` is
the other `z.record(z.string(), z.string())` in a stored shape and is **not** reachable: `rowToItem`
returns a bare object literal typed as the contract and never parses (ADR-0362's class), so it
becomes a live disclosure on the day that mapper is made to parse. And `records.ts`' numeric guard
interpolated `JSON.stringify(value)` — the field alone now, matching the three guards beside it,
pinned across `"000-11-2222"`, `"MRN-1"`, an object and `NaN`; no existing test asserted the value,
so nothing was inverted. The sharpest thing found here is that `audit-log-store.test.ts` had
**already written the rule down** for the neighbouring issue code — *"a JSONB key is as much a
stored value as what it holds"*, about `unrecognized_keys`, whose keys the formatter already dropped
— so the `z.record` case was the hole beside a test that stated the principle.

The **third** copy of the try/catch loop went with it. `readRequestRows` is `readRows` now and
`requestIdOf` is deleted, having been byte-identical to `textIdentity(row, "request_id")` — a fourth
spelling of that predicate — and the twelfth rule reported its own declaration **`overtaken`** the
moment the migration landed, which is the forcing function working rather than a list going stale.
And `chain-log-store.ts`' comment said `INTEGER` where the column is `BIGINT`, which is the whole
reason `numericIdentity` has two arms: node-postgres returns a `BIGINT` as a **string** and an
`INTEGER` as a number (measured on PG 16.13: `select 7::bigint` → `"7"`), so the identity arrives as
a string and it is the string arm that reads it. The comment cited the one shape that column never
produces, and nothing failed either way — which is why it survived.

### The pack certified over a page it could not read

This increment's own open question 3, closed, and it is ADR-0372's class reintroduced one layer in
**by the increment that stopped the throw**: a DR readiness snapshot is now recorded over the
*readable* subset, so `resilience.dr_readiness` read `satisfied` with the summary *"DR readiness:
READY (0 issues)"* while the refused row sat in a `console.error`. The test that pinned it asserted
`ready: true, totalIssues: 0` and named no consequence, so it read as a documented trade-off rather
than a live gap.

`DrReadinessReport.unreadableEvidenceAxes` is a **sibling of `unevidencedAxes`, not an eighth
count**: the seven are projected `INTEGER` columns a reader sums, the per-row figure already reaches
an operator through `onUnreadableExecution`, and a count here would be a second place for it to
drift. Four decisions:

- **Typed over all five axes**, not the two with a store read. `failovers`-as-unevidenced is
  *meaningless*, which is why ADR-0372 narrowed that one; `backups`-as-partly-unreadable is merely
  *unproduced*, since `meta.backup_records` is catalogued with no writer — so narrowing would refuse
  a legitimate future value and cost a vocabulary migration. The load-bearing narrowing stays at the
  call site that knows, `UnreadableDrExecution.axis`.
- **Nullable, with no `[]` default**, and the counter-argument is recorded rather than dismissed:
  pre-ADR-0373 snapshots *provably* read completely, because a refused row threw before `record()`
  was reached, so `[]` would be true of every one of them. Refused anyway — that proves something
  about one producer at one commit while a default applies on every parse for ever (hand-edited rows,
  later producers), and the premise is the behaviour this increment removed, so the population is
  closed. On the *input* side absence does mean `[]`, with its own reason: three of the five axes are
  config literals with no read behind them.
- **It rides on `DrReadinessInput.evidenceRead`, not a second parameter** — and ADR-0372's own type
  fence is what decided that. A `readonly DrReadinessAxis[]` member of `DrReadinessInput` makes the
  alias circular (measured: `TS2502` + `TS2456`), because every list-valued member of that input
  **is** an axis by the type's definition. That fence was right, and it also located the field: the
  lifecycle is two hops from `assessDrReadiness`, so a parameter would be two intermediaries that
  could drop the fact — and dropping it reads as *no row was refused*. Riding on the input also
  means **no change in `dr-runtime-pg`**: the report goes whole into the `report` JSONB, pinned by a
  test, with no projected column needed.
- **The guard is in the adapter** (ADR-0372's placement), with its own finding kind
  (`axis_evidence_unreadable`) and its own unknown (`evidence_read_unknown`) rather than reusing
  `axis_unevidenced` — because the two are about the *same control* and must be separable in one
  list: *nobody drilled* and *a drill was recorded and cannot be read* are opposite remedies. The
  unreadable facts **lead** the findings and the summary, since an absent axis leaves the figures
  true about what they measured while a refused row makes them claims about a different row set.

`ready` folds it in too, and the brief's *"`ready` is correct about the readable rows"* was
half-true: ADR-0372 had already made `ready` mean *no issue found **and** the evidence was
complete*. Guarding only the adapter would have left `formatDrReadiness` and the `[dr] readiness`
line saying READY while the control said unevidenced — one process contradicting itself with the
reassuring half on the surface an operator reads (ADR-0361). `totalIssues` is untouched.
`axisClaimFindings` is the list-shaped counterpart to `scopeIsAbsent` now that two of that file's
guarded adapters ask a list-shaped question, folding `undefined` in with `null`, which is the whole
runtime fence given these are structural views; and `DR_VERDICT_UNEXPLAINED_FINDING` gained a fourth
clause or it would again misdescribe its own trigger.

And `formatUnreadableEvidenceAxes` reaches the `[dr] readiness` line, because that line is the
deployed binary's **only** DR-readiness surface — no route serves a snapshot — so a fact computed
into a report no deployment prints is this run's most-found shape. The `onUnreadableExecution`
comment is corrected with it: `unevidencedAxes` still deliberately does not name the axis, and what
has changed is that the callback is no longer the *only* surface such a row reaches.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `unreadableDetail`'s non-zod arm returns `err.message` verbatim, on the stated ground that a mapper's own guard messages name no row value — a convention of exactly the kind ADR-0367 found failing in **four of six** refusal strings, one of them an id. The only honest fence is a text test over the live construction sites with a vacuity floor; nothing inside the module can check it. The addendum found and closed one live member of that class (`records.ts`' numeric guard, which interpolated `JSON.stringify(value)`), which is evidence for the question rather than against it. | platform | 2026-11-30 |
| `AccessReviewItem.grantAttributes` is the other `z.record(z.string(), z.string())` in a stored shape, and `renderIssuePath` closed the one disclosure that was *reachable*. It is unreachable only because `rowToItem` returns a bare object literal typed as the contract and never parses (ADR-0362's class) — so the day that mapper is made to parse, which is the fix ADR-0362 argues for, this becomes a live disclosure that the positional render then handles. Worth knowing in that order. | platform | _informational_ |
| A new required field on `AuditActor` (or any `.strict()` stored shape) now turns every pre-existing row into a paging `sev1`. Whether that wants a declared schema version per stored shape, or a rule that such a field must be `.optional()`, is a contract-evolution decision this increment does not make. | platform | 2026-12-31 |
| ~~`DrReadinessReport` has no field for *this axis's evidence was partly unreadable*~~ — **closed in the addendum** by `unreadableEvidenceAxes`, and it was worse than this question stated: the adapter signed `satisfied` with *"DR readiness: READY (0 issues)"*, so this was not a limitation but ADR-0372's own class reintroduced one layer in. | — | closed |
| `TombstoneAuditPage.unreadable` reaches no escalator: `DeletionEvidenceEscalator.onAuditFinding` takes findings only, so a sweep that cannot read a stored Article 17 proof still has no alarm behind it — the same gap `onRefused` was made required for in ADR-0371. It is reported on the sweep's log line and nowhere durable. | platform | 2026-12-31 |
| `tombstone-store.ts`' `listForTenant` and `findForRequest` still throw. The second is the sharper one: it is `DeletionReconciler`'s *evidence* lookup, where "a tombstone naming the request exists ⟺ that request's deletion committed", so a refused row there is not a missing proof but an unanswerable question. Dropping it would be **worse** than the throw — `found.length === 1` would answer `completed_by_evidence` over a broken premise — and neither existing verdict fits (`ambiguous_evidence` says two tombstones name this; `evidence_unverified` says a record failed `verifyStoredEvidence`), so the honest shape is the pair plus a **sixth** verdict. A verdict decision, not a read one. | platform | 2026-12-31 |
| `UnreadableRowReporter` is now two incompatible exported types under one name — `kernel-pg`'s over `UnreadableRow` and `tenant-lifecycle-pg`'s over `UnreadableRequestRow` — both re-exported with `export *`, with `node.ts` importing from both. The *field* name divergence is argued above; the type name was not noticed, and it is the shape CLAUDE.md records as a finding for `packages/deploy`. | platform | 2026-12-31 |
| `auditRowLimit` bounds the anchor check at the newest 500 rows (`ORDER BY occurred_at DESC`), so a refused audit row outside that window reaches no axis at all. Pre-existing, and worth stating now that `anchors.unreadable` is framed as *the* detector for an edited audit row. | platform | 2027-01-31 |
| Nothing fences a consumer that reads `.records` and drops its sibling `.unreadable` — one level up from a conversion, so outside the twelfth rule by construction. The direction is established and a count is not: one pass over production sources gets 50 reads of `.unreadable` against 45 of `.records`, another 57 against 50, depending on a filter neither states. | platform | 2027-01-31 |
| The remaining non-sweep members are declared rather than fixed. Whether a route or a scheduler should forward a reporter is a per-surface decision, and the twelfth rule is what keeps the list from going stale. | platform | 2027-01-31 |
| `patchedReadConn` is duplicated across two forensics-pg test files; it belongs in that package's `test-fakes.ts` for the reason `scopeFilter` was hoisted. | platform | 2026-11-30 |
| There are two spellings of *forward the reporter*: positional (`listRecent(scope, onUnreadable, limit)`) and an options field (`loadEngineDefinitions({onUnreadable})`). Both are the primitive's sanctioned shapes and each matches its own call site's existing signature, so neither is wrong — but one spelling is this repo's rule, and nothing decides which. | platform | 2026-12-31 |
| `event-log.ts`' `sequence_number` is still `tx.query<Row>`-asserted, so a string there lands in `WorkflowEvent.sequenceNumber` unchecked. Pre-existing and now declared in a test comment; fixing it is Option G, which rule 9 refuses in its accessor form. | platform | 2027-01-31 |
| `pg-record-reads.ts`' `ROW_FIELD_ALIASES` and `business_key` derivation are load-bearing on `event-log.ts`' `interface Row` — worth knowing before anyone rewrites that mapper, since the rule fails rather than going quiet. | platform | _informational_ |

**The rule's own self-check named a backlog entry as its control**, and that is the most durable
lesson in the increment's tooling: it removed `tombstone-store::scanAll`'s declaration to prove the
fence fires, and failed an hour later for the one reason that is not a regression — the work got
done. It selects *whatever `unmigrated` entry still exists* now, which also means it retires itself
honestly, by failing with a message about an empty backlog, on the day the last one is closed.

**Two notes about the fakes.** All sixteen `auditTombstones` failures in the tombstone slice's
baseline were **one fake returning an array**, not the production code — the kind of signal that
reads as a broken change. And that fake's new shape is a discriminated `ScanRow` rather than a
records-list beside a refusals-list, for a reason worth copying: **the second shape cannot express a
page whose last row is the refused one**, which is the only case the page shape exists for. A fake
that cannot represent the case under test agrees with whatever the caller does.

## References

- ADR-0372 — the three reads this generalises, and the `detail` this corrects.
- ADR-0289 — a parse failure on read is a finding, never something to swallow.
- ADR-0286 — the anchor check is the only detector for an edited audit row.
- ADR-0322 — conclusive versus inferred, which is what licenses `compromised`.
- ADR-0331 — `null` is not `[]`; a claim is not an absence.
- ADR-0351 — an enum member added to no membership list regresses the refinements silently.
- ADR-0362 — a type annotation standing in for a parse; no rule compares a contract field to a catalog column.
- ADR-0367 — a refusal message must not interpolate a record value.
- ADR-0371 — `checked: 0` is a readable figure; a diagnostic belongs where diagnostics are read.
