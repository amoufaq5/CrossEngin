# ADR-0388: A diff that covers five of seventeen

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-27 |
| **Authors** | Claude Opus 5 |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0330, ADR-0331, ADR-0334, ADR-0348, ADR-0359, ADR-0361, ADR-0368 |

## Context

A tenant describes their business, the Architect designs a manifest, a reviewer approves it, and
activating it makes it that tenant's live schema (ADR-0368). The page the reviewer approves from
renders `ManifestDiffView`, and the register's P1.2 entry says it covers 5 of 16 sections. The
class is **a comparison whose aperture is narrower than the artifact it compares** — ADR-0361's
class, one level out from a field list to a whole manifest.

Everything below was re-derived against the committed tree. Four of the register's claims survive,
three do not, and one defect was in neither the register nor this file.

**The count.** `ManifestSchema.shape` has **18** keys and **16** content sections, which is right
as the register states it. But `meta` is not metadata for this purpose: `meta.extends` decides
whether a design *extends* the deployment's pack or *replaces* it, and this file already records
that adding it leaves the view `comparable` with every count zero. Counting `meta` in, the honest
denominator is **17 sections two manifests can differ on** — `manifestVersion` being the one
exclusion, and a *proof* rather than a convention: the schema pins it to `z.literal("1.0")`, so two
manifests that both parse cannot disagree about it.

**The coverage.** Measured by running `diffManifests` from `apps/operate-server/dist` against the
real `buildErpCorePack()` rather than by counting layer functions — this file records an earlier
reading getting that wrong by miscounting four layer functions as four sections. The five covered
are `entities`, `relations`, `roles`, `permissions` and `workflows`. The three cases the register
names come back **byte-identical to an unchanged manifest**:

| change to real `erp-core` | `ManifestDiffView` |
|---|---|
| remove job `erp-core-overdue-invoice-reminder` | `impact=none warn=0 counts={0,0,0,0}` |
| narrow view `account.list` from 5 columns to 1 | `impact=none warn=0 counts={0,0,0,0}` |
| add `meta.extends: ["operate-erp/core"]` | `impact=none warn=0 counts={0,0,0,0}` |
| *(control)* unchanged | `impact=none warn=0 counts={0,0,0,0}` |

**Three of the register's claims are refuted.**

1. *"two of the eleven (`jobs`, `views`) are served"* is **three**, and the omitted one is the one
   that produces database columns: `manifest.traits` has **20** non-test readers (re-measured by the orchestrator at **22 source files** under a looser predicate — the figure moves with what counts as a read, so the set is the durable part) including
   `column-plan.ts`, `write-mask.ts`, `list-query.ts`, `column-encryption.ts`,
   `sensitive-field-policy.ts`, `cursor-encryption.ts` and `unique-enforcement.ts`. The register is
   right about which two are *both* served and declared by a shipped pack, because **no pack
   declares a custom trait** — a census across all seven source packs gives 0 for `traits`,
   `integrations`, `files`, `reports`, `dashboards`, `customWidgets`, `theme`, `i18n` and `search`.
   So the trait exposure is reachable from a hand-edited proposal, from a model exceeding the
   design spec, and from `resolveCompliancePacks` — whose `gdpr`, `hipaa` and `uae-moh` packs each
   contribute a custom trait, `gdpr`'s carrying a **required enum** `legal_basis` — and which is
   callerless today (register P0.8).

2. *"a reviewer approves eight sections that are discarded"* is backwards, and the register already
   says so. What it does not say is that the consequence of `views` being uncovered is sharper than
   a missing summary line: `listConfigForEntity` takes `columns`, `sort` and `pageSize` from a view
   and derives `sortableFields`, `filterableFields` and `searchableFields` from its columns, and
   since ADR-0359 a request naming a field that is no longer filterable is answered **400**. So
   narrowing a view's columns turns a working `?field=` filter into a refusal, invisibly. For
   `jobs`, `invokeRolesByAction` makes `jobs[].invokeRoles` an **authorization input** at
   `POST /v1/meta/jobs/invoke`, so a `jobs` change can widen who may invoke a job without the
   permission layer — which reads `manifest.permissions` alone — seeing anything.

3. **A defect in neither the register nor this file.** `computeManifestDiff` passes `next.traits`
   to `computeEntityDiff` as the one `customTraits` list, and `computeEntityDiff` applies it to
   **both** sides — so the *old* entity was resolved against the *new* trait definitions. Measured
   through the reviewer's own diff view: a trait field retyped, a trait field removed, and a trait
   field's classification weakened `phi` → `internal` each answered `impact: none` with every count
   zero, while `columnPlanForEntity` reads `manifest.traits` so the served table genuinely gains,
   loses or retypes that column. This is a kernel bug and it is the covered 5 being *silently
   wrong* rather than merely narrow.

**And `assessManifestRisk` is still on the narrow side of ADR-0361's split**, which the register
lists as open and which this increment confirms rather than closes: it reads `doc["entities"]` and
never `doc["traits"]`, so the identical `phi` field reports a `phi_data` finding on
`entity.fields` and **no such finding** on a trait. The masking makes it worse than the bare fact —
both fixtures read `level: "high"` because `no_permissions` fires, so an operator reading the level
would not notice the `phi_data` finding had gone. It is in `apps/operate-server/src/design-review.ts`
and outside this increment's scope.

