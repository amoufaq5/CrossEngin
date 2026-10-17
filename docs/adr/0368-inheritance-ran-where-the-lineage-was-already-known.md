# ADR-0368: Inheritance ran where the lineage was already known

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0314, ADR-0331, ADR-0340, ADR-0342, ADR-0354, ADR-0359, ADR-0365 |

## Context

The deployment's headline feature is that a tenant describes their business in prose, the AI
Architect designs a manifest, a platform reviewer approves it, and activating it makes it that
tenant's live system. Measured against the committed tree on the shipped compose, **nine of that
sentence's eleven steps work and the two it is actually about do not** — and a third defect sits
underneath both, so that the three compose into a single live hazard rather than three gaps.

**One. Inheritance ran where the lineage was already known, and not where it was a question.**
`resolveManifest` — the entire `meta.extends` mechanism, with its merge, its `overrides: true`
marker and its three refusals — has exactly one non-test caller: `loadBuiltinPack`
(`manifest-source.ts:62`), which runs over the seven *built-in* packs at boot, whose lineage is
fixed at build time and could have been composed by hand. A **tenant's** activated manifest is the
only input in the system whose lineage is a runtime question, and it reaches
`TenantGatewayCache.serverFor`, which does `ManifestSchema.safeParse` → `tryValidateManifest` →
`this.build(...)` and never resolves anything. So `meta.extends` on a stored manifest was parsed
and never followed, and **activating a design replaced the pack**: measured, a four-entity design
took the other forty-seven entities, fifteen roles, nineteen workflows and seventy-nine transitions
away from that tenant — the general ledger, AR/AP, inventory and HR among them.

The shape of that is worth stating because it is not "a missing call". The mechanism was *applied
to the input that did not need it*. `node.ts:2519-2521` even asserts the opposite in prose —
*"resolving that lineage is the gateway cache's job rather than a second resolution here"* — and
returns `null` from `roleDirectory` for any stored manifest carrying `meta.extends`, on a premise
that does not hold.

**Two. The approval gate was supplied under a flag nothing passed.** `reviewGate` reaches the
design routes only inside `options.requireDesignReview && reviewStore !== null`
(`node.ts:2941`), and the activation handler's check is `if (ctx.reviewGate !== undefined)`
(`ai-design-routes.ts:328`). The shipped compose passed neither `--design-review` nor
`--require-design-review`, so the check was skipped: **the tenant's own `erp_admin` designed a
manifest, reviewed their own diff in `/setup`, and clicked Activate.** The compose comment above
`--ai-design` claimed *"a reviewer approves it, and activating it makes it that tenant's live
schema"*, and both halves were false. `/setup`'s own copy claimed *"you review everything before
anything goes live"*.

**Three. The design spec asked for six of the manifest's sixteen sections.**
`DESIGN_SYSTEM_PROMPT` is 4,834 characters and — measured against the committed build — mentions
neither `workflow` nor `extends`, and `DESIGN_EXAMPLE_MANIFEST` has no `workflows` key. So **every
AI design had zero workflows and zero transitions**, in a product whose generated systems are
supposed to have lifecycles, and every design was standalone and therefore a replacement.

Taken together these were a one-click path to a tenant replacing their own ERP with a handful of
workflowless tables that nobody checked — on a deployment where the acceptance floor is low enough
that a model replying with the fifteen characters `{"entities":[]}` is recorded as a successful
design with a real `manifestHash`.

## Decision

Ship all three, in this order, and the order is the decision rather than a sequencing detail.

**Lineage first.** A review gate over a manifest that replaces the pack is *worse than no gate*: it
launders the replacement through a human who is shown a diff covering five of sixteen sections.
That is this repo's falsely-true-control direction (ADR-0337), so the gate must not land before the
semantics it is approving are correct. The plan's own batch 19 said "gate first in the commit
order", and it was right about a different pair — the gate before the API key, because without a key
nothing reaches activation at all. Both hold: lineage → gate → key.

**1. `TenantGatewayCache` resolves a tenant's manifest, between parse and validation.** That
position is the whole point and it is measured, not reasoned: a child declaring
`extends: ["operate-erp/core"]` and referencing core's `Account` is **refused** by
`tryValidateManifest` when unresolved (`reference targets unknown entity 'Account'`) and **ok**
once resolved, where it yields the 52-entity / 16-role union in **one** `getManifest` call. Putting
resolution after validation would therefore have been inert.

