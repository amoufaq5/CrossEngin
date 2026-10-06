# ADR-0339: the mask nobody applied, and the grant nobody could make

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0329 (per-class sensitive grants; one function behind read and write), ADR-0338 (the response half, and this ADR's Q7), ADR-0288 (a declaration with no forcing function), ADR-0334 (an unservable field is a boot refusal), ADR-0313 (the audit trail's own sensitive grants) |

## Context

ADR-0338 closed the response half of field-level classification: redaction had covered
`[list, read]` while the routes emit five actions plus one per workflow transition, so
any write handed back every classified field in the clear. Its own Q7 named the mirror
and left it: `validateClassifiedWriteMask` is implemented, per-class aware, tested — and
**called by nothing on the request path.**

Measuring it turned up something larger than a missing call. The read side and the write
side are both broken, in opposite directions, and the one declaration that would fix both
has no way to be made.

### What is live, reproduced on a throwaway PG 16 cluster as a non-owner role

The whole asymmetry fits in one entity. `erp-government`'s `Citizen` declares
`national_id` as `regulated` **with** an explicit `update: {roles: ["gov_admin"]}` and
`read: {roles: ["gov_admin","case_worker","gov_auditor"]}`, and `contact_email` as `pii`
with no field grant at all:

```
gov_admin   GET  /v1/citizens/{id} -> national_id VISIBLE | contact_email redacted
case_worker GET  /v1/citizens/{id} -> national_id VISIBLE | contact_email redacted
            (and in the database: contact_email = 'c@example.test')

case_worker PATCH {"national_id":"NID-CHANGED-BY-CASE-WORKER"}     -> 200
case_worker PATCH {"contact_email":"written-by-case-worker@…"}      -> 200
            (both land; on disk: 'NID-CHANGED-BY-CASE-WORKER', 'written-by-case-worker@…')
```

So, in one entity: a `pii` field **readable by nobody and writable by anybody**, and a
`regulated` field whose explicit `gov_admin`-only write grant a `case_worker` ignores.

On the healthcare pack the same thing is worse because the field is PHI and encrypted:

```
front_desk POST  /v1/patients {"mrn":"MRN-WRITTEN-BY-FRONT-DESK", …}  -> 201
front_desk GET   /v1/patients/{id}                                    -> mrn ABSENT
           on disk: pgp_sym_decrypt(mrn, <tenant key>) = 'MRN-WRITTEN-BY-FRONT-DESK'

front_desk PATCH /v1/patients/{id} {"mrn":"MRN-SILENTLY-REPLACED"}     -> 200
           on disk: 'MRN-SILENTLY-REPLACED'
```

That second request is the one that matters most, and it is not well described as
"writing a class you cannot read". It is a **blind overwrite**: a role replaced a medical
record identifier it could not see before the change and cannot see after, so the
substitution is invisible to the person who made it and to everyone else without the
grant. ADR-0338 had just made that column ciphertext at rest; the value was encrypted
with the tenant's key and still freely replaceable by a role with no claim to it.

### The measurements that shaped the decision

Across the seven packs there are **46** sensitive-classified fields — 24 `pii`, 17
`commercial_sensitive`, 4 `phi`, 1 `regulated`:

| | count | consequence |
|---|---|---|
| with an explicit per-field `read` grant | **7** | the only ones any role can read |
| with an explicit per-field `update` grant | **7** | the only ones a declaration governs |
| `required: true` with no `update` grant | **12** | a symmetric default makes their entity uncreatable |

The 39 with no `read` grant are **unreadable by every role in every deployment**, and the
reason is a third callerless thing: `policyForEntity` exists on `OperateRuntimeOptions`
and on the redaction builder and **nothing in `apps/operate-server` has ever passed it**.
The only `SensitiveFieldPolicy` built anywhere is for `--audit-read-routes`. So entity
responses are redacted against `policy = {}`, `privilegedForClass` answers false for
everyone, and `gov_admin` — the most privileged role its pack defines — cannot read a
citizen's email address.

