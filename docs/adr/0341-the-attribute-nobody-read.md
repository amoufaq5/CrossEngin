# ADR-0341: The attribute nobody read

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0340, ADR-0339, ADR-0338, ADR-0336, ADR-0335, ADR-0334, ADR-0331 |

## Context

ADR-0340 made an ABAC obligation fail closed: `RbacGrant.abac` is an opaque policy key, one
`dischargeAbac` is the only thing that calls an `AbacEvaluator`, and with no evaluator an obligation
resolves `undischargeable` and the grant is refused — with a boot refusal so that a silent total
denial could not be mistaken for the rule working. It left its first open question:

> **the attributes are not wired.** `meta.user_tenant_membership` has carried
> `abac_attributes JSONB NOT NULL DEFAULT '{}'` since Phase 1 and has had a writer *and* a reader
> since ADR-0335 (`--platform-user-routes`) … what is missing is the wire, and **five** non-test
> sites hardcode `Principal.abacAttributes` to `{}`.

So the column is provisioned, populated by a route, read back by that route — and read by nothing
that makes a decision. The whole ABAC domain has had its subject recorded and never consulted.

### What ADR-0340 got wrong about its own ordering

That entry justified leaving the wire undone with an ordering argument, ending: *"an evaluator wired
before the attributes is wrong-and-safe, while attributes wired first would restore the hole."* The
first half is right. The second is an overstatement, and worth correcting because it would have
misled the next person: with obligations refused at boot, attributes wired on their own **restore no
hole at all** — nothing can read them, so the cost is inertness, not exposure. The honest reason to
do the two together is not danger in one order; it is that **either half alone is inert**, which is
the condition ADR-0336 named and this repo now declares rather than ships.

### The bound the seam imposes, which no evaluator can lift

`AbacEvaluationInput` is `{policyKey, principal, entity, operation, field?}`. It carries **no
record**. So the canonical ABAC shape — "this principal owns *this* row", `user.department ==
record.department`, one of the two spellings `packages/auth`'s own tests used before ADR-0340 — is
structurally inexpressible here, by **any** evaluator, including an embedded OPA or Cedar. What is
expressible is a predicate over the principal's own attributes. That is what this increment builds,
and the limitation is in the module rather than in a reader's memory.

### `{}` and `null` are different facts, and the gap is in the allowing direction

`Principal.abacAttributes` was `Readonly<Record<string, unknown>>`. An evaluator handed `{}` cannot
tell *this principal has no attributes* — a fact it may answer from — from *no directory was
consulted* — a fact nothing may answer from. Under the old type the five hardcoded `{}`s made every
principal look like the first. That is ADR-0331's distinction (an absent field means nobody looked;
an empty one asserts there is nothing) landing in an authorization input, and the failure it
produces is a confident answer over an input nobody gathered.

## Decision

**The attribute source is wired, with a consumer, and an unresolved attribute refuses.** Five parts.

**1. Provenance is in the type.** `Principal.abacAttributes` is
`Readonly<Record<string, unknown>> | null`, still **required** — an optional field can be forgotten
with the type still valid, which is the shape ADR-0330 refused for an optional retention block, and
here every construction site must state which fact it holds. `dischargeAbac` refuses
`undischargeable` on `null` **before calling the evaluator**, placed after the no-obligation check
so that an absent obligation still answers `null`: there was nothing to check, so a missing input
cannot matter. A deployment-supplied evaluator therefore cannot answer from unresolved attributes
even if it forgets to look — the rule sits in the one function that holds all five callers rather
than in a convention asking people to be careful.

**2. Attributes are resolved once, in the auth stage.** `ResolvedPrincipal.abacAttributes` is
optional on the contracts type, where **absent means not resolved**, and `withAbacAttributes`
decorates the `PrincipalResolver`. One decoration covers both credential families, because an
api-key validates in the `authenticate` stage through `opaqueTokenLookup` and then resolves in a
*separate* `resolve_principal` stage through the same resolver a JWT uses. `principalAbacAttributes`
in `@crossengin/api-gateway` is the single spelling of the absent→`null` mapping, beside the
`ResolvedPrincipal` it reads, because the three request-path sites that build an `auth.Principal`
live in two other packages and the tempting wrong form (`?? {}`) is exactly the conflation part 1
exists to prevent. Attributes do **not** reach `meta.gateway_pipeline_executions`: a captured
`PipelineExecution` carries `principalId` and never the resolved principal, checked rather than
assumed.

