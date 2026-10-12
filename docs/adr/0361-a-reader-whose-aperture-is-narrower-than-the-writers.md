# ADR-0361: A reader whose aperture is narrower than the writer's

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0282, ADR-0329, ADR-0337, ADR-0338, ADR-0339, ADR-0340, ADR-0343, ADR-0348, ADR-0351, ADR-0354, ADR-0359, ADR-0360 |

## Context

An entity's own `fields` are not the fields its served table has. A trait contributes more, which is
why `resolvedFields(entity, customTraits)` exists and why its own doc comment calls itself *"the one
answer to 'which fields of this entity become columns?', shared by `validateManifest`'s reference
checks and by the serving store's column plan, so validation cannot say a field exists that the
served table has no column for."*

`entityClassifiedFields(entity)` took an `Entity` and read `entity.fields`. So the narrow answer
needed no workaround and the wide one did: five call sites spelled the wide form by hand as
`entityClassifiedFields({ ...entity, fields: [...resolved] })` — a fabricated entity whose only
purpose was to widen the aperture of a function that should never have narrowed it — and three took
the narrow one. Three of eight readers wrong is a convention failing, not three typos.

The class is wider than one function and wider than classification. The same shape appears across
the authorization path, and in every instance **the comment beside the narrow read asserts the
property the narrow read breaks**:

- `write-mask.ts`: *"Built from `entityClassifiedFields`, which is the same source
  `redactionSpecForEntity` reads, so what a role may write and what it may read are derived from one
  declaration and cannot drift apart."* — **true and worthless**. Both read the raw entity, so they
  agreed *in being wrong*.
- `write-mask.ts`: *"Which rule refused is re-derived from the same two inputs the rule itself read,
  in the same order of precedence."* — **false**. The rule read `fieldWriteGrant(perm, writeOp)`; the
  re-derivation read `perm.update`. And `fieldWriteGrant`'s own comment is *"The one spelling of the
  fallback, so no reader re-derives it."*
- `validate.ts`: a view's undeclared role *"fails closed at serve time and looks like a missing
  grant."* — **false**. Nothing reads a view's `permissions` at serve time, so it fails *open*.
- `searchableFieldsFor`: *"With no view, all text-like fields are searchable."* — false for a trait's.
- `checkAbacObligations`' boot line: *"abac obligations: none declared, so no grant depends on an ABAC
  evaluator"* — false for an obligation on a report's grant. The sentence exists so that "we checked
  and found nothing" could not be claimed from silence, and it was claiming it from a narrower survey.

So the lesson the increment is named for: **an invariant that two readers agree on is not an
invariant that either is right.** Agreement is cheap when both read the same narrow source.

### What was measured

Across all seven packs: **zero** custom traits, and **zero** of the eight built-in trait fields
carries a classification — so the classification half has zero members on every shipped pack and is
reachable only from an **authored** manifest, which is the platform's headline Architect feature. It
is also **one wiring step from non-zero**: `packages/compliance`'s four packs declare custom traits
and `resolveCompliancePacks` merges `contributions.traits` into `result.traits`, so wiring the
compliance-pack resolver is precisely what puts the first custom trait into a shipped manifest.

Twelve fields carry an explicit per-field `create` arm, all twelve declare `update` beside it, and
**none** is create-only. There are **132** views, every one `permissions: "inherit"` — written as a
literal by `pack-erp-core`'s `listView` factory rather than applied by the zod default, and 28 is the
count of distinct authored view *declarations* — all of kind `list`, **0** overrides anywhere. There
are **0** reports and **0** dashboards in any pack.

### Live, as a non-owner, on both stores

PG 16.13, 964 statements applied with a clean re-plan, served as a role with `rolbypassrls = f`
owning none of `meta.*`. A probe manifest declaring a trait carrying `personal_email` (`pii`) on an
entity that also declares `declared_email` (`pii`) as an in-entity control.

