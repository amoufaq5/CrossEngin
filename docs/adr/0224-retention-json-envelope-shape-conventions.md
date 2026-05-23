# ADR-0224: Retention JSON envelope shape conventions (family-wide)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.json-envelope.conventions
- **Closes**: 13 milestones' recurring "JSON envelope shape" deferred Qs +
  documents canonical conventions for future multi-value milestones
- **Related**: ADR-0183 (`multiFlags` infra), ADR-0199/0200/0207/0210/0211/
  0214/0217/0218/0219/0220/0221/0222/0223 (13 multi-value milestones with
  recurring JSON envelope shape evolution)

## Context

13 consecutive multi-value family milestones have evolved the JSON envelope
shape across all 3 retention surfaces (history, diff-timeline, diff-
history). Each milestone independently chose conventions for new fields:
- Multi-value flags renamed to plural form (`kinds`, `actorIds`).
- Single-value flags kept singular (`actorIdNot` before ADR-0219).
- Boolean flags echoed as boolean (`systemOnly`, `noSystem`).

The recurring deferred Q "JSON envelope shape unification" has appeared in
ADR-0207/0210/0214/0217/0218/0219/0220/0221/0222/0223 future Qs. This ADR
documents the **canonical conventions** that govern the JSON envelope shape
across all 3 retention surfaces, identifies remaining inconsistencies, and
proposes future-Q fixes.

### Why a family-wide ADR now

- 13 milestones in the multi-value family have converged on consistent
  patterns; the conventions are stable enough to codify.
- Operators reading JSON output need predictable shapes across surfaces;
  inconsistencies waste operator scripting time.
- Future multi-value milestones should inherit canonical conventions
  without re-deciding; this ADR is the single point of reference.
- Cross-surface consistency tests can verify conventions hold uniformly,
  catching regressions when new fields are added.

## Decision

Document the canonical JSON envelope shape conventions for retention CLI
actions. Add cross-surface consistency tests verifying the conventions hold
where they're already consistent. Identify remaining inconsistencies as
future Qs (deferred fixes).

### Canonical conventions

#### 1. Field naming derives from CLI flag name (plural for multi-value)

| CLI flag | Envelope field | Type | Convention |
|----------|----------------|------|------------|
| `--kind X --kind Y` | `kinds` | `string[] \| null` | plural, lowercase, no prefix |
| `--kind-not X` | `kindsNot` | `string[] \| null` | plural, lowercase, `Not` suffix camelCase |
| `--actor-id X` | `actorIds` | `string[] \| null` | plural, lowercase, no prefix |
| `--actor-id-not X` | `actorIdsNot` | `string[] \| null` | plural, lowercase, `Not` suffix |
| `--kind-a X` | `kindsA` | `string[] \| null` | per-side plural, `A`/`B` suffix |
| `--actor-id-a X` | `actorIdsA` | `string[] \| null` | per-side plural |
| `--system-only` | `systemOnly` | `boolean` | camelCase boolean (never null) |
| `--no-system` | `noSystem` | `boolean` | camelCase boolean |
| `--system-only-a` | `systemOnlyA` | `boolean` | per-side boolean |
| `--with-actor-names` | `withActorNames` | `boolean` | camelCase boolean |
| `--tenant <uuid>` | `tenantFilter` | `string \| null` | (history only — naming
                                                  with `Filter` suffix for
                                                  optional filter args) |
| `--table <name>` | `tableFilter` | `string \| null` | (history only) |
| `--since DATE` | `since` | `string \| null` | ISO-8601 string or null |
| `--until DATE` | `until` | `string \| null` | ISO-8601 string or null |
| `--limit N` | `limit` | `number` | always set (default 100) |
| `--after-id <uuid>` | `afterId` | `string \| null` | cursor or null |
| `--before-id <uuid>` | `beforeId` | `string \| null` | cursor or null |
| `--range A..B` | `range` | `string \| null` | raw range expression or null |

#### 2. Type shape rules

- **Multi-value flag** → `T[] | null` (empty array NOT used; always null
  when flag not set). Empty array would be ambiguous with "filter set to
  empty" vs "filter not set".
- **Single-value flag** → `T | null` (null when not set).
- **Boolean flag** → `boolean` (always; never null). Default `false` when
  not set.
- **Numeric flag** → `number` (always; default value when not set).
- **Action discriminator** → `action: string` (always present; identifies
  which CLI action emitted the envelope).

#### 3. Surface-level discriminators (in addition to `action`)

- `diff-history`: just `action: "diff-history"` is sufficient.
- `diff-timeline`: 3 dispatch paths require discrimination:
  - pair-wise: `action: "diff-timeline"` (no extra discriminator)
  - N-way: `action: "diff-timeline"`, `nway: true`
  - cross-table: `action: "diff-timeline"`, `crossTable: true`
- `history`: just `action: "history"` is sufficient (no current
  discriminator; consider adding for future-proofing).

#### 4. Result vs envelope-level fields

- **Envelope-level fields** echo operator INPUT (which flags were used).
- **`result` field** (or `entries`/`result`) contains the actual DATA
  (diff output, history entries, etc.).
- Data fields at result-level may use slightly different naming (e.g.,
  result.eventKindA vs envelope.kindsA) because result-level fields
  describe ACTUAL data not operator intent.
- This 2-level structure allows operators to distinguish "what I asked
  for" from "what I got" by JSON path nesting.

#### 5. Pagination cursor fields