## Decision

Two parts, in the kernel, plus the renderer.

**1. Each side of a manifest diff is resolved against its own manifest's traits.**
`resolvedAgainstOwnTraits` pre-expands the old entity against `old.traits` and hands
`computeEntityDiff` an entity carrying `traits: []`, so the diff's own `expandTraits` call
contributes nothing and `fields` already holds the old resolution. Index resolution and the
removed-column map then read exactly what they would have for the real pair.
`checkEntityFieldNames` is called at the pre-expansion site because the diff's copy of it then has
an empty trait list and could no longer catch an own-field/trait-field collision on the old side.

**2. A section census, derived from the schema.** `packages/kernel/src/manifest/sections.ts`
declares `ManifestSectionName = Exclude<keyof Manifest, "manifestVersion">` — a type derived from
`ManifestSchema` — and three total maps over it, so **adding a section to the schema is a compile
error** rather than a section nothing compares. `diffManifestSections(active, next)` answers which
sections differ, named member by member, with:

- `MANIFEST_SECTION_REACH` — `served` / `validated_only` / `unread`, so a finding names a
  consequence rather than reporting an inert declaration. Measured: **9 served, 5 validated_only,
  3 unread**. Taken as `served` wherever *any* key of the section is served, because
  under-reporting a reach is the dangerous direction.
- `MANIFEST_SECTION_MEMBER_KEYING` — `record` (10) / `named_array` (2) / `object_keys` (4) /
  `unkeyed_array` (1), which is how a change is reported as more than a count. `meta` keyed by its
  own keys is what surfaces `extends` **by name**.
- `manifestSectionChangeMayWithhold` — whether the change can take away something a request
  currently gets. A *may*, deliberately over-reporting.

**Equality is `canonicalizeForHash`**, the function `manifestHash` already commits through. So for
a parsed manifest a section this reports unchanged contributes identical bytes to the hash the
reviewer approves, and there is no second notion of "the same manifest" to drift from the first.
The one deliberate exception is `meta.manifestResolution`, which the hash strips too.

**The census reports every differing section and holds no opinion about which a caller renders in
detail elsewhere.** A filtering list in the consumer would be ADR-0288's maintained list — wrong
three times in this repo — and without one a seventeenth section needs no consumer change to be
shown. Duplication between a section summary and a detail block is a summary above a detail block,
not a defect.

**3. The renderer shows it, and may not say "No changes" while a section differs.** `DiffView`
returned early on `impact === "none"`, which is the whole reason the three measured cases read as
"This proposal matches the currently-active system". The early return now reads `sectionChanges`
too, so the page cannot label a changed section `none`. `sectionChanges` is **optional** on the web
mirror: a server a build behind sends nothing and the page reads exactly as today.

**And the chip and banner read `diff.impact` as the server computed it, which is a correction to
this ADR's first draft rather than its plan.** That draft recomputed the impact on the client from
`sectionChanges.some(mayWithhold)`, and because the census is coarse by design while the server
suppresses its upgrade for the five sections a detail layer reads, the two **disagreed**: measured
against the real `diffManifests`, adding one *optional field* changes the `entities` section,
`entities` is served, so the census answers may-withhold and the browser read `breaking` over a
server that said `additive`. A client re-deriving a judgement the server already made, with a
different rule — and `operate-web` has zero tests, so nothing would have caught it. The second fold
is deleted; the `No changes` guard stays, because it reads `sectionChanges` for its *presence* and
not its verdict, which is what keeps the page honest against a build whose `impact` predates the
census.

## Alternatives considered

- **Option A: put `sectionChanges` on `ManifestDiff`.** It would ship with a producer
  (`computeManifestDiff`, four non-test callers) and two live consumers needing no wiring at all —
  `crossengin diff --format json` prints `{ diff }` whole, and the Architect's `diff_manifests`
  tool `return`s the object whole.
  - **Pros:** no dead mechanism at commit time; the strongest possible answer to this repo's
    most-found class.
  - **Cons:** `packages/ai-architect/src/diff-summary.test.ts` carries **7 constructions** of
    `ManifestDiff` — one annotated `const emptyDiff: ManifestDiff = {…}` at `:6` and six object
    literals passed to `diffSummaryFromManifestDiff`, whose parameter is `ManifestDiff`. A required
    field is `TS2741` at all seven, in a package this increment may not edit. (Counted, because an
    earlier draft of this sentence said eight.)
  - **Why not:** breaking another package's typecheck to avoid a wiring line is the worse trade. An
    *optional* field would have avoided it and reintroduced ADR-0331's conflation — a consumer
    could not tell "not computed" from "nothing changed" — in the one record whose job is to keep
    those apart.