**A tenant may extend only the manifest this deployment itself serves** (`TENANT_PARENT_POLICY`).
The boot manifest is the one this deployment has already surveyed, provisioned and declared — its
unique-index enforcement (ADR-0360), PHI storage decision (ADR-0338), list-surface survey
(ADR-0359) and ABAC obligation check (ADR-0340) were all computed over it — so a tenant extending
anything else would inherit entities the deployment never checked. One registry entry is
*sufficient and complete*, because `stripExtendsFromMeta` is applied to the composed manifest, so a
resolved manifest carries no `meta.extends`: handing the boot manifest back resolves it to itself
with zero further lookups and no possibility of a loop. Verified both ways.

Resolution is **unconditional** and the registry is a **required** constructor option. A manifest
with no `extends` resolves to itself and costs nothing, so there is no efficiency argument for a
flag — and an optional registry defaulting to "do not resolve" would be the pre-fix answer kept as
a default, reachable by anyone who forgets the argument.

**A resolution failure is a `refused` — a 503 naming the tenant — and not the `{kind: "none"}`
fallback.** `none` serves the tenant *the deployment's* gateway, so a tenant whose activated
manifest cannot be interpreted would be silently served the base pack with nothing saying their
activation did nothing: ADR-0314's "their data is in a different place than they think". Both of
today's outcomes for such a manifest are wrong — silent replacement, or silent fallback — and a
named 503 is the honest third. Three new `GATEWAY_BUILD_REFUSAL_KINDS` members
(`lineage_parent_unknown`, `lineage_cycle`, `lineage_override_undeclared`), all **permanent**,
because none clears without the tenant changing their manifest and activation already invalidates
the cache. They classify through the existing `REFUSAL_BY_ERROR_NAME` map on `Error.name` rather
than `instanceof`, for the reason that map already documents: an `instanceof` across a package
boundary is defeated by two resolutions of one module through `dist/`, and a missed match
degrades to `unknown`, which is transient — the safe direction.

**2. The compose requires platform approval, through one flag.** `--require-design-review` sets
`designReview` too, and passing `--design-review` **alone would be worse than passing neither**:
the review routes would mount over a permanently empty queue, because enrolment is gated on
`requireDesignReview` and the catalog's `review_status` default is `not_required`, which the
activation gate denies. A reviewer would read "nothing pending" while every proposal activated
unreviewed.

Two CLI refusals land with it, both for flags that would otherwise be **silently inert** — the one
thing worse than not having them, since an operator who asked for an approval gate and got none
believes their tenants' designs are reviewed. `--design-review` requires a Postgres store, because
`reviewStore` is built only inside `options.designReview && conn !== undefined`. And it requires
`--ai-design`, because `source: "ai"` in `buildDesignRoutes` is the **only** proposal producer in
the workspace — `MANIFEST_PROPOSAL_SOURCES` declares `manual` and nothing writes it — so a reviewer
without the Architect is handed a console over a queue that can never be non-empty.

**3. The Architect is told about `meta.extends` and `entityLifecycle` workflows.** Without this the
inheritance mechanism ships **with no producer**, which is this repo's most-found defect committed
inside the increment that names it. The prompt becomes a function of the deployment's pack slug,
**required and nullable**: `null` is the claim *this deployment serves no named pack* (a
`--manifest` file deployment), where an optional parameter would be a forgotten argument. The
change is not inert, measured against the committed build: `normalizeGeneratedManifest` preserves
both a `workflows` key and `meta.extends` untouched.

## Alternatives considered

- **Option A: resolve a tenant's lineage against any built-in pack slug.** The registry for all
  seven already exists in `manifest-source.ts`.
  - **Pros:** more useful; zero extra code.
  - **Cons:** a tenant could inherit a pack the deployment never surveyed, so every boot survey
    would describe a manifest that is not the one being served.
  - **Why not:** narrower is safer and extends later without a migration. The policy has one
    spelling (`TENANT_PARENT_POLICY`) precisely so widening it is a single visible edit.

- **Option B: treat a resolution failure as `reportInvalid` → `{kind: "none"}`.**
  - **Pros:** no new refusal kinds; a tenant naming an unknown parent still gets a working system.
  - **Cons:** the system they get is the base pack, with nothing saying their activation did
    nothing. "The base plus my bits" silently becoming "the base" is the ADR-0314 class.
  - **Why not:** a wrong answer ranks below a refusal in this repo, and the caller already has a
    `refused` arm that produces a 503 naming the tenant.

- **Option C: gate activation first and fix lineage later.** The plan's stated order.
  - **Pros:** one compose line; closes the unreviewed-activation hazard immediately.
  - **Cons:** the reviewer approves a pack replacement, over a diff that covers five of sixteen
    sections. The approval makes the destruction *authorised* rather than preventing it.
  - **Why not:** ADR-0337's falsely-true control. A gate is only worth having over semantics that
    are already right.