So three of the four field-level functions in `packages/auth/src/fields.ts` have no
caller (`computeFieldRedaction`, `validateWriteMask`, `validateClassifiedWriteMask`), the
fourth is reached only through the gateway, and the policy that parameterises it has no
producer. The read path is **fully closed** and the write path **fully open**, which is
why neither had a symptom anybody reported: total redaction looks exactly like
classification working perfectly.

## Decision

**Three parts, and only one of them is a new default.**

### 1. An explicitly declared per-field `update` grant is enforced, always

No flag. A pack author who writes `update: {roles: ["gov_admin"]}` on a national
identifier has made a decision, and a decision the runtime ignores is this repo's
recurring defect — ADR-0288's `needsAuditEmitter`, ADR-0334's unread tenant states,
ADR-0338's own redaction list. Blast radius is the 7 declared fields, every one
deliberate, and it cannot make anything uncreatable: a field with a declared grant has by
construction a role that holds it.

### 2. The deployment can declare who is privileged per class, for entity routes

`--sensitive-field-role <role>` and `--sensitive-field-class <class>=<role>`, with the
grammar, the empty-value meaning and the unknown-class refusal of
`--audit-read-sensitive-*` copied **byte for byte**. Two grant vocabularies that look
alike and differ would be worse than either, and ADR-0329's rule has to survive intact: a
class with an entry is authoritative for it, so `--sensitive-field-class phi=` withholds
`phi` from everyone including a wholesale grantee, and an empty list is a refusal rather
than a fall-through.

They are **separate flags from the audit-trail pair**, not a generalisation of them,
because the surfaces differ in stakes: reading the audit trail is reading every tenant's
conduct, which ADR-0313 gated on its own grants for that reason. One declaration spanning
both would make a deployment that wants its clinicians to read PHI also grant them the
platform's audit trail.

This part is what makes 39 fields readable at all, which is a product fix falling out of
the same declaration rather than a side effect: it is wired to `policyForEntity`, so reads
and writes are parameterised by **one** policy and `privilegedForClass` keeps the property
its own comment claims — *"so the per-class rule cannot diverge between what a role may see
and what it may change"*.

### 3. The classification default on writes is opt-in, and refuses at boot

`--classified-write-mask` turns on the symmetric rule: a sensitive field with no declared
`update` grant is writable only by a privileged role. Off by default, for a measured
reason rather than caution — with no declaration, `policy = {}` makes all 46 unwritable,
and **12 of them are `required: true`**, so `Employee`, `Lead`, `Opportunity`,
`FixedAsset`, `Patient`, `Student` and `Permit` become **uncreatable by every role**. A
mask that simply switches on is not shippable.

And the flag **refuses to mount** when the declaration would leave a required sensitive
field writable by nobody, naming the entities and fields. That is ADR-0334's conversion
applied a third time: without it, a deployment that turns the flag on discovers the
problem as a 403 on create with no indication of which declaration is missing. **The
refusal and its list are the migration guide** — the survey is the only artefact that can
tell an operator which grants their manifest still owes.

The survey's role universe is the **manifest's declared roles**, not the deployment's
api-key roles: a JWT deployment can present any role the manifest defines, so surveying
the narrower set would refuse a boot over a field a JWT holder can write. That direction
can only under-report uncreatability, which is the safe one.

### Where the mask runs, and why not in the gateway

In the CRUD handler, after entity RBAC and before schema validation. The gateway was the
other candidate and the evidence refused it on three counts, none of which is about the
seat being unavailable — `ctx.parsedBody` is a mutable field on mutable state from stage
2, body + operationId + principal are all populated by stage 7, any stage can refuse
terminally, and `ResponseRedactionSpec` already carries the exact five arguments the mask
takes, `EntityPermissions.fields[].update` included:

- **A gateway mask would mask the wrong thing.** `create` applies settings defaults,
  literal defaults and sequence allocation, and injects `created_at`/`updated_at`,
  *after* dispatch. A pre-handler mask sees the client's literal patch and not the fields
  actually written — and conversely would have to decide what a server-filled classified
  field means, which is not a caller writing anything.
- **The registry is keyed by response-carrying operationId.** A write mask is keyed by
  **entity** and runs inside a handler that already knows `spec.entity`. Reusing
  ADR-0338's `entityOperationIndex` would be a category error; what this increment reuses
  from that work is the *policy source* and the *classified-field derivation*, not the
  operation mapping.
