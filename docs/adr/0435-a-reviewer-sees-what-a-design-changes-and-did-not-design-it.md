# ADR-0435: A reviewer sees what a design changes, and is not the person who designed it

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0388 (the 17-section census and per-side trait resolution this extends), ADR-0361 (`resolvedFields` and the aperture rule), ADR-0368 (lineage resolution and the review gate), ADR-0338 (refuse only if nothing correct breaks), ADR-0434 (per-tenant gateway routing, which made a design's activation observable live), ADR-0426 (expression defaults, the H-02 path a default change rides) |

## Context

The external due-diligence audit ranked **H-28** high: a reviewer approving an AI-designed manifest
could not see most of what it changed. At `f6faf05` it was *partly fixed* — ADR-0388 had given the
diff a 17-section census, fixed the old side's trait resolution and read the field grant's `create`
arm — and seven items remained: no warning on a move between two sensitive classes; default and
expression changes invisible; role `inherits` and ABAC obligations visible only as a section-level
`breaking` with no detail; no diff at all for a first activation; the CLI approval showing counts;
no four-eyes, so one `platform_admin` designs, approves and activates on the shipped compose; and a
trait field's classification change absent from the field diff (added by the verification's
challenge; `entity-field-aperture.ts` already declared it `fails_open`).

Measured on `erp-core` before the change (`Vendor.contact_email` is `pii`):

| Change | What the reviewer was shown |
|---|---|
| `pii` → `phi` | `additive`, no warning |
| `pii` → `commercial_sensitive` | `additive`, no warning |
| role gains `inherits` | `breaking` from the census only, no detail |
| `abac` added to a `list` grant | `breaking` from the census only, 0 permission changes |
| default added or changed | 0 field changes |
| trait field `pii` → `public` or → `phi` | a census entry only, 0 field changes |
| first activation | `comparable: false`, 0 sections |
| failure reading the active manifest | *"This is the first system for this tenant"* |

The audit **understated** the first row: `pii` → `phi` read `additive` while the same change is a
blocking column-encryption change in the deployment's own schema diff. And no designer was recorded
anywhere, so four-eyes was not expressible.

## Decision

**The diff names every change a reviewer approves, at the level that decides it.**

- A kernel module, `manifest/change-detail.ts`, adds four readers — `fieldDefaultChanges`,
  `fieldClassificationChanges`, `roleInheritanceChanges`, `abacObligationChanges` — each resolving
  both sides against **their own** traits (ADR-0388's rule), so a trait field's default and
  classification are in the field diff. A classification change is graded as a **move**: raised,
  lowered, between two sensitive classes, between two insensitive ones, and whether encryption at
  rest changed. A raise that changes encryption is `breaking` (`classification_moved` carries the
  ciphertext clause); a move between sensitive classes warns.
- The diff view gains `roleChanges`, `obligationChanges` and `baseline`
  (`active_manifest` / `deployment_manifest` / `unreadable` / `none`) and five warning codes, and the
  roles and permissions detail extractors count the new lists — so ADR-0388's census suppression
  for those sections is now earned by a layer that speaks. A required field losing its default is
  `breaking`; a default added or changed warns as additive.
- **A first activation is compared against the deployment's own manifest**, both sides
  lineage-resolved through `buildDiffLineage`, which composes `meta.extends` with the gateway's own
  `tenantLineage` registry. A design extending `erp-core` reads `removed 0`; a standalone one reads
  `removed 51` and 15 roles removed — which is the difference ADR-0368 found nobody could see.
- **Both sides are compared at one composition level** (`composeOrReason`). When one side cannot be
  composed, the two stored manifests are compared and a `breaking` `lineage_unresolved` warning says
  so; a first activation whose proposal will not compose says that a listed removal is not one
  activation would make. A read failure is `baseline: "unreadable"`, never "first system".

**The designer cannot approve their own design.**

- `meta.operate_tenant_manifests.designed_by` (nullable TEXT, `char_length >= 1`) is recorded at both
  design routes and through the asynchronous design job.
- An approval by the designer is **403 `designer_cannot_approve`** at the route, and refused again
  by the store inside the decide transaction. A **reject is never gated**. A proposal with no
  recorded designer stays approvable and the response says `designer_unrecorded`; every approve
  response carries `fourEyes` (`distinct_principals` / `self_approved` / `designer_unrecorded`).
- `--allow-design-self-approval` is the hatch, refused at parse without the review routes, with a
  boot line either way (info when four-eyes is on, warn when off). The compose is unchanged and
  `deploy/README.md` tells a single operator to add the flag.

**The CLI approval shows the detail.** The approval request carries a required `details` list —
entity, field, classification, default, `inherits`, `abac` and section lines, capped at 40 with a
"… N more" line — and `interactiveApprover` prints it before `Apply? [y/N]`. `DiffView` names the
baseline instead of always saying "first system", shows a first-activation banner and renders the
role-inheritance and ABAC sections; the new fields are optional, so an older server still renders.

## Alternatives considered

- **Four-eyes on by default with no hatch.** Refused on ADR-0338's rule: the documented bootstrap
  grants one operator both the design and the review role, so a single-operator deployment approves
  its own design today and refusing that would break a deployment that works. The hatch is named,
  parse-refused where it would be inert, and announced at boot.
- **Compare a stored manifest against a composed one when one side will not compose.** That was the
  first implementation and review measured it wrong against the real `erp-core` registry: a live
  manifest that no longer composed read *"51 entities added"* with 377 `permission_granted`
  warnings, and a proposal that did not compose read *"51 entities removed"* with 133 warnings —
  removals that cannot happen, since activation is refused for that proposal — with no warning that
  the two sides were composed differently.
- **Treat a proposal with no recorded designer as self-approved.** Refused: every proposal stored
  before the column has none, and refusing them would strand the pending queue on upgrade. Review
  found no route that rewrites a proposal's manifest after creation, no producer of
  `source: "manual"` and no path that resumes a design job, so no way to obtain an undesigned
  proposal and approve it yourself.
- **Compare defaults by `manifestHash`.** It does not move when a literal default's array of named
  objects is reordered, so `fieldDefaultChanges` sorts object keys and keeps array order.

## Consequences

- **Positive:** every row of the Context table now reaches the reviewer with detail — `pii` → `phi`
  is `breaking` with the ciphertext clause, `inherits` and `abac` carry their own lists, defaults and
  trait-field classifications are field changes, and a first activation is a real comparison. The
  person who asked for a design cannot also approve it unless the deployment says so.
- **Negative:** every first activation reads `breaking`, because `meta` always differs from the
  deployment's manifest and the section census grades a `meta` change as possibly withholding (review
  measured the only differences as `meta.name`, `meta.slug` and a removed `meta.description`, with
  zero warnings). The removal counts still separate an extending design from a replacing one.
