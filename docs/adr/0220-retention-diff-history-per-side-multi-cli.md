# ADR-0220: `retention diff-history` per-side multi-value tuple expectations (bulk)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.diff-history.per-side.multi
- **Closes**: ADR-0215 deferred future Qs (per-side multi-value variants on
  `--kind-a`/`--kind-b`, `--actor-id-a`/`--actor-id-b`, `--actor-id-not-a`/
  `--actor-id-not-b`) — paired with ADR-0217 (global `--kind` multi-value),
  ADR-0218 (global `--actor-id` multi-value), ADR-0219 (global `--actor-id-
  not` multi-value)
- **Related**: ADR-0183 (`multiFlags` infra), ADR-0199/0200/0207/0210/0211/
  0214/0217/0218/0219 (9 prior single→multi widenings), ADR-0215 (per-side
  ADDITIVE expectation checks), ADR-0216 (per-side `--system-only`)

## Context

ADR-0215 introduced the per-side asymmetric expectation-check matrix on
`retention diff-history` with 8 single-value flags: `--kind-a`/`--kind-b`,
`--actor-id-a`/`--actor-id-b`, `--actor-id-not-a`/`--actor-id-not-b`, plus
ADR-0214-derived `--kind-not-a`/`--kind-not-b` which were already multi-value
from the start. ADR-0215's future-Qs section deferred 3 per-side multi-value
widenings (per dimension):

1. Per-side `--kind-a`/`--kind-b` multi-value tuple expectation
2. Per-side `--actor-id-a`/`--actor-id-b` multi-value tuple expectation
3. Per-side `--actor-id-not-a`/`--actor-id-not-b` multi-value tuple exclusion

After ADR-0217/0218/0219 widened the corresponding global flags to multi-
value, the per-side variants became the natural follow-up. The 3 changes
share identical mechanical patterns: same one-shot break, same Set-based
membership lookup, same always-list error format, same array-or-null JSON
envelope, same empty-array-as-filter-not-set convention.

This ADR closes all 3 future Qs in a **single bulk milestone** because:

- Each rename is mechanical (9 consecutive single→multi precedents make the
  pattern routine).
- Splitting into 3 separate milestones would triple the churn of CLAUDE.md/
  README.md/docs/adr/index.md/commit overhead without adding clarity.
- Operators using one per-side multi-value variant typically want all three
  (composition is the canonical use case).
- The 6 field renames are inside a single adapter call sequence; touching
  them together avoids partial-rename inconsistency in intermediate states.

### Real per-side multi-value use cases

1. **Per-side cohort positive expectation** — assert side A is in cohort
   {Alice, Bob} (e.g., trusted operators) AND side B is in cohort {Carol,
   Dave} (e.g., reviewers).
2. **Per-side exclusion tuple** — assert side A is NOT in {migration SA list
   of 3} AND side B is unconstrained (one-sided forensic).
3. **Per-side kind tuple expectation** — assert side A is in opt-out
   workflow kinds {opt_out_set, opt_out_cleared} AND side B is a deletion
   kind {policy_deleted}.
4. **Compose with global multi-value** — global `--actor-id` {Alice, Bob,
   Carol} requires BOTH events in trio; per-side `--actor-id-a` {Alice, Bob}
   further constrains A to that subset.
5. **Hybrid global + per-side belt-and-suspenders** — global symmetric
   tuple assertion + per-side narrows further.

## Decision

Bulk-widen 6 per-side adapter input fields from single-value to multi-value
arrays:

- `eventKindA?: OptOutHistoryEventKind` → `eventKindsA?: ReadonlyArray<OptOutHistoryEventKind>`
- `eventKindB?: OptOutHistoryEventKind` → `eventKindsB?: ReadonlyArray<OptOutHistoryEventKind>`
- `actorIdA?: string` → `actorIdsA?: ReadonlyArray<string>`
- `actorIdB?: string` → `actorIdsB?: ReadonlyArray<string>`
- `actorIdNotA?: string` → `actorIdsNotA?: ReadonlyArray<string>`
- `actorIdNotB?: string` → `actorIdsNotB?: ReadonlyArray<string>`