- **The handler already holds four of the five arguments.** `authPrincipal(...)` is
  computed for the RBAC check one line above, `ctx.roles` and `ctx.permissions` are on the
  context. Only the policy needed threading.

Ordering inside the handler is load-bearing: the mask runs **before** `validateEntity`, so
a 403 for a field you may not write is not preceded by a 422 listing which other fields
are required. The authorization answer comes first.

`transition` and `delete` take no body — a transition writes only
`{[stateField]: toState, updated_at}`, both server-chosen — and `link`/`unlink` write a
five-string tuple with no payload. No mask applies to any of them, and each carries a
comment saying so rather than a dead call.

## Cross-cutting invariants enforced

- **A declared grant is enforced.** Not conditionally, not behind a flag.
- **One policy governs reads and writes.** The same `SensitiveFieldPolicy` instance
  reaches the redaction registry and the write mask, so a role cannot end up able to write
  a class it may not read — which is what ADR-0329 built `privilegedForClass` for and what
  nothing had ever been able to check.
- **Fail closed, but not silently.** The mask refuses rather than dropping the field; a
  dropped field would report success for a write that did not happen.
- **A configuration that cannot work is refused at boot**, naming the fields, not
  discovered per request.
- **No field value appears in a refusal, a finding or a boot line.** These are the fields
  whose values are the thing being protected, and a log is a disclosure.

## Alternatives considered

- **Enforce the classification default by default, and author the 39 missing grants across
  the seven packs.**
  - **Considered, and it is the right end state.** The packs classify fields and grant
    nobody access to them, which is under-specification rather than a deliberate posture.
  - **Decision.** Not in this increment. Each of the 39 is a product decision about who in
    a generic ERP may write an employee's salary or a lead's phone number, and deciding 39
    of them as a side effect of wiring a function is how a platform acquires an access
    model nobody chose. The flag plus the survey is what makes that authoring possible,
    pack by pack, with the boot refusal naming what is still owed.
- **One declaration shared with `--audit-read-sensitive-*`.**
  - **Decision.** No — see part 2. Different surfaces, different stakes, and ADR-0313
    separated them deliberately.
- **Make the declaration imply the write mask.**
  - **Decision.** No. The declaration says who may see a class; the mask says writes are
    enforced against it. A deployment declaring a grant to make PHI readable by its
    clinicians would otherwise silently acquire a write refusal on the 39 fields no
    manifest grants — the thing part 3 exists to avoid.
- **Drop unwritable fields from the patch instead of refusing.**
  - **Decision.** No. A silently narrowed write reports success for something that did not
    happen, which is the shape of defect ADR-0333 and ADR-0338 both exist to end. The
    `--audit-read-routes` precedent is the same: a tenant naming another tenant is a 403,
    not a quietly narrowed query.
- **Enforce in the gateway as a 14th-stage sibling of response redaction.**
  - **Decision.** No, on the three measured grounds above — chiefly that the handler
    rewrites the body after dispatch, so the gateway would mask the client's patch rather
    than the write.

## Consequences

- **Both live defects are closed**, verified through the real server as a non-owner role on
  PG 16. Part 1, with no flag at all: `case_worker` PATCHing `Citizen.national_id` answers
  **403** `{"rule":"explicit_update_grant"}` and the stored ciphertext is unchanged, while
  `gov_admin` — the role the pack declares — gets 200 and the value moves. Part 3:
  `--classified-write-mask` with no declaration **refuses at boot**, naming
  `Employee (work_email); Lead (full_name); Opportunity (amount); FixedAsset
  (acquisition_cost); Patient (mrn, given_name, family_name, date_of_birth, sex)` and the two
  flags that fix it. Part 2, with
  `--sensitive-field-class phi=clinician --sensitive-field-class pii=clinician
  --sensitive-field-class commercial_sensitive=erp_admin`: the boot refusal clears, and on one
  record `clinician` reads `mrn = 'MRN-BY-CLINICIAN'` while `front_desk` reads `None` — and
  `front_desk`'s blind overwrite, the headline defect, answers **403**
  `{"rule":"classification_default"}` with the ciphertext at rest untouched.
