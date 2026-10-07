# ADR-0343: The refusal that was a wiring problem

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0342, ADR-0340, ADR-0339, ADR-0338, ADR-0336, ADR-0328 |

## Context

ADR-0342 put the record on `AbacEvaluationInput`, made availability part of the contract as
`ABAC_RECORD_AVAILABILITY` over eight grant positions, and **refused three of them at boot**. Its
own open questions ranked one of the three first:

> **field `read` cannot carry a record policy**, which is the most surprising of the three refusals,
> because a per-record field policy is the canonical ABAC example

The reason it recorded for that refusal is this, verbatim from
`ABAC_RECORD_AVAILABILITY_REASONS.field_read`:

> response redaction computes one field set per response and applies it by a generic JSON walk, so
> it cannot identify which record a field belongs to

Reproduced against the committed tree, a manifest with one per-field `read` grant carrying
`same_dept=department:eq_record:department` does not start:

```
fatal: 1 abac-qualified grant(s) name a policy that compares against a field of the record, at a
position where no call site can ever supply one, so each would be denied at every request rather
than evaluated: Chart.read -> mrn requires abac policy 'same_dept' — response redaction computes
one field set per response and applies it by a generic JSON walk, so it cannot identify which
record a field belongs to. …
```

**That sentence is true about the implementation and false about the question**, and the gap between
those two is this increment's class: **a structural refusal that was really a wiring one.**

The repo already had the vocabulary to tell them apart and did not apply it here.
`pg-unreachable-stores.ts` (ADR-0336) splits a blocked store into
`prerequisite_of_unbuilt_surface` — blocked by *ordering*, will be wired — and
`contract_cannot_carry_the_surface` — blocked by *shape*, needs a schema change first — on the
stated grounds that "calling both 'unwired' sends the next person to write the route that cannot be
written honestly". ADR-0342's three `never` positions are exactly those two kinds mixed:

| position | why no record | kind |
|---|---|---|
| entity `create` | the record does not exist until the write commits | **shape** |
| entity `list` | the subject is a row *set*; a per-row answer is a filter | **shape** |
| field `read` | the stage computed one field set for the whole body | **ordering** |

A response to `GET /v1/charts/{id}` *is* the record. A page's `data` array *is* a list of records.
Nothing structural was in the way; the stage simply never looked.

## Decision

**Response redaction is per record, driven by the operation's declared record shape, and the
`deferred` outcome ADR-0342 introduced is what decides whether to pay for it.**

**1. The shape is declared, per operation.** `ResponseRecordShape` is `record` | `page` | `none`,
and `ResponseRedactionSpec.recordShape` is **required**. `record` is a body that *is* one record
(`read`, `create`, `update`, a workflow transition); `page` is `{data: [record, …], page: {…}}` (an
entity `list`, the association list); `none` is a body with no record in it (a `delete`'s 204, the
association `count`, link/unlink).

It is **declared and never probed.** Inferring it from the body — "if it has a `data` array, treat
the elements as records" — is a heuristic in an authorization path, which this repo refuses
(ADR-0328: declared beats probed), and it misreads a record that happens to carry a `data` array.
`compileOperateServer` derives it from `ACTION_RECORD_SHAPE`, a total map over `RouteAction`, so a
seventh action is a compile error rather than a member inheriting `record` — and inheriting `record`
is precisely the unsafe answer, because on a list it would evaluate the policy against the page
*wrapper* instead of a row.

**2. The two-pass, keyed on the deferral.** `computeResponseRedaction` returns
`{redacted, deferred}`, where `deferred` is the fields whose role check passed and whose obligation
answered `deferred` — a subset of `redacted`, and the only fields for which supplying a record could
change the answer. So:

1. compute with **no record** — exactly today's single call;
2. `deferred` empty ⇒ apply today's walk and stop. **Byte-identical behaviour and one evaluation per
   response** for every deployment that declared no record-bearing field policy, which is all of
   them today;
3. otherwise locate the records from the shape and recompute per record.

