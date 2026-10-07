# ADR-0344: The seam that could only be asked one question

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0343, ADR-0342, ADR-0341, ADR-0340, ADR-0339, ADR-0336, ADR-0288 |

## Context

ADR-0343 made response redaction answer a per-field `read` policy **per record**. The cost it
recorded for that, first among its own open questions:

> **`AbacEvaluator` has no batch seam**, so a deployment-supplied evaluator that makes a network
> call pays one call per record per page. Bounded by `MAX_PAGE_SIZE`, and for `--abac-policy` each
> call is a map lookup and a string compare; a
> `(inputs: readonly AbacEvaluationInput[]) => readonly AbacOutcome[]` arm would fix it and touches
> all five readers.

The seam is synchronous — `AbacEvaluator = (input: AbacEvaluationInput) => AbacOutcome` — which is
why there is nothing clever to do instead. A promise-returning seam could coalesce after the fact,
collecting calls within a tick and answering them together; a synchronous one cannot. A batch here
has to be **collected before any answer is needed**, which makes "add a batch arm" a question about
each reader's control flow rather than about the type.

Asking it reader by reader is what this increment is, and **three of the things that open question
said are wrong.**

### It does not touch all five readers. It touches one, and the four it does not, do not for three different reasons

`dischargeAbac` has five callers — `rbacCheck` and the four field-level functions in
`packages/auth/src/fields.ts`. Reading their control flow:

| reader | batches | why |
|---|---|---|
| `rbacCheck` | no | one obligation per call; there is nothing to group it with |
| `computeFieldRedaction` | no | callerless and superseded by the classified pair |
| `computeClassifiedFieldRedaction` | **yes** | every obligated field is decided, so the question set is known before any answer is needed |
| `validateWriteMask` | no | first refusal wins |
| `validateClassifiedWriteMask` | no | first refusal wins |

The write masks are the interesting entry, because batching them is not merely pointless but
**wrong**. Both loop the patch fields and return on the first refusing one, so a batch would have
to evaluate every obligated field up front — including the ones after the rejection, whose answers
are never used. That costs more on a surface where the field count is tiny, and it hands the
deployment's policy layer questions whose answers were never needed, which is exactly ADR-0340's
reason that `rbacCheck` consults the evaluator only *after* the role check passes:

> there is nothing to learn from an evaluation when a 403 was already owed, and asking hands the
> deployment's policy layer a principal it has no business seeing

`computeFieldRedaction` is the classification-unaware original, which CLAUDE.md has recorded as
callerless and probably deletable since ADR-0339. Giving it an arm would equip dead code and leave
the two read paths with different costs for no reader's benefit.

So **one** existing reader takes the arm, not five and not two. Two *functions* end up using it,
because that reader gains a plural sibling below — but that is a consequence of the design and not
a count of the readers, and conflating the two is how the "all five" estimate was reached in the
first place.

### The shape is not `(inputs) => readonly AbacOutcome[]`

A bare positional array of outcomes makes one class of implementation bug invisible, and it is the
likeliest one: a batch that returns the right **number** of **valid** outcomes in the wrong
**order**. Every element of such an answer is a legal answer to some question in the set, so no
amount of validating the outcomes can detect it, and roughly half of a permutation *allows*. It is
a silent mis-authorization in the one code path whose job is to be fail-closed.

The realistic way to produce it is not a deliberate reordering but an implementation that resolves
its questions into a map keyed by policy key and returns that map's values — which collapses
duplicate keys and discards the question order outright. A page of fifty records asking the same
policy key fifty times is precisely the input that triggers it, and it is the input this seam exists
for.

So an answer carries the position of the question it answers:

```ts
export interface AbacBatchAnswer {
  readonly index: number;
  readonly outcome: AbacOutcome;
}
```

For a correct implementation — `inputs.map((input, index) => ({ index, outcome: evaluate(input) }))`
— the index is pure redundancy. **That is its whole job.**

### The fan-out is records × fields, not records