- **Option B: derive the member keying at run time by probing `ManifestSchema.shape`.** The probe
  works: unwrap `ZodOptional`/`ZodEffects`, then `ZodArray` with a `name` on its element →
  `named_array`, `ZodRecord` → `record`, `ZodObject` → `object_keys`, else `unkeyed_array`. It
  answers for **17 of 17** with nothing unreadable.
  - **Pros:** no declaration to drift.
  - **Cons:** a run-time answer cannot be a compile-time obligation, it couples the shipped module
    to zod's internals, and `named_array` has to *know* the key property is `name` where the probe
    can only pick it from candidates.
  - **Why not:** declared in the module and the probe run in the test, comparing both ways — this
    repo's `pg-value-set-domains.ts` shape. Both halves present: the type gives the compile error,
    the probe catches a stale or reshaped declaration.

- **Option C: exclude a content section from the census by optionality.** The two non-content keys
  are exactly the two **required** keys of `ManifestSchema`; all 16 content sections are optional.
  - **Pros:** a one-line derivation with 18 of 18 agreement.
  - **Cons:** it is a coincidence, not a rule. Making `entities` required would silently drop it
    from the census.
  - **Why not:** the one exclusion rests on a proof instead (`manifestVersion` is a single
    literal), asserted by a test. The coincidence is recorded here so nobody simplifies to it.

- **Option D: let the kernel declare which sections a consumer already renders in detail.** It
  would stop a section summary duplicating a detail block.
  - **Pros:** no five-name list in `operate-server`.
  - **Cons:** it is a fact about *operate-server's five layers*, not about `ManifestDiff`, so the
    kernel would be modelling a consumer's rendering.
  - **Why not:** eliminated rather than relocated — the census reports everything and the
    duplication is a summary line, so there is no list in either place.

- **Option E: a second notion of equality, so reordering `relations` is not a change.** Multiset
  comparison over canonical members would make a reorder a no-op.
  - **Pros:** fewer false positives on a semantically irrelevant edit — `topologicalEntityOrder`
    decides DDL order, not the array.
  - **Why not:** `canonicalizeForHash` leaves an unnamed array in place, so a reorder **does** move
    `manifestHash`. A second equality would let the census call unchanged a section whose
    contribution to the approved hash moved, which is the one property the module rests on.

- **Option F: fix `assessManifestRisk`'s trait blindness in the same change.** Confirmed live and
  it is the approval gate.
  - **Why not:** `apps/operate-server/src/design-review.ts` is outside this increment's scope, and
    its fix is `resolvedClassifiedFields` plus a decision about `normalizeEntities`' raw-document
    shape. Named in Open questions with its measurement.

## Consequences

- **Positive:** the three cases the register names are reported, measured against the real
  `erp-core`: a removed job reads `jobs[served] -1 {-erp-core-overdue-invoice-reminder}`, a narrowed
  view `views[served] ~1 {~account.list}`, and an added lineage declaration
  `meta[served] +1 {+extends}` — with the unchanged control still reporting nothing. A trait field
  removed or retyped is now a real field change through the entity layer, and `destructive` is true
  for the removal.
- **Negative:** `computeManifestDiff`'s behaviour changed for every caller, so this needs the full
  sweep rather than a per-package run (ADR-0329). A trait field whose **type kind** changes now
  raises `UnsupportedDiffChangeError` exactly as an own field does, which is consistent and routes
  `operate-server`'s `entityLayer` catch to `fallbackEntityLayer` — a comparison over
  `entity.fields` that is itself trait-blind, so that one case is covered by the census and not by
  the entity layer.