- `nextAfterId: string | null` — cursor for forward pagination when page
  full.
- `nextBeforeId: string | null` — cursor for backward pagination when page
  full.

#### 6. Count + entries fields

- `count: number` — number of entries returned.
- `entries: T[]` — array of result rows (only on list-style surfaces:
  history + diff-timeline). diff-history uses `result: { fieldDiffs: T[],
  ... }` instead since it's a per-event-pair comparison.

### Remaining inconsistencies (deferred to future Qs)

After 13 milestones, 3 known inconsistencies remain in the **history**
surface envelope vs diff-history/diff-timeline:

1. **`eventKinds` / `eventKindsNot` vs `kinds` / `kindsNot`** — history
   envelope uses the adapter input field name (`eventKinds`); diff-history
   and diff-timeline use the CLI flag name (`kinds`). Canonical convention
   says envelope field names derive from CLI flag names, so history
   should be `kinds`/`kindsNot`.

2. **Missing `action` discriminator on history** — diff-history and diff-
   timeline emit `action: "diff-history"` / `action: "diff-timeline"`;
   history omits the discriminator. Canonical convention says every
   surface emits `action` discriminator.

3. **Missing `withActorNames` echo on history** — diff-history and diff-
   timeline echo `withActorNames` in envelope; history parses the flag
   but doesn't echo it. Canonical convention says all operator-input
   flags echo in envelope.

These 3 inconsistencies are documented as future Qs below for a follow-
up rename milestone.

## Rejected alternatives

1. **Fix the 3 history inconsistencies as part of this ADR** — would make
   this a breaking-change milestone, not a documentation milestone; the
   user explicitly requested "No adapter changes; pure documentation +
   test additions"; CLI-side renames are still operator-visible breaking
   changes; defer to a follow-up rename milestone.
2. **Don't document, just keep evolving organically** — the recurring
   deferred Q has appeared in 10+ ADRs; codifying conventions saves
   future re-decision time.
3. **Use JSON Schema or Zod schema for envelope shapes** — would require
   adapter changes + schema generation tooling; scope creep; can be added
   later if validation becomes important.
4. **Unify result-level field names with envelope-level field names** —
   result-level fields describe actual data (e.g., `eventKindA` is the
   actual event_kind of side A); envelope-level fields echo operator
   intent (e.g., `kindsA` is what operator passed via `--kind-a`); these
   are semantically distinct and the 2-level naming is a feature.
5. **Field naming from adapter input field names instead of CLI flag
   names** — would make history's `eventKinds` canonical; but adapter
   field names aren't operator-visible; CLI flag names are what operators
   know. Flag-name-derived envelope fields preserve the operator's
   mental model.
6. **Empty array as "filter not set" instead of null** — ambiguous with
   "filter set to empty" (which we use as filter-not-set within the
   adapter); JSON envelope nulls clearly indicate flag-not-supplied;
   matches adapter's empty-array-as-filter-not-set convention.
7. **Boolean flags rendered as `string | null`** — booleans are
   inherently 2-valued; null adds no signal; always-boolean rendering is
   cleaner.
8. **Numeric flags rendered as `number | null`** — limit/range have
   sensible defaults; null vs default is ambiguous; always-number
   rendering with default value when not set is cleaner.

## Future questions

1. **Rename history envelope `eventKinds`/`eventKindsNot` → `kinds`/
   `kindsNot`** — breaking change to operator JSON scripts but session-
   recent code with no external consumers contained scope; matches the
   13 prior milestones' one-shot break precedent. Defer to a follow-up
   rename milestone.

2. **Add `action: "history"` discriminator to history envelope** —
   ADDITIVE field; non-breaking; operators reading JSON would gain a
   reliable discriminator. Defer to the same follow-up.

3. **Add `withActorNames` echo to history envelope** — ADDITIVE field;
   non-breaking. Defer to the same follow-up.

4. **Cross-surface JSON Schema generation** — automatically generate JSON
   Schema from envelope shapes; would enable operator-side validation +
   IDE autocomplete. Scope creep for documentation milestone; defer.

5. **CLI output format variants — `--format=csv`, `--format=tsv`,
   `--format=yaml`** — operator dashboard backing; envelope shape
   conventions translate naturally. Defer to operator-ergonomics
   milestone.

6. **Result-level field naming unification** — result objects on diff-
   history have `eventKindA`/`eventKindB`/`actorIdA`/`actorIdB` (singular
   forms reflecting the per-event-pair semantic) — these are data fields
   not flag echoes. Document the 2-level separation more rigorously.
   Defer — current state is correct, just under-documented.

## Consequences

- **Canonical conventions codified** — future multi-value milestones
  inherit the conventions without re-deciding; ADR is the single
  reference.
- **Test count: 9,138 → 9,141** (+3 net: cross-surface consistency
  tests).
- **3 history inconsistencies identified** for a follow-up rename
  milestone (future Q 1-3 above).
- **No production code changes** — pure documentation + test additions;
  operator JSON scripts unaffected.
- **Cross-surface consistency tests added** — verify canonical
  conventions hold on each surface (multi-value fields are arrays,
  boolean fields are booleans, action discriminator on surfaces that
  have it).
- **Pattern documented for future surfaces** — when new retention CLI
  actions are added (`retention summary`, etc.), envelope shape follows
  this ADR's conventions without per-milestone re-decision.
- **Follow-up rename milestone is well-scoped** — 3 specific history-
  surface renames + envelope tests update; mechanical given the
  documented conventions.