"One call per record per page" understates it by a factor of F. The per-record pass calls
`computeResponseRedaction` once per record, and *that* calls the evaluator once per obligated field.
A batch collected inside one record takes N×F to N; the stated target needs the pool to span both
axes, which is why the plural entry point is in the contracts package rather than only in the
gateway.

## Decision

**`evaluateBatch` is an optional sibling of `evaluator`, never a replacement, and the two readers
with a fan-out pool every question into one call.**

### The seam

```ts
export interface AbacBatchAnswer { readonly index: number; readonly outcome: AbacOutcome; }
export type AbacBatchEvaluator =
  (inputs: readonly AbacEvaluationInput[]) => readonly AbacBatchAnswer[];
export interface AbacBatchRequest {
  readonly policyKey: string;
  readonly context: Omit<AbacEvaluationInput, "policyKey">;
}
export function dischargeAbacBatch(
  requests: readonly AbacBatchRequest[],
  evaluator: AbacEvaluator | undefined,
  batch?: AbacBatchEvaluator,
): readonly AbacDischarge[];
```

`AbacEnforcement` gains `evaluateBatch?`. `AbacBatchRequest.policyKey` is **required**, unlike
`dischargeAbac`'s parameter: "there is no obligation" is expressed by not making a request, so the
result has no `null` arm either.

`dischargeAbacBatch` returns one discharge per request, positionally aligned, and its rule order is
the contract:

1. **No requests → `[]`, and neither function is called.** Two reasons, and the second is the one
   that is easy to state backwards: a deployment's policy service must not be woken for nothing,
   **and** an empty answer must not count as a validated one. `length !== inputs.length` compares
   `0 !== 0` and *passes*, so an empty batch is trivially aligned — returning before the call is
   what stops that vacuous pass standing in for a check.
2. **No `evaluator` → every discharge `undischargeable`, and `batch` is not called either.** This is
   the sibling rule enforced. Four of the five readers ask one question at a time — `rbacCheck`, the
   two write masks, and the callerless `computeFieldRedaction`, which loops `dischargeAbac` per
   field — so of the three that are reachable, none can use a batch. A seam carrying only a batch is
   therefore half-wired: every entity-level obligation in that deployment would already be answering
   `undischargeable`, and the one reader that *could* use the batch refuses rather than enforcing a
   policy the rest of the deployment cannot.
3. **A request whose principal's attributes were never resolved is `undischargeable` and is excluded
   from the array handed to the evaluator**, exactly as `dischargeAbac` refuses it before calling one
   (ADR-0341). So a batch evaluator receives only questions it could answer, and its length is the
   number of those rather than of the requests.
4. Every request excluded → return without calling anything.
5. With `batch`, one call. Without it, `dischargeAbac` per askable request — exactly today's
   behaviour and today's cost.

Every discharge starts `undischargeable` and is only ever overwritten by an answer, so each refusal
above is the **absence of a write** rather than a branch that must remember to deny.

### Refusal granularity splits on whether the correspondence survives

| fault | refuses |
|---|---|
| the call throws | the **whole** batch |
| the return is not an array | the **whole** batch |
| `length !== inputs.length` | the **whole** batch |
| an element is not an object, or `index !== position` | the **whole** batch |
| an element's `outcome` is outside `ABAC_OUTCOMES` | **that one** |

The line is whether an answer can still be shown to belong to its question. A length or index fault
means it cannot, so honouring the elements that happen to line up would be guessing which — the
prefix of a short array is not evidence that it answers the first questions. An unreadable
*outcome* on a correctly indexed answer is the opposite case: the correspondence is intact and
exactly one answer is unreadable, which is the granularity the single path already has.

A throw is in the whole-batch column for a reason worth stating separately, because the tempting
alternative is to catch per element and refuse only the question that raised. That alternative is
**strictly laxer**: it would leave the other N−1 answers standing as authoritative, when what the
throw says is that the implementation is in an unknown state. Both arms are fail-closed for the
element that threw; only one is fail-closed for the rest. `buildAbacEvaluator`'s own doc comment
had claimed it "never throws", which a pinned test has contradicted since ADR-0342 — a hostile
record whose field is a throwing getter raises inside `resolveScalar` — so the comment is corrected
here too.

