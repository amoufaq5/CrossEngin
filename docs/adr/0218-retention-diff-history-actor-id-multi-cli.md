# ADR-0218: `retention diff-history --actor-id` multi-value tuple expectation

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.diff-history.actor-id.multi
- **Closes**: ADR-0203 Q2 (multi-value `--actor-id` tuple expectation)
- **Related**: ADR-0183 (`multiFlags` infra), ADR-0199 (diff-timeline multi-actor),
  ADR-0200 (diff-timeline multi-kind), ADR-0203 (global `--actor-id` original
  single-value), ADR-0207 (diff-timeline `--actor-id-not` multi-value),
  ADR-0210 (history `--actor-id` multi-value), ADR-0211 (history
  `--actor-id-not` multi-value), ADR-0214 (diff-history `--kind-not` multi),
  ADR-0215 (diff-history per-side), ADR-0216 (diff-history per-side
  `--system-only`), ADR-0217 (diff-history `--kind` multi)

## Context

ADR-0203 introduced the global `--actor-id <uuid>` expectation check on
`retention diff-history` as a single-value flag: operator declares "I expect
both events to have actor_id = X" and adapter throws on mismatch with side(s)
named. The future-Qs section listed multi-value tuple expectation —
`--actor-id` repeatable for "BOTH events have any of these N actors" — as a
deferred follow-up.

Across the actor + kind family of expectation-check + filter flags on the
retention surfaces, the established cadence is single→multi widening via
one-shot breaking rename:

- ADR-0199: diff-timeline `--actor-id` → multi
- ADR-0200: diff-timeline `--kind` → multi
- ADR-0207: diff-timeline `--actor-id-not` → multi
- ADR-0210: history `--actor-id` → multi
- ADR-0211: history `--actor-id-not` → multi
- ADR-0214: diff-history `--kind-not` → multi
- ADR-0217: diff-history `--kind` → multi (just-shipped)
- **This ADR (0218): diff-history `--actor-id` → multi**

ADR-0217 (diff-history `--kind` multi) restored within-action symmetry on the
kind dimension — both positive `--kind` and negative `--kind-not` are now
multi-value tuple expectations. This ADR restores within-action symmetry on
the actor dimension by widening the positive `--actor-id`. The negative
`--actor-id-not` was already documented as single-value in ADR-0205 and
remains so for this milestone (separate future Q).

The 8 consecutive single→multi renames have made the pattern mechanical: same
`multiFlags` infrastructure, same one-shot break precedent (session-recent
code with no external consumers), same per-occurrence validation, same
Set-based O(1) membership lookup, same always-list error format, same empty-
array-as-filter-not-set convention, same array-or-null JSON envelope shape.

### Real cohort-positive-expectation use cases on actor dimension

1. **Multi-operator state transition verification** — assert BOTH events are
   authored by EITHER Alice OR Bob (canonical pair-of-trusted-operators
   forensic).
2. **On-call cohort verification** — assert BOTH events are in the on-call
   actor set (e.g., any of 5 on-call SREs).
3. **System-account-pair verification** — assert BOTH events are from EITHER
   migration SA OR backfill SA (system account pair forensic).
4. **CI gate with actor-tuple positive** — require both events match any of
   these 3 expected service accounts before treating diff as legitimate.
5. **Compose with --kind multi-value** — assert BOTH events are
   (opt_out_set OR opt_out_cleared) AND authored by (Alice OR Bob).
6. **Compose with --actor-id-not** — assert BOTH events are authored by
   (Alice OR Bob) but NOT Carol (cohort positive + single exclusion).

## Decision

Widen `--actor-id <uuid>` on `retention diff-history` from single-value to
**repeated flag** for multi-value OR-semantic tuple expectation check. Operator
declares "I expect BOTH events to have actor_id in {set of N actor UUIDs}"
and adapter throws on mismatch with the side(s) named.

### Breaking adapter rename

`DiffHistoryEntriesInput.actorId?: string` →
`DiffHistoryEntriesInput.actorIds?: ReadonlyArray<string>`.

