# ADR-0342: The record nobody could ask about

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0341, ADR-0340, ADR-0339, ADR-0338, ADR-0331, ADR-0336, ADR-0322 |

## Context

ADR-0341 wired the ABAC subject — `meta.user_tenant_membership.abac_attributes` now resolves
once in the auth stage and reaches `Principal.abacAttributes` — and closed its own increment with
the bound it could not cross:

> `AbacEvaluationInput` carries `{policyKey, principal, entity, operation, field?}` and **no
> record**, so "owns this row" and `user.department == record.department` — one of the two
> spellings this package's own tests used — are inexpressible by **any** evaluator here, OPA
> included.

That is this increment's class: **a question the seam could not be asked.** Not a dropped
obligation (ADR-0340), not an unread record (ADR-0341) — the input simply had no place to put the
thing half of all ABAC policies are about.

Measured against the committed tree at `31d2d1e`, built in a worktree, all five readers' evaluator
inputs:

```
rbacCheck input keys        : entity,operation,policyKey,principal
rbacCheck can see a record  : false
field read input keys       : entity,field,operation,policyKey,principal
field update input keys     : entity,field,operation,policyKey,principal
```

### The measurement that shapes the whole design

The obvious fix — put a record on the input — is not the hard part. The hard part is that **no
call site has the record at the moment it currently decides.** `rbacCheck` runs before any store
call in every handler, and the per-field functions run on the caller's patch. Measured per
position:

| position | the record, at the moment of the decision |
|---|---|
| entity `create` | **never exists** — the record is what the write is about to produce |
| entity `read` | loaded immediately **after** the check (`store.get`, `handlers.ts:154`) |
| entity `update` | `before` loaded inside the transaction, **conditionally** (`hasGuards \|\| hasEffects \|\| expectedUpdatedAt`), after the check *and* after the write mask |
| entity `delete` | same, conditionally |
| entity transition | loaded **unconditionally** at the top of the transaction — the cheapest position |
| entity `list` | the subject is a **set**; a per-row answer is a filter, not a 403 |
| field `read` | the gateway computes **one** field set per response (`computeRedactedFields`) and applies it with a generic JSON walk (`redactJsonValue`) that cannot identify a record boundary |
| field `update` | only the caller's patch, before the transaction and before the load |

So availability is not uniform, it is not derivable from the grant alone, and in two cases it is
*structurally* unavailable rather than merely unwired. A design that put a `record?` on the input
and left it at that would have produced a seam that silently answers from `undefined` at five of
eight positions — which, before this change, errs toward **granting**.

## Decision

**Five parts.**

**1. `AbacEvaluationInput.record?`, where absent means *the call site could not supply one*.**
The same distinction `Principal.abacAttributes`' `null` draws (ADR-0341), one level out: not "the
record is empty".

**2. A fourth outcome, `deferred`, mapped to `false` in `ABAC_OUTCOME_ALLOWS`.** An evaluator
whose policy needs a record and is handed none answers `deferred`. It is a **refusal pending a
record**: `allowed: false` with `abac.outcome === "deferred"`, and the only way to turn it into an
allow is to ask again with the record. That direction is the whole safety argument — a call site
that ignores a deferral **refuses**, so a handler nobody taught about the record gate denies
rather than grants. Reporting a deferral as an allow-with-an-outstanding-obligation would have
reproduced ADR-0340's dropped obligation one level up, in a place where the drop is harder to see.
`isAbacDeferred` is the one spelling of the comparison.

**3. Availability is part of the contract, as a total map.** `ABAC_RECORD_AVAILABILITY` over the
eight `ABAC_GRANT_POSITIONS` answers `always` / `sometimes` / `never`, with
`ABAC_RECORD_AVAILABILITY_REASONS` carrying the sentence the boot refusal prints — so the position
a record can reach, the handler that reaches it and the message explaining why it cannot have one
definition apiece. A ninth position is a compile error in two maps, and a reason that restates its
own key fails a shape test.

