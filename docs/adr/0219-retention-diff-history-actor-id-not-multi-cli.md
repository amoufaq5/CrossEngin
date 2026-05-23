# ADR-0219: `retention diff-history --actor-id-not` multi-value tuple exclusion

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.diff-history.actor-id-not.multi
- **Closes**: ADR-0205 Q1 (multi-value `--actor-id-not` tuple exclusion)
- **Related**: ADR-0183 (`multiFlags` infra), ADR-0199 (diff-timeline multi-actor),
  ADR-0200 (diff-timeline multi-kind), ADR-0205 (global `--actor-id-not`
  original single-value), ADR-0207 (diff-timeline `--actor-id-not`
  multi-value), ADR-0210 (history `--actor-id` multi-value), ADR-0211
  (history `--actor-id-not` multi-value), ADR-0214 (diff-history `--kind-not`
  multi), ADR-0217 (diff-history `--kind` multi), ADR-0218 (diff-history
  `--actor-id` multi)

## Context

ADR-0205 introduced the global `--actor-id-not <uuid>` exclusion check on
`retention diff-history` as a single-value flag: operator declares "I expect
NEITHER event to have actor_id = X" and adapter throws on match with side(s)
named. The future-Qs section listed multi-value tuple exclusion —
`--actor-id-not` repeatable for "NEITHER event matches any of these N
excluded actors" — as Q1.

This ADR closes that Q1 by widening to multi-value repeated flag. The
established cadence is now 9 consecutive single→multi widenings via one-shot
breaking rename:

- ADR-0199: diff-timeline `--actor-id` → multi
- ADR-0200: diff-timeline `--kind` → multi
- ADR-0207: diff-timeline `--actor-id-not` → multi
- ADR-0210: history `--actor-id` → multi
- ADR-0211: history `--actor-id-not` → multi
- ADR-0214: diff-history `--kind-not` → multi
- ADR-0217: diff-history `--kind` → multi
- ADR-0218: diff-history `--actor-id` → multi (just-shipped)
- **This ADR (0219): diff-history `--actor-id-not` → multi**

ADR-0218 widened the positive actor-id; this ADR widens the negative,
completing the **within-action symmetry on the actor dimension** on
diff-history. Both positive `--actor-id` and negative `--actor-id-not` are
now multi-value tuple expressions; the kind dimension already has this
symmetry (`--kind` from ADR-0217 + `--kind-not` from ADR-0214). Per-side
single-value variants remain (separate future Qs).

### Real cohort-negative-exclusion use cases on actor dimension

1. **Multi-actor exclusion forensic** — assert NEITHER event is in the
   suspect actor cohort (e.g., 3 compromised service account candidates
   during incident investigation).
2. **Workflow audit excluding migration cohort** — assert NEITHER event is
   from migration SA 1 OR migration SA 2 OR backfill SA (workflow vs
   migration distinction).
3. **CI gate with actor-tuple exclusion** — fail build if either event was
   authored by any of these 3 excluded automation accounts.
4. **Anti-automation pair verification** — assert NEITHER event is from
   automation accounts pre-list before treating diff as deliberate human-
   policy work.
5. **Compose with multi-value --actor-id positive** — canonical "events by
   Alice OR Bob but NOT Carol OR Dave" cohort positive + tuple exclusion.
6. **Compose with --kind multi-value exclusion** — assert NEITHER event is
   (policy_deleted OR retention_set) AND NEITHER event is authored by
   (excluded SA list).

## Decision

Widen `--actor-id-not <uuid>` on `retention diff-history` from single-value
to **repeated flag** for multi-value OR-semantic tuple exclusion check.
Operator declares "I expect NEITHER event to have actor_id in {set of N
excluded UUIDs}" and adapter throws on match with side(s) named.

### Breaking adapter rename

`DiffHistoryEntriesInput.actorIdNot?: string` →
`DiffHistoryEntriesInput.actorIdsNot?: ReadonlyArray<string>`.

Session-recent code from ADR-0205 with no external consumers contained scope —
matches ADR-0199/0207/0210/0211/0214/0217/0218 one-shot break precedent.
9 consecutive single→multi renames make this mechanical.