Indices must be **exactly ascending** rather than any permutation the reader re-sorts. Re-sorting
would repair an authorization answer whose order the implementation did not intend, silently making
a broken evaluator look correct; refusing says so. And the requirement is free for any
implementation that maps over `inputs`.

### One of the five readers, and no map saying so

`computeClassifiedFieldRedaction` is refactored into **plan → discharge → assemble**, and a plural
entry point pools the requests from every (record, field) pair:

```ts
export function computeClassifiedFieldRedactionForRecords(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  fields: readonly ClassifiedField[],
  policy: SensitiveFieldPolicy | undefined,
  abac: Omit<AbacEnforcement, "record"> | undefined,
  records: readonly (Readonly<Record<string, unknown>> | null)[],
): readonly FieldRedactionResult[];
```

The enforcement parameter is `Omit<AbacEnforcement, "record">` deliberately: it makes supplying the
record twice **structurally impossible**. A plural caller that could also set `abac.record` would
create two sources for one fact and force a silent precedence rule.

There is deliberately **no total map over the five readers.** `ABAC_OUTCOME_ALLOWS` is a total map
because a new enum *member* must be a compile error. These five are hand-written functions, so a map
over them could not make a sixth reader a compile error — it would be a constant nobody reads, which
is the class `packages/testing/src/strategy/pg-unreachable-stores.ts` exists to fence. The reasons
live in doc comments at each of the five sites and in the table above. The residual is stated rather
than papered over: nothing mechanical stops a sixth reader from looping `dischargeAbac`.

### The gateway enumerates records by running its own redactor

The per-record pass needs the records before it can ask about them, and the rebuild needs each
record's answer. Two separate walks of the body — one to enumerate, one to rebuild — is a pair of
definitions that can drift about *which objects are records*, which is ADR-0288's shape. So there is
one definition used twice: `recordsIn(shape, body)` runs `redactRecords` itself with a collecting
`RedactedFieldsFor` that returns the empty set, pushes each non-`null` record, and throws the
rebuilt body away. It is cheap because `redactJsonValue` returns its argument unchanged for an empty
set.

The rebuild then looks each record's set up **by object identity** — the same parsed objects reach
both passes — falling back to the record-free set on a miss. The fallback is unreachable while the
two share one definition and is there because the per-record pass can only ever *relax* the
record-free one, so a miss degrades to the **stricter** answer rather than throwing.

The property is **superset, not equality**, and the asymmetry is the safe direction. `page`'s
rebuild skips any wrapper key the record-free set names, so an entity with a classified field
literally called `data` would stop the real rebuild descending into the array at all; enumerating
with the empty set descends unconditionally. So every position the rebuild can reach was
enumerated — never the other way round — and the worst an over-enumeration costs is one evaluation
for a record nobody asks about. Asserting equality would have been the wrong property and would
fail on exactly that body.

Keying by identity is safe for a second reason worth recording: `JSON.parse` never yields two
references to one object, so a record cannot be aliased on the live path at all. An aliased record
reaching `redactRecords` directly is answered consistently and contributes duplicate cells to the
batch, which is not worth de-duplicating for a case the pipeline cannot produce.

### `--abac-policy` supplies the degenerate batch, deliberately

For a map lookup and a string compare, batching buys nothing: the batch *is* what the absent arm
does. It is supplied anyway, so the branch a deployment with a real batch takes — the validated one,
with the length and index checks — is the branch this repo actually runs, on every per-record
redaction. A seam whose only implementation lives in its own tests is a modelled capability with no
mechanism, which is ADR-0336's finding and the thing this increment would otherwise reproduce in a
new place.