The deferral *is* the signal. ADR-0342 added that outcome so a call site unable to supply a record
would refuse rather than grant; here the same outcome tells a call site that *can* supply one that it
should. No second declaration listing which fields are record-bearing — which would be a maintained
list beside a derivable fact, this repo's recurring defect.

**3. Every fallback is the stricter set, by construction rather than by care.** The per-record pass
can only ever *relax* the record-free pass, since the only thing that changes is a `deferred`
becoming `satisfied`. So a shape that cannot find a record — a `record` body that is not an object, a
`page` whose `data` is absent or holds a non-object — falls back to the record-free set, which keeps
the obligated field redacted. Fail-closed is the default direction of the algorithm, not an
invariant somebody has to remember.

**4. `ABAC_RECORD_AVAILABILITY.field_read` becomes `always`, and two `never` positions remain.**
Entity `list` stays refused, and the distinction is worth stating because it is the whole reason
these two positions differ: **a field policy filters columns within a row, which a response can
express per record; an entity-list policy would filter rows**, and dropping rows would leave
`page.nextCursor` and any count describing a set the caller was not shown. Filtering rows is a
different operation, not a redaction.

### The property that ends

ADR-0338 recorded that the registry "shares one spec object across all of an entity's operations",
pinned by an identity assertion. That ends here, and it is a consequence rather than a regression:
the shape is a property of the **operation**, so a spec keyed by operation has to carry it. The
sharing that remains — `classifiedFields`, `entityPermissions`, `roles`, the policy and the
evaluator are all the same references — is pinned structurally instead, so what still holds is still
checked.

## Alternatives considered