Before: the boot line said `[fields] unreadable by every declared role: 2 — Contact.declared_email,
Contact.personal_email` and `writable by no declared role: 2`, and seconds later the same binary
answered **201** to a write of `personal_email` and handed the plaintext back in the create response;
a `GET` of a row holding both redacted the declared field and **returned the trait field in full**; a
`PATCH` overwrote it with **200** while the declared field was 403. Identical on `--store pg-columns`,
where the column is genuinely emitted and the owner reads the value back.

**The boot line and the request path contradicted each other about the same field in the same
process, and the boot line was the one that was wrong — in the reassuring direction.** That is
ADR-0337's falsely-true-control direction in a new place, and worse than silence: the surface built to
make classification legible is the thing that concealed the gap. The create response echoing the value
is ADR-0338's write-discloses finding for the fourth time.

After: `POST {"personal_email": …}` as the unprivileged role is **403** with the same body shape as
the declared control; `GET` returns `{"id","label"}` with all three classified fields withheld; with
`--sensitive-field-class pii=boss` the privileged role gets **201** writing all three and sees all
three on read, while the unprivileged one is still 403. The trait field behaves identically to the
entity-declared one in every direction, which is what proves it entered the classification system
rather than merely being refused.

The other two members were verified on the same cluster. `tax_id`, declared
`create: [boss], update: [boss]`, answers **`rule: "explicit_create_grant"`** on a POST and
**`explicit_update_grant`** on a PATCH of the same field by the same role — where before both said
`update`, so an operator meeting the create 403 would widen a list that already named them.
Separately, on the `erp-core` shape the register's own claim was checked and found to have zero
shipped members: `ap_clerk` POSTing `contact_phone` got `explicit_update_grant` and PATCHing the same
field returned **200**, which is the sharper half the register missed. And a manifest declaring a
report whose `permissions` carries `abac: "same_facility"` booted printing
`[abac] abac obligations: none declared, so no grant depends on an ABAC evaluator`; it now prints
`none on an entity grant, but 1 at a position nothing serves and no survey walks … so it is NOT
enforced and NOT refused at boot: reports.weekly.permissions -> 'same_facility'`, with both remedies.

### The readers fail in opposite directions, and what decides it

`audit-read-routes.ts` reads raw too, and measured it **withholds** the field: `redactAuditPayloads`
drops `redacted ∪ undescribed`, so a key the lookup does not describe is dropped, where the gateway
redactor drops `redacted` alone and passes an undescribed key straight through. **Closed world versus
open world.** One narrow read, two opposite failure directions, decided entirely by the consumer's
drop set — and the audit site stays withheld even from a reader explicitly privileged for `pii`, so
resolving traits there is a **capability** fix for an entitled reader and not a disclosure fix. That
makes it a decision rather than a patch, and its own doc comment already argues for the behaviour.

Its *remedy* was the trap. It said a deployment wanting those fields readable should build the lookup
from `resolvedFields` instead — and doing that for the field list while leaving the classification
half narrow makes every trait field a **described, unclassified** field, which is served in the clear.
So the advice converted a fail-closed omission into a fail-open disclosure. Mutation-verified: taking
the old advice for real fails two of that file's tests rather than shipping the disclosure.

## Decision

**Make the narrow read a stated choice and the wide read the shared one.**

1. `entityClassifiedFields(entity: Entity)` becomes **`classifiedFields(fields: readonly Field[])`**.
   It no longer takes an entity, so there is no entity-shaped call to get wrong: a caller must say
   which fields it means.
2. **`resolvedClassifiedFields(entity, customTraits)`** joins `resolvedFields` and
   `resolvedFieldNames` in `@crossengin/kernel/ddl` as the one answer to "which of this entity's
   fields are classified, as the served table has them". The five fabricated entities collapse into it.