- **A clinician reading a patient's MRN through an entity route is a first.** Before this, no
  role in any deployment could read any `pii`/`phi`/`regulated`/`commercial_sensitive` field
  unless its manifest granted `read` on that field by name — 7 of 46.
- **A declared grantee the manifest does not define is said at boot**, not left to be inferred
  from a field that stayed redacted. `resolveEffectiveRoles` throws on an unknown role and every
  predicate answers `false`, which is fail-closed and for an undefined role also correct — but a
  grant that reaches nobody because of a typo is a declaration that does nothing, which is the
  class this increment exists to end. Verified: `phi=clinicain` prints the typo and the 19
  manifest roles beside it.
- **39 classified fields become readable** by the roles a deployment nominates, for the
  first time. Before this, no role in any deployment could read a `pii`, `phi`,
  `regulated` or `commercial_sensitive` field through an entity route unless the manifest
  granted `read` on it explicitly — 7 of 46.
- **`policyForEntity` has a producer**, which makes it the fourth callerless thing this
  run of increments has wired rather than declared.
- **Three of four field-level auth functions had no caller**; two do now
  (`computeClassifiedFieldRedaction` via the gateway, `validateClassifiedWriteMask` via the
  handler). `computeFieldRedaction` and `validateWriteMask` are the non-classified
  originals, superseded by the classified pair, and are left alone rather than deleted —
  see Q2.
- **A 403 is caller-visible where a write previously succeeded**, for the 7 explicitly
  granted fields, unconditionally. That is the point of the increment.

## Open questions

- **Q1: the 39 unauthored grants.** The end state is a per-field `update` (and `read`)
  grant on every classified field in every pack, at which point
  `--classified-write-mask` becomes the default and the deployment-level declaration
  becomes the exception rather than the mechanism. 12 required fields across 7 entities
  are the blocking subset; the boot survey names them.
- **Q2: `computeFieldRedaction` and `validateWriteMask` still have no callers.** They are
  the classification-unaware originals, and the classified pair supersedes them on every
  path. Deleting them is probably right — ADR-0337's rule is that a callerless symbol is a
  question, and the answer here looks like "superseded" — but they are public API of
  `@crossengin/auth`, so that is a separate, mechanical increment with a `pnpm -r`
  rebuild in it, and `pg-unreachable-stores.ts` does not fence *functions* (ADR-0337
  measured why and refused the general fence).
- **Q3: an ABAC-qualified grant grants unconditionally.** `rbacCheck` returns
  `allowed: true` with `requiresAbac: grant.abac` attached, and **nothing reads
  `requiresAbac`** — the handler checks `decision.allowed` alone. So an `abac` qualifier
  is an obligation handed back and dropped. Latent rather than live: **no pack declares
  one**, so no deployment is affected today. Fixing it needs an attribute *source*, and
  both principal bridges (`handlers.ts` and `association.ts`) hardcode
  `abacAttributes: {}`, so there is nothing to evaluate against — which makes it a
  subsystem decision rather than a wiring step, and the same shape as this ADR one layer
  down.
- **Q4: the mask sees the caller's keys, not the stored record.** It answers "may this
  principal write this field", never "may this principal write *this value*", so a
  value-dependent rule (an amount above a threshold, a state the record is already in) is
  out of scope and belongs with the write guards, which already own that question.
- **Q5: `transition` can write a classified field if a manifest names one as a
  `stateField`.** The patch is server-chosen so no caller is writing it, which is why no
  mask applies — but a pack that classified its own state field would be putting a
  classified value under lifecycle control with no field-level check anywhere. Nothing in
  the seven packs does this, and a manifest-validation refusal is the cheaper place to
  close it than a mask.
- **Q6: the survey is a boot-time answer to a manifest-time question.** A manifest
  activated later (per-tenant manifests) is not surveyed, so a tenant can activate a
  manifest whose required classified field no role can write and discover it as a 403 on
  create. `applyTenantManifestSchema` is where the equivalent check would land, beside
  ADR-0334's `unservable_field_type`.