- **Move per-record redaction into the handler**, which is what ADR-0342's own open question
  proposed ("closing it means per-record projection in the handler, reaching the list and
  association-list paths and `projectRecord`").
  - **Pros:** the handler holds the records as objects, so no re-parse.
  - **Cons:** there would then be two implementations of field-read redaction — the handler's for
    the record-bearing case and the gateway's for everything else — which is exactly the divergence
    ADR-0329 put one function behind both halves to prevent, and which ADR-0339 found had already
    happened once. It also reaches four handler families (entity read, entity list, association
    list, `projectRecord`) instead of one stage.
  - **Why not:** and the premise was wrong. The gateway **already parses the body** for the existing
    walk, so the re-parse is not a new cost; and the record shape is derivable from the action the
    route was built from, so the gateway does not need to guess. This ADR corrects its predecessor
    on that point.

- **Infer the shape from the response body.**
  - **Pros:** no contract change, no producer to wire, works for a registry a deployment supplies
    itself.
  - **Cons:** a heuristic deciding an authorization answer. A record carrying its own `data` array
    would have its elements treated as records and the policy answered against the wrong object.
  - **Why not:** ADR-0328's rule. The cost of declaring it is one required field whose producer is
    a total map over an enum.

- **Declare which field grants are record-bearing on the spec**, instead of reading `deferred`.
  - **Pros:** the two-pass decision needs no change to `FieldRedactionResult`.
  - **Cons:** the spec would have to be told which policy keys need a record, duplicating
    `recordBearingPolicyKeys` into a second place that can go stale — ADR-0288's shape, which this
    repo has found wrong four times.
  - **Why not:** the evaluator already answers the question. `deferred` is derived, not maintained.

- **Always recompute per record**, with no fast path.
  - **Pros:** one code path; no reliance on `deferred` being correct.
  - **Cons:** every deployment pays N evaluator calls per page for a feature none of them has
    declared, and a deployment-supplied evaluator may be a network call.
  - **Why not:** the fast path is where the cost claim comes from, and it is checkable — a test
    asserts one evaluator call for a three-record page when nothing defers.

- **Leave the refusal and make the reason honest** ("the stage does not look yet").
  - **Pros:** zero risk; the boot refusal already names the remedy.
  - **Cons:** the refused position is the canonical ABAC example, and the honest reason would have
    said the platform simply had not done it.
  - **Why not:** ADR-0336's own argument for splitting `prerequisite_of_unbuilt_surface` from
    `contract_cannot_carry_the_surface` is that the first *will be wired*. This is that wiring.

## Consequences

- **Positive.** A per-field `read` policy is enforced against the record the field came from, on a
  single record and on every row of a page independently — so one response can disclose a classified
  field on one row and withhold it on the next. Two of ADR-0342's three boot refusals remain, and
  both are now structural rather than mixed.
- **Positive.** Zero cost where nothing is declared: one evaluation per response, the same walk, the
  same bytes.
- **Negative — N evaluator calls per page** when a record-bearing field policy *is* declared.
  Bounded by the page limit (`MAX_PAGE_SIZE`), and for `--abac-policy` each call is a map lookup and
  a string compare. A deployment-supplied evaluator that makes a network call per record pays per
  row; `AbacEvaluator` has no batch seam, which is the top open end.
- **Negative — the spec is no longer shared across an entity's operations**, so a classified entity
  holds one spec object per response-carrying operation instead of one. Field references are shared,
  so the cost is a small object per operation, not a copy of the classification.
- **Neutral.** `ResponseRedactionSpec` gains a required field and `operationsForEntity` changes
  return type, so a deployment supplying its own `RedactionRegistry` must declare shapes. Required
  rather than defaulted for ADR-0338's reason: a default that cannot be right for every operation
  fails silently in the unsafe direction.
- **Reversibility.** The fast path *is* the old behaviour, so reverting is removing a branch. A
  deployment that declared a record-bearing field policy would then be refused at boot again rather
  than served wrongly, which is the safe way for this to come undone.

## Implementation notes

- `FieldRedactionResult.deferred` is populated by both `computeFieldRedaction` and
  `computeClassifiedFieldRedaction` and means one narrow thing: the role check passed and the only
  refusal is an obligation that needs a record. A field refused on roles, or answered `denied` or
  `undischargeable`, is **not** in it, because re-asking cannot change any of those — `denied` is a
  statement about this principal, `undischargeable` says nothing could answer, and a role refusal is
  not an obligation. The classification-default branch carries no obligation and can never
  contribute. `isAbacDeferred` is the one spelling of the test, shared with `rbacCheck`'s readers.
- The fast path's early return (`redacted.length === 0 → 0`) is still safe and the reason is worth
  the comment it carries: with no record every obligation answers `deferred`, which redacts, so
  `redacted` empty implies `deferred` empty. The fast path cannot skip a record-bearing obligation.
- `redactRecords` dispatches through a total map over `ResponseRecordShape`. On a `page` the wrapper's
  own keys get the record-free set, which preserves today's semantics for `page: {limit, nextCursor}`
  exactly — that part of the body is not a record and never was.
- `redactJsonValue` is unchanged. Its recursive name-dropping is still what applies one set to one
  value; only the choice of set moved.
- `apps/operate-server/src/audit-read-routes.ts` declares `recordShape: "record"` and deliberately
  supplies **no** record and no evaluator, so a record-bearing field policy resolves
  `undischargeable` there and the field stays redacted. Two reasons and the second is the real one:
  that path's "record" is a *historical snapshot* in `before`/`after`, so a policy of the form "only
  on a patient in your department" would be answered against the department the row held when it was
  written rather than the one it holds now — a different question, and the wrong one to answer
  silently.
- The association families carry their shapes directly rather than through an action, and the
  link/unlink pair is `none` even though its *attribution* is the owner entity. Attribution answers
  "whose fields could appear here" and the shape answers "where"; a route can be attributed to an
  entity and return none of its records.

- **`redactableResponseShapes()` exposes `SHAPE_REDACTORS`' own keys** rather than the test listing
  the shapes a second time, so "one redactor per shape" cannot be satisfied by a stale list beside
  the map.
- **The `page` branch drops a wrapper key whose own name is in the redacted set**, `data` included.
  That is not an edge case nobody will hit: `redactJsonValue` already behaves that way for a wrapper
  key named like a classified field, and making `page` the one shape where a redacted top-level key
  survives would be a new disclosure introduced by the fix.
- **A pipeline test for the per-record path has to authenticate**, and this is worth knowing before
  someone writes the next one. An anonymous request has `abacAttributes: null`, and since ADR-0341
  `dischargeAbac` refuses `undischargeable` **before** calling the evaluator on `null` — so the
  obligation never answers `deferred`, the second pass is unreachable, and a test written against an
  anonymous caller **passes vacuously** on the record-free set. The cases go through `x-api-key` +
  an `OpaqueTokenLookup` + a principal resolver returning real attributes, which is the live path.
- **Both halves are mutation-tested**, because the cost claim rests on a call count rather than on an
  output: forcing `deferred.length === 0` to `true` (i.e. the pre-change behaviour) fails 2 tests
  including the per-record page, and replacing `redactedFor(element)` with the base set in the `page`
  branch fails 3 including the two-rows-two-answers headline.

### Verified live

On PostgreSQL 16, as the non-owner role `app_rw`, with two memberships in one tenant holding **the
same role** and different `department` attributes, over
`--abac-policy same_dept=department:eq_record:department` and one per-field grant
`fields.mrn.read = {roles: ["clinician"], abac: "same_dept"}`.

**Before**, against the committed tree, the deployment does not start — quoting the reason this ADR
invalidates:

```
fatal: 1 abac-qualified grant(s) name a policy that compares against a field of the record, at a
position where no call site can ever supply one … Chart.read -> mrn requires abac policy
'same_dept' — response redaction computes one field set per response and applies it by a generic
JSON walk, so it cannot identify which record a field belongs to.
```

**After**, it boots (`1 declared and an evaluator is declared, so each is evaluated per request`),
and one page answers differently per row:

```
LIST as nurse A (cardiology)        LIST as nurse B (oncology)
  card-row  cardiology  mrn=MRN-CARD    card-row  cardiology  mrn=(withheld)
  onco-row  oncology    mrn=(withheld)  onco-row  oncology    mrn=MRN-ONCO
```

The mirror is the part that proves it: the two principals hold the same role, so what decides is the
record and not the caller alone. Also verified: the single-record `read` shape (four combinations,
each disclosing only on the matching department), a **write** response — `POST` returns `mrn` to the
matching principal and withholds it from the other, which is ADR-0338's "a write discloses" closed
per record — and the page wrapper surviving untouched (`page: {limit, nextCursor}` intact beside the
redacted rows).

### Measured

- Seven builtin packs declare zero ABAC obligations, so the position flip changes nothing anyone
  serves today and remains a forcing function later.
- **89 builds, 89 typechecks, 17,065 tests**, all green.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `AbacEvaluator` has no batch seam, so a remote evaluator pays one call per record per page. A `(inputs: readonly AbacEvaluationInput[]) => readonly AbacOutcome[]` arm would fix it and is a contract change touching all five readers. | Platform | 2026-12-31 |
| Entity `list` still cannot carry a record policy, and the honest shape for it is **row filtering** — which changes what `page.nextCursor` and any count mean, so it is a different feature rather than a wider redaction. | Platform | 2026-12-31 |
| A record with a **nested** object gets the record's own set applied to the nested value by `redactJsonValue`'s walk. Correct for the flat JSONB documents entity records are today; unexamined for a nested shape, where the nested object is arguably its own record. | Platform | 2026-12-31 |
| The shape is declared per operation by `compileOperateServer`; a deployment supplying its own `RedactionRegistry` declares its own and nothing checks the declaration against the responses that route actually produces. | Platform | 2026-12-31 |
| `audit-read-routes.ts` could supply the snapshot as the record once somebody decides whether a policy over a historical row is the question a reader is asking. | Platform | 2026-12-31 |

## References

- ADR-0342 — the record nobody could ask about (this ADR closes its Q1 and corrects its claim that the fix belongs in the handler).
- ADR-0340 — the `deferred` outcome's origin and the fail-closed obligation.
- ADR-0339 — one function behind the read and write halves, so they cannot diverge.
- ADR-0338 — the redaction registry's operation keying, and `operationsForEntity` made required.
- ADR-0336 — `prerequisite_of_unbuilt_surface` vs `contract_cannot_carry_the_surface`: blocked by ordering is not blocked by shape.
- ADR-0328 — declared beats probed.