- **Option D: make the lineage registry an optional constructor option, defaulting to no
  resolution.**
  - **Pros:** a strictly additive change; every existing construction site keeps compiling.
  - **Cons:** it is the defect preserved as a default. Every test double and every future call site
    would silently get the pre-fix behaviour.
  - **Why not:** `node.ts` is the only non-test construction site, so required costs one edit.

- **Option E: switch `--store pg-columns` in the same increment, so an activated manifest gets
  typed Postgres tables.**
  - **Pros:** it is what ADR-0314 describes, and it is one flag.
  - **Cons:** `ColumnMappedEntityStore` refuses a classified field with no
    `COLUMN_ENCRYPTION_SECRET` (ADR-0338), and the Architect's own prompt instructs the model to
    classify PHI — so it would turn a design into a boot refusal. It also needs a migration
    decision for any tenant already holding JSONB rows.
  - **Why not:** a store decision, not a flag. Stated in the compose and the README instead of
    done quietly; see *Open questions*.

## Consequences

- **Positive.** An activated manifest *adds to* the deployment's system instead of replacing it, so
  the headline feature stops being destructive. Nothing activates without a platform reviewer. The
  Architect can author a lifecycle. `meta.manifestResolution` records the parent's slug, version and
  hash on the resolved manifest, so what a tenant is being served has provenance. Three refusal
  kinds mean a tenant whose manifest cannot be interpreted gets a 503 naming why instead of
  somebody else's rules. Two CLI refusals make a review gate that cannot fire impossible to
  configure.
- **Negative.** Proposals minted before the gate went live are **permanently unactivatable** — the
  activation gate denies `not_required` as well as `rejected`, deliberately, so turning review on
  leaves no back door — and must be designed again. The prompt is longer, which costs input tokens
  on every design and matters most on the local-model path where the context budget is already the
  likeliest failure. A tenant extending a non-boot pack now gets a 503 where they previously got a
  silently wrong answer: better, and still a new failure an operator will meet.
- **Neutral.** Resolution runs on every gateway build, including for the manifests that have no
  `extends`; measured at one no-op call. The reviewer's diff still covers five of sixteen sections
  with no `jobs` and no `views` layer, so the gate is real and its *view* is still partial.
- **Reversibility.** The gate is one compose line. The prompt is one file. Lineage resolution is
  reversible in code but **not in effect**: once tenants have activated extending manifests, their
  served systems depend on the merge, so removing it would take the parent's entities away from
  them — the same destruction this ADR fixes, in the other direction.

## Implementation notes

