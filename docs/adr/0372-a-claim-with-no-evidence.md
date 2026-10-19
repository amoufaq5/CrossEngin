# ADR-0372: A claim with no evidence, and a fact with no claim

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-19 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Phase** | 4 |

## Context

This increment came out of measuring the register rather than reading it. A nine-cluster read-only
audit re-derived every open item against the committed tree, and three of what it found were not in
the register at all. They read as unrelated — a disaster-recovery control, a GDPR deadline, a
backup disposition — and they are one class, which has two faces.

**A claim with no evidence.** `assessDrReadiness({now})` with no inputs answers
`ready: true, totalIssues: 0`, and `evidenceFromDrReadiness` signs that `satisfied` with the summary
*"DR readiness: READY (0 issues)"*. The cause is not a missing backup check: every count in that
report is derived by **filtering** a supplied list, so an empty list contributes zero issues on
every axis, and a deployment that has recorded no backup, no drill and no runbook is certified
disaster-recovery-ready.

**A fact with no claim.** `GdprDeletionRequestSchema` refused `completedAt > deadlineAt`, so a
deletion finishing one second past its Article 12(3) deadline destroyed the tenant's data, wrote the
tombstone, **committed** the row `completed` — and then threw on the read-back, because the parse
sits on the far side of the commit. `read()` then answers 500 for that row for ever, and
`completedWithTombstone()` throws inside its own `.map()`, so one such row stops
`DeletionReconciler.auditCompleted` auditing every other completed request. And a deployment that
takes Postgres backups had no disposition that was both runnable and true: `erases` and `retains`
keep the subsystem in scope and nothing in this binary can attest for backups, so every deletion
refuses; `absent` is the only runnable value and it signs *"this deployment does not take backups"*
inside a cryptographic proof.

**The repo already states the rule for the first face, in the file where one of the two members
lives.** `packages/certification-runtime/src/evidence.ts:81-96` carries a nine-line comment arguing
that a falsely-**true** control *"is not a cost but the compliance failure itself"*, and ends: *"So
zero scope is `scope_absent`, never satisfaction: an absence of evidence is not evidence."* It
implements that for encryption coverage. Forty lines below it, in the same file, the DR adapter does
the opposite. ADR-0337 wrote the rule and applied it to the member it had found.

And ADR-0371's rule — **absent is not the same fact as checked-and-found-nothing, and absent must
not license the claim** — had a second door one package down, which the audit of ADR-0371 found
rather than its use.

The second face is the register's own P2.13 stated outright: *the one fact a regulator asks for is
the one the table cannot hold.*

### What the grade was, and what it is

The DR finding was first reported as a live P0 and it is not. An adversarial pass over the audit's
own verdicts refuted that grade on the discipline the same audit had applied one item earlier: the
control is unreachable on any shipped deployment two ways. `drReadinessSource`
(`apps/operate-server/src/certification.ts:130`) does `if (latest === null) return []`, so with no
stored snapshot the control is **unevidenced** rather than satisfied; and writing a snapshot needs
`--dr-readiness-config` while surfacing it needs `--certification-config`, neither of which is among
the shipped compose's 18 distinct api flags. It is a P2-grade latent defect by the register's own
tier test.

That reordering is why the work is still here rather than deferred: ADR-0371's rule is that **a flag
cannot be defaulted on while the thing it records can be vacuously true**, and register P0.3 — the
increment that decides which background flags a reference deployment defaults on — is next. The
guard has to precede it.

## Decision

### Part A — the DR readiness report names the axes it had no evidence on

`DR_AXIS_EMPTY_MEANS` is a frozen total map over the **five** list-valued members of
`DrReadinessInput`, to `"unevidenced" | "nothing_happened"`. Its key type is derived from the
interface itself (`NonNullable<T[K]> extends readonly unknown[]`), so a sixth list input is a `tsc`
failure naming it — verified, `TS1360`. `tierSpecs` falls out by construction: it is configuration
rather than a record of anything, and it has a default.

**The asymmetry is the whole content.** `failovers` is `nothing_happened`, because an empty failover
list is the *claim* that nothing failed over — a fact about the deployment, and the healthy case —
while an empty drill list means nobody drilled, an empty backup list means nobody recorded a backup,
and an empty replication list means lag was never measured. Four absences of evidence and one
evidence of absence. Getting that backwards would make every healthy deployment report a finding.