### Adapter check rewrite

```ts
if (input.actorIdsNot !== undefined && input.actorIdsNot.length > 0) {
  const excludedSet = new Set<string>(input.actorIdsNot);
  const matches: string[] = [];
  if (entryA.actor_id !== null && excludedSet.has(entryA.actor_id)) {
    matches.push("A");
  }
  if (entryB.actor_id !== null && excludedSet.has(entryB.actor_id)) {
    matches.push("B");
  }
  if (matches.length > 0) {
    const suffix =
      matches.length === 1
        ? `${matches[0]} matches`
        : "both A and B match";
    const actorList = input.actorIdsNot.map((a) => `'${a}'`).join(", ");
    throw new Error(
      `diffHistoryEntries: expected neither event to have actor_id in [${actorList}] but ${suffix}`,
    );
  }
}
```

Set-based O(1) membership lookup. Null actor_id never matches any UUID in
the exclusion tuple (system events pass exclusion by construction —
operators wanting "neither event is system OR anything-from-X" must compose
with `--no-system`).

### Always-list error format

Single-value renders as `actor_id in ['X']`; multi-value renders as
`actor_id in ['X', 'Y']`. Single-value error breaks from ADR-0205's
`actor_id 'X'` shape — acceptable because the field rename is itself
breaking; consistent rendering across single + multi reads better than
separate special-case formats.

The error rendering matches ADR-0218 positive-side `actor_id in [...]`
format, restoring symmetry across positive + negative actor expressions on
diff-history.

### CLI parsing

`runRetentionDiffHistory` reads via `getMultiFlag("actor-id-not")` instead of
`getStringFlag`. Empty array converted to `undefined` (matches empty-array-
as-filter-not-set convention from the family).

No per-occurrence validation needed — UUIDs are free-form strings at the CLI
boundary (matches ADR-0207/0210/0211/0218 pattern).

### JSON envelope shape

Field renamed `actorIdNot: string | null` → `actorIdsNot: string[] | null`.
Matches ADR-0207/0210/0211/0214/0217/0218 array-or-null canonical multi-value
envelope shape across the family.

### Help text

`--actor-id-not <uuid>` → `--actor-id-not <uuid> ...` indicating repeatable.
Description extended explaining "repeatable + NEITHER event authored by any
of the listed actors (OR-semantic exclusion) + match by either side on any
listed actor exits 1 (anti-actor verification, mirror of --actor-id)".

### Per-side stays single-value

`--actor-id-not-a` / `--actor-id-not-b` (ADR-0215) stay single-value for
this milestone. Documented as future Q (per-side multi-value tuple exclusion
mirrors ADR-0215 + ADR-0217/0218/0219 family pattern). Deferred to keep
milestone scope focused on closing ADR-0205 Q1 on the global flag
specifically.

### Check ordering preserved

Global `--actor-id-not` multi fires after global `--actor-id` multi (positive
before negative within actor dimension), matches established ordering. With
contradictory `--actor-id alice` + `--actor-id-not alice`, positive check
fires first surfacing positive error (no behavioral change from ADR-0205).

## Rejected alternatives

1. **Keep single-value `actorIdNot` + add `actorIdsNot` field (additive)** —
   defeats simplicity; inconsistent with established one-shot break precedent
   across 8 prior single→multi renames.
2. **Comma-separated string `--actor-id-not alice-uuid,bob-uuid`** — breaks
   shell quoting (UUIDs in nested quoted args); inconsistent with multiFlags
   pattern.
3. **`--actor-id-not-list` canonical flag name** — inconsistent with
   established `--actor-id-not` repeatable pattern from ADR-0207/0211; breaks
   naming symmetry across surfaces.