`buildAbacBatchEvaluator(evaluator: AbacEvaluator)` takes the evaluator **instance**, not the policy
map, so the batch is provably that evaluator mapped and the two cannot answer one question
differently. It is **not** exported from `@crossengin/auth`: a generic `batchFromEvaluator` in the
contracts package would let any deployment satisfy the batch arm without batching anything, while a
reviewer reads the wiring as batched.

### The handler path is untouched

`OperateRuntimeOptions.abacBatchEvaluator` exists only to forward to the redaction registry, because
the two readers the handler path uses are `rbacCheck` (one question) and the write mask (must not).
`handlers.ts`, `association.ts` and `write-mask.ts` are not edited.

## Alternatives considered

- **Option A: `(inputs: readonly AbacEvaluationInput[]) => readonly AbacOutcome[]`,** the shape
  ADR-0343 proposed.
  - **Pros:** the simplest possible type; the correct implementation is `inputs.map(evaluate)`.
  - **Cons:** a permuted answer array has the right length and all-valid members, so it passes every
    check that looks at outcomes, and about half of a permutation allows.
  - **Why not:** it is a silent mis-authorization in the fail-closed path, and the realistic bug that
    produces it — answers assembled out of a key-indexed map — is triggered by exactly the input
    this seam exists for.

- **Option B: make the batch the primitive and derive the single arm from it.**
  - **Pros:** one function to implement; no sibling rule, no half-wired state to refuse.
  - **Cons:** `rbacCheck` asks exactly one question and would have to array-wrap it; every
    deployment, including ones with no fan-out, writes array code.
  - **Why not:** it taxes the three readers that can never benefit to serve the two that can, and
    `AbacEvaluator` is the published seam — changing its arity is a breaking change to every
    deployment's policy layer for no deployment's gain.

- **Option C: a promise-returning evaluator with automatic coalescing.**
  - **Pros:** no reader has to restructure; batching happens by itself within a tick.
  - **Cons:** every one of the five readers, and everything that calls them, becomes async —
    `computeClassifiedFieldRedaction` is called from the boot survey and from a synchronous gateway
    stage; `rbacCheck` is called from every handler before any store call.
  - **Why not:** it is a far larger change than the cost it addresses, and it would make an
    authorization decision await I/O inside stages that are synchronous by design. Collect-then-ask
    gets the same call count with no reachability change.

- **Option D: batch inside one record only, leaving the gateway to loop.**
  - **Pros:** no plural entry point in `@crossengin/auth`; the gateway's two-pass is untouched.
  - **Cons:** N×F becomes N, not 1 — a 50-row page still makes 50 calls.
  - **Why not:** it does not answer the open question, which was about the per-record loop.

- **Option E: a total map over the five readers recording which batch.**
  - **Pros:** consistent with this repo's dominant idiom; the reasons live in code rather than prose.
  - **Cons:** the members are functions, not enum members, so the map cannot force a sixth reader to
    appear in it; nothing would read the map.
  - **Why not:** a constant nobody reads with no forcing function is `CALLERLESS_FLAG_STORES`'
    shape — a list written to be a rule's input and never consumed. Prose at each site plus the ADR
    is the honest form of the same information.

- **Option F: re-sort a permuted but index-complete answer array instead of refusing it.**
  - **Pros:** tolerant of an implementation that returns answers in a different order.
  - **Cons:** it repairs an authorization answer whose order the implementation did not intend.
  - **Why not:** a batch that did not mean to reorder has a bug, and silently making it look correct
    hides the bug in the fail-closed path.

## Consequences

- **Positive:** a deployment whose policy layer is a network call is asked **twice per response**
  instead of `F + N×F` times. **Two and not one**, because the pool is per *call* rather than per
  response: the record-free pass goes through the singular `computeClassifiedFieldRedaction`, which
  now routes through `dischargeAbacBatch` as well and so pools its own F cells, and the per-record
  pass pools the remaining N×F. Collapsing the two would mean the first pass knowing what the
  second will ask, which is the thing it exists to discover. With no batch supplied, behaviour and
  cost are unchanged. The plural form also builds the `auth.Principal` and copies `spec.roles`
  **once** per response rather than once per record, which the per-record pass had been doing since
  ADR-0343.