- **Negative:** the census is a **fourth** mirror of the diff view's shape once wired
  (`manifest-diff.ts`, `design-review-routes.ts`'s `ManifestDiffViewLike`, `DiffView.tsx`). Nothing
  compares the three, which is pre-existing and now one field wider.
- **Neutral:** `MANIFEST_SECTION_REACH` is a judgement about the workspace, like
  `pg-binding-names.ts`' divergence reasons, so whether a declared reach is true is unverifiable by
  machine. What is machine-checked is that the map is total and that its distribution is the
  measured one.
- **Neutral:** a trait field's *classification* is still not reported by the entity diff, correctly
  — it moves no column, so `computeFieldModification` does not compare it. The census reports it as
  `traits: changed`.
- **Reversibility:** the census is additive and reverting it is deleting two files, one `index.ts`
  line and one web block. The trait fix is three lines and reverting it restores a wrong answer.

## Implementation notes

`sections.ts` imports `canonicalizeForHash` from `./hash.js`; there is no cycle. `manifest/index.ts`
re-exports it, and `packages/kernel/src/index.ts` already does `export * from "./manifest/index.js"`,
so no root-index edit was needed.

**The edit `apps/operate-server` needs, which this increment could not make, is one file.**
`manifest-diff.ts`: import `diffManifestSections` and `manifestSectionChangeMayWithhold` from
`@crossengin/kernel/manifest`; add `readonly sectionChanges: readonly ManifestSectionChangeView[]`
to `ManifestDiffView` with `[]` in `emptyView()`; in `compare()` compute
`const sectionChanges = diffManifestSections(active, next).map((c) => ({ ...c, mayWithhold: manifestSectionChangeMayWithhold(c) }))`,
add `sectionChanges.length > 0` to the `changed` disjunction, and make `impact` read `breaking`
when any `mayWithhold` is true.

**`design-review-routes.ts` is deliberately not on that list, and a draft of this ADR had it
there.** Measured rather than reasoned: `ManifestDiffViewLike` is a *structural* mirror, TypeScript
narrows at compile time and strips nothing at run time, and `diffFragment` returns
`{ diff: diffManifests(active, next) }` which the handler spreads into `json(200, …)`. Calling the
real `diffFragment` from `dist` with a differ that returns an extra `sectionChanges` key, the
serialized body **keeps it**. So the mirror edit buys nothing for the data path; it is worth making
only so the mirror stays an honest description of what travels, and only `operate-server` code that
wants to *read* the field needs it.

Without that edit the kernel half is reachable from `crossengin diff --format json` and the
Architect's `diff_manifests` tool and **not** from the reviewer's page — this repo's most-found
class, and the reason the wiring is specified rather than assumed. The web half is complete and
independently safe: `sectionChanges` is optional there, so a server that does not send it renders
exactly today's page.

Verified: `pnpm --filter @crossengin/kernel test` 801 passing, `typecheck` and `build` clean;
`apps/operate-web` `npx tsc --noEmit` and `npx next build` clean. The section census was exercised
against a real pack pair (`erp-core` → standalone `erp-healthcare`: 8 sections, every one `served`,
every one `mayWithhold`) as a non-vacuity control. Nothing was verified against a live Postgres or
a running server, because nothing here touches SQL or the request path.

Mutations run, each reversed by inverse string replacement with the mutant asserted present before
and absent after: reverting the trait fix (4 of 4 trait tests fail); dropping a section from
`MANIFEST_SECTION_NAMES` (the order test fails); **adding an 18th section to `ManifestSchema`
(TS2741 at both total maps, plus 3 test failures)**; collapsing `presenceOf`'s absent/empty
distinction (4 fail); removing the `manifestResolution` skip (1 fail); downgrading `jobs`' reach
(2 fail); keying `relations` as a record (3 fail); and four mutations of
`manifestSectionChangeMayWithhold` (1, 1, 1 and 3 fail). `satisfies readonly ManifestSectionName[]`
on the array is **not** a fence — a shorter array is still assignable — so the array's completeness
rests on the runtime order test and the compile error rests on the maps.

## Addendum: a silent layer is not a verdict

An adversarial pass over the committed increment found that **the suppression this ADR shipped was
the right idea at the wrong granularity**, and that the two gaps it leaves are in the layers rather
than in the census. Three findings, each reproduced against the committed tree before it was acted
on; the first is the serious one.

**1. `SECTIONS_WITH_DETAIL_LAYERS` suppressed per *section* while a layer covers only part of its
section**, so the census was overruled by a layer that had seen nothing — an absence of information
read as a verdict of `additive`, which is ADR-0372's own class inside one predicate. Measured, five
withholding changes across four of the five covered sections read `additive` with every layer
silent:

| change | section | layers | before | after |
|---|---|---|---|---|
| `abac: "own_rows"` added to a `list` grant | `permissions` | all zero | `additive` | `breaking` |
| a role loses its `inherits` | `roles` | all zero | `additive` | `breaking` |
| `unique: true` added to a field | `entities` | all zero | `additive` | `breaking` |
| a transition retargeted (`to`) | `workflows` | all zero | `additive` | `breaking` |
| a transition re-sourced (`from`) | `workflows` | all zero | `additive` | `breaking` |

The first is the sharpest: ADR-0340 refuses an undischargeable obligation **at boot**, so for a
tenant whose deployment declares no evaluator that is a permanent 503 approved as additive.

The set is replaced by `SECTION_DETAIL_LAYER`, a **total map over all 17 sections** from section to
the function that counts what its layer reported, `null` for the twelve no layer reads — so the
entry *is* the reader and the stale-entry hazard a membership list carries cannot arise. The nine
view fields it reads are a `Pick` of `ManifestDiffView`, built once in `compare` and **spread into
the returned view**, so what decides the suppression is what the reviewer is shown rather than a
second derivation of it. Four controls whose layer did speak are unmoved: an optional field added
stays `additive` (`fieldChanges: 1`), a lifecycle **state** added stays `additive`
(`lifecycleChanges: 1`), a widened `list` grant stays `additive`, and a removed field, a cascading
relation and a removed role stay `breaking` on their own warnings.

Two costs, stated rather than discovered later. A **cosmetic** change inside a covered section its
layer cannot see now reads `breaking` — a role's `description` moving is the measured member — which
is the same cost every *uncovered* section already pays, and is the safe direction. And the
granularity is the section: a change adding an optional field to one entity *and* `unique: true` to
another reads `additive`, because `entityLayer` spoke about the first. Per-member matching is
**refused on measurement** — three of the five sections align (`entities`, `permissions`, `roles`
key by the name their layer reports) and two cannot, since `workflows` keys by workflow name while
`lifecycleLayer` reports by **entity** (so a per-member rule would regress the lifecycle-state
control above) and `relations` is `unkeyed_array` with no member keys at all.

**2. `grantMap` never read the third field-grant arm.** ADR-0348 added `FieldPermission.create` two
increments ago and this map reads `fields.*.read` and `fields.*.update` only, so a narrowed `create`
grant — who may **set** a field at registration — produced no `PermissionChange` at all. With
finding 1 fixed the census now calls it `breaking`, so the verdict was recovered and the **detail**
was still missing: the reviewer saw `permissions` changed with nothing naming the field. It is read
directly and never through `fieldWriteGrant`'s `create ?? update` fallback, because resolving the
fallback would report an inherited `update` grant twice and a declared `create` grant not at all.
`isDestructiveOperation` deliberately excludes `create` at both scopes, which is ADR-0348's
asymmetry: widening who may *set* a field discloses nothing, where widening who may *change* one
lets a value be destroyed by someone who cannot read it.

**3. One relation kind flip keeps its label, so neither half saw it.** `relationLabel` is
`from.field → to`, identical for `many_to_one` and `one_to_many` over the same triple, and
`relationOnDelete` compares only the delete rule — while `relations` is `unkeyed_array`, where a
same-count content change answers `mayWithhold: false`. Measured: `additive`, no detail, no warning.
The kind is compared **before** `onDelete` now, reported as a `modified` change carrying
`kind many_to_one → one_to_many`, with a new `relation_kind_changed` breaking warning. A flip
involving `many_to_many` needs no arm: its label is `left ↔ right` and `{kind, left, right}` is the
whole of that member, so it already arrives as a removal plus an addition — asserted by a test
rather than assumed.

**What the flip costs is not what it looks like, and the first draft of the warning said the wrong
thing.** It does *not* move the foreign key: the column comes from the field's `reference` type
rather than from the relation declaration. What only `many_to_one` does is bind a column on `from`
— a `one_to_many`'s `field` names an inverse collection, which `validate.ts`, `extends.ts` and
`column-plan.ts` each say in their own words — so after the flip `relationDeleteIndex` drops the
relation and `entity-ddl.ts`'s `onDeleteFor?.(col.field) ?? "restrict"` reverts the key to RESTRICT.
A declared CASCADE or SET NULL is silently lost, so a parent delete that used to succeed starts
failing, `boot-schema-targets.ts` re-weights the Article 17 delete order off the same index, and
validation stops requiring `field` to exist on `from`. And it is **applied** rather than merely
described, which the additive-only migration rule might have suggested otherwise:
`compositeFkStmts` emits `DROP CONSTRAINT IF EXISTS` before its `ADD`, so every `ensureSchema` run
replaces the key with the new policy. Still breaking, for a different reason than the draft gave — caught by measuring the claim before committing it, which is this register's P3.1
discipline applied to a message the author had just written. The test's active side therefore
declares CASCADE, so the fixture exercises what the warning says; and a second test pins that a
simultaneous kind-and-`onDelete` change reports the **kind alone**, which is the right consequence
of comparing the kind first, since naming `onDelete restrict → cascade` beside it would name a rule
that will never be applied.

One suspicion was **refuted** and is recorded because its absence is the reason finding 3 is narrow:
a `many_to_many` relation has no content outside its label, so `relationOnDelete` answering `null`
for it is complete rather than a gap.

**4. And a fourth, in this increment's own work: the route's mirror never got the field.** This ADR
added `sectionChanges` to `ManifestDiffView` and to the web mirror and left
`design-review-routes.ts`'s `ManifestDiffViewLike` untouched — the deliberately-decoupled structural
mirror that is what the *route's own type* says a reviewer receives. At runtime the field still
reaches the wire, because the route is `return { diff: diffManifests(active, next) }` and
`JSON.stringify` serializes own properties rather than declared ones, which is exactly why nothing
broke and nothing noticed. The cost is twofold and the second half is the real one: `ManifestDiffer`
is an **injection seam**, so a differ satisfying the mirror could omit the census entirely and
typecheck — and both route stubs in this app were in that state, serving a response the route's type
did not describe. ADR-0386's class — an absent field whose omission is unobservable — on the
surface this ADR exists to fix.

This was already on file as this ADR's own open question (*"four mirrors of one view shape, compared
by nothing"*); it had a live member and nobody had looked. The field is **required** on the mirror,
which found the second stub immediately. And the general fence is in, because assignability only
checks one direction: passing `diffManifests` as a `ManifestDiffer` proves the real view has *at
least* the mirror's fields, and the reverse is unchecked by construction, so
`AssertNever<Exclude<keyof ManifestDiffView, keyof ManifestDiffViewLike>>` closes it. An array of
that `Exclude` would **not** have been a fence — `[]` is assignable to `"sectionChanges"[]` as
readily as to `never[]`, so the missing field would compile and the test would pass; the constraint
has to fail at the alias. Mutation-checked: renaming the mirror's field gives
`TS2344: Type '"sectionChanges"' does not satisfy the constraint 'never'` plus both stubs and
`node.ts`. What is still open is the other two mirrors — the web one and `crossengin diff`'s — which
this fence does not reach.

**And it did not reach one level *in* either, which the kernel half proved on this ADR's own
field.** `Exclude<keyof A, keyof B>` compares two shapes' *own* keys and says nothing about what
sits inside an array, so when `ManifestSectionChange` gained `reachNote` the alias above stayed
`never` while the mirror's element was a field short — the identical drift, one level deeper, in
the increment that closed the shallow one. There is a second alias over
`ManifestDiffView["sectionChanges"][number]` now, and the general shape is that **each mirrored
element owes its own**: no type can walk a type's nested arrays, so this is a per-shape obligation
rather than something a cleverer single fence would cover.

Verified: `apps/operate-server` 5,031 tests passing (128 files), `typecheck` clean, and all twelve
workspace rules green (725 tests) — the tenth anchors its `manifest-diff.ts` declarations by
**symbol** rather than by line, so the census they carry is unmoved. Mutations run, each reversed by
inverse string replacement with the mutant asserted present before and absent after: restoring the
unconditional suppression fails **6** tests; pointing `workflows`' extractor at `relationChanges`
fails **3**, one of them a lifecycle test that predates the map; giving `jobs` an extractor fails the
both-directions fence; dropping the `create` arm fails **2**; dropping the kind comparison fails
**1**; and renaming the mirror's `sectionChanges` fails the type fence by name plus both stubs and
`node.ts`.

Nothing was verified against a live Postgres or a running server, and that is a narrower claim than
this ADR's first draft made. The diff **is** served over a request path, so "nothing here touches
the request path" was wrong — what makes a live run add little is the shape of that path: the review
handler is a pass-through (`return { diff: diffManifests(active, next) }`) with no response schema
of its own, and a platform operationId has no redaction spec, since the registry's specs are derived
from `compileOperateServer`'s entity routes. So a new test wires the **real** differ through
`buildDesignReviewRoutes` and asserts the census is in the response body and survives
`JSON.stringify` — which is the property finding 4 made unobservable, since there the bytes were
right while the type was wrong.

**That test failed when it was first written, and it is the fourth instance of this addendum's own
probe trap.** This route file's `MANIFEST` and `ACTIVE_MANIFEST` fixtures carry no
`manifestVersion`, so the real differ refuses them and answers `comparable: false` with every list
empty — so the assertion read `[]` and the honest diagnosis was *the probe had not parsed*, not
*the census is absent*. It supplies its own parseable pair and asserts `comparable` first. Written
down because the paragraph above it names the trap, and the author still walked into it one test
later: the remedy has to be a check in the test, not a sentence in the file.

Three of the probes that produced this addendum were wrong before they were right, all in the same
way: a manifest carrying a key the schema strips (`roles` on a transition, `required` on a relation)
or one it refuses (a field grant written as a bare array rather than `{roles: […]}`) answers
`comparable: false` with every count zero — which is **byte-identical to an unchanged manifest** but
for that one flag, exactly the trap `diffManifests` carries and `CLAUDE.md` records. The silent-layer
tests therefore assert `comparable` first, and the lesson is the general one: a probe over this
function must prove its own mutation parsed.

### The kernel half: a fix that destroyed what it was fixing

The same pass over `packages/kernel` found that **this ADR's own trait fix carried a regression**,
and it is the increment's sharpest finding because the mechanism is the one the fix introduced.
`resolvedAgainstOwnTraits` pre-expanded the old entity and handed on `{...entity, traits: [],
fields: [...resolved]}` — a fabricated entity whose `traits: []` is the problem: `checkEntityFieldNames`
then sees every trait-contributed field as an **own** field, so a trait field named `id` collided
with the implicit key and raised `FieldNameCollisionError` for a manifest that had been accepted.
The fabrication destroyed **trait provenance**, which is the fact that function reads, and that
destruction *was* the regression — the same shape as ADR-0361's fabricated entity one package over,
in the increment that cites it.

So the fix moved one level up and `resolvedAgainstOwnTraits` is **deleted**: `DiffContext` carries
`oldCustomTraits` and `computeEntityDiff` resolves each side against its own list. That function
already owns a mechanism for *which traits apply*; applying one list to both sides was the whole
defect, so giving it two is the honest fix and it keeps provenance rather than flattening it.
`RESERVED_ENTITY_FIELD_NAMES` is one spelling in `ddl/resolution.ts` now, read by the diff and by
the validator.

`oldCustomTraits` is **both-or-neither** rather than optional, and that shape is the increment's own
class caught one more time. The first spelling was `oldCustomTraits?: readonly Trait[]` defaulting to
`customTraits` — which is the **pre-fix behaviour kept as what silence buys**, so a caller supplying
one list and forgetting the other gets the original defect back with the type valid: ADR-0386's
shape, inside the fix for the defect, flagged in the implementer's own handoff rather than hidden.
There is no honest default either (`customTraits` restores the bug; `[]` makes every trait field
read as *added*), which is ADR-0338's argument for asking instead — so `DiffContext` is a union of
*neither supplied* and *both supplied*, and the fence costs nothing: the diff's own suite passes no
context at all, which the first member admits, and `computeManifestDiff` is the one live caller and
holds two manifests by construction. Mutation-checked by dropping `oldCustomTraits` from that call,
which fails `TS2345` at the call site, reversed by inverse string replacement with `md5sum`
confirming the file byte-identical.

**And the collision the regression surfaced is a real manifest defect nothing refused.** A field
named `id` — own or trait-contributed — makes `columnPlanForEntity` plan the column while
`emitEntityTableDdl` already writes the implicit key, so one `CREATE TABLE` carries `"id" TEXT NOT
NULL` and `"id" TEXT` and Postgres answers **`42701 column "id" specified more than once`**: the
manifest parsed, validated, hashed and **could not be served at all**. Confirmed twice, because the
second half is a database claim rather than a text one: the real `columnPlanForEntity` +
`emitEntityTableDdl` emit three `"id"` tokens in one statement, and that exact statement run on
PG 16.13 answers `ERROR: column "id" specified more than once` (rolled back). `validateEntities` refuses
both halves now, as validation errors on ADR-0348's split, with the trait's message naming its blast
radius. Measured before deciding, which is what made it cheap: the seven built-in packs give **69
entities / 556 own fields / 0 custom traits**, the four compliance packs — the only source of a
custom trait anywhere — give **3 traits / 9 trait fields**, and `id` appears **0** times in any of
it. The diff fix is still needed independently, because `computeManifestDiff` runs on *stored*
manifests and one stored before this rule still carries the shape.

**And the sentence justifying a one-member set was the only thing keeping it at one.** The first
version of `RESERVED_ENTITY_FIELD_NAMES`' doc read *"only `id` today … since `tenant_id` is refused
earlier as a reserved prefix nothing in the packs uses"*, and **there is no such refusal**: driven
through `validateManifest` itself rather than through the emitter, `tenant_id` was **accepted**, and
its `CREATE TABLE` carries `"tenant_id" UUID NOT NULL` beside `"tenant_id" TEXT` — confirmed on
PG 16.13 as `ERROR: column "tenant_id" specified more than once`, the identical unservable shape.
This file's own documentation class, inside the comment explaining a set's membership, and the
instrument is the same one that found it: `it.each(RESERVED_ENTITY_FIELD_NAMES)` drives the
refusal from the constant, so a third member cannot arrive by the same route. The set is two, at a
measured cost of zero (all four names appear 0 times in 556 own fields), and the **negative** half
is what keeps it honest — `created_at` and `updated_at` are two more emitted columns and are
asserted *not* reserved, with a test that they still validate, because `auditable` supplies exactly
those names and the emitter therefore overrides rather than duplicating them. That override is a
real defect of its own and a quieter one; it is an open question below and register P2.12c, because
what is wrong there is the **type** rather than the name.

Two refusals are argued from measurement and written into the source so nobody attempts them a third
time. A **tuple-exhaustiveness fence** over `MANIFEST_SECTION_NAMES` adds only the *addition* case,
because a rename already errors three ways (`TS2820` at the array, `TS2561` at each map) — and that
case is a strict subset of what the three existing tests catch, since they also compare declaration
**order** and the schema's own key spellings, neither of which any type over `ManifestSectionName`
can see (it derives from the same schema, so a rename moves both sides together). A **fourth reach
member** separating *read by a non-request-path surface* from *read by nothing* splits
`{reports, dashboards, customWidgets}` from the other five on an axis no reviewer acts on, while the
question a reviewer needs — can this alter what a request gets — is what `served` already asks.

Four of the eleven findings were under-asserting tests, and the two worth naming are the ones that
measured as nearly vacuous. The canonical-bytes test compared **72 of 77 sibling pairs as
`null`/`null`** — a base manifest carrying almost no sections, so "varying one section reports only
that section" was mostly a statement about absent keys; driven from a base that carries **all
seventeen** it makes **272 substantive comparisons, 0 null/null**, and it earned its place
immediately by catching two fixtures that varied a key `IntegrationDeclarationSchema` and
`DashboardDeclarationSchema` do not retain, so they canonicalised identically and would have passed
while testing nothing. And the reach-meanings test asserted that each sentence *exists*; it asserts
the exact three strings and scans for remedy markers with a **word-bounded** matcher, because
`validated_only`'s old sentence contained "runtime" and an unbounded `run` reported a remedy in a
correct string.

The four comment corrections are this file's own recurring class, and **F9 is the one with a
consequence**: both non-served sentences said "runtime" or "read by nothing", and three sections
falsify that — `reports` and `dashboards` are read by `operate-server`'s boot survey,
`customWidgets` by `architect-cli`'s summary, and `extends.ts`'s merge reads all seventeen. They say
**request path** now, which is the axis `MANIFEST_SECTION_REACH` measures and the only one a
reviewer acts on. That correction is also why the sentence had to start travelling: `apps/operate-web`
held a **fourth** copy of the three keyed on the bare `reach` string, that copy was the live one — the
one a reviewer reads — and its two non-served sentences each dropped a different clause, between
them exactly the two facts separating `validated_only` from `unread`. So `ManifestSectionChange`
carries `reachNote` and the client renders what it was sent, falling back to the bare `reach` rather
than to prose of its own: **saying less beats saying something false**, and a copy removed cannot
drift where a copy fenced can.

Verified: `packages/kernel` 801 → **820 tests**, `apps/operate-server` **5,036**,
`operate-runtime-pg` 660 and all seven packs green after the kernel rebuild (the validator change
is what those re-runs are for), `operate-web`'s `tsc` and `next build` clean, and the workspace
sweep green in all three phases. The nested mirror fence was
mutation-checked by dropping `reachNote` from `ManifestDiffViewLike`'s element, which fails
`TS2344: Type '"reachNote"' does not satisfy the constraint 'never'` **by name** plus both stubs by
excess-property check; staling `reachNote` in the view's own map fails exactly the one new test;
and dropping `oldCustomTraits` from its one call site fails `TS2345`, with `md5sum` confirming the
file byte-identical after the reversal.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The suppression's granularity is the section, so a change whose layer speaks about a *different* member of the same section still reads `additive`. Closing it needs per-member matching, which the addendum measures as impossible for `workflows` and `relations`. | operate-server owner | 2026-12-31 |
| A **widened transition grant** reads `additive`, because `isDestructiveOperation` keys on the terminal segment and a transition's is its own name. `erp-core`'s `mark_paid` moves money (ADR-0366), so the widening deserves attention — and no name test can know that, since the effect is in the workflow and the write effects rather than in the operation id. The axis would have to become *needs attention* rather than *may withhold*, or the layer would have to read the transition's effects. Left as a judgement rather than guessed at; the existing test blesses `additive` deliberately. | reviewer-surface owner | 2026-12-31 |
| `assessManifestRisk` reads the raw document, so a trait-carried `phi` field reports no `phi_data` finding — confirmed live, and masked by `no_permissions` also answering `high`. The approval gate is on the narrow side of ADR-0361's split. | operate-server owner | 2026-11-30 |
| `manifest-diff.ts`'s `fallbackEntityLayer` reads `entity.fields` raw, so the throw the trait fix now (correctly) produces for a type-kind change degrades to a trait-blind comparison. | operate-server owner | 2026-11-30 |
| `fieldNameByColumn` maps only the entity's own fields, so a removed trait *reference* field renders as `x_id` rather than `x`. Cosmetic. | operate-server owner | 2026-12-31 |
| Four mirrors of one view shape. **One pair is compared now, at two levels** — the addendum's finding 4 closed the route's against the real view with an `AssertNever` fence, after that pair drifted on this ADR's own field, and the kernel half proved that fence blind one level in: `reachNote` landed on `ManifestSectionChange` and `UncoveredViewField` stayed `never`, because an `Exclude` over two views' keys says nothing about what sits inside an array. There is a second alias over the element now, and **each mirrored element shape owes its own**, since no type can walk a type's nested arrays. The web mirror and `crossengin diff`'s are still compared by nothing; the web one cannot use the same fence (a separate package that must not import the differ), so it wants a generated type or a runtime assertion on a captured response — though `reachNote` shows the cheaper move where it applies: **delete the copy instead of fencing it**. | kernel + operate-server + operate-web owners | 2026-12-31 |
| `crossengin diff`'s `countDiff` hardcodes `workflowsAdded/Removed/Modified: 0`, so its human output asserts zero workflow changes unconditionally. The census would supply them. | architect-cli owner | 2026-12-31 |
| Should a `validated_only` or `unread` section change be reported to a reviewer at all? Today it is, at `additive`, because an authored declaration a deployment discards is a fact an approver should see. | reviewer-surface owner | 2026-12-31 |
| **A declared `created_at` or `updated_at` silently replaces the server's stamp.** The implicit-column class has four members and the emitter handles them two ways, measured: `id` and `tenant_id` are **duplicated** (`"id" TEXT NOT NULL` beside `"id" TEXT`) and so unservable, while `created_at` and `updated_at` are **overridden** — a field declaring `created_at: text` emits `"created_at" TEXT` *instead of* `TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', now())`, so the table serves and the audit stamp becomes a caller-supplied column with no default, against ADR-0360's own reading that a `created_at` stamp is *the server writing a field, not the caller writing it*. It cannot simply be refused: `BUILT_IN_TRAIT_FIELDS`' `auditable` supplies exactly those two names, which is **why** the emitter de-duplicates them, and an own field colliding with a trait-supplied one is already refused — so the uncovered case is an own `created_at` on an entity *without* `auditable`. Zero members across the seven packs (0 of 556 own fields). The honest fix is probably a type check rather than a name refusal. | kernel owner | 2026-12-31 |
| The web mirror's `reachNote` is **optional with a bare-`reach` fallback**, so a client newer than its server renders `validated_only` where a sentence belongs. Accurate and unprettified, and deliberately not a local default — but nothing tells the operator the two are out of step, which is the general version of the question the compose stack's lockstep build makes moot today. | operate-web owner | _unscheduled_ |

## References

- Register item P1.2, and ADR-0361 for the aperture class one level down.
- ADR-0368 for lineage resolution, and why `meta.extends` is the consequential key.
- ADR-0359 for a dropped list surface being a 400 rather than a wider answer.
- ADR-0288 for the maintained list this census is shaped to avoid.
- ADR-0331 for `membersKeyed: false` meaning "no key to name" rather than "nothing changed".
- ADR-0334 for a finding naming a remedy that works, or naming none.