Session-recent code from ADR-0203 with no external consumers contained scope —
matches ADR-0199/0207/0210/0211/0214/0217 one-shot break precedent. The
workspace has established the breaking-rename pattern across 8 consecutive
single→multi renames; this is mechanical.

### Adapter check rewrite

```ts
if (input.actorIds !== undefined && input.actorIds.length > 0) {
  const expectedSet = new Set<string>(input.actorIds);
  const mismatches: string[] = [];
  if (entryA.actor_id === null || !expectedSet.has(entryA.actor_id)) {
    mismatches.push(
      `A is ${entryA.actor_id === null ? "<system>" : `'${entryA.actor_id}'`}`,
    );
  }
  if (entryB.actor_id === null || !expectedSet.has(entryB.actor_id)) {
    mismatches.push(
      `B is ${entryB.actor_id === null ? "<system>" : `'${entryB.actor_id}'`}`,
    );
  }
  if (mismatches.length > 0) {
    const actorList = input.actorIds.map((a) => `'${a}'`).join(", ");
    throw new Error(
      `diffHistoryEntries: expected both events to have actor_id in [${actorList}] but ${mismatches.join(" and ")}`,
    );
  }
}
```

Set-based O(1) membership lookup. Null actor_id never matches any UUID in
the tuple (system events fail positive expectation by construction —
operators wanting "system OK" use `--system-only` instead).

### Always-list error format

Single-value renders as `actor_id in ['X']`; multi-value renders as
`actor_id in ['X', 'Y']`. Single-value error breaks from ADR-0203's
`actor_id 'X'` shape — acceptable because the field rename is itself
breaking; consistent rendering across single + multi reads better than
separate special-case formats.

`<system>` placeholder for null actor_id preserved across single + multi.

### CLI parsing

`runRetentionDiffHistory` reads via `getMultiFlag("actor-id")` instead of
`getStringFlag`. Empty array converted to `undefined` (matches empty-array-
as-filter-not-set convention from ADR-0199/0200/0207/0210/0211/0214/0217).

No per-occurrence validation needed — UUIDs are free-form strings at the CLI
boundary (PG validates at SQL layer). Pattern matches ADR-0210/0211 history
actor multi-value (no enum to validate against).

### JSON envelope shape

Field renamed `actorId: string | null` → `actorIds: string[] | null`. Matches
ADR-0207/0210/0211/0214/0217 array-or-null canonical multi-value envelope
shape across the family.

### Help text

`--actor-id <uuid>` → `--actor-id <uuid> ...` indicating repeatable.
Description extended explaining "repeatable + BOTH events have any of the
listed actors (OR-semantic tuple expectation) + mismatch by either side on
any actor not in the listed set exits 1 + null actor_id never matches
positive expectation".

### Per-side stays single-value

`--actor-id-a` / `--actor-id-b` (ADR-0215) stay single-value for this
milestone. Documented as future Q (per-side multi-value tuple expectation
mirrors ADR-0215 + ADR-0217/0218 family pattern). Deferred to keep milestone
scope focused on closing ADR-0203 Q2 on the global flag specifically.

Asymmetry between global multi-value and per-side single-value acceptable
because per-side semantically asserts THIS event must be exactly this actor
(singular by design — operator picking per-side already has a specific actor
in mind for each side). Operator wanting per-side tuple expectation can use
global `--actor-id` multi-value if both sides should match the same tuple.

### Check ordering preserved

Within-action ordering matches ADR-0205 contradictory-combination ordering:
kind dimension → actor dimension. Within actor dimension: global `--actor-id`
multi → per-side `--actor-id-a` / `--actor-id-b` → global `--actor-id-not`
→ per-side `--actor-id-not-a` / `--actor-id-not-b` → `actorPresence`.

## Rejected alternatives

1. **Keep single-value `actorId` + add `actorIds` field (additive)** — defeats
   simplicity; operators have two ways to express the same intent;
   inconsistent with established ADR-0199/0207/0210/0211/0214/0217 one-shot
   break precedent.
2. **Comma-separated string `--actor-id alice-uuid,bob-uuid`** — UUIDs can
   appear in shell-quoted strings with commas in adjacent flags; breaks
   shell quoting; inconsistent with multiFlags pattern.