**3. The directory writes no SQL.** `PostgresUserStore.membershipFor(tenantId, userId)` already
exists and already carries the `withTenantContext` and strict `scopeFilter` this read needs —
`meta.user_tenant_membership` has one `ALL`-scope isolation policy and no platform arm, so a
non-owner read without tenant context returns zero rows. A second spelling of that query is what
this repo refuses, so the directory consumes a narrow `MembershipAttributeReader` that
`PostgresUserStore` satisfies structurally. Only an **`active`** membership supplies attributes
(copying `recipient-resolver.ts`'s filter), applied in the directory rather than as a second query,
because `membershipFor` returns every status by design. The cache is
`CachedTenantStatusDirectory`'s shape and its three figures, with `DEFAULT_MAX_STALE_MS` now
**exported and imported** rather than restated: a first lookup that throws propagates (nothing was
ever known), a refresh that throws serves the last value to that bound, and an **absence** gets the
shorter TTL because the two mistakes are not symmetric — stale attributes delay a policy change,
while a stale absence keeps refusing a principal whose membership an operator just granted. The
cache key is both ids, NUL-separated, so one tenant's attributes for a person cannot be served in
another.

**4. A credential that names no person gets no lookup.** `PRINCIPAL_KIND_NAMES_A_PERSON` is a
**total map** over the four principal kinds with only `user` true — wider than "skip
`service_account`" and deliberately so: `ai_architect` and `system` have no `meta.users` row to join
either, so a lookup could only ever cost a query on the auth path to answer `null`, and a total map
makes a fifth kind a compile error rather than a kind inheriting whichever answer a `!==` gave it.
This is ADR-0331's rule applied: a bare `--api-key 'key:role:tenant'` resolves as a
`service_account` on one shared `DEFAULT_PRINCIPAL_ID`, so looking its attributes up would hand one
placeholder's attributes to every service credential in the deployment.

**5. The consumer is declared, and declaring it is what switches the producer on.**
`--abac-policy <key>=<attribute>:<op>[:<value>]` (ops `eq`, `ne`, `in`, `present`) declares the
policies a grant's `abac` key resolves against — colon-delimited after the key because that is
`--rate-limit-policy`'s existing convention in this app, and a repeated key is refused rather than
last-wins, since which of two policies decides an authorization must not depend on argv order.
Declaring a policy is also what builds the attribute directory: the producer is wired exactly when a
consumer exists, so a deployment with no policy pays no per-request lookup, and the flag is
**refused under `--store memory`**, where there is no membership table and every obligation would
answer `undischargeable` — the total denial that looks like the policy working.

The boot check changes shape with it. `checkAbacObligations` took `evaluatorDeclared: boolean` and
now takes `answerableKeys: ReadonlySet<string>`, with a second refusal `policy_undeclared` for an
obligation whose key no declared policy answers. "An evaluator exists" was never the right question:
a declared-but-incomplete policy set answers `undischargeable` at request time for exactly the keys
it is missing, which is the same silence the boot refusal exists to end. `obligation_unevaluable`
keeps its meaning for an empty set and takes precedence, because that is the no-evaluator case and
must not be reported as a per-key gap.

Three evaluation rules are decisions rather than mechanics, and each is in the module with its
reason: an **absent** attribute denies for every operator **including `ne`** (so `ne` is not the
negation of `eq` — an absent attribute means nothing is known, and a grant condition evaluated
against nothing must not be satisfied); a **structured** value denies for every operator except
`present`, because guessing a scalar rendering would make the answer depend on an unstated
convention; and a policy key the evaluator does not know is **`undischargeable`, not `denied`**,
because that is a configuration gap and not a statement about the principal.

## Alternatives considered

- **Option A: wire the attributes and ship no evaluator.**
  - **Pros:** exactly the increment that was asked for; smallest diff; no product decision.
  - **Cons:** a per-request membership lookup feeding a seam no deployment can supply — a producer
    with no consumer, which is the condition ADR-0336 measured and declared rather than built.
  - **Why not:** inert. The attributes would be resolved, correct, and read by nothing, and the ADR
    would have had to say so.

- **Option B: embed a policy engine (OPA/Rego, Cedar) behind `AbacEvaluator`.**
  - **Pros:** a real policy language; `data.access.allow_update` is literally an OPA data path.
  - **Cons:** a runtime dependency, a bundle-distribution story and a per-request evaluation budget
    on the request path — and **it would still not see the record**, so the policies people actually
    want remain inexpressible until `AbacEvaluationInput` changes.
  - **Why not:** it does not unblock the thing it looks like it unblocks, and the seam keeps it
    available as a configuration choice for a deployment that wants it.

- **Option C: carry attributes on the api-key spec, as a fifth field.**
  - **Pros:** no database read, no cache, no TTL; works under `--store memory`.
  - **Cons:** a credential is not a membership. Attributes would be deployment argv rather than
    tenant data, unchangeable without a restart, invisible to the JWT path, and for a bare spec they
    would attach to ADR-0331's shared placeholder id.
  - **Why not:** it reintroduces exactly the collision ADR-0331 closed, and `--platform-user-routes`
    already writes the real thing.

- **Option D: keep `abacAttributes` as `Record` and use `{}` for unresolved.**
  - **Pros:** no type change, no blast radius across 24 sites in five packages.
  - **Cons:** an evaluator cannot tell "has no attributes" from "nobody looked", and the conflation
    resolves in the allowing direction.
  - **Why not:** it is ADR-0331's distinction, and the increment exists because that distinction was
    missing.

- **Option E: look attributes up per handler rather than in the auth stage.**
  - **Pros:** no contracts change to `ResolvedPrincipal`.
  - **Cons:** several lookups per request, and five sites each free to answer the question
    differently — the divergence ADR-0329 put `privilegedForClass` behind one definition to prevent.
  - **Why not:** the request already carries one identity record; that is where an identity fact
    belongs.

- **Option F: build the directory unconditionally under `--store pg`, with no flag.**
  - **Pros:** ADR-0335's rule for the lifecycle trail — a fact the deployment already has either
    gets recorded or does not, and making it opt-in is what left that table empty for four phases.
  - **Cons:** that rule is about *writing* a record the deployment already produces. This is a
    *read* on the auth path whose only consumer is a policy, so with no policy declared it is cost
    with no reader.
  - **Why not:** coupling it to `--abac-policy` ties the producer to its consumer in one decision
    instead of two flags that can disagree.

## Consequences

- **Positive.** An ABAC-qualified grant can be satisfied for the first time, from a fact a tenant
  administers rather than from argv, through the credential families a deployment actually uses. The
  five hardcoded `{}`s are gone and the type no longer lets a sixth appear. An obligation evaluated
  against attributes nobody gathered is refused by the one function all five readers share, so a
  deployment's own evaluator cannot get that wrong. And the boot refusal now asks the question that
  matters — can this policy layer answer *this grant* — rather than whether one exists.
- **Negative.** The seam still cannot see the record, so the policies most people mean by ABAC
  remain inexpressible; what shipped is the half that is expressible, which is a real but narrower
  capability. A directory failure lands as an unclassified **500** through the listener's top-level
  catch, where ADR-0334 deliberately chose **503** for the same "could not establish" condition on
  the tenant-status gate — correct in direction, coarser in kind. The TTL is how long an attribute
  change takes to bite. A `service_account` can hold no attributes at all, by rule 4. And
  `Principal.abacAttributes` becoming `| null` is a breaking contracts change across five packages.
- **Neutral.** `DEFAULT_MAX_STALE_MS` is exported from `tenant-status-gate.ts` so two directories
  share one bound. `ResolvedPrincipalSchema` gained an optional field; nothing on the request path
  parses a principal through it, so the field survives the pipeline either way.
- **Reversibility.** The directory, the flag and the evaluator are additive and removable. The type
  change is the part with a cost to undo, and reverting it would reinstate the conflation.

## Implementation notes

`parseAbacPolicies` splits the key on the **first** `=` and the remainder on `:`, so a value may
contain `=` and a key may not contain one.

The obligation check runs in two places for one reason each: `node.ts` before its sensitive-field
survey (ADR-0340's ordering — the first refusal must be the one whose remedy is true), and
`buildOperateHttpServer`, which also compiles an activated per-tenant manifest.

**Part 1 changed behaviour everywhere an obligation is evaluated, and ADR-0340's own tests caught
it — 17 of them, across three files in two packages.** Each asserted that a `satisfied` evaluator
returns an obligated field or admits an obligated write; all failed, because every one of those
files holds its own `ResolvedPrincipal` fixture and none carried `abacAttributes`, so the obligation
is now refused before any evaluator runs. That is the new rule working — a deployment with a policy
and no attribute directory refuses rather than answering from an input nobody gathered — and the
spread is the useful part of the evidence: the change reaches every principal in a deployment that
declares no policy, which is every deployment today.

The fixtures therefore gained **resolved-but-empty** attributes rather than any assertion being
weakened, which is the shape a configured directory produces for a member carrying none; and the
case they used to cover is now pinned on its own in each file — on `satisfied`, with attributes
unresolved, the grant is refused **and the evaluator records zero calls**. The one in
`association.test.ts` earns its keep beyond symmetry: that module keeps its own copy of
`authPrincipal`, so the test is what stops the two copies diverging on this rule.

### Verified live

Against a throwaway PostgreSQL 16 cluster with the catalog applied (146 `meta` tables), **every
request served as a non-owner role** (`app_rw`, `rolbypassrls = f`) — which is the half that matters
here, because `meta.user_tenant_membership` carries one `ALL`-scope isolation policy and no platform
arm, so a read without tenant context returns zero rows and this directory would resolve `null` for
a membership that exists.

Seeded: one tenant, one provisioned `meta.users` row, and an **active** membership carrying
`{"department":"clinical","clearance":"high"}`. Served from resolved `erp-healthcare` with an
explicit per-field read grant `Patient.fields.mrn.read = {roles:["clinician"], abac:"clinical_only"}`
— so the role check passes and the principal's attributes are the only thing that can decide — and
two credentials: `k1:clinician:<tenant>:<userId>`, which names the principal, and
`k2:clinician:<tenant>`, which does not.

The boot refusals:

```
A. no --abac-policy
   fatal: 1 abac-qualified grant(s) are declared and this deployment has no ABAC evaluator, so each
   would be denied at every request rather than evaluated: Patient.read -> mrn requires abac policy
   'clinical_only'.

B. --abac-policy other_key=department:eq:clinical
   fatal: 1 abac-qualified grant(s) name a policy key this deployment's ABAC evaluator cannot
   answer, so each would be denied at every request rather than evaluated: Patient.read -> mrn
   requires abac policy 'clinical_only'. Declare a policy for 'clinical_only' …

C. --store memory --abac-policy clinical_only=department:eq:clinical
   fatal: --abac-policy requires a Postgres store (--store pg or pg-columns): attributes come from
   meta.user_tenant_membership and there is none under --store memory
```

With the policy declared, the boot lines and then one stored `Patient` read back under each
condition:

```
[abac] abac policies: 1 declared: clinical_only: department eq clinical
[abac] abac obligations: 1 declared and an evaluator is declared, so each is evaluated per request:
       Patient.read -> mrn requires abac policy 'clinical_only'
```

| Condition | `mrn` |
|---|---|
| `k1`, policy `department eq clinical`, membership `department=clinical` | `"MRN-1"` |
| `k2` — a bare spec, so `service_account` on the shared placeholder id | redacted |
| `k1`, policy `department eq oncology` | redacted |
| `k1`, policy `department in nursing,clinical` | `"MRN-1"` |
| `k1`, policy `ward eq a` — an attribute the membership does not carry | redacted |
| `k1`, same policy, membership flipped to `revoked` | redacted |

The second row is ADR-0331's rule reaching a decision: the bare credential resolves as a
`service_account`, gets no lookup, and so is refused rather than being handed the placeholder's
attributes. The fifth is the absent-attribute rule, and the sixth the active-only filter.

And the disclosure check, rather than an assumption: with `--gateway-execution-capture 1`, the
captured row count is **1** and the number of captured rows containing any attribute value is
**0** — a `PipelineExecution` carries `principalId` and never the resolved principal.

Workspace: `pnpm -r build && pnpm -r typecheck && pnpm -r test` all green — **16,768
tests**, up from 16,575.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| **The record gap.** `AbacEvaluationInput` carries no record, so "owns this row" is inexpressible by any evaluator. Closing it is a contract decision with a real asymmetry behind it: `read` and `update` have a stored record in hand, `create` has only the client's patch, and `list` has a set — so either the input gains an optional record that is absent for exactly the operations where a policy would most want it, or ABAC splits into record-free and record-bearing kinds | Platform | open |
| A directory failure answers **500**, not the **503** ADR-0334 chose for "could not establish"; the listener's catch is generic and the typed error would have to reach it | Platform | open |
| `search.PermissionTagInput.abacAttributes` is still the only other *consumer* of attributes in the workspace, with its own value type (`string \| number \| boolean`) and no runtime; `deriveSessionTags` would now have a real source to flatten | Platform | open |
| Six of ADR-0340's seven spellings remain unreconciled — `reporting.BaseReport` still carries two ABAC fields at once, `views` still has `abac` and a producerless `requiresAbac`, and `auth.RoleDefinition.abacAttributes` still has neither producer nor reader. **Role-level attribute defaults are the sharpest of those now**: with a membership source live, a role default would be the natural fallback and nothing merges one | Platform | open |
| `defaultGuardEvaluator` still throws on `abac_check`; its `policyKey` could route to the declared policy set, but a workflow guard has variables rather than a principal, so the seam does not fit without an input change | Platform | open |
| Attribute **writes** are only reachable through `--platform-user-routes`, whose grant is a platform operator; a tenant administering its own members' attributes has no surface | Platform | open |

## References

- ADR-0340 — the obligation nobody discharged; this closes its Q1 and corrects its ordering claim.
- ADR-0339, ADR-0338 — the field-level rules an obligated grant rides on.
- ADR-0336 — a capability built and reachable by no deployment; the condition Option A would have
  reproduced.
- ADR-0335 — `--platform-user-routes`, which writes the column this reads.
- ADR-0334 — 403 vs 503 for a state that could not be established, and the TTL idiom.
- ADR-0331 — a credential that names no person, and the absent-vs-empty distinction.