3. The gateway gets a **required** `classifiedFieldsForEntity` resolver with **no fallback to
   `entity.fields`** — that fallback *was* the defect. `api-gateway-runtime` deliberately does not
   depend on `@crossengin/kernel`, so it cannot resolve a trait; the compiler asks instead.
4. `compile.ts` builds **one** `classifiedFieldIndex` and gives it to both the write mask and the
   redaction registry — the same *value*, not the same narrow function called twice.
5. `fieldWriteGrantArm(perm, writeOp)` joins `fieldWriteGrant`, answering **which arm** the grant came
   from, and `WriteMaskRefusal.rule` gains a fourth member `explicit_create_grant` through a total map
   over `FIELD_WRITE_OPERATIONS`.
6. `validateClassifications` resolves traits, so the `phi`-requires-`auditable` invariant is no longer
   bypassable by moving the declaration one level out.
7. `validateReports` and `validateDashboards` check their grants' role names against `manifest.roles`,
   which nothing did; the structurally-unreachable duplicate-id check is deleted rather than kept.
8. `listConfigForEntity`'s three field-derived outputs read **one** private `resolvedFieldsOf`, where
   `entityFieldNames` resolved traits and `textFieldsOf`/`referenceFieldsOf` did not.
9. A view cannot carry an ABAC obligation (`abac` deleted from `PermissionRefSchema`) and neither can
   a report through its redundant top-level key; the remaining two positions — a report's and a
   dashboard's `permissions.abac` — are **reported** at boot so the affirmative line cannot lie.
10. `surveyViewPermissionOverrides` reports at boot that this deployment reads no view `permissions`.
11. `entity-field-aperture.ts` is the **tenth** workspace rule: every reader asking about an entity's
    fields either asks over the resolved set or declares why not, with its failure direction and its
    consequence, compared in both directions every run.

### What the tenth rule measured

Over 982 files: **84** reads of the `.fields` shape survive comment-stripping and string-blanking, and
**19** of those are on an `Entity`-typed binding — **23% precision for a bare scan, 100% for the type
anchor** on a population checked by hand. Grouped per `(file, symbol)` that is **16** readers: **12
raw**, 3 calling a resolver, 1 `trait_aware`. Twelve declarations, matching the twelve raw readers in
both directions, and the audit returns **0 findings**.

By direction: **fails_open 3, fails_closed 1, incomplete 8** — and the direction is the most valuable
thing recorded, because it is what decides whether a member is a defect or a declaration.

Four generalisations were refused on measurement, each with its count. Any `<receiver>.fields` read is
23% precise, because `.fields` is a property on `EntityPermissions`, `UiEntitySchema`, `ListQuery`,
`ListConfig`, `ListSearch`, an index definition, a drift record and a PHI decision. A receiver *named*
`entity`/`ent`/`e` fails because `apps/operate-web` reads `entity.fields` eleven times on a
`UiEntitySchema` — the name is identical on both sides of the question. A file-wide first-annotation
lookup reproduced ADR-0354's bare-name defect in the rule's own prototype, so the lookup is scoped to
the enclosing function. And iterating `<x>.entities` type-blind is wrong in the direction that
*invents* members.

Three findings beyond what the register or this increment's own sweep had. `manifest-diff.ts`'s
`classificationLayer` is **fails_open and live on the reviewer's approval path**: a classification
change on a trait field is absent from the `ManifestDiffView`, so weakening `phi` → `internal` is
approved unseen — the same blindness the scout found in `assessManifestRisk`, which means the
Architect's approval gate reads the narrow side of the split. `refusal.ts`'s
`detectEncryptionWeakening` gates a hard refusal and is **latent because nothing calls
`classifyManifestEditRefusal` at all**, so wiring that gate without widening the read would ship the
hole. And three `apps/operate-server` modules project a manifest from `Record<string, unknown>` and
read `entity["fields"]` by bracket access: they hold no `Entity` and no `Trait[]`, so they *cannot*
call the resolver — blocked by **shape** and not by wiring, which is `pg-unreachable-stores.ts`'
distinction, and they are declared as such.