4. **AND semantic on multi-value exclusion** — semantically equivalent to OR
   for negative exclusion ("NEITHER event is X AND NEITHER is Y" = "NEITHER
   event is X OR Y"); OR rendering reads more naturally.
5. **Array literal JSON `--actor-id-not '["a", "b"]'`** — worse UX than flag
   repetition; requires shell-escape; doesn't compose with tab-completion.
6. **Retain single-value `actor_id 'X'` error format** — error parsing was
   never API-grade contract; consistent `actor_id in ['X']` rendering across
   single + multi reads better than separate special-case formats; mirrors
   ADR-0218 positive-side rendering.
7. **Per-side multi-value in same milestone** — scope creep; per-side is
   ADDITIVE not breaking; separate future Q.
8. **Add IS NOT NULL handling for system events** — system events (null
   actor_id) never match any UUID in the exclusion tuple by construction;
   adding IS NOT NULL handling would change semantics from "exclude these
   specific actors" to "exclude these actors AND system events"; operators
   wanting "exclude system" use `--no-system` instead (separate composition).
9. **Normalize expression DSL for actor tuples (e.g.,
   `--actor-id-not 'alice|bob'`)** — scope creep; pipe character has shell
   semantics; inconsistent with multiFlags pattern.
10. **CLI-side eager error on `--actor-id-not X` + `--actor-id X`
    contradiction** — adapter ordering already surfaces positive error first
    naturally; CLI-side check would duplicate logic without behavioral
    benefit; operators can express both intentionally (positive cohort +
    explicit exclusion of one specific actor within cohort would be
    nonsensical but adapter handles by checking positive first).

## Future questions

1. **Per-side multi-value `--actor-id-not-a` / `--actor-id-not-b`** — widen
   per-side from single-value to multi-value tuple exclusion on each side
   independently. Mirrors ADR-0215 + ADR-0217/0218/0219 family pattern.
   ADDITIVE field on per-side semantic. Deferred — separate future Q.
2. **`--actor-id-not @file.txt`** — file-source of N excluded UUIDs for very
   large exclusion lists (e.g., known-bad SA roster of 50 accounts). Defer —
   bounded by command-line argv length; UUID lists typically scripted via
   xargs.
3. **Combined `--actor-id` + `--actor-id-not` tuple OR/AND semantic
   disambiguation flag** — currently positive checks first, negative checks
   second; operator-explicit policy could swap order. Defer — current
   ordering serves the canonical "cohort positive + exclude noise" use case.
4. **Multi-value `--actor-id-not` on retention history** — already exists
   from ADR-0211. N/A on this milestone.
5. **CLI-side dedup of duplicates** — operator passing `--actor-id-not X
   --actor-id-not X` produces `[X, X]`; Set converts to `{X}` at adapter.
   Defer — current behavior is observably idempotent.
6. **Semantic-shape exclusion grouping shorthand (e.g.,
   `--exclude-automation-actors`)** — symbolic exclusion cohort sources.
   Defer — operator-policy concern.

## Consequences

- **Restored within-action symmetry on actor dimension** — both positive
  `--actor-id` and negative `--actor-id-not` are multi-value tuple
  expressions on diff-history, mirroring the kind dimension (`--kind` from
  ADR-0217 + `--kind-not` from ADR-0214).
- **9th surface in actor + kind multi-value family** — joins ADR-0199/0200/
  0207/0210/0211/0214/0217/0218 in the established cadence; the global
  multi-value matrix on diff-history is now COMPLETE.
- **Test count: 9,083 → 9,091** (+8 net: adapter +4, CLI +4).
- **JSON envelope shape change** — `actorIdNot: string | null` →
  `actorIdsNot: string[] | null`; consumers of the JSON envelope on
  diff-history must update field path.
- **Error rendering shift** — single-value error format changes from
  `actor_id 'X'` to `actor_id in ['X']`; consistent with kind dimension and
  positive side from ADR-0218.
- **Diff-history global multi-value matrix complete** — `--kind` (ADR-0217),
  `--kind-not` (ADR-0214), `--actor-id` (ADR-0218), `--actor-id-not` (this
  ADR). Only `--system-only`/`--no-system` remain single-value (boolean by
  nature — not applicable to multi-value). Per-side variants are the natural
  next batch of milestones.
- **Operators have complete control over per-event-pair forensic
  assertions** — multi-value tuple expressions across both positive +
  negative on both kind + actor dimensions, plus per-side single-value
  variants for asymmetric assertions.