`unevidencedAxes` is `z.array(DrEvidenceAxisSchema).nullable()` with no default on the output type:
three-valued, where `null` is a report written before this check existed, `[]` is the signed claim
that every axis carried a record, and non-empty says which did not. A `.default([])` would
retro-assert the claim over every stored row, which is the falsely-true direction (ADR-0331's
claim-versus-nobody-looked, ADR-0371's `anchor_provenance_absent`).

`ready` becomes `counts.totalIssues === 0 && unevidencedAxes.length === 0`.

**`totalIssues` does not change meaning, and that is load-bearing rather than tidy.**
`meta.dr_readiness_snapshots` projects each of the seven counts as its own `INTEGER` column under a
`>= 0` CHECK, and a reader sums them. An unevidenced axis is a separate axis and **not an eighth
count**, so `ready = false AND total_issues = 0` is precisely *"nothing wrong was found because
nothing was looked at"*, and the column beside it says which axes.

### Part A2 — the fourth zero-scope adapter, which an adversarial pass found in the same file

`evidenceFromAccessReviewEvidence` sits forty lines below the DR adapter and has the identical
shape, and this one is the **sharpest of the four**, because it is reachable from the shipped
producer rather than from a hand-edited row.

Measured end to end through the real functions: a finished campaign with no items compiles
`totalItemsAcrossCampaigns: 0, completionRate: 1`, seals to a contract-valid `sealed` record, and
the control answered `satisfied: true` with the summary **"soc2_type2 access review sealed at 100%
completion"** and an empty findings list — a SOC 2 evidence pack certifying that access was
reviewed, over zero reviewed items. `completionRate` was the only quantitative gate and `1 < 0.95`
is false, so nothing in the adapter could see the scope. There is no zero-item refusal among
`compileCampaignEvidence`'s six, and **the repo's own test is titled "compiles an empty finished
campaign at 100% completion"** — a fifth test pinning the state this increment corrects.

The structural tell is the same one ADR-0337 and Part A both answered: the field that would let the
adapter see its scope was missing from the structural view. `AccessReviewEvidenceLike` declared
`framework`, `status`, `sealedSha256` and `completionRate`, and no item count.

Two decisions carry it. `totalItemsAcrossCampaigns` is **required** on the structural view, on
ADR-0338's and ADR-0361's argument that a default which cannot possibly be correct fails silently in
the unsafe direction — so the compiler asks, and the one reader already holds the record. And the
guard belongs in the **adapter** and deliberately not in `computeCampaignEvidenceMetrics`, whose
`completionRate: 1` is a division guard: changing it would move every stored pack's rates and so the
sealed digest computed over them, which is ADR-0332's quantise-in-the-producer rule read the other
way. *The metric is right; reading it as a measurement over an empty scope was wrong.*

`ACCESS_REVIEW_SCOPE_ABSENT_FINDING` carries the **same `scope_absent` kind** as its encryption
sibling rather than a third spelling, because it is one class — *this control was asked over an empty
scope and so certified nothing* — and sharing the kind is what lets a reader of a stored report
answer *"which controls were satisfied over nothing?"* with one filter. The two are told apart by the
`sourceKind` on the evidence that carries them, which is already how a reader reaches a finding.

The `forensic_chain` adapter is the fourth of the four and is **not** in this state, for a reason
worth recording: it is guarded **at the source**, by
`if (entries.length === 0) return []` in `apps/operate-server/src/certification.ts`, under the
comment *"a valid-by-vacuity empty log must not read as a satisfied control"*. So guarding at the
source is a legitimate answer to this class, and the census is now four adapters with four answers
rather than three fixes and a hole.

### Part B — a late Article 17 completion is representable

The `completedAt > deadlineAt` refusal is **deleted**.

**The refusal was the defect.** Nothing in the system prevents a late completion — how long an
erasure takes is not something a schema can refuse — so the refinement did not prevent the breach,
it destroyed the evidence of it, after the erasure had committed.

`isCompletedLate(request)` makes the fact legible instead, with **no clock parameter**: both operands
are stored, so the answer is a property of the record rather than of when it is asked, and a `now`
would invite a settled historical fact to drift. `isOverdue` gained its first doc comment naming it,
so the pair is total over the statuses that can breach, with `rejected` the one terminal status
neither reports.

**No migration is owed**, and that is the proof it was purely a contract defect:
`META_GDPR_DELETION_REQUESTS` carries no table-level `constraints` array and none of its seven
column CHECKs mentions `completed_at` or `deadline_at`. The database always accepted a late
completion. That is exactly why the row committed and only the contract refused it.

### Part C — the parse moves off the far side of the commit

`DeletionRequestCommittedUnreadable` is thrown by `transition` when the read-back parse fails **after
the transaction has committed**. Its name, its message and its `committedStatus` all lead with the
commit, because that is the entire information the caller needs and the thing a bare `ZodError`
cannot carry. The rule is stated at the throw site: **a read-back that cannot be represented must
not be reported as a write that did not happen** — the two have opposite remedies.

`DeletionRequestRefused` gained a doc saying it means the write did **not** happen, which is why it
is not the vehicle, and `completed_unrecorded` keeps its meaning for the case it is actually about: a
transition that threw *before* committing.

There is deliberately **no sixth run outcome**. `completed` is *true* of this path — the deletion
happened and the request is in the status it names — and a sixth member would have to be answered by
`needsReconciliation`, whose honest answer is `false`, so it would change no behaviour while reading
to an operator as a new failure mode. The condition stays visible twice over: `detail` is non-null
where an ordinary `completed`'s is null, and the row keeps being named by every
`completedWithTombstone` sweep.

**And one unrepresentable row no longer stops the sweep.** One private `readRequestRows` applies the
rule for all three list methods. `UnreadableRequestRow` carries exactly two fields — `requestId`
(`string | null`, never an invented handle) and `detail` — and deliberately **no `tenantId`**:
every other column of a row the contract refused is of unestablished trustworthiness, so handing one
back invites an operator to scope a manual fix by the value that may be the reason it was refused
(ADR-0310's rule about what a finding may carry).

The reporter is a **required parameter before the optional `limit`**, not a constructor option. The
three methods have three different audiences — a scheduler, an HTTP route, an audit sweep — which
one callback on the store would merge; and required means the compiler names every call site when a
method is added, where a constructor-level reporter would let a new method inherit one nobody chose.
A reporter defaulting to *drop it silently* is the defect restated as a default (ADR-0364's
addendum, ADR-0371's `onRefused`).

### Part D — `present_not_erased`, the fourth deletion disposition

`present_not_erased` says: this deployment **has** the subsystem, it holds the tenant's data, and
this deletion did not erase it. It leaves the attester requirement and **it is not silence** — that
is the whole argument. `absent` leaves scope because the subsystem is not there; this one makes a
positive signed statement that the data **is** there. It is ADR-0317 inverted, not an instance of it.

- `requiredSubsystemsFor` reads a total map `DISPOSITION_REQUIRES_ATTESTATION` rather than a widened
  `!==`, so a fifth disposition is a compile error at the one place that decides.
- `absentSubsystemsFor` keeps its exact `=== "absent"` filter, with a doc saying that widening it to
  *everything that did not attest* would recompute the same false claim; `unerasedSubsystemsFor` is
  the second reading, because *we have none* and *we have it and did not erase it* lead to opposite
  actions (ADR-0331).
- Both pipeline-performed subsystems refuse it, through a 2×2 over two small total maps rather than
  four copied `addIssue` blocks, with its own sentence distinct from `absent`'s.
- `CONSERVATIVE_DELETION_CAPABILITIES` is deliberately **unchanged**: the fourth disposition is a
  *claim*, so putting it on the four unperformed subsystems would make that constant assert the
  deployment *has* object storage, backups, search indexes and caches — a false statement in the
  other direction. What makes the constant conservative is that it refuses rather than claims.

**The byte shape is unchanged, so no content tag moves — and that is measured, not argued.** A
pristine `git archive HEAD` copy of the package and the working tree, side by side, assembling the
same tombstone with `backups: "absent"`, produced identical digests:
`contentManifestSha256 = b1f849fd4f41d7ea12e0d3c0b3e62ef1b213a8ec9260da06e16e51acf32dc4fb` and
`proofSha256 = 56c9b8bee80ac28af20647fe2f0d2ab82da2aa91cdf3b75b23cb8c09f3f093d7`, both verifying,
`proofVersion` v4. Better than that argument: `tombstone-proof.test.ts` is **unmodified** and holds
literal 64-hex pins for v1–v4 content and proof digests, and all 135 of its tests pass after the
widening. What changes is forward compatibility in one direction only: an older binary's `z.enum`
refuses a newer proof's fourth value. A `reason` or `horizon` field beside the disposition —
*"we hold it for 35 days"*, which is the fact an operator actually has — **would** change the shape
and needs `crossengin.tombstone.content.v5`.

**The only thing in the tree that noticed the change was incomplete was a type fence.**
`tombstones.ts` holds a second, deliberately duplicated `DispositionSchema` (restated to avoid a
module cycle), pinned in both directions by `asCapabilityDeclaration`/`asDeletionCapabilities` so
that *"a disposition added, removed or renamed over there fails typecheck here rather than drifting
into a proof"*. Adding the member to `tombstone-assembly.ts` alone produced exactly two `TS2322`s,
and the one-line widening cleared both. No test, no workspace rule and no runtime check would have
caught `requiredSubsystemsFor` honouring a value the signed declaration refuses — measured as a live
defect, `assembleTombstone` answering `record_invalid: capabilityDeclaration.backups: Invalid enum
value` for the one declaration the member exists to make expressible.

### Part E — ADR-0371's defect had a second door

`PostgresChainLogReader.verifyFromCheckpoint` took a caller-supplied `ChainCheckpoint` of **any**
provenance, loaded the suffix and handed it to `verifyChainSuffix`, consulting `provenance`
**nowhere**. Since `verifyChainSuffix([])` is `{valid: true, brokenAt: null}` by construction, a
stale anchor over a forged prefix read as verified having examined nothing — which is exactly what
ADR-0371 closed in `verifyChainFromCheckpoint`, one package up.

It is callerless outside its own tests, so nothing live was harmed. Three things make it worth
closing rather than noting:

1. **The repo's own tests asserted the open door as a feature.** All three existing tests of the
   method passed `provenance: "unverified"`, and one asserted `{valid: true, brokenAt: null}` over an
   **empty suffix** anchored on it. That assertion is the vacuous claim, pinned.
2. It sits on the auditor-facing reader that `runVerifyChain` and `chain-verify.ts` both construct,
   so the object is in the serving process one call away from reintroducing the unsoundness.
3. **No workspace rule covers it**, because `pg-unreachable-stores.ts` asks which exported *class*
   has no caller and not which *method* — the gap CLAUDE.md already records for
   `PostgresDataKeyStore.destroy`.

It **throws** `ChainAnchorNotVerified` rather than answering `{valid: false}`, and the distinction is
ADR-0371's own refused-versus-error split one layer down: a `false` verdict says *this chain did not
verify* and names where it broke, while the truth here is that the verification could not be
performed, which asserts nothing about the chain. Returning `valid: false` would report a tamper for
a configuration problem, and `reason` is the field a reader would then have to disambiguate from a
real `sequence gap`. The message names the provenance it got, `absent` included, because a row
predating the column is a different fact from one stating `unverified`.

A **backstop** rather than the gate: `verifyChainFromCheckpoint` adjudicates before any reader is
reached, so nothing in the serving binary can meet this refusal — `dischargeAbac`'s shape, and
ADR-0369's `sessionScope` throw kept as a backstop the live path can no longer reach. Not deleted
though callerless, because the fold is the primitive and the fold is sound; what was wrong is that
the name claimed an adjudication the body did not perform, so deleting it would send the next
auditor to re-implement it, ungated.

### Part F — three declarations got a reader

Every part of this increment computed a fact, and two of them would have reached nobody.

`absentSubsystemsFor`, `unerasedSubsystemsFor` and `requiredSubsystemsFor` had **zero callers**
outside `assembleTombstone`, so an operator's only route to discovering what they had declared was a
deletion refusing, or a signed proof saying something they had not meant. Adding a fourth
disposition without a surface would have reproduced this run's most-found shape inside the increment
that names it. `node.ts` prints the three groups at boot and warns by name when `backups` is
`absent` — reported and never refused, because nothing in the process can tell a true `absent` from
a false one. Whether this deployment takes backups is a fact no code here can observe, which is
precisely why the operator declares it.

`formatDrReadiness` and `formatUnevidencedAxes` had zero callers outside their own test, while the
binary's only DR surface printed `ready=false issues=0` — the unexplained pair `readiness.ts`'s own
comment says must never be met. That line names the axes now, **and their remedy**, because three of
the four are hand-typed `--dr-readiness-config` fields each carrying `.default([])`, so a config of
`{"input":{}}` met a permanent `ready=false` with nothing saying which fields to fill. `drills` is
excluded from that advice: it is read from the drill store, so empty there means nobody drilled
rather than nobody declared.

And `GET /v1/platform/deletion-requests/stranded` carries its unreadable rows in the response. Once
a bad row stopped escaping the store's `.map()`, that page went **short and still looked complete**
— on the one route whose audience is hunting exactly those rows. `unreadable` is always present and
`[]` is the claim that every row in the window could be represented, because an absent field reads
as *none* and is indistinguishable from *nobody looked*. The audit row carries both counts, and the
503 beside it lost a sentence that had become the wrong diagnosis: it said *"a stored deletion
request could not be read"*, which was true when one bad row threw and describes nothing that reaches
that catch now.

## Alternatives considered

**A backup-only guard rather than a per-axis map.** What the register asked for, and it would have
been the member rather than the class — in the increment whose whole subject is that distinction.
Measured: all five of `assessDrReadiness`' list inputs resolve `?? []` and every count filters one,
so four axes were vacuous and not one.

**Counting the unevidenced axis in `totalIssues`.** Simpler, and it breaks the catalog: seven counts
are projected as `INTEGER` columns a reader sums, so an eighth summand would make the stored total
disagree with the columns beside it. The separate list keeps that arithmetic true and makes
`ready = false AND total_issues = 0` an explicable pair rather than a contradiction.

**Deriving `DR_EVIDENCE_AXES` from the map at runtime** (`Object.keys(...).filter(...)`), which the
brief asked for. Refused on measurement: the derived form made `@crossengin/testing`'s
`pg-value-set-domains` rule fail, because that rule resolves an exported `z.enum`'s members by
reading them and reported `@crossengin/dr-runtime:DrEvidenceAxisSchema` in its `unresolved` bucket,
which it refuses to carry. It also needed a non-empty-tuple cast asserting what it could not show.
The literal tuple is `as const satisfies readonly DrEvidenceAxis[]`, the house idiom at six existing
sites, and the map remains the single statement of which absence is which.

**Keeping the late-completion refusal and making the store not throw.** Rejected: it keeps a fact
that happened unrepresentable, which is the register's P2.13 class, and it leaves `isOverdue`'s
answer for a completed request the only thing a reader has.

**Moving the parse inside the transaction.** It *is* possible — `conn.transaction` rolls back in its
catch — and must not be done: on the `completed` path the tenant's data is already destroyed and the
tombstone already anchored, so rolling the status write back would discard the record of a deletion
that happened and strand the request `in_progress` (ADR-0320). The comment at that site states the
trade rather than a false impossibility, because a false impossibility invites the "fix" that
reinstates the defect.

**A `reason`/`horizon` field on the new disposition.** It is the fact an operator actually has and it
changes the declaration's shape, so it needs a fifth content tag. Deliberately not here.

**Deleting `verifyFromCheckpoint`.** Callerless, and `chain-verify.ts` has the gated spelling. Not
taken: the fold is the primitive and it is sound, so deletion would send the next auditor to
re-implement it ungated.

**Returning `{valid: false}` for an unvouched anchor.** Rejected for ADR-0371's own reason: it would
report a tamper for a configuration problem, and `reason` would have to disambiguate it from a real
`sequence gap`.

**A workspace rule asking which exported *method* has no caller.** It would have found Part E. ADR-0337
measured and refused the compiler-API answer to the adjacent class twice (26 s, 1.2 GB,
cross-package symbols resolving into `dist`), and the text-scan form cannot see a method.

## Consequences

- A deployment with no DR evidence reports `NOT READY` and its certification control reads
  **unevidenced** rather than satisfied. Every deployment is in that state today, because
  `BackupRecord` has zero producers — so nothing that was right changes, and the figure an auditor
  reads stops being a false reassurance.
- `resilience.dr_readiness` is in five frameworks' `frameworkRefs`, and
  `certifiable = controls.length > 0 && deficient === 0 && notAssessed === 0`, so `satisfied: false`
  flows through to a non-certifiable report. The fix is consequential rather than cosmetic.
- A GDPR deletion that finishes late is stored, readable and reportable. Its breach is visible where
  it used to be unrepresentable, and the row it used to poison no longer stops the reconciler.
- A deployment holding backups can declare the truth, and its Article 17 proof names the subsystem
  as held-and-not-erased rather than claiming it does not exist.
- `DrReadinessLike.unevidencedAxes` is a **required** field on an exported structural interface, so
  it is a cross-package break by construction. Five sites inside the slice's packages and two
  outside them.
- The `stranded` route's 200 gains a field. A client ignoring it sees the old shape minus any row
  the contract refused.

## Implementation notes

### The catalog column, and why its migration is free

`meta.dr_readiness_snapshots.unevidenced_axes` is nullable `TEXT[]` with no default and no CHECK,
between `drill_breaches` and `report`. No CHECK because an array-containment predicate is not a shape
`check-admission.ts` can probe, and `DrReadinessReportSchema`'s own `z.enum` is the fence — the
argument the `report` JSONB column beside it already rests on. Nullable with no default is the
claim-versus-nobody-looked distinction in the column itself.

Measured on a throwaway PostgreSQL 16.13 cluster: **964 catalog statements executed, 0 failed**, the
column landing as `ARRAY`/nullable in the declared position; re-plan after apply reads
*"nothing to do — the live schema matches the catalog"*. Then an existing deployment reproduced by
**dropping the column with three rows present** — two tenant-scoped and one platform — gives
**1 planned step, 0 unreconciled**, `1 executed / 0 failed`, and a clean re-plan. Free for
ADR-0358's reason: a nullable column with no default and no CHECK has no existing rows to validate
against.

And the three pre-upgrade rows read **SQL NULL**, not `{}`, which is the whole claim-versus-nobody-
looked distinction surviving into the real column rather than only into the schema.

The three states are genuinely distinct in the real column — `{drills,runbooks,backups,replication}`
/ `{}` / SQL NULL — which is what proves the array is bound as an array rather than stringified, and
that `null` is not collapsed to `[]` anywhere in the round trip. `asAxes` maps SQL NULL to `null` and
never to `[]`, with the reason at the function. The column is **derived** from
`report.unevidencedAxes` and never accepted, which is the seven counts' own rule, so the column and
the JSONB cannot disagree.

### Verified live, as a non-owner role

On the same cluster, through the real built functions, as `serving` — a non-superuser with
`NOBYPASSRLS`, because a table's owner bypasses RLS and verifying as the owner proves nothing about
the policies. Seven checks, all passing:

| what | result |
|---|---|
| an estate with no record | `ready=false issues=0 axes=drills, runbooks, backups, replication` |
| the certification control over it | `satisfied: false` — unevidenced, not satisfied |
| a completion **one second** past the Article 12(3) deadline | readable, `status=completed` |
| `isCompletedLate` on it | `true` |
| an on-time completion | `false` |
| `backups: "present_not_erased"` | `required=[tenant_schema, shared_tables]` |
| the two readings of that declaration | `unerased=[backups]`, `absent=[object_storage, search_indexes, caches]` — and `backups` in neither the absent list nor the attester set |

The third row is the one the increment turns on: that record used to destroy a tenant's data, commit
`completed`, and then be unreadable for ever.

### Five tests asserted the state this increment corrects

That is the clearest evidence the class is a class rather than five bugs.

1. `dr-readiness.test.ts` asserted `report.ready === true` under the comment *"No executions + no
   declared infra ⇒ ready, zero issues"* — the config a deployment writes when it has declared
   nothing.
2. `chain-log-store.test.ts` asserted `{valid: true, brokenAt: null}` for an **empty suffix** over a
   checkpoint whose `provenance` was `unverified`.
3. Its sibling asserted the same vacuous clearing from a hand-placed anchor.
4. `deletion-request-routes.test.ts` asserted the recorded figure was `"1 stranded"` over a window
   that also held a row nothing could represent.
5. `access-reviews`' own test is titled **"compiles an empty finished campaign at 100%
   completion"** — the producer half of Part A2, named as the intended behaviour.

Each is corrected with its reason at the assertion, so a later reader meets the argument rather than
a bare change.

### The increment's own class, found in the increment

An adversarial review of the committed work found three things, and two of them are this ADR's
criticism of ADR-0337 aimed back at it.

**The increment did not build.** Making the unreadable-row reporter required — correctly — named
four call sites in `node.ts` plus a structural interface, and the slice's report said nothing else
needed changing, which is true of the *disposition* widening and false of the reporter *whose entire
stated benefit is that the compiler names every call site*. Both packages were green in isolation.
That is ADR-0307's conditional green: per-package tests cannot see it, and the figure that hid it was
a status line scoped to the slice's own packages.

**A fourth zero-scope adapter sat in the same file as the one being fixed**, and it was the worse of
the two: reachable from the shipped producer, where the DR one needs two flags no deployment passes.
See Part A2. The structural tell was identical — the field that would let the adapter see its scope
was missing from the structural view — which is the third time in this increment that the fix was
*add the field the decision needed and never had*.

**The new fact reached no deployment.** `formatDrReadiness` and `formatUnevidencedAxes` had no caller
outside their test, which is this run's most-found shape and would have shipped inside the increment
naming it.

### What the audit refuted about its own findings

Two of the audit's verdicts were overturned by an adversarial pass, and both corrections are in this
ADR rather than quietly applied. The DR finding's **grade** was wrong (see Context). And the
register's P0.4 was reported as dropping its subject at *one* six-field seam; there are **two**
`data_subject_erasure` emitters, the synchronous route admitting the kind with a `.strict()` body
schema carrying no subject field at all. Neither changes this increment's work; both change what the
next one is scoped against.

## Open questions

1. **`present_not_erased` carries no horizon.** *"We hold it for 35 days"* is the fact an operator
   has and what makes ADR-0347's bounded deletion horizon checkable. It changes the declaration's
   shape, so it needs `crossengin.tombstone.content.v5`.
2. **Six further throwing sweeps are unclosed.** `result.rows.map((row) => rowTo…(row))` where the
   mapper ends in a throwing `.parse()`: three in `tombstone-store.ts` and three in
   `lifecycle-event-store.ts`. The tombstone one is the sharper half, because that sweep is what
   ADR-0327 built to find a tampered proof — so one unrepresentable row stops the search for the
   tamper.
3. **The sibling late-notification refusal is not closed**, and it is asymmetric with this one in
   the direction that makes it a bigger job: `incident_communications_breach_window_check` exists in
   the catalog, so the comms fix is a CHECK migration where this was a pure contract edit — and
   dropping a CHECK is a loosening the reconciler refuses without `--allow-loosening`.
   `isBreachNotificationTimely` has zero non-test callers and there is no incident route in the
   binary at all, so it has no reachable writer today.
4. **No workspace rule asks which exported *method* has no caller.** Part E was reachable only by
   reading, and the backstop is what makes the gap not matter for that one member.
   `PostgresDataKeyStore.destroy` is the other recorded instance.
5. **The unevidenced axes are reported, not escalated.** A deployment whose DR control has been
   unevidenced for a year learns it from a log line and a certification report.
6. **Three of the four evidence axes have no durable source.** `runbooks`, `backups` and
   `replication` are hand-typed `--dr-readiness-config` fields with `.default([])` — ADR-0328's
   caller-supplied-scope shape — and only `drills` reads a store. `meta.backup_records` has no
   writer, which is the honest source for one of the three and is declared.
7. **Four of six deletion subsystems still have no attester**, so `present_not_erased` makes the
   declaration honest without making the erasure complete.
8. **`isCompletedLate`'s reach.** A boot or sweep count of late completions wants a
   `deadline_at`-ordered query, which is register P1.8 proper and is fairly left open.

## References

- ADR-0307 — the typecheck overlay, and conditional green
- ADR-0310 — what a finding may carry
- ADR-0317 — a subsystem's silence read as nothing to delete
- ADR-0320 — the record of a deletion that happened
- ADR-0328 — the scope is a deployment declaration, never caller-supplied
- ADR-0329 — `content.v2`, the signed capability declaration
- ADR-0331 — a claim versus nobody looked
- ADR-0337 — a falsely-true control is the compliance failure itself
- ADR-0347 — the bounded deletion horizon
- ADR-0351 — `content.v4`, and `PROOF_VERSION_COVERAGE`
- ADR-0362 — a predicate deciding from a proper subset of the facts
- ADR-0364 — an optional reporter defaulting to "do not count"
- ADR-0371 — an anchor nobody verified