**4. A manifest declaring a record-bearing obligation at a `never` position is refused at boot by
name** (`record_unavailable`), with no escape hatch, for ADR-0340's reason: an obligation served
with its qualifier removed is the opposite of what the manifest declares. A `sometimes` position —
a per-field `update` grant — is **reported and not refused**, because that is a coherent
declaration whose consequence is real: "you may only set this field on a record that is yours"
genuinely cannot admit a *create*, so the boot line says which fields are not settable at create
and the deployment starts (ADR-0322's rule).

**5. Three record operators on `--abac-policy`, and the subject of the comparison is the
operator.** `eq_record` / `ne_record` / `in_record` read their third segment as a **record field
name** rather than a literal, so `same_dept=department:eq_record:department` is
`user.department == record.department` and `owns=user_id:eq_record:owner_id` is ownership. A
`record.<field>` prefix on the operand was rejected: it collides with a literal that happens to
start with `record.`, so one spec would have two readings and the parser would pick one silently.
`ABAC_OPERATOR_NEEDS_RECORD` is what `recordBearingPolicyKeys` reads and what the boot check is
built from — the declaration decides which keys need a record, because only the deployment knows.

### Where the record is supplied, and the invariant that makes it safe

**Nothing is written before the obligation is discharged.** A handler that sees a deferral may do
exactly one thing before re-asking: load the record. Reads, pure validation and the role half of
the write mask are permitted in between; no `create`/`update`/`remove`, no write guard, no write
effect. Concretely: `read` re-asks after `store.get`; `update` and `delete` **force** the
conditional `before` load and re-ask immediately after it, *before* the 409 and before the guard;
the transition re-asks right after the record it already loads, *before* the from-state 409,
because authorization precedes business logic. Re-asking calls `rbacCheck` again with the record
rather than taking a second code path, so one function decides both times.

### Two refusals argued rather than assumed

**A record-level denial is a 403 and not a 404.** Answering 404 for a record that exists would
make a record-predicate refusal indistinguishable from a missing record — the conflation this repo
refuses between `null` and `{}` (ADR-0331), and between "absent" and "nobody looked" — so neither
the caller nor an operator reading the log could tell "not yours" from "not there". A wrong answer
is worse than a refusal (ADR-0336's `IdempotencyStore.get` rule). The cost is that the caller
learns the id exists; the population that can learn it is already the population holding the
entity-level grant, not the public.

**The association routes refuse a record-bearing obligation, and that is correct for two of the
three and unclosed for one.** List and count answer for a *set*; link/unlink act on an owner
record they do not load. A `deferred` decision lands on the existing `!decision.allowed` 403 path
with no logic change, which is the fail-closed answer — and it is now commented and pinned by
tests rather than left to be rediscovered. Measured: **zero** `many_to_many` relations across the
seven packs, so no manifest can reach it today.

## Alternatives considered

- **Put `record?` on the input and nothing else.**
  - **Pros:** one-line contract change; no new outcome, no availability map, no boot check.
  - **Cons:** five of eight positions would pass `undefined` and an evaluator would have to guess
    what that means. The guess that reads naturally — "no record constraint applies" — grants.
  - **Why not:** it is ADR-0340's defect with a new name. The seam would carry a question that is
    unanswerable at most positions and report the unanswerable case as a pass.

- **Make a deferral an `allowed: true` carrying an outstanding obligation for the handler to
  discharge.**
  - **Pros:** reads more naturally — "the role check passed, one thing is outstanding" — and no
    handler has to know about a refusal that is not really a refusal.
  - **Cons:** a handler that forgets to discharge it **succeeds**.
  - **Why not:** that is exactly ADR-0340 (`requiresAbac` handed back and nothing read it), one
    level up and harder to spot, because here the forgetting is per handler rather than per
    function. `allowed: false` makes forgetting cost a 403.

- **Split ABAC into record-free and record-bearing *kinds* on the grant**, so a manifest author
  declares which kind a key is.
  - **Pros:** the boot check could be answered from the manifest alone, with no policy declaration.
  - **Cons:** the manifest would assert a property of the deployment's policy layer, which it
    cannot know; two deployments can answer one key differently, and a key's kind is decided by
    the comparison the operator wrote.
  - **Why not:** the declaration already knows. `ABAC_OPERATOR_NEEDS_RECORD` derives it from the
    operator, so the fact lives where it is true and the manifest stays a statement about grants.

- **Move per-record redaction into the handler so field `read` could carry a record policy.**
  - **Pros:** closes the one position whose unavailability is the most surprising — a per-record
    field policy is the canonical ABAC example.
  - **Cons:** the redaction stage is operation-keyed and response-shaped by construction
    (ADR-0338), computing one field set per response; making it per record means the handler
    projects every record it returns, which is a different seam and reaches the list path, the
    association list path and `projectRecord`.
  - **Why not:** out of this increment's class, and refusing it at boot is honest where answering
    it from the wrong record would not be. Named as the top open question.

- **A mask mode that treats a deferral as "not yet a refusal"**, so the pre-transaction pass could
  report every role refusal before the 422.
  - **Pros:** preserves ADR-0339's 403-before-422 ordering exactly.
  - **Cons:** a boolean parameter that changes fail-closed semantics, on the function whose halves
    already diverged once.
  - **Why not:** the ordering cost is bounded and statable (below); the parameter would not be.

- **Allow the principal's own id as a left operand** (`principal.id:eq_record:owner_id`).
  - **Pros:** ownership with no provisioning step.
  - **Cons:** the left side is an attribute name, so a reserved spelling would shadow a real
    attribute of that name — the `hasOwnProperty` lesson in a new place.
  - **Why not:** `owns=user_id:eq_record:owner_id` expresses it today when the deployment writes
    the user's id into their membership attributes, which `--platform-user-routes` already does.
    Named as an open question.

## Consequences

- **Positive.** A record-bearing ABAC policy is expressible, enforced at five positions, and
  refused by name at the three where it cannot be. The two structural refusals are stated at boot
  rather than discovered as a silent total denial — ADR-0339's own finding, that total refusal
  looks exactly like the rule working. `deferred` makes the fail-closed direction the default for
  any call site added later.
- **Negative — the 422 ordering degrades for a record-bearing field obligation.** The mask
  short-circuits on the first refusing field and a deferral is a refusal, so the fields after it
  are not checked before `validateEntity`. A caller with both a role violation on a later field
  and an invalid body now gets the 422 first. Bounded: ADR-0339's ordering argument is about an
  *unauthorized* caller harvesting the entity's shape from a 422, and this caller has already
  passed the entity-level `update` role check, so they could learn the same shape from a valid
  write on a record they do own. Pinned by a test so the change is visible in the suite and not
  only in a comment.
- **Negative — `update` and `delete` now load the record where they previously did not.** One
  extra `get` inside the transaction, for exactly the deployments that declared a record-bearing
  obligation on those grants. The alternative is answering the policy from nothing.
- **Negative — a record-level denial discloses that the id exists**, to a caller already holding
  the entity grant. Argued above.
- **Neutral.** `ABAC_OUTCOMES` gains a member and no Postgres CHECK constraint anywhere names
  those values, so this is purely additive at the catalog. `ABAC_OPERATORS` widens from four to
  seven and the four existing operators behave identically, pinned by the suite that shipped with
  ADR-0341.
- **Reversibility.** The contract additions are additive and the boot refusals are keyed on a
  declaration that is empty in every shipped pack, so reverting costs nothing to a deployment that
  declared no record policy. Reverting for one that did would restore the hole, which is why the
  refusal has no flag.

## Implementation notes

- `packages/auth/src/abac.ts` owns the whole contract: the fourth outcome's entry in
  `ABAC_OUTCOME_ALLOWS`, `record?` on `AbacEvaluationInput` and `AbacEnforcement`,
  `isAbacDeferred`, and the position/availability maps with `abacGrantPosition` /
  `abacRecordAvailabilityFor`. `dischargeAbac` deliberately gains **no** record-absence refusal:
  only the evaluator knows whether a key needs a record, and five of the eight positions are
  record-free, so a refusal there would reject predicates over the principal's own attributes that
  never wanted one. That contrasts with the `abacAttributes === null` arm, where the seam *always*
  claims to carry the input, so absence is unambiguously a gap.
- `abacGrantPosition` is total and does not throw. Three operation names are unreachable for a
  field obligation (`surveyAbacObligations` emits only `read`/`update` there) and are mapped to the
  entity position for that operation rather than defaulting, because the permissive default is the
  one a fall-through would pick.
- `fields.test.ts` had a hardcoded `["satisfied","denied","undischargeable"]` driving the
  read/write agreement property. It now iterates `ABAC_OUTCOMES`, so `deferred` is covered by that
  property and a fifth outcome cannot land outside it — a second copy of an enum with no forcing
  function is this repo's recurring shape.
- `abac-policy.ts` grew **two** more total maps beside `ABAC_OPERATOR_NEEDS_RECORD`:
  `OPERATOR_OPERANDS` for parse arity and `OPERATOR_RENDERED_WORD` for display. The first fixed a
  live bug in the dictated design — the existing arity test was `operatorRaw !== "in"`, so
  `in_record` would have been treated as single-valued and `teams=team:in_record:a,b` refused with
  a message pointing at `in`. The second avoids dispatching on the spelling
  (`replace("_record","")`), which an eighth operator would break silently.
- `formatAbacPolicies` renders `same_dept: department eq record.department` and a multi-field
  `in_record` as `record.(a,b)`, so a literal `in a,b` line cannot be misread as a record one. The
  module's absolute rule holds and now covers a second source: **no attribute value and no record
  value may appear in anything it logs** — only the declaration, which the operator typed.
- `recordBearingKeys` is **required** on `AbacObligationCheckInput` and joins the grouped
  `BuildOperateHttpServerOptions.abac` object beside `evaluator` / `answerableKeys` /
  `attributeDirectory`, for that group's existing reason: a caller that could omit it would compute
  an empty set, find no record-bearing obligation anywhere, and boot a deployment that denies the
  grant at every request.
- Refusal order in `checkAbacObligations` is `obligation_unevaluable` → `policy_undeclared` →
  `record_unavailable`, so the one reported is the one whose remedy is true. With no evaluator,
  `recordBearingKeys` is empty by construction and `record_unavailable` could only be vacuously
  silent, which is why it comes after both questions that do not need the declaration.
- Two tests in `abac-policy.test.ts` pin an ordering *by construction* rather than by reading an
  answer: the unresolved-attributes-outrank-deferral case passes a record whose `owner_id` is a
  **throwing getter**, so any read of the record surfaces as an exception instead of
  `undischargeable`, with a paired control proving the probe is live once attributes resolve. The
  same trick pins that a literal policy never reads a supplied record.
- Two tests that asserted the limitation were **inverted rather than deleted**: `ABAC_OPERATORS`'
  "offers no operator over a record, which this seam cannot carry" now asserts the three
  `*_record` operators are exactly what a `/record|owns|same/` filter finds, so they cannot be
  removed without a test naming the reason they exist.

### Verified live

On PostgreSQL 16, as the non-owner role `app_rw` (a table's owner bypasses RLS, so testing as the
owner proves nothing), against two memberships in one tenant holding **the same role** and
different `department` attributes, each carrying its own `user_id`. Two policies:
`same_dept=department:eq_record:department` and `owns=user_id:eq_record:owner_id`.

The **boot refusal**, on a manifest putting `same_dept` on `Chart.create`:

```
[abac] abac obligations: 1 abac-qualified grant(s) name a policy that compares against a field of
the record, at a position where no call site can ever supply one, so each would be denied at every
request rather than evaluated: Chart.create requires abac policy 'same_dept' — a create has no
stored record: the record the policy is about does not exist until the write commits. …
fatal: …
```

and its control: the **same manifest** with `same_dept=department:eq:cardiology` — a policy that
needs no record — boots. So the refusal is about the comparison and not about the position alone.

The **request path**, with the obligations on `read` / `update` / `delete`:

| act | principal | result |
|---|---|---|
| `POST /v1/charts` | A | **201** — `create` carries no obligation |
| `GET /v1/charts/{id}` | A (cardiology, record cardiology) | **200** |
| `GET /v1/charts/{id}` | B (oncology) | **403** `same_dept … (denied)` |
| `PATCH` | A (owner) | **200**, note becomes `by-A` |
| `PATCH` | B (not owner) | **403** `owns … (denied)`, stored note still `by-A` |
| `DELETE` | B (not owner) | **403** `owns … (denied)`, row still present |
| `DELETE` | A (owner) | **204**, row gone |

Every refusal is `denied` and not `undischargeable` or `deferred`, which is the point: the record
reached the evaluator and the policy answered from it.

The **`sometimes` position**, on a manifest whose `fields.note.update` grant carries `same_dept`.
The boot line reports and does not refuse:

```
[abac] abac obligations: 1 declared and an evaluator is declared, so each is evaluated per
request: Chart.update -> note requires abac policy 'same_dept'; 1 obligated field(s) are therefore
not settable at create: … — the update path supplies the record and the create path cannot, so an
obligated field is not settable at create
```

and the three consequences:

- `POST` naming `note` → **403**, `rule: "abac_obligation"`, `abacOutcome: "deferred"`, with the
  structural reason in the detail. Final — there is nothing to re-ask with.
- `POST` **omitting** `note` → **201**. The obligation is consulted only for a written key.
- `PATCH {"note":…}` → **200** for A, **403** `denied` for B (so the record reached the mask's
  re-run inside the transaction), and B's `PATCH` of an *unobligated* field → **200** with `note`
  still A's value. The mask refuses per field, not per request.

### Measured

- Seven builtin packs declare **zero** ABAC obligations, so both new refusals are vacuous today
  and a forcing function later — asserted by a test over every pack.
- **Zero** `many_to_many` relations across the seven packs, which is why the association position
  is reported rather than closed.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Field `read` cannot carry a record policy, because redaction is per response. Closing it means per-record projection in the handler, reaching the list and association-list paths. | Platform | 2026-12-31 |
| The principal's own id is not an operand; `owns=user_id:eq_record:owner_id` needs the id written into the membership attributes. A reserved left-operand spelling would shadow a real attribute of that name. | Platform | 2026-12-31 |
| Link/unlink could load the owner record and does not, so the association position is unclosed rather than structural. Vacuous today (no pack declares a `many_to_many`). | Platform | 2026-12-31 |
| A record-bearing obligation on a `required` classified field makes its entity uncreatable. `--classified-write-mask`'s existing survey catches it only when that flag is on, because `surveySensitiveFields` passes no `AbacEnforcement`; threading the obligation into the survey would catch it unconditionally. | Platform | 2026-12-31 |
| The comparison is scalar-to-scalar. A record field holding an array (a tags list, a set of owners) is `structured` and denies for every operator — "the principal's team is one of the record's owners" is still inexpressible. | Platform | 2026-12-31 |
| `validateWriteMask` is the only one of the four field functions not routing through the shared `obligationAdmits` predicate. No behaviour difference (both read the same total map), but that asymmetry is the shape that let the read and write halves diverge in the first place. | Platform | 2026-12-31 |

## References

- ADR-0341 — the attribute nobody read (its Q1 is this ADR's subject).
- ADR-0340 — the obligation nobody discharged (`deferred` exists so its defect cannot recur one level up).
- ADR-0339 — the mask nobody applied (the 403-before-422 ordering this increment partially trades).
- ADR-0338 — the redaction registry's per-response, operation-keyed shape.
- ADR-0336 — serving a wrong answer is worse than refusing (`IdempotencyStore.get`).
- ADR-0331 — "absent" and "nobody looked" are different facts.
- ADR-0322 — a surface that degrades rather than refusing has to say so out loud.
