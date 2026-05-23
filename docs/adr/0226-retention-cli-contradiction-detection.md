# ADR-0226: Retention CLI cross-flag contradiction detection (CLI-side eager errors)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.contradiction-detection
- **Closes**: 15 multi-value milestones' deferred cross-flag contradiction
  detection Q (recurring future Q across ADR-0214/0217/0218/0219/0220/0221/
  0222/0223)
- **Related**: ADR-0183 (`multiFlags` infra), ADR-0224 (family-wide JSON
  envelope conventions), ADR-0225 (history envelope rename), ADR-0199/
  0200/0207/0210/0211/0214/0217/0218/0219/0220/0221/0222/0223 (15 prior
  multi-value milestones that introduced positive + negative flag pairs)

## Context

15 multi-value milestones introduced positive (`--kind`, `--actor-id`) +
negative (`--kind-not`, `--actor-id-not`) flag pairs on all 3 retention
surfaces, plus per-side variants on diff-history. Operators can express
**set-intersection contradictions** like `--kind opt_out_set --kind-not
opt_out_set` that silently produce empty PG results (IN AND NOT IN same
value = empty by construction). Multiple ADRs deferred CLI-side eager
contradiction detection as a future Q.

The set-intersection contradiction pattern is universal across the family:
- Global: positive_set ∩ negative_set non-empty
- Per-side: positive_a_set ∩ negative_a_set non-empty (similar for B)

This ADR closes the deferred Q with uniform CLI-side eager contradiction
detection across all 3 retention surfaces, exiting 2 with a clear error
naming the conflicting values BEFORE the adapter call.

### Why now

- 15 multi-value milestones produce mature flag pairs ready for cross-flag
  validation.
- Operators using multi-value flags in scripts hit the silent-empty-result
  surprise often; CLI-side errors save debugging time.
- ADR-0224 codified envelope conventions; cross-flag validation is the
  natural ergonomic layer on top.
- Set-intersection detection is mechanical given the established
  conventions.

### Real contradiction use cases (caught now)

1. **Copy-paste error** — operator copies a kind value from one shell var
   to two flags by mistake (`--kind $K --kind-not $K`).
2. **Cohort iteration** — operator scripts that build flag lists from
   external sources may include duplicates across positive/negative.
3. **Refactoring drift** — operator updates one flag list but forgets to
   remove from the other; silent empty result.
4. **CI script regressions** — flag list construction logic regresses to
   include conflicts; CI flags fail fast with explicit error.

### Use cases NOT caught (deferred as future Qs)

1. **Semantic contradictions across dimensions** — `--system-only` +
   `--actor-id Y` (system-only requires null actor_id; --actor-id requires
   non-null UUID; produces empty result). Deferred — multi-dimensional
   semantic check; harder to articulate clean error message.
2. **Cross-side per-side contradictions** — `--kind-a opt_out_set
   --kind-b opt_out_set` (operator may intentionally assert both sides
   same kind). Not a contradiction; same-value pattern allowed.
3. **Global + per-side contradictions** — `--system-only` + `--no-system-a`
   (global says BOTH systems; per-side says A is human). Adapter ordering
   handles this; CLI-side check would require additional cross-flag
   reasoning. Defer.
4. **Per-side intra-side mutual-exclusivity** — `--system-only-a` +
   `--no-system-a` already detected (exits 2 from ADR-0216).

## Decision

Add CLI-side eager contradiction detection for set-intersection non-empty
between positive + negative multi-value flag pairs. Exit 2 with explicit
error naming the conflicting value(s) BEFORE the adapter call.

### Detection helper

```ts
function findContradictoryValues<T>(
  positive: ReadonlyArray<T> | undefined,
  negative: ReadonlyArray<T> | undefined,
): T[] {
  if (
    positive === undefined ||
    positive.length === 0 ||
    negative === undefined ||
    negative.length === 0
  ) {
    return [];
  }
  const negativeSet = new Set<T>(negative);
  return positive.filter((value) => negativeSet.has(value));
}
```

Generic over `T` to handle both `OptOutHistoryEventKind` (kind dimension)
and `string` (actor-id dimension). Returns array of conflicting values
(not just boolean) so the error message can name them.

### Per-surface checks

**Retention history** (2 checks):
- `--kind / --kind-not`
- `--actor-id / --actor-id-not`

**Retention diff-timeline** (2 checks; applies across all 3 dispatch
paths since parsing happens once at top of function before path
dispatch):
- `--kind / --kind-not`
- `--actor-id / --actor-id-not`

**Retention diff-history** (6 checks for the per-event-pair surface with
per-side variants):
- `--kind / --kind-not`
- `--kind-a / --kind-not-a`
- `--kind-b / --kind-not-b`
- `--actor-id / --actor-id-not`
- `--actor-id-a / --actor-id-not-a`
- `--actor-id-b / --actor-id-not-b`

Per-side checks use the same `findContradictoryValues` helper applied to
per-side field pairs. Implementation uses a table of `{ label, positive,
negative }` records iterated in a tight loop for clean code.

### Check ordering