- **Negative:** the seam now has two arms, and a deployment implementing the batch one has a new way
  to be wrong (misalignment) which is refused rather than tolerated. The index echo is boilerplate
  for a correct implementation. The repo carries a degenerate batch that exists to exercise a branch.
- **Neutral:** no flag, no manifest field, no schema change, no table. Nothing in the shipped packs
  declares a record-bearing field obligation, so **no shipped deployment's cost changes** — the
  per-record pass only engages on a deferral, which needs such a policy declared.
- **Reversibility:** high. Removing `evaluateBatch` leaves `dischargeAbacBatch` mapping over the
  single evaluator, which is the pre-ADR-0344 behaviour; the plan/assemble refactor and the plural
  entry point stand on their own and would stay.

## Implementation notes

- `packages/auth/src/abac.ts` — `AbacBatchAnswer`, `AbacBatchEvaluator`, `AbacBatchRequest`,
  `AbacEnforcement.evaluateBatch?`, `dischargeAbacBatch`, and the private `readBatchAnswers` that
  owns the whole-batch-versus-single refusal line.
- `packages/auth/src/fields.ts` — plan/assemble over a per-field `FieldVerdict`, so the three
  properties ADR-0343 pinned are still provable by reading one ordered loop: `readable`/`redacted`/
  `deferred` in field-list order, `deferred` a **subsequence** of `redacted`, and a roles-refused
  field never reaching the evaluator. The verdict is carried on a `PlannedField {name, verdict}`
  rather than in an array the assembler indexes alongside `fields`: under `noUncheckedIndexedAccess`
  a parallel array forces either a non-null assertion or an unreachable arm, which is the thing the
  plan/assemble split exists to avoid. One private `fieldEvaluationContext` is now the single
  spelling of the evaluation context, shared by the planner and `dischargeFieldObligation`, so the
  batching and non-batching readers cannot build different inputs for one grant.
- `packages/api-gateway-runtime/src/redaction.ts` — `computeResponseRedactionForRecords`, `recordsIn`.
  `computeResponseRedaction` and `computeRedactedFields` keep their signatures and behaviour.
- `packages/api-gateway-runtime/src/runtime.ts` — `applyResponseRedaction`'s deferral arm. The fast
  path (`base.deferred.length === 0`) and the reported **record-free** count are untouched.
- `packages/api-gateway-runtime/src/manifest-redaction.ts` — `RedactionSpecOptions.abacBatchEvaluator?`,
  spread onto the spec's `abac` beside `evaluator`.
- `packages/operate-runtime/src/compile.ts` — `OperateRuntimeOptions.abacBatchEvaluator?`, forwarded
  to `redactionRegistryFromManifest` only.
- `apps/operate-server/src/abac-policy.ts` — `buildAbacBatchEvaluator`.
- `apps/operate-server/src/server.ts`, `node.ts` — `abac.evaluateBatch?`, the second genuinely
  optional member of the grouped object beside `attributeDirectory`, for the opposite reason to the
  required ones: its absence cannot make an answer different, only the asking dearer.

### Measured

A manifest with one entity, a `department` field and **three** `pii` fields each carrying
`read: {roles: ["clinician"], abac: "same_dept"}`, against
`same_dept=department:eq_record:department`. Both arms of the seam exercised on the same tree, so
the "before" figure is not a reconstruction — it is the live no-batch path a deployment supplying
only `evaluator` still takes:

| page size | evaluator-only | with a batch | answer |
|---|---|---|---|
| 1 | 6 calls | **2** | identical |
| 50 (`DEFAULT_PAGE_SIZE`) | 153 calls | **2** | identical |
| 500 (`MAX_PAGE_SIZE`) | **1,503** calls | **2** | identical |

"Identical" is checked rather than asserted: `mrn` comes back on exactly the cardiology rows in
both regimes — 1 of 1, 25 of 50, 250 of 500.