- **Neutral:** two bare api-keys resolve to one placeholder principal, so they count as one designer
  and are refused — the conservative reading of an identity that cannot tell two people apart.
  `entity-field-aperture.ts`' `manifest-diff.ts::classificationLayer` declaration came back
  `overtaken` and is deleted, taking the `fails_open` count from 3 to 2.
- **Reversibility:** the hatch restores the old behaviour per deployment; `designed_by` is an
  additive nullable column.

## Implementation notes

Test results: kernel 948, kernel-pg 841, operate-server 5,598 (148 files), architect-cli 219,
testing 796; kernel, operate-server and architect-cli typecheck clean, `operate-web` `tsc` clean.
Ten tests that pinned the old behaviour were rewritten, not deleted: the two classification-impact
tests, two read-failure diff tests, five approve-response-shape tests and the approve-input test.
Review rewrote one more, *"falls back to the stored live manifest when it no longer composes"*,
which had asserted the mixed comparison, and added the proposal-does-not-compose case; with the fix
reverted the rewritten test fails.

Mutation-checked, each caught: removing the route four-eyes check; removing the store four-eyes
check; removing the between-sensitive warning; dropping the roles and the permissions extractor
counts; breaking the lineage baseline; renaming `baseline` on the route mirror (the `AssertNever`
fence fails typecheck); removing the unreadable baseline; grading encryption-changing raises
`additive`; not recording the designer; not printing CLI details; reading `entity.fields` instead of
`resolvedFields`. Review found disabling the ABAC reader for a field's `read` grant left all 16 kernel
tests green; the test now covers a field's `read` and `update` arms and disabling either fails.

Verified live on PG 16 with `--ai-design` against a fake OpenAI-compatible provider and
`--require-design-review`, the API connecting as `crossengin_app`:

| Arm | Result |
|---|---|
| first activation | `comparable: true`, `baseline: deployment_manifest`, added 2 / removed 0, `designedBy` the designer |
| re-activation | `baseline: active_manifest`, one modified field, `AnimalPatient.display_name` `text(200)` → `integer` |
| designer holding the review role approves | 403 `designer_cannot_approve` |
| designer rejects their own design | 200 |
| a different reviewer approves | 200, `fourEyes: "distinct_principals"`, `designed_by` and `reviewed_by` on the row |
| `--allow-design-self-approval` without review routes | exit 2, refused at parse |
| the flag with review routes | boot line *"four-eyes OFF"*; self-approval 200, `fourEyes: "self_approved"` |

The implementation report says the `designed_by` migration was not checked against a real Postgres;
the live run above wrote and read the column on a freshly migrated cluster, which covers the fresh
path and not an upgrade of a populated table.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Every first activation reads `breaking` from the `meta` section alone; whether `meta.name`/`slug`/`description` should be excluded from the census's withholding grade | platform | _open_ |
| One person with two credentials (a login session to design, the bootstrap api-key to approve) appears as two principals and passes four-eyes; no identity check can close it | platform | _open_ |
| The review page does not show `designedBy`, so a reviewer cannot see who asked for the design | platform | _open_ |
| `assessManifestRisk` still reads entity fields without resolving traits | platform | _open_ |
| `decide()` has no expected-status predicate | platform | _open_ |
| `designed_by` arriving on a populated upgraded table was not verified live | platform | _open_ |
| A move between two insensitive classes (`internal` → `public`) raises no warning, as before | platform | _open_ |

## References

- `packages/kernel/src/manifest/change-detail.ts`, `packages/kernel/src/bootstrap/meta-schema.ts`
- `apps/operate-server/src/manifest-diff.ts`, `design-review-routes.ts` (`composeOrReason`),
  `design-review-store.ts`, `ai-design-routes.ts`, `tenant-manifests.ts`, `design-runner.ts`,
  `cli.ts`, `node.ts`
- `apps/architect-cli/src/approval-detail.ts`, `tools.ts`, `chat.ts`
- `apps/operate-web/components/DiffView.tsx`; `deploy/README.md` (*Approving a tenant's design*)
- `packages/testing/src/strategy/entity-field-aperture.ts`