Two of the rule's own "live" notes were corrected against a measurement taken afterwards: the
`version: 0` hole in `validation.ts` and the missed literal defaults in `defaults.ts` both need an
entity carrying `versioned` or `gxp_signed`, and **the only trait any of the seven packs declares
anywhere is `auditable`** (68 entities; 0 `versioned`, 0 `gxp_signed`, 0 custom), whose four fields are
`datetime`/`uuid` and server-stamped. So the reader is live and the defect has no member — a
distinction worth keeping, because "live" is the most load-bearing word in that file.

## Alternatives considered

- **Option A: fix the three readers and leave the signature.**
  - Pros: smallest diff; no ripple through five packages.
  - Cons: leaves the trap. A ninth reader takes the narrow read for the same reason the first three did.
  - Why not: the pain was three readers that forgot; one level up is a signature in which forgetting
    is not expressible.

- **Option B: add `@crossengin/kernel` to `api-gateway-runtime` and resolve in the gateway.**
  - Pros: one call site, no new option, the gateway answers for itself.
  - Cons: measured acyclic — kernel's runtime closure is ten packages and holds neither
    `api-gateway-runtime` nor any of its four dependents — but it contradicts the stated reason
    `RedactionManifestInput` exists, and would drag kernel's `files`, `i18n`, `integrations`, `jobs`,
    `reporting`, `search` and `views` closure into the request edge.
  - Why not: the seam is deliberate and the cost is a dependency the request edge does not want.

- **Option C: move the trait-merging logic into `@crossengin/types` so both sides can resolve.**
  - Pros: one function, callable everywhere, no resolver option.
  - Cons: `BUILT_IN_TRAIT_FIELDS` exists only in `kernel/src/ddl/built-in-traits.ts` and appears
    nowhere in `packages/types/src`. Built-in traits are a DDL concept.
  - Why not: the layering is right and the reader was wrong.

- **Option D: add `traits?: readonly Trait[]` to `RedactionManifestInput` and merge custom traits in
  the gateway, relying on the measured fact that no built-in trait field is classified.**
  - Pros: `Trait` is already in `@crossengin/types`, which the gateway already depends on.
  - Cons: the correctness rests on a current fact about a table the gateway cannot see. Classifying
    `created_by` as `pii` is defensible, and the day somebody does, the gateway is silently wrong again.
  - Why not: a correctness argument that depends on a fact outside the reader's aperture is the defect,
    restated.

- **Option E: make `classifiedFieldsForEntity` optional with a fallback to the raw read, and warn.**
  - Pros: no call-site churn.
  - Cons: a default that cannot possibly be correct fails silently in the unsafe direction. ADR-0338
    settled this for `operationsForEntity`, whose default was `[read, list, get]` with no write ids.
  - Why not: the compiler can ask, so it should. Mutation-verified: dropping the option from one call
    site is `error TS2345`, so required-ness bites at compile time and not only in prose.

- **Option F: rename `explicit_update_grant` to an arm-agnostic `explicit_field_grant`.**
  - Pros: one member instead of four; no enum growth.
  - Cons: `rule` goes straight into the 403 body, so a rename is a breaking wire change where an
    addition is not — and it loses the distinction an operator acts on.
  - Why not: `WriteMaskRefusal.rule`'s own doc comment states the rule — *"A third member rather than a
    flag on the other two, because an operator acts on each differently"* — so a fourth follows the
    same argument. Convergence, not invention.

- **Option G: survey a view's and a report's `abac` and refuse at boot, per ADR-0340.**
  - Pros: consistent with the no-hatch rule for an undischargeable obligation.
  - Cons: ADR-0340's argument is that *serving a grant with its qualifier removed is the opposite of
    what the manifest declares*. Here the grant is not served at all, so there is no partially-honoured
    grant, and the remedy for an author who wants it enforced does not exist.
  - Why not: deleting the two deletable keys removes the trap outright at a measured cost of zero, and
    reporting the two that cannot be deleted kills the lie without refusing a deployment that works.

