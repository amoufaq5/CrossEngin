# ADR-0340: The obligation nobody discharged

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0339, ADR-0338, ADR-0337, ADR-0336, ADR-0329, ADR-0334, ADR-0314 |

## Context

ADR-0339 closed the asymmetry in field-level authorization: of the 46 sensitive-classified
fields in the seven packs, 39 were unreadable by every role and 39 were writable by anybody. Its
third open question recorded a smaller defect beside it:

> **an ABAC-qualified grant grants unconditionally**: `rbacCheck` returns `allowed: true` with
> `requiresAbac` attached and **nothing reads it**, so the qualifier is an obligation handed back
> and dropped. Latent — no pack declares one — and fixing it needs an attribute *source*, since
> both principal bridges hardcode `abacAttributes: {}`.

Two of those three sentences are wrong, and the increment began by establishing which.

### What `abac` is, and what the repo thought it was

`RbacGrantSchema` is `{roles: RoleName[], abac?: string}`. The string's meaning was never
declared, and this package's own tests read it two incompatible ways — `rbac.test.ts` used
`"data.access.allow_update"`, a policy path, and `types.test.ts` used
`"user.department == record.department"`, an expression. One contract, two readings, in two test
files of one package.

The repo had already answered the question once, elsewhere and correctly.
`@crossengin/workflow-engine`'s `ABAC_CHECK_GUARD` is `{kind: "abac_check", policyKey:
z.string().min(1).max(200)}` — a **key**, not an expression — and `defaultGuardEvaluator`
**throws** on it, naming the remedy (`supply a custom GuardEvaluator`). No custom evaluator exists
anywhere in the workspace, so that path is unreachable in practice and can never be *wrongly
satisfied*. `rbacCheck` faced the same question and made the opposite choice silently.

### The obligation is dropped in five places, not one

`requiresAbac` had zero readers, which ADR-0339 recorded. What it missed is that the field-level
functions in `packages/auth/src/fields.ts` have the same hole in a worse place. All four —
`computeFieldRedaction`, `validateWriteMask`, `computeClassifiedFieldRedaction`,
`validateClassifiedWriteMask` — read `rule.roles` and never `rule.abac`:

```ts
const rule = fieldPerms?.[field.name]?.read;
if (rule !== undefined) {
  if (rule.roles.some((r) => effective.has(r))) readable.push(field.name);
```

Those last two are the pair ADR-0339 reached for as the fix. ADR-0339's rule is that an
**explicitly declared** per-field grant is enforced always, with no flag, because each of the 7 is
a pack author's deliberate restriction. An explicitly declared grant may carry an obligation — and
that grant was enforced as to roles and silently unconditional as to attributes, on exactly the
fields ADR-0338 had just made ciphertext.

### Measured before the fix

Built from the committed tree at `0df5458` in a worktree and run, since this package's `dist/` had
already been rebuilt by the time the question was asked. One grant,
`{roles: ["front_desk"], abac: "data.access.owns_encounter"}`, declared on `Patient.update` and on
`Patient.fields.mrn.read` / `.update`, with no evaluator anywhere in the deployment:

```
BEFORE 1. entity rbacCheck : {"allowed":true,"requiresAbac":"data.access.owns_encounter"}
BEFORE 2. field read       : {"readable":["mrn"],"redacted":[]}
BEFORE 3. field write mask : {"ok":true}
BEFORE 4. empty abac key   : true
```

All three directions are unsafe, and the second is the sharp one: the PHI field ADR-0338
encrypted at rest and ADR-0339 made readable only to a declared grantee was **disclosed** to that
grantee by a grant whose own text says a policy must admit them first. The fourth line is a
separate defect — `abac: ""` parsed, and `"" !== undefined`, so an empty key was a live obligation
naming nothing.

### It is not gated on a pack author

`ManifestSchema.permissions` in `packages/kernel/src/manifest/types.ts` is
`z.record(z.string(), EntityPermissionsSchema)` — `@crossengin/auth`'s own schema, unwrapped. So
`abac` is an **Architect-authorable manifest field**: a tenant describes "only the clinician who
owns the encounter may update it", the Architect writes the grant, a platform reviewer approves it
reading a declaration the runtime discards, and activation serves the unqualified grant. "Latent"
was true only in the sense that no pack ships one today.

### The attribute source exists

ADR-0339 said fixing this needs an attribute source. `meta.user_tenant_membership` has carried
`abac_attributes JSONB NOT NULL DEFAULT '{}'::jsonb` since Phase 1, and since ADR-0335 it has a
writer *and* a reader: `apps/operate-server/src/platform-users.ts` accepts
`abacAttributes: z.record(z.unknown())` on `GrantMembershipInput` and selects the column back on
every membership read. So the source is provisioned and populated by `--platform-user-routes`.
What is missing is the wire from that row to `Principal.abacAttributes`, which **five** non-test
sites hardcode to `{}` — not the two ADR-0339 named:

```
packages/api-gateway-runtime/src/redaction.ts:80
packages/operate-runtime/src/handlers.ts:93
packages/operate-runtime/src/association.ts:214
apps/operate-server/src/sensitive-field-policy.ts:186
apps/operate-server/src/live-grants.ts:128
```

### Seven spellings of one concept

Measured across the workspace, non-test:

| Declaration | Shape | Status |
|---|---|---|
| `auth.RoleDefinition.abacAttributes` | `Record<string,string>` | role-level defaults, no producer, no reader |
| `auth.RbacGrant.abac` | `string` | the policy key; the subject of this ADR |
| `reporting.BaseReport.abac` | `string` | **second** ABAC field on a report, which already has `permissions: RbacGrantSchema` carrying one |
| `search.PermissionTagInput.abacAttributes` | `Record<string, string\|number\|boolean>` | the only *consumer* of attributes anywhere — flattens them to permission tags |
| `views.PermissionRef.abac` | `string` | independent |
| `views.PermissionVerdict.requiresAbac` | `string` | after this ADR, has no possible producer |
| `workflow-engine.ABAC_CHECK_GUARD.policyKey` | `string` | the one that was already right, and throws |

Three different value types for the attributes, two for the policy reference, and one report
carrying two of them. This is the `FLAG_KINDS` shape of ADR-0336 — a modelled domain with no
mechanism — except that here one of the seven had a working refusal and the authoritative one did
not.

## Decision

**An authorization obligation that can be dropped is not an obligation.** Four parts.

**1. The policy reference is a key, and the reading converges with the one the repo already
made.** `RbacGrant.abac` is documented as an opaque policy key, resolved by the deployment's
evaluator and never parsed as an expression by this repo, and tightened to
`z.string().min(1).max(MAX_ABAC_POLICY_KEY_LENGTH)` — the same bound as
`ABAC_CHECK_GUARD.policyKey`. `""` is refused, because an obligation naming nothing is a
configuration error and was previously a live obligation that no evaluator could ever match.

**2. All five readers fail closed, through one evaluation point.** `dischargeAbac` is the only
function in the workspace that calls an `AbacEvaluator`, and its answers are:

- no obligation (`policyKey === undefined`) → `null`, which means *there was nothing to check*.
  Deliberately not a `satisfied` discharge: "nothing to check" and "a policy answered yes" are
  different facts, and reporting the second for the first claims an evaluation that never ran.
- no evaluator → `undischargeable`, not `denied`. `denied` is a claim about this principal's
  attributes; `undischargeable` says no evaluator could answer at all. Different facts with
  different remedies, and the boot refusal below exists so the second never reaches a request.
- the evaluator throws, or returns a value outside `ABAC_OUTCOMES` → `undischargeable`. An
  exception inside an authorization check must never become an allow, and must not propagate as a
  500 that a client retries.

`ABAC_OUTCOME_ALLOWS` is a **total map** over the outcome enum rather than an `if`-chain, so a
fourth outcome is a compile error instead of a member inheriting whichever branch the chain ended
on. `AuthorizationDecision.requiresAbac` is **deleted** rather than fixed in place: a field whose
whole history is being dropped must not survive under its old name, and `abac?: AbacDischarge`
carries `{policyKey, outcome}` on **both** the allowed and the refused arm, so a satisfied check is
reportable and not only a refusal.

The order inside `rbacCheck` is load-bearing: the evaluator is consulted **only after** the role
check passes. There is nothing to learn from an evaluation when a 403 was already owed, and asking
would hand the deployment's policy layer a principal it has no business seeing.

**3. One evaluator, threaded from the one place that holds all five readers.**
`OperateRuntimeOptions.abacEvaluator` in `packages/operate-runtime/src/compile.ts` reaches the two
handler families' `rbacCheck` calls, the write mask, and the response-redaction registry, because
`compile.ts` is the only module that builds all of them. Two evaluators would let the read side and
the write side disagree about one grant — the divergence ADR-0329 put `privilegedForClass` behind
one definition to prevent and ADR-0339 found had happened anyway.

**4. A manifest declaring an obligation this deployment cannot discharge is refused at boot, by
name.** `checkAbacObligations` surveys every grant position — the five operation names,
`transitions`, and `fields[x].read` / `fields[x].update` — and `AbacObligationsUnevaluable` names
the count, the first eight obligations and what the operator can do about each. ADR-0334's
conversion for the fourth time: without it the deployment serves the manifest and silently denies
every obligated grant on every request, and a total denial is indistinguishable from the rule
working, which is ADR-0339's own finding about why 39 unreadable fields had no symptom.

**There is no escape-hatch flag, and that is a decision.** ADR-0338 shipped
`--allow-plaintext-phi` because plaintext PHI is a degraded-but-coherent state an operator may
knowingly accept. An unevaluated ABAC obligation is not degraded — it is the opposite of what the
manifest declares — so a flag here would be an option to serve the hole deliberately.

The refusal lives in `buildOperateHttpServer`, which is also what compiles an **activated
per-tenant manifest**, so a tenant's own manifest is covered by the same rule — the placement that
gives a per-tenant gateway the tenant-status gate (ADR-0334). `node.ts` asks again before its
own survey, for ordering: an obligation on a required classified field's `update` grant makes that
field unwritable, which would trip `--classified-write-mask`'s `would_make_entity_uncreatable`
refusal and name the classification declaration as the remedy for something no declaration can
fix. First refusal wins, so it must be the one whose remedy is true.

**The attributes are deliberately not wired, and the ordering is the argument.** With no evaluator
in the deployed binary, an obligated manifest is refused at boot, so `Principal.abacAttributes`
feeds nothing — threading a per-request membership lookup to a consumer that cannot exist is the
exact shape this repo declares rather than builds (ADR-0336). What makes leaving it correct rather
than merely cheap is that the *direction of the lie changed*: before this ADR, `{}` erred toward
granting and disclosing; after it, the same `{}` errs toward denial and redaction. So an evaluator
wired before the attributes would answer `denied` for everyone — wrong, and safe. Wiring them in
the other order would restore the hole.

## Alternatives considered

- **Option A: read `requiresAbac` at the four `rbacCheck` call sites.**
  - **Pros:** smallest possible diff; no contract change.
  - **Cons:** leaves the four field-level functions — the ones ADR-0339 made authoritative — still
    dropping the obligation, and leaves `AuthorizationDecision` shaped so the next reader can drop
    it again.
  - **Why not:** the recurring rule of the last ten increments is that the honest fix sits one
    level up from where the pain was felt. The pain was a field nobody read; the fix is a decision
    type in which an un-discharged obligation cannot be an allow.

- **Option B: implement an expression evaluator for the `"user.department == record.department"`
  reading.**
  - **Pros:** makes the feature work end to end with no deployment dependency.
  - **Cons:** inventing an expression language, its parser, its attribute binding and its security
    model, for a contract whose own tests disagree about whether that is even what the string is;
    and `workflow-engine` has already decided it is a key.
  - **Why not:** a product decision disguised as a wiring step, and the wrong one — two of the
    repo's three ABAC references are keys.

- **Option C: embed a policy engine (OPA/Rego, Cedar).**
  - **Pros:** `data.access.allow_update` is literally an OPA data path, so one of the two test
    spellings is already Rego-shaped.
  - **Cons:** a runtime dependency, a sidecar or WASM bundle, a bundle-distribution story, and a
    per-request evaluation budget on the request path — none of which the increment that found a
    dropped field should decide.
  - **Why not:** the seam is the decision; the engine is the deployment's. Shipped as
    `AbacEvaluator` so this stays a configuration choice.

- **Option D: delete `abac` from `RbacGrantSchema`.**
  - **Pros:** removes the hole absolutely; nothing declares one today.
  - **Cons:** it is a manifest field, so deleting it makes previously-valid manifests invalid; and
    it deletes a modelled requirement — "only the clinician who owns the encounter" is a real
    thing tenants ask for — rather than answering it.
  - **Why not:** `validateManifest` would start refusing stored manifests, and the requirement
    would come back with nowhere to be declared.

- **Option E: wire `meta.user_tenant_membership.abac_attributes` into `Principal` now.**
  - **Pros:** closes ADR-0339's stated gap; the source exists and is populated.
  - **Cons:** a per-request `(userId, tenantId)` lookup with its own TTL cache, feeding a consumer
    that the boot refusal guarantees cannot run — a producer for no consumer.
  - **Why not:** ordering. See the last paragraph of the Decision; the follow-up is named below.

- **Option F: an `--allow-unevaluated-abac` flag so an existing deployment keeps booting.**
  - **Pros:** no deployment can be broken by this change.
  - **Cons:** the flag's meaning is "serve the grant with its qualifier removed", which is the
    defect with a name.
  - **Why not:** and it is unnecessary — the measured obligation count across all seven packs is
    zero, so the refusal breaks nothing that worked. The same argument ADR-0338 used for refusing
    by default: nothing served this correctly today.

## Consequences

- **Positive.** An ABAC-qualified grant can no longer be served unqualified, in any of the five
  readers, and a manifest that declares one is refused at boot naming it rather than denying it
  silently per request. The read and the write side of a field obligation are enforced by one
  function with one answer, so ADR-0329's non-divergence property finally holds for obligations as
  well as classes. An empty policy key is refused at parse time. The policy reference has one
  declared meaning, matching the one spelling in the repo that already worked.
- **Negative.** A deployment whose manifest declares an `abac` grant will not boot, and there is no
  flag past it; the remedy is to remove the key (leaving the role grant, which is enforced) or to
  supply an evaluator, which no CLI flag does — only an embedder calling
  `buildOperateHttpServer`. A tenant whose *activated* manifest declares one is refused its own
  gateway and falls back to the deployment's, loudly in the log but with the tenant unaware, which
  is ADR-0314's limitation reached by a new route. `Principal.abacAttributes` is still `{}` at five
  sites. And `AuthorizationDecision.requiresAbac` is gone, which is a breaking change to a public
  type with, as it happens, no readers.
- **Neutral.** `OperationName` is now derived from a new `OPERATION_NAMES` constant rather than
  being a hand-written union, so the two cannot drift. `views.PermissionVerdict.requiresAbac` is
  unchanged and now has no possible producer anywhere.
- **Reversibility.** The seam and the survey are additive and removable. The boot refusal is one
  `if`. The deletion of `requiresAbac` is the only part with a cost to undo, and it is small.

## Implementation notes

`dischargeAbac` has **two** call sites rather than the five the design asked for, for a reason
worth recording: the omitted-`abac` case in `fields.ts` cannot construct an `AbacEvaluationInput`,
because there is no entity to name, so it must short-circuit before `dischargeAbac`. That
short-circuit is a single private helper serving all four field functions, so there is still one
spelling of the fail-closed answer per module and the evaluator is still called in exactly one
place. A test pins that the omitted-parameter result is `toEqual` the
`{entity}`-with-no-evaluator result, so forgetting the argument cannot become a silent grant.

The entity name reached `fields.ts` as `AbacEnforcement {entity: string; evaluator?: AbacEvaluator}`
— one optional parameter whose `entity` is required — rather than two parameters, so a caller
cannot ask for obligation enforcement without naming the entity the policy is about, and every
existing call site compiles unchanged.

`ResponseRedactionSpec.abac` is set unconditionally by `redactionSpecForEntity`, with only the
evaluator conditional: the entity is always known there, and a spec that carries it is checkable.

### Verified live

**The boot refusal, through the real CLI against a throwaway PostgreSQL 16 cluster as a non-owner
role** (`app_rw`, `rolbypassrls = f`, 146 `meta` tables applied — 145 catalogued plus
`_meta_migrations`). The clean `erp-core` manifest:

```
[abac] abac obligations: none declared, so no grant depends on an ABAC evaluator
[sensitive] [fields] 21 sensitive-classified field(s): commercial_sensitive 11, pii 10 (…)
operate-server listening on http://localhost:5561 (…, store=pg)
```

The same manifest with two obligations added — one entity-level on `Invoice.update`, one
field-level on `Employee.fields.national_id.read` — exits **1** and never listens:

```
fatal: 2 abac-qualified grant(s) are declared and this deployment has no ABAC evaluator, so each
would be denied at every request rather than evaluated: Employee.read -> national_id requires abac
policy 'data.access.same_department', Invoice.update requires abac policy 'data.access.owns_invoice'.
Remove the `abac` key from the grant — the role grant beside it is enforced and stays — or give the
deployment an ABAC evaluator, a capability it does not currently have.
```

**The request path, through the real `buildOperateHttpServer` + `OperateHttpServer.dispatch`** —
the two functions the deployed binary uses — over the resolved `erp-healthcare` manifest with
`clinician` named in every grant, so the role check passes and the policy is what decides. An
in-memory store, because the decision is taken before any store call and this increment changes
nothing store-side.

Entity-level grant on `Patient.create`:

| Evaluator | Result |
|---|---|
| none | refused at build, `AbacObligationsUnevaluable` naming the grant |
| `satisfied` | proceeds past authorization (422 on a genuinely missing `account_id`), evaluator asked once with `data.access.owns_encounter\|Patient\|create\|-` |
| `denied` | `403 {"error":"forbidden","detail":"abac policy '…' did not admit 'create' on 'Patient' (denied)","abacPolicyKey":"…","abacOutcome":"denied"}` |
| throws | `403 … "abacOutcome":"undischargeable"` — not a 500 |
| manifest with no obligation | the same 422, byte for byte |

Field-level grants on `Patient.mrn` — the PHI field ADR-0338 made ciphertext and the pre-fix
disclosure above. Writes, with `rule` naming the third refusal rather than misdirecting to the role
rule:

```
field (satisfied) create: 201 {… "mrn":"MRN-1" … "id":"rec_mux7hihq0001"}
field (denied   ) create: 403 {"error":"forbidden","detail":"field 'mrn' on 'Patient' is not
  writable by this principal","field":"mrn","rule":"abac_obligation",
  "abacPolicyKey":"data.access.owns_encounter","abacOutcome":"denied"}
```

And reads, with **one stored record** read back through three evaluators, which is the direct
counterpart of `BEFORE 2`:

```
create            : 201 id=rec_mux7hw370001
read (satisfied      ): 200 mrn="MRN-1" keys=6
read (denied         ): 200 mrn=null    keys=5
read (undischargeable): 200 mrn=null    keys=5
```

**The empty key** is refused by the manifest schema itself, at the grant's own path:

```
empty abac key parses: false   permissions.Patient.update.abac
```

**The survey reaches every grant position**, rendered:

```
Patient.list requires abac policy 'p.list' | Patient.transition:admit requires abac policy 'p.tr'
| Patient.read -> mrn requires abac policy 'p.fr' | Patient.update -> mrn requires abac policy 'p.fu'
```

**The pack census measures zero** obligations across all seven resolved builtin packs, asserted as
a per-pack object rather than a sum so a non-zero pack is named, with three guards against a
vacuous zero: every pack's resolved `permissions` map asserted non-empty, a synthetic manifest with
one obligation driven through the same `checkAbacObligations`, and a real resolved `erp-core` with
one grafted obligation asserted to refuse.

Workspace: `pnpm -r build && pnpm -r typecheck && pnpm -r test` all green — **16,575 tests**, up
from 16,413.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Wire `meta.user_tenant_membership.abac_attributes` into `Principal.abacAttributes`, with the evaluator that consumes it — five hardcoded `{}` sites, and a per-request `(userId, tenantId)` lookup wanting `--tenant-status-gate`'s TTL idiom (positive TTL, shorter absence TTL, first lookup propagates, refresh serves stale to a bound) | Platform | open |
| Which ABAC mechanism: a policy engine (OPA/Cedar) behind `AbacEvaluator`, or a narrow built-in attribute-comparison vocabulary expressible in the manifest? The seam makes it a configuration choice; nothing picks yet | Platform | open |
| Reconcile the seven declarations: `reporting.BaseReport` carries two ABAC fields at once, `views` has both `abac` and a now-producerless `requiresAbac`, `search` has the only attribute *consumer* with its own value type, and `auth.RoleDefinition.abacAttributes` has neither producer nor reader | Platform | open |
| `workflow-runtime`'s `defaultGuardEvaluator` throws on `abac_check` and on `expression`; with an `AbacEvaluator` now defined, the guard's `policyKey` could route to the same seam instead of refusing | Platform | open |
| A tenant whose activated manifest is refused falls back to the deployment's gateway rather than being told; the fallback pre-dates this change (any build failure does it) but an authorization refusal is a worse thing to degrade silently | Platform | open |
| `surveySensitiveFields` calls the field functions without an `AbacEnforcement`, so an obligated field surveys as writable-by-nobody. Correct, and unreachable because the obligation refusal fires first — but the survey's own output would be misleading if that ordering ever changed | Platform | open |

## References

- ADR-0339 — the mask nobody applied; its Q3 is what this ADR corrects and closes.
- ADR-0338 — at-rest PHI encryption; `Patient.mrn` is the field the field-read hole disclosed.
- ADR-0337, ADR-0336 — a capability built, catalogued and reachable by no deployment.
- ADR-0334 — converting a page-1 failure into a boot refusal that names the cause.
- ADR-0329 — one definition behind the read and the write side so the two cannot diverge.
- ADR-0314 — a tenant served from a fallback is not told.
- `packages/workflow-engine/src/definitions.ts` — `ABAC_CHECK_GUARD.policyKey`, the prior art.