All 6 check blocks rewritten with Set-based O(1) membership lookup;
always-list error format matches the global multi-value family.

### Adapter check rewrite pattern (uniform across 6 fields)

For positive expectations (eventKindsA, actorIdsA):

```ts
if (input.eventKindsA !== undefined && input.eventKindsA.length > 0) {
  const expectedSet = new Set<string>(input.eventKindsA);
  if (!expectedSet.has(entryA.event_kind)) {
    const kindList = input.eventKindsA.map((k) => `'${k}'`).join(", ");
    throw new Error(
      `diffHistoryEntries: expected event A to have event_kind in [${kindList}] but A is '${entryA.event_kind}'`,
    );
  }
}
```

For negative expectations (actorIdsNotA):

```ts
if (input.actorIdsNotA !== undefined && input.actorIdsNotA.length > 0) {
  const excludedSet = new Set<string>(input.actorIdsNotA);
  if (entryA.actor_id !== null && excludedSet.has(entryA.actor_id)) {
    const actorList = input.actorIdsNotA.map((a) => `'${a}'`).join(", ");
    throw new Error(
      `diffHistoryEntries: expected event A to have actor_id NOT in [${actorList}] but A matches`,
    );
  }
}
```

Symmetric B variants identical with `entryB` substituted. `<system>`
placeholder for null actor_id preserved across positive variants.

### Always-list error format

Single-value renders as `in ['X']`; multi-value renders as `in ['X', 'Y']`.
All 6 error rendering breaks from ADR-0215's `'X'` shape — acceptable
because the field renames are themselves breaking; consistent rendering
across single + multi mirrors ADR-0217/0218/0219 family format.

### CLI parsing

All 6 flags switched from `getStringFlag` to `getMultiFlag`. Per-occurrence
validation via `isOptOutHistoryEventKind` loop for kind flags (matches
ADR-0200/0214/0217 pattern). No validation needed for actor flags (UUIDs
are free-form strings, matches ADR-0207/0210/0211/0218/0219 pattern).

### JSON envelope shape

6 field renames in envelope:
- `kindA: string | null` → `kindsA: string[] | null`
- `kindB: string | null` → `kindsB: string[] | null`
- `actorIdA: string | null` → `actorIdsA: string[] | null`
- `actorIdB: string | null` → `actorIdsB: string[] | null`
- `actorIdNotA: string | null` → `actorIdsNotA: string[] | null`
- `actorIdNotB: string | null` → `actorIdsNotB: string[] | null`

Matches established array-or-null canonical multi-value envelope shape
across the family.

### Help text

All 6 per-side flags changed from `<uuid>` / `<event-kind>` to `<uuid> ...`
/ `<event-kind> ...` indicating repeatable. Description blocks extended
explaining "repeatable + side A / side B has any of the listed actors /
event_kinds (OR-semantic tuple) + per-side fires independently".

### Check ordering preserved

The per-side check order matches established ADR-0215 ordering: global
fires first, then per-side. Within per-side: A before B. Across per-side
dimensions: kind → actor → actorPresence (matches global ordering pattern).

## Rejected alternatives

1. **Three separate milestones (per dimension)** — 3× the CLAUDE.md/README/
   index.md/commit overhead without architectural benefit; the rename
   pattern is mechanical after 9 prior precedents; operators using one
   variant typically want all three.
2. **Keep single-value per-side + add multi-value variants alongside** —
   defeats simplicity; doubles the per-side field count; inconsistent with
   established one-shot break precedent across 9 prior single→multi renames.
3. **Comma-separated strings for per-side** — same shell-quoting hazards as
   global multi-value flags (rejected in ADR-0217/0218/0219); inconsistent
   with multiFlags pattern.
4. **Repeated flag with implicit AND semantic on positive per-side** —
   semantically wrong; one event has exactly one kind / one actor_id; AND
   on multi-value is unsatisfiable for N > 1.
5. **Per-side `--A-kind` / `--A-actor` shorter naming** — `--kind-a` /
   `--actor-id-a` already established in ADR-0215; renaming would be a
   second breaking change without justification.