- **Option H: fix `sequences.ts`, `validation.ts`, `defaults.ts`, `settings-defaults.ts` and
  `ui-schema.ts` in the same increment.**
  - Pros: closes the class rather than half of it.
  - Cons: each is a behaviour change with its own argument. `auditable.created_at` is `required: true`
    with a `now()` default, so pulling trait fields into the validation plans could make a create demand
    a field the server fills; pulling them into `ui-schema` changes every rendered form.
  - Why not: declared with their failure direction and consequence instead, which is ADR-0307's and
    ADR-0360's treatment of a subsystem change wearing a reader's clothes. The tenth rule is what makes
    them visible, and a ninth reader landing undeclared is now a test failure.

## Consequences

- **Positive:** a trait-contributed classified field is redacted on read and masked on write, on both
  stores, through one index two readers share. A field-level 403 names the arm that refused it. The
  `phi`-requires-`auditable` invariant is no longer bypassable. A report or dashboard granting a ghost
  role is a validation error. A view and a report cannot declare an obligation nothing surveys, and the
  two that remain are named at boot instead of being claimed absent. `listConfigForEntity` no longer
  reads its own entity two ways.
- **Negative:** a signature change in a contracts package rippling through six packages.
  `RedactionCoverageError` now fires for an entity whose *only* classified fields come from a trait and
  which no operation serves — correct, and a boot that previously succeeded could now refuse (measured:
  zero such entities on any shipped pack). Resolving `textFieldsOf` makes a trait-contributed text field
  searchable, so on the column store an encrypted one can collapse the whole `?q` OR group and
  `UNSERVEABLE_SURFACE_REFUSES.search` refuses a request that is served today — measured
  behaviour-identical on all seven packs, since no built-in trait field is a searchable kind or a
  reference.
- **Neutral:** the audit trail keeps withholding a trait field, with its remedy corrected.
- **Reversibility:** each part is independently revertable. Two contract removals, both at zero members.

## Implementation notes

- `fieldWriteGrantArm` answers the **arm** rather than the write op, and the distinction is the whole
  point: an absent `create` inherits `update`, so a create refused by the inherited grant correctly
  reports `explicit_update_grant` — widening `update` genuinely is the remedy there. Written beside
  `fieldWriteGrant` over the same `??`, because the hazard was never that someone read the wrong field;
  it was that the answer lived somewhere the fallback's author could not see.
- `validateClassifications` keeps two loops rather than merging into the resolved one, because the path
  and the remedy differ by where the declaration is: an own field indexes `fields[j]` and a trait's has
  no index in this entity, so its message names the trait and warns that dropping the classification
  there changes every entity carrying it.
- The `?? []` in `compile.ts`'s resolver wiring is sound for a stated reason:
  `buildClassifiedFieldIndex` walks the same `manifest.entities ?? []` list and omits only entities with
  no classified field, so a miss can only mean the honest empty set. An index built from a *different*
  entity list would make the whole thing fail open again, and that `??` is where it would land without
  a symptom.
- `@crossengin/auth`'s `ClassifiedField.classification` is **optional** where `@crossengin/types`' is
  required, and the optionality is load-bearing — it is how `maskWrite` expresses `explicit_only` mode
  by stripping the classification. So a deployment-supplied resolver may legally return `{name}` with
  no classification, and `planClassifiedRead` then serves that field unless an explicit `read` grant
  exists. Fail-open, reachable only from a hand-written resolver. See the open questions.
- An adjacent finding, measured incidentally and not fixed: every write returned
  `500 {"error":"write_failed","detail":"the write could not be completed"}` until a `meta.tenants` row
  was provisioned, the cause being `operate_entity_records_tenant_id_fkey`, with no diagnosis in the
  response at all. That is ADR-0359's Q3, live.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Should the audit trail resolve traits, making a trait field readable by an entitled reader? Measured: withheld today even from a `pii`-privileged reader, so this is a capability decision about what an audit payload shows, not a defect. Both halves or neither. | Platform | 2026-11-30 |