3. **`--actor-id-list` canonical flag name** — inconsistent with established
   ADR-0210/0211 history actor multi-value (`--actor-id` repeatable, not
   `--actor-id-list`); breaks naming symmetry with per-side variants.
4. **Repeated flag with implicit AND semantic** — semantically wrong; an
   event has exactly one actor_id; AND on multi-value is unsatisfiable for
   N > 1.
5. **Array literal JSON `--actor-id '["alice", "bob"]'`** — worse UX than
   flag repetition; requires shell-escape of JSON; doesn't compose with
   tab-completion.
6. **Retain single-value `actor_id 'X'` error format for backward-compat
   error parsing** — error parsing was never API-grade contract; consistent
   `actor_id in ['X']` rendering across single + multi reads better than
   separate single-value-special-case vs multi-value-list-case formats.
7. **Per-side multi-value in same milestone** — scope creep; per-side is
   ADDITIVE not breaking; separate future Q with its own design space.
8. **Repeat positional argument** — diff-history takes positional historyId
   pair; mixing positional UUIDs would parse-ambiguously.
9. **Add eventKinds-style filter dimension to PG WHERE** — semantically wrong;
   diff-history is per-event-pair expectation check (asserts BOTH events
   match tuple), not list-style filter (would semantically degenerate).
10. **Normalize expression DSL for actor tuples (e.g.,
    `--actor-id 'alice|bob|carol'`)** — scope creep; not consistent with
    multiFlags pattern across the family; pipe character has shell semantics.

## Future questions

1. **Per-side multi-value `--actor-id-a` / `--actor-id-b`** — widen per-side
   from single-value to multi-value tuple expectation on each side
   independently. Mirrors ADR-0215 + ADR-0217/0218 family pattern. ADDITIVE
   field on per-side semantic (different from global multi-value semantic).
   Deferred — separate future Q with its own scope.
2. **`--actor-id @file.txt`** — file-source of N actor UUIDs for very large
   cohorts (e.g., on-call SRE roster of 50 actors). Defer — UUID lists
   typically stay in-shell or scripted via xargs; bounded by command-line
   argv length (~131KB on Linux).
3. **Multi-value `--actor-id-not` on diff-history (closes ADR-0205 Q1)** —
   widen negative actor-id from single-value to multi-value exclusion tuple.
   Natural follow-up. Deferred to keep milestone scope focused.
4. **Multi-value `--actor-id` on retention history** — already exists from
   ADR-0210. N/A on this milestone.
5. **CLI-side dedup of duplicates** — operator passing `--actor-id X
   --actor-id X` produces array `[X, X]`; Set converts to `{X}` at adapter.
   Defer — current behavior is observably idempotent; dedup at CLI would
   hide operator intent in JSON envelope echo.
6. **Semantic-shape positive grouping shorthand (e.g.,
   `--on-call-actors=ops-prod`)** — symbolic actor cohort sources. Defer —
   operator-policy concern; cohort definition belongs in tenant config not
   CLI flag.

## Consequences

- **Restored within-action symmetry on actor dimension** — both positive
  `--actor-id` and (single-value) `--actor-id-not` are now consistent on
  diff-history; widening `--actor-id-not` to multi-value (ADR-0205 Q1) is
  the natural next step.
- **8th surface in actor + kind multi-value family** — joins ADR-0199/0200/
  0207/0210/0211/0214/0217 in the established cadence.
- **Test count: 9,076 → 9,083** (+7 net: adapter +4, CLI +4, but global
  vitest -1 from rewrite consolidation).
- **JSON envelope shape change** — `actorId: string | null` →
  `actorIds: string[] | null`; consumers of the JSON envelope on diff-history
  must update field path.
- **Error rendering shift** — single-value error format changes from
  `actor_id 'X'` to `actor_id in ['X']`; consistent with kind dimension.
- **Operators have unprecedented control over per-event-pair forensic
  assertions** — multi-value tuple expectations on both kind + actor
  dimensions, combined with per-side single-value variants for asymmetric
  assertions.
