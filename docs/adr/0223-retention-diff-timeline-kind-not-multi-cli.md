# ADR-0223: `retention diff-timeline --kind-not` multi-value substrate-side NOT IN exclusion (3 dispatch paths)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.diff-timeline.kind-not.multi
- **Closes**: ADR-0200 deferred future Q (`--kind-not` filter on diff-
  timeline across all 3 dispatch paths) + ADR-0207 deferred Q4
- **Related**: ADR-0183 (`multiFlags` infra), ADR-0193/0194/0199/0200/0202/
  0207/0213 (3-dispatch-path symmetry pattern), ADR-0200 (diff-timeline
  `--kind` multi-value), ADR-0207 (diff-timeline `--actor-id-not` multi-
  value), ADR-0222 (history `--kind-not` multi-value just-shipped)

## Context

ADR-0200 introduced the global `--kind <event-kind>` substrate-side WHERE
filter on `retention diff-timeline` as multi-value from inception (across
all 3 dispatch paths — pair-wise + N-way via `--add-tenant` + cross-table
via `--add-table`). The future-Qs section deferred the negative symmetric
`--kind-not` exclusion filter, parallel to ADR-0207's diff-timeline
`--actor-id-not` multi-value pattern.

ADR-0222 just added `--kind-not` to retention history with the ADDITIVE-
multi-value-from-inception pattern. This ADR closes the deferred Q on diff-
timeline, **completing the kind dimension symmetry across all 3 retention
surfaces**:

| Surface       | `--kind` positive | `--kind-not` negative |
|---------------|--------------------|------------------------|
| history       | multi (ADR-0221)   | multi (ADR-0222)       |
| diff-timeline | multi (ADR-0200)   | **multi (this ADR)**   |
| diff-history  | multi (ADR-0217)   | multi (ADR-0214)       |

13 consecutive multi-value family milestones (11 single→multi widenings +
2 ADDITIVE-from-inception new fields).

This milestone follows the established 3-dispatch-path symmetry pattern
(ADR-0193/0194/0199/0200/0202/0207/0213) — same SQL clause structure
applied identically to each of 3 adapter methods (DiffHistoryTimelineInput,
DiffHistoryTimelineNwayInput, DiffHistoryTimelineCrossTableInput).

### Real cohort-negative-exclusion use cases on diff-timeline surface

1. **Cross-tenant cohort-vs-deletion timeline** — across 5-tenant cohort
   show ALL mutation events EXCLUDING (policy_deleted, retention_set);
   surface only opt-out workflow events for incident timeline.
2. **Cross-table forensic timeline excluding maintenance** — across all 4
   prunable tables show events EXCLUDING policy_deleted during incident
   window.
3. **Pair-wise migration verification with deletion exclusion** — assert
   migration timeline on both tenants EXCLUDING retention_set events
   (those would indicate post-migration cleanup we want to filter out).
4. **CI gate aggregation with kind-list exclusion** — fail build if any
   timeline event in the last hour matches any of these N excluded kinds.
5. **Compose with --actor-id-not** (already multi from ADR-0207) — "events
   NOT by automation actors AND NOT of maintenance kinds" cohort
   exclusion across the timeline.

## Decision

Add NEW `--kind-not <event-kind>` repeatable flag on `retention diff-
timeline` for multi-value OR-semantic substrate-side NOT IN exclusion
filter across all 3 dispatch paths. Operator excludes timeline entries
with `event_kind IN {N excluded event_kinds}`.

### ADDITIVE adapter field (3 input types)

All 3 diff-timeline input types gain `eventKindsNot?:
ReadonlyArray<OptOutHistoryEventKind>`:
- `DiffHistoryTimelineInput` (pair-wise)
- `DiffHistoryTimelineNwayInput` (via `--add-tenant`)
- `DiffHistoryTimelineCrossTableInput` (via `--cross-table`)

ADDITIVE — no breaking rename; existing consumers unaffected. Multi-value
from inception matching ADR-0211/0222 precedent.

### Adapter WHERE clause (3-path symmetry)

Each of the 3 adapter methods gains the same conditional WHERE block
positioned immediately after the existing `eventKinds` IN block:

```ts
if (input.eventKindsNot !== undefined && input.eventKindsNot.length > 0) {
  const kindNotPlaceholders = input.eventKindsNot
    .map((kind) => {
      params.push(kind);
      return `$${params.length}`;
    })
    .join(", ");
  conditions.push(`h.event_kind NOT IN (${kindNotPlaceholders})`);
}
```

Mechanical 3-path symmetry matches established ADR-0193/0194/0199/0200/
0202/0207/0213 pattern — every diff-timeline filter exists in 3 identical
conditional WHERE clauses. `event_kind` is NEVER NULL by constraint, so no
IS NULL handling needed.

### CLI parsing

`runRetentionDiffTimeline` reads via `getMultiFlag("kind-not")` ONCE at
top of function (before path dispatch), with per-occurrence validation via
`isOptOutHistoryEventKind` loop matching ADR-0200/0214/0217/0220/0221/0222
pattern. Then threaded to whichever of 3 adapter methods is selected.

### JSON envelope shape

