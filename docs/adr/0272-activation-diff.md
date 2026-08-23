# ADR-0272: Activation diff — reviewing the change, not the document (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0271 (manifest viewer), ADR-0270 (design-review queue), ADR-0267 (AI onboarding), ADR-0077 (Phase 4) |

## Context

ADR-0271 let a reviewer see the schema a proposal *contains*. But activation **replaces** the
tenant's live schema, so what actually matters is the delta: a removed entity takes its table
and rows with it, a removed field drops stored values, and a widened `delete` grant hands
destruction rights to a role that did not have them. None of that was visible — the reviewer
was reading a document, not reviewing a change.

## Decision

- **Reuse the kernel's structural diff; add the governance layer it lacks.** `@crossengin/kernel`
  already ships `computeManifestDiff` covering entities, fields and indexes with a `destructive`
  flag. Reimplementing DDL comparison would have been duplicative and worse. `manifest-diff.ts`
  delegates that layer and adds what the kernel does not model: **permission grants and
  revocations** (CRUD, transitions, field-level), role and relation changes, lifecycle deltas,
  and field **classification** transitions.
- **Impact rollup**: `none | additive | breaking`, with warnings ordered breaking-first and
  written as consequences rather than labels ("Entity WorkOrder is removed — its table and every
  row in it go away on activation"). A widened `delete`/`update` grant is classified **breaking**,
  not additive: gaining destruction rights is exactly what a reviewer must catch.
- **Injected and optional**, like `assessRisk` and `projectSchema` before it. The `diff` key is
  omitted entirely when either the differ or the active-manifest source is unwired. The platform
  route resolves the active manifest for the **proposal's** tenant, never the reviewer's — a
  reviewer has no tenant of their own, and getting this backwards would diff against the wrong
  system. A failure resolving it degrades to the not-comparable view rather than 500ing the page.
- **UI**: `DiffView` renders above the schema on both the review detail and the wizard review
  step — the delta matters more than the full document. A tenant with no live system yet gets
  "first system, nothing to compare" rather than an empty diff.

## Two findings worth recording

1. **The kernel's `nullabilityChange` tracks `required`, not nullability**, despite its name:
   `to === true` means the field *became required* (breaking). Getting this backwards would have
   inverted every required/optional warning. Asserted directly in a test.
2. **`computeManifestDiff` throws** `UnsupportedDiffChangeError` on a changed type kind, altered
   enum values, or a flipped `unique` — precisely the breaking changes a reviewer most needs. So
   that layer catches and degrades to a name-level comparison rather than silently reporting
   "nothing changed" on the most dangerous input.

## Consequences

- **Verified live** against a real Postgres: a tenant activated a baseline system, then a revised
  proposal produced `impact: BREAKING` with all five consequences — entity removed (table + rows),
  classified field removed (stored values dropped), `app_user` loses `create`, `app_user` **gains**
  `delete`, relation removed — while the one genuinely additive field appeared with no warning.
  The UI rendered the red banner, counts, warnings and the +/− field table.
- The review flow now has three complementary layers: **risk** (is this schema dangerous in
  itself), **schema** (what does it contain), **diff** (what does activating it do). Each answers
  a question the others cannot.
- +67 tests (operate-server **47 files / 894**; the diff alone is 43). Full workspace build +
  typecheck + test green; operate-web build green.
- The proposal store is now built when **either** the AI routes or the review queue is enabled —
  a review-only deployment still needs it to resolve a tenant's live manifest.
- Follow-ups: notifying a tenant when their proposal is decided (open since ADR-0270); showing
  per-field and per-transition grants individually rather than as a role's grant count; and a
  data-volume estimate on destructive changes ("this drops 12,400 rows") which needs a count
  query per affected entity.