- `apps/operate-server/src/tenant-manifest-lineage.ts` is new and pure: no SQL, no env, no clock.
  `buildTenantManifestLineage(parent)` returns the registry and the permitted slug **as one
  object**, derived from one source, so a registry whose permitted slug said something else cannot
  be formed (ADR-0342's grouping rule). `permittedParentSentence` exists because
  `UnknownParentManifestError` names the parent that was *asked for* and has never been told which
  one was allowed — a refusal an operator cannot act on is worse than none.
- Resolution goes between `safeParse` and `tryValidateManifest`, and both `tryValidateManifest` and
  `this.build` must receive the **resolved** object. Passing `parsed.data` onward is the original
  bug restated, which is why a test asserts the built manifest carries a parent's entity.
- Measured against the built kernel, as the premises this rests on: the boot pack resolves to 51
  entities / 15 roles and carries no `meta.extends`; a child extending it validates only after
  resolution; the union is 52 / 16 in one registry call; `manifestResolution.parents` records
  `operate-erp/core`; an unknown parent, a self-slug collision and a redeclared `Invoice` raise
  `UnknownParentManifestError`, `ExtendsCycleError` and `UndeclaredEntityOverrideError`
  respectively.
- `--require-design-review` implies `--design-review` at `cli.ts:1132-1134`; the compose states
  `--design-review-role platform_admin` explicitly even though it is the default, because this is
  the grant that separates "designs the system" from "approves the system" and a four-eyes-shaped
  decision belongs in the file an operator edits. A tenant's own `erp_admin` holds
  `--ai-design-role` and not this one, which is what makes the separation real.
- The store refusal for `--design-review` is reachable only on a deployment that did **not** pass
  `--ai-design`, because that flag's own store refusal fires first and is the better sentence
  there. It is kept as its own condition rather than left to that entailment, so removing the
  producer arm cannot silently take the store requirement with it.
- Three pieces of copy were false and are corrected rather than deleted, each with the correction
  recorded beside it: the compose comment above `--ai-design`, `/setup`'s "you review everything",
  and the membership form's *"Free text, because no route serves the list"* — which is false,
  `GET /v1/meta/schema` is flagless and returns all fifteen roles with labels. What is true is
  narrower: that route answers for the **caller's** tenant, so a platform operator administering
  someone else's would be offered their own roles.
- **A fourth figure was corrected mid-increment and it is the plan's, not this repo's.** The batch
  plan records the reviewer's diff as covering "4 of 16 sections (`manifest-diff.ts:298,310,382,465`)"
  and the register records 5; the register is right. Those four line references are the four *layer
  functions*, and they miss that relations and roles ride on other layers, and that
  `classificationLayer` is a second read of entities rather than its own section. `ManifestDiffView`
  carries changes over entities, relations, roles, permissions and **workflows**, where
  `LifecycleWorkflow` is `Extract<…, { kind: "entityLifecycle" }>` and `lifecycleLayer` reports
  "lifecycle added with N states". The half of that worth having is the second one: **a workflow
  this increment teaches the Architect to emit is shown to the reviewer**, so the prompt change and
  the gate compose rather than passing each other. Measured end to end on the real `diffManifests`:
  adding a lifecycle yields `[{entity: "Visit", detail: "lifecycle added with 3 states"}]` at impact
  `additive`, and narrowing one yields `"states removed: in_progress; transitions removed: start"`
  at impact **`breaking`**. The figure had been propagated into five files before it was measured,
  which is why it is written down here.
- **And `meta.extends` is invisible to the reviewer**, which is a gap this increment *creates*.
  Measured on the same function: adding `meta.extends` leaves the view `comparable` with all counts
  zero and no warnings. So the one fact every AI design now declares — which pack it builds on — is
  absent from the page where it is approved. It is *enforced* rather than trusted, since resolution
  refuses any parent but the deployment's own, so the gap is in what a reviewer can see; it is an
  open question below rather than a silent cost.
- **A trap worth recording, because it cost two independent readings.** `diffManifests` returns
  `emptyView()` — `comparable: false`, every list empty, every count zero — when either side fails
  `parseManifest`. Both the first measurement here and the Architect slice's concluded "workflows
  are not in the diff" from a fixture that used `initial` and string states where the schema wants
  `initialState` and state objects, and read the resulting empty view as the answer. **An
  unparseable manifest and an unchanged one differ only in the `comparable` flag**, so any reader of
  this function that ignores that flag reads "nothing changed" for a proposal it could not parse.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The reviewer's diff covers 5 of 16 manifest sections with no `jobs` and no `views` layer, both of which are served — so a design can change what a request gets unseen. Batch 19 items 58/41. | Platform | 2026-11-30 |
| `meta.extends` is invisible in `ManifestDiffView` (measured: zero counts, zero warnings), so a reviewer approving an AI design cannot see which pack it builds on. One layer, and the first consumer of it is the page this increment just turned on. | Platform | 2026-11-30 |
| `diffManifests` answers `comparable: false` with every count zero for an unparseable manifest, which is one flag away from "nothing changed". Whether `design-review-routes.ts` distinguishes the two on the reviewer's page is unverified. | Platform | 2026-11-30 |
| No per-tenant Postgres schema is applied on `--store pg`: `applyTenantManifestSchema`'s only caller is `TenantColumnStoreRegistry.ensure`, built only for a `ColumnMappedEntityStore`. Switching stores is Option E and needs a PHI-key and migration decision. | Platform | 2026-12-15 |
| A role picker for the membership form needs a platform route answering for the **administered** tenant, over the `MembershipRoleDirectory` that `membership-role-fence.ts` already builds. | Platform | 2026-11-30 |
| Whether a tenant may extend a pack other than the deployment's own, and what boot survey would then describe what is served. `TENANT_PARENT_POLICY` is the one place to widen. | Platform | — |
| The acceptance floor: `{"entities":[]}` is still a successful design. With a reviewer in the path this is now caught by a human rather than by the platform; a structural floor is a separate decision. | Platform | 2026-12-15 |

## References

- ADR-0314 — per-tenant schemas, and "their data is in a different place than they think".
- ADR-0331 — a claim versus nobody looked; required-and-nullable over optional.
- ADR-0337 — a falsely-true control is worse than a falsely-false one.
- ADR-0340 — a manifest declaring what the deployment cannot honour is refused at boot.
- ADR-0342 — grouping options that must agree, so a wrong pairing cannot be formed.
- ADR-0359 — `serverFor`'s three arms, and a per-tenant gateway that could not be built.
- ADR-0365 — an undeclared membership role is a silent total denial.