Contradiction checks fire AFTER multi-value flag parsing + validation but
BEFORE the adapter call. The diff-history surface fires kind checks
before actor checks (matching the adapter's check ordering pattern).
Within kind/actor: global before per-side A before per-side B.

### Error format

```
retention {surface}: {label} share value(s) [{values}] — empty result by construction
```

Where:
- `{surface}` = `history` / `diff-timeline` / `diff-history`
- `{label}` = the flag pair (e.g., `--kind and --kind-not`, `--actor-id-a
  / --actor-id-not-a`)
- `{values}` = quoted, comma-separated list of conflicting values

Examples:
```
retention history: --kind and --kind-not share value(s) ['opt_out_set'] — empty result by construction
retention diff-history: --actor-id-a / --actor-id-not-a share value(s) ['11111111-...'] — empty result by construction
```

Exit code 2 (CLI validation error, distinct from exit 1 adapter error).

### Adapter behavior unchanged

If contradictions slip through (e.g., adapter called directly bypassing
CLI), the PG layer still handles correctly (returns empty result via
SQL IN AND NOT IN). The CLI-side check is an ergonomic guard, not a
correctness requirement.

## Rejected alternatives

1. **Adapter-side contradiction detection** — would push the check into
   PG layer with error responses; less ergonomic than CLI-side; harder to
   render clean error messages; adapter consumers other than CLI would
   need to handle the error responses.
2. **Warning instead of error (exit 0 with stderr warning)** — silent
   empty result is the operator confusion to fix; warning + empty result
   wouldn't prevent CI scripts from succeeding with empty data.
3. **Detection of cross-dimensional semantic contradictions in same
   milestone** (`--system-only` + `--actor-id Y`) — multi-dimensional
   semantic checks would expand scope significantly; defer to a follow-
   up milestone focused on semantic contradictions.
4. **Auto-resolve contradictions by removing conflicting values** —
   operator intent is ambiguous (was the positive or negative correct?);
   exit 2 forces operator to clarify.
5. **Single combined check function instead of per-pair labeled checks** —
   error message would lose specificity; "some kind dimension contradicts"
   wouldn't help operator find which flag pair to fix.
6. **CLI flag to disable contradiction checks (`--allow-contradiction`)**
   — adds CLI complexity without enduring benefit; if operator wants
   empty result, they can write a filter that's NOT contradictory.
7. **Detect partial contradictions** (e.g., `--kind X Y` + `--kind-not X`
   — Y survives) — already handled by IN AND NOT IN at PG layer
   (returns only Y); not a contradiction since result is non-empty.
   Defining "partial" contradiction would require operator-policy.
8. **Check at parsed-command level instead of per-surface** — would
   require generic surface metadata; cleaner to add per-surface where
   the field types are known.

## Future questions

1. **`--system-only` + `--actor-id Y` cross-dimensional semantic
   contradiction** — system-only requires actor_id IS NULL; --actor-id
   requires actor_id IN (Y); empty result. Defer — separate semantic-
   contradiction milestone.

2. **`--no-system` + redundant `--actor-id` (where Y is non-null)** —
   not a contradiction; `--no-system` filters to non-null actor_id,
   `--actor-id Y` is a subset. Redundant but valid; no check needed.

3. **Global + per-side contradiction** — `--system-only` (global says
   BOTH events system) + `--no-system-a` (A is human). Adapter ordering
   handles; CLI-side check would require additional reasoning. Defer.

4. **Partial contradiction warnings** — `--kind X Y --kind-not X` —
   Y survives; warning could note that X is redundantly excluded. Defer
   — operator-policy.

5. **`--explain` flag showing why a query would return empty** — when
   contradictions detected, the error already explains; for legitimate
   empty results, `--explain` showing SQL + bound parameters would help.
   Defer — separate milestone (ADR-0224 future Q5 family).

6. **CLI-side eager validation of UUID format on `--actor-id` /
   `--actor-id-not`** — currently free-form strings; PG validates at
   SQL layer. CLI-side regex validation would catch typos earlier but
   duplicate PG's validation. Defer.

## Consequences

- **15 multi-value milestones' recurring future Q closed** — set-
  intersection contradiction detection is the natural ergonomic layer
  on top of the multi-value family.
- **Test count: 9,153 → 9,170** (+17 net: 17 CLI tests covering all 3
  surfaces + per-side variants on diff-history).
- **No adapter changes** — pure CLI-side ergonomic check; adapter
  contract unchanged.
- **Operators get fast feedback** — copy-paste errors, refactoring drift,
  CI script regressions all caught with explicit exit 2 errors naming
  the conflicting values.
- **Same-value cross-side patterns preserved** — `--kind-a X --kind-b X`
  is NOT a contradiction (operators may intentionally assert both sides
  same kind); only same-dimension positive/negative pairs are checked.
- **Check ordering is deterministic** — kind dimension before actor
  dimension; global before per-side; A before B. Operators fixing one
  contradiction can predict the next one.
- **Pattern documented for future surfaces** — when new retention
  actions add multi-value positive/negative pairs, they inherit the
  contradiction check pattern via the shared `findContradictoryValues`
  helper.