What drops is **crossings of the seam**, not evaluations. With `--abac-policy`'s degenerate batch
the 1,503 comparisons still happen, inside one call; for an evaluator that leaves the process the
1,503 round trips become 2. That is the whole point, and it is why the figure to quote is the call
count.

The pipeline fence pins both regimes in the committed suite (N=3, F=2): 2 batch calls of 2 then 6
with a batch, `F + N×F = 8` single calls without one, byte-identical responses and an identical
`content-length` across the two, and the stage reason `redacted_2_fields` — the record-free count —
on both paths. With nothing deferred: one batch call of F, no second call, and the records are
never enumerated.

### Verified live

On the throwaway PG 16 cluster (146 `meta` tables: the catalog's 145 plus `_meta_migrations`), as
the **non-owner** role `app_rw`, one tenant with two memberships holding the **same** role and
different `department`. Four charts, two per department. The mirror is the proof — both principals
hold one role, so what decides is the record:

```
LIST as A (cardiology)                              LIST as B (oncology)
  c1  cardiology  mrn=MRN-C1     insurer=INS-C1       c1  cardiology  mrn=(withheld)  insurer=(withheld)
  o1  oncology    mrn=(withheld) insurer=(withheld)   o1  oncology    mrn=MRN-O1      insurer=INS-O1
  c2  cardiology  mrn=MRN-C2     insurer=INS-C2       c2  cardiology  mrn=(withheld)  insurer=(withheld)
  o2  oncology    mrn=(withheld) insurer=(withheld)   o2  oncology    mrn=MRN-O2      insurer=INS-O2
```

(`diagnosis` behaves identically and is elided for width.)

And the branch taken was measured rather than assumed, by instrumenting both arms in a temporary
`dist` and counting — measure, do not ship; the instrumentation was removed by a rebuild:

```
boot                        0 crossings
GET /v1/charts?limit=10     2 crossings:  3 inputs, then 12   (4 records × 3 fields)
GET /v1/charts/{id}         2 crossings:  3 inputs, then 3    (1 record × 3 fields)
single-arm crossings        0
```

Boot making **zero** crossings is worth recording, because it is what attributes the figures: a
first run showed four crossings for what looked like one request, and the extra two were the
readiness probe, which is itself a list.

Two comments were corrected in passing, both false and both found by reading rather than by a test
failing. `buildAbacEvaluator`'s claimed that "the evaluator never throws" while a test has pinned
the opposite since ADR-0342. And the `inputWithRecord` test helper justified its conditional spread
with `exactOptionalPropertyTypes`, which is **set nowhere** in `packages/config/typescript` — so
`{record: undefined}` typechecks, every reader compares `record === undefined`, and the two shapes
are indistinguishable at both levels. The conditional spread is the right style here and is used
throughout; it is a convention, not a compiler rule, and it was cited as a rule in exactly one
place.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A permuted *outcome* list with ascending indices is still accepted; only a reordered answer list is caught. Is there a cheap check for the former? | Platform | — |
| `rbacCheck` remains one question per call, so a handler path with several obligations in flight (an entity grant plus a field mask on one request) still asks separately. | Platform | — |
| Entity `list` still cannot carry a record policy, and the honest shape for it is row filtering — a different feature (ADR-0343 Q2). | Platform | — |
| The degenerate batch in `abac-policy.ts` exists to exercise a branch; if a real batch producer ever lands, it should replace rather than join it. | Platform | — |

## References

- ADR-0343 — per-record response redaction, and the open question this closes.
- ADR-0342 — the `deferred` outcome and `ABAC_RECORD_AVAILABILITY`.
- ADR-0341 — `Principal.abacAttributes` as `Record | null`, refused before the evaluator is called.
- ADR-0340 — `dischargeAbac` as the one evaluator call site, and the role-check-first ordering.
- ADR-0336 — a capability reachable by no deployment.
- ADR-0288 — a hand-maintained list with no forcing function.