| `sequences.ts`, `validation.ts`, `defaults.ts`, `settings-defaults.ts` and `ui-schema.ts` read `entity.fields` raw, so a trait field gets no allocator, no validation, no default plan and does not appear in `GET /v1/meta/schema`. Declared with their direction and consequence in the tenth rule, not fixed: each is a behaviour change with its own argument. | Platform | 2027-01-31 |
| `@crossengin/auth`'s `ClassifiedField.classification` is optional, so an entry with none is served rather than withheld. Tightening it is not available — the optionality is how `explicit_only` mode strips the classification — so the fix is a second type, or a refusal in the gateway for an entry with no classification. | Platform | 2026-12-31 |
| A report's and a dashboard's `permissions.abac` are reported and not refused, which is right while nothing serves them. The moment a report route exists, that report becomes a refusal and the position needs a member in `ABAC_GRANT_POSITIONS` with availability and denial-effect answers. | Platform | 2027-01-31 |
| All 132 views are `kind: "list"`, and `listConfigForEntity` reads only the **first** list view per entity — so a second list view on one entity is wholly inert, and seven of eight view kinds are read by nothing at serve time. Whether view-level presentation authorization should be served at all is a product decision. | Platform | 2027-01-31 |
| `validateFiles` is structurally vacuous in the same way the deleted report duplicate-id check was: it tests `Object.keys()` of a record for duplicates, which cannot occur. Not touched here. | Platform | 2027-01-31 |
| `manifest-diff.ts`'s `classificationLayer` is `fails_open` on the path a reviewer approves from: a classification change on a trait field is absent from the `ManifestDiffView`. Together with `assessManifestRisk` reading raw, the Architect's approval gate is on the narrow side of the split — which is the sharpest remaining member and arguably its own increment. | Platform | 2026-12-31 |
| `refusal.ts`'s `detectEncryptionWeakening` gates the `weaken_encryption_below_pack_minimum` hard refusal and reads raw, and `classifyManifestEditRefusal` has no caller outside its own test. Wiring that gate must widen the read in the same change, or it ships the hole. | Platform | 2026-12-31 |
| `ui-schema.ts` is the widest-reaching `incomplete` member: no trait field reaches the web client at all, so `created_at`/`updated_at` are absent from every list, record and form view on all 68 `auditable` entities in every deployment. All 25 of `operate-web`'s own reads sit downstream of it. | Platform | 2027-01-31 |
| The tenth rule's anchor is an `Entity`-typed binding found by text scan, so a reader that receives its fields through a structural local type is invisible to it — which is exactly what `EntityLike` was in `list-query.ts` before this increment deleted it. | Platform | 2027-01-31 |

## References

- ADR-0282 — the increment that added the view role check, whose own text records that every pack ships
  only `list` views with `inherit` permissions, "which is why this went unnoticed".
- ADR-0329 — the symmetric rule: a role cannot write a class it may not read.
- ADR-0337 — the falsely-true control; a callerless symbol is a question, not a verdict.
- ADR-0338 — `operationsForEntity` made required, because a default that cannot be correct fails silently.
- ADR-0339 — the read half wired and the write half not.
- ADR-0340 — an obligation handed back and dropped; the no-hatch boot refusal and its affirmative line.
- ADR-0343 — a structural refusal that was really a wiring one.
- ADR-0348 — the `create` arm, and the validation-error versus boot-refusal split.
- ADR-0351 — a test that documents a hazard and checks the half that works.
- ADR-0359 — report versus refuse, argued from the remedy; `UNSERVEABLE_SURFACE_REFUSES`.
- ADR-0360 — a remedy that cannot work is worse than none; say it either way, including when zero.
