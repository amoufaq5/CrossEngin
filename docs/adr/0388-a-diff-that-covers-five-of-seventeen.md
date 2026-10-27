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

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `assessManifestRisk` reads the raw document, so a trait-carried `phi` field reports no `phi_data` finding — confirmed live, and masked by `no_permissions` also answering `high`. The approval gate is on the narrow side of ADR-0361's split. | operate-server owner | 2026-11-30 |
| `manifest-diff.ts`'s `fallbackEntityLayer` reads `entity.fields` raw, so the throw the trait fix now (correctly) produces for a type-kind change degrades to a trait-blind comparison. | operate-server owner | 2026-11-30 |
| `fieldNameByColumn` maps only the entity's own fields, so a removed trait *reference* field renders as `x_id` rather than `x`. Cosmetic. | operate-server owner | 2026-12-31 |
| Four mirrors of one view shape, compared by nothing. A `satisfies` across the three TS ones, or deriving two from the first, is the fix. | kernel + operate-server owners | 2026-12-31 |
| `crossengin diff`'s `countDiff` hardcodes `workflowsAdded/Removed/Modified: 0`, so its human output asserts zero workflow changes unconditionally. The census would supply them. | architect-cli owner | 2026-12-31 |
| Should a `validated_only` or `unread` section change be reported to a reviewer at all? Today it is, at `additive`, because an authored declaration a deployment discards is a fact an approver should see. | reviewer-surface owner | 2026-12-31 |

## References

- Register item P1.2, and ADR-0361 for the aperture class one level down.
- ADR-0368 for lineage resolution, and why `meta.extends` is the consequential key.
- ADR-0359 for a dropped list surface being a 400 rather than a wider answer.
- ADR-0288 for the maintained list this census is shaped to avoid.
- ADR-0331 for `membersKeyed: false` meaning "no key to name" rather than "nothing changed".
- ADR-0334 for a finding naming a remedy that works, or naming none.