3 envelope shapes (pair-wise no-discriminator, `nway:true`, `crossTable:
true`) all gain `kindsNot: string[] | null` field positioned after `kinds`.
Matches established array-or-null canonical multi-value envelope shape.

### Help text

Both diff-timeline usage lines (pair-wise + cross-table) gain `[--kind-not
<event-kind> ...]` indicating repeatable. Pair-wise description extended
with "--kind-not is repeatable and EXCLUDES entries with any of the listed
event_kinds (OR-semantic NOT IN; mirror of --kind)". Cross-table description
extended to enumerate --kind-not alongside other repeatable flags.

### Composition with --kind

`--kind X --kind Y --kind-not Z` produces SQL `h.event_kind IN ($X, $Y)
AND h.event_kind NOT IN ($Z)`. Both clauses fire independently at PG layer
across all 3 paths. Matches ADR-0222 composition behavior on history
surface.

### Check ordering preserved

The NOT IN clause fires AFTER the IN clause within the WHERE conditions
(global eventKinds IN before eventKindsNot NOT IN), matching the
established ordering pattern (positive before negative).

## Rejected alternatives

1. **Single-value `--kind-not <event-kind>`** — would require breaking
   rename later when extending to multi-value; 13 prior multi-value
   milestones make the multi-value-from-inception pattern routine.
2. **Apply only to pair-wise path, defer N-way + cross-table** — breaks
   the established 3-dispatch-path symmetry pattern; operators using N-way
   or cross-table would have surprise feature gaps.
3. **Comma-separated string `--kind-not policy_deleted,retention_set`** —
   breaks shell quoting; inconsistent with multiFlags pattern.
4. **`--exclude-kind` canonical flag name** — inconsistent with established
   `--kind-not` repeatable pattern on diff-history (ADR-0214) and history
   (ADR-0222); breaks naming symmetry across surfaces.
5. **`event_kind != ANY($N::text[])`** array-element-of-array PG syntax —
   equivalent semantically; NOT IN clause is more readable in EXPLAIN
   output and matches ADR-0211/0222 pattern exactly.
6. **AND semantic on multi-value exclusion** — semantically equivalent to
   OR for negative filter; OR rendering reads more naturally.
7. **Array literal JSON `--kind-not '["a", "b"]'`** — worse UX than flag
   repetition.
8. **`event_kind IS NULL OR NOT IN (...)`** matching ADR-0211 actor-id-not
   pattern — event_kind is NOT NULL by constraint, so OR clause would never
   trigger; cleaner to omit.
9. **CLI-side eager error on `--kind X --kind-not X` contradiction** —
   adapter handles naturally (PG returns empty result); operators may
   intentionally include redundant `--kind-not` for self-documentation;
   defer.
10. **CLI per-path flag parsing duplication** — parsing flag once at top
    of function then threading to 3 adapters is cleaner than per-path
    parsing; matches ADR-0193/0194/0199/0200/0207/0213 dispatcher pattern.

## Future questions

1. **`--kind-not` on diff-history per-side variants (`--kind-not-a`/
   `--kind-not-b`)** — already exists from ADR-0215; this Q is N/A.
2. **`--kind-not @file.txt`** file-source — bounded 4-value enum; defer.
3. **CLI-side dedup of duplicates** — operator passing `--kind-not X
   --kind-not X` produces `["X", "X"]` → PG NOT IN clause with X twice.
   Defer — PG handles duplicates fine.
4. **Semantic-shape exclusion grouping shorthand (e.g.,
   `--exclude-maintenance-kinds`)** — operator-policy concern; defer.
5. **Cross-flag contradiction detection** — `--kind X --kind-not X` could
   surface CLI-side error; defer — current PG-returns-empty behavior is
   observably correct.
6. **JSON envelope shape unification family-wide ADR** — across 13 multi-
   value milestones, document the canonical conventions. Defer — separate
   future Q for the documentation milestone.

## Consequences

- **13th milestone in multi-value family** — ADDITIVE new field across 3
  dispatch paths, multi-value from inception. Pattern matches ADR-0211/
  0222 (ADDITIVE) + ADR-0200/0207/0213 (3-dispatch-path symmetry).
- **Kind dimension symmetry complete across ALL 3 retention surfaces** —
  history (ADR-0221/0222), diff-timeline (ADR-0200/this ADR), diff-history
  (ADR-0217/0214). Positive + negative both multi-value on every surface.
- **Test count: 9,123 → 9,138** (+15 net: adapter +6, CLI +9).
- **No JSON envelope shape regression** — 3 envelope shapes gain new
  `kindsNot` field; existing fields preserved.
- **No SQL plan regression** — NOT IN clause is parameterized and PG plans
  it identically to IN clause across all 3 dispatch paths.
- **No new help text page** — same 2 usage lines (pair-wise + cross-table)
  extended with one new flag option each.
- **Cross-flag composition continues** — `--actor-id-not` (ADR-0207) +
  `--kind-not` (this ADR) combine for "events NOT by X AND NOT of kind Y"
  cohort exclusion across all 3 paths.
- **Natural follow-up — JSON envelope shape unification family-wide ADR**
  — across 13 multi-value milestones, document the canonical conventions
  (array-or-null, string-or-null, boolean) with cross-surface consistency
  tests.