6. **Retain single-value error format on per-side for backward-compat
   parsing** — error parsing was never API-grade contract; consistent
   `in [...]` rendering across single + multi reads better than separate
   per-side-special-case format.
7. **Defer per-side multi-value indefinitely** — operators are already
   using multi-value globally (ADR-0217/0218/0219); per-side single-value
   asymmetry would be a recurring source of "but global is multi" friction.
8. **Per-side multi-value only on per-side flags that have global multi-
   value** — would skip per-side `--kind-not-a/b` (already multi from
   ADR-0215); equivalent to current behavior; no new ADR needed.
9. **JSON envelope per-side fields stay single-value (kindA: string)
   while adapter switches to multi** — inconsistent envelope vs adapter;
   operators reading JSON would see single-value while adapter expects
   array; layer mismatch.
10. **Add per-side `system-only` multi-value variant** — boolean by nature
    (not applicable to multi-value); ADR-0216 already settled this
    dimension as boolean discriminated string union.

## Future questions

1. **Per-side multi-value validation per-occurrence on UUIDs** — currently
   no validation (free-form strings); PG may reject malformed UUIDs at SQL
   layer. Defer — adapter layer handles malformed UUIDs naturally; CLI-side
   regex validation would duplicate PG's validation.
2. **Per-side `@file.txt` source for very large per-side cohorts** — defer;
   per-side cohorts typically smaller than global; bounded by argv length.
3. **Combined cross-per-side contradiction detection** (e.g.,
   `--actor-id-a alice --actor-id-not-a alice` per-side) — currently both
   checks fire independently; per-side positive fires first; operator sees
   positive error if A doesn't match. Defer — current adapter ordering
   handles naturally.
4. **CLI-side dedup of duplicates per-side** — operator passing
   `--kind-a opt_out_set --kind-a opt_out_set` produces `["X", "X"]`; Set
   converts to `{X}` at adapter. Defer — current behavior is observably
   idempotent.
5. **Per-side multi-value on retention diff-timeline / history** — N/A
   already multi-value where applicable; list-style filter not per-event-
   pair expectation.
6. **Per-side semantic shape grouping (e.g., `--A-opt-out-workflow`
   shorthand)** — symbolic per-side cohort sources. Defer — operator-
   policy concern; cohort definitions belong in tenant config.

## Consequences

- **All per-side expectation-check dimensions on diff-history now multi-
  value** — `--kind-a/b` + `--kind-not-a/b` + `--actor-id-a/b` + `--actor-
  id-not-a/b` all accept repeated flags for tuple expressions. Only
  `--system-only-a/b` + `--no-system-a/b` remain single-value (boolean by
  nature).
- **10th milestone in actor + kind multi-value family** — joins the 9
  global widenings (ADR-0199/0200/0207/0210/0211/0214/0217/0218/0219);
  with this milestone the per-side variants reach multi-value parity with
  global on diff-history.
- **Test count: 9,091 → 9,106** (+15 net: adapter +9, CLI +6).
- **JSON envelope shape change** — 6 per-side fields renamed
  `kindA/kindB/actorIdA/actorIdB/actorIdNotA/actorIdNotB` →
  `kindsA/kindsB/actorIdsA/actorIdsB/actorIdsNotA/actorIdsNotB`; consumers
  of the JSON envelope on diff-history must update 6 field paths.
- **Error rendering shift** — single-value per-side error format changes
  from `event_kind 'X'` / `actor_id 'X'` / `actor_id NOT 'X'` to
  `event_kind in ['X']` / `actor_id in ['X']` / `actor_id NOT in ['X']`;
  consistent with global multi-value family from ADR-0217/0218/0219.
- **Diff-history per-side multi-value matrix complete** — all 4 per-side
  expectation-check dimensions are multi-value; the diff-history surface
  now has the COMPLETE multi-value matrix (global + per-side, positive +
  negative, kind + actor).
- **Operators have unprecedented forensic precision** — multi-value tuple
  expressions on both global symmetric + per-side asymmetric, across both
  positive + negative, on both kind + actor dimensions, with system-
  presence boolean dimension orthogonal. Effectively any state-transition
  assertion expressible in a single command.
