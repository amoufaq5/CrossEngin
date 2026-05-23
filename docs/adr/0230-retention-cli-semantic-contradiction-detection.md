# ADR-0230: Retention CLI cross-dimensional semantic contradiction detection

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.semantic-contradiction
- **Closes**: ADR-0226 future Q1 (cross-dimensional semantic
  contradiction detection — `--system-only` + `--actor-id Y`)
- **Related**: ADR-0226 (same-dimension set-intersection contradiction
  detection), ADR-0212 (`--system-only`/`--no-system` on diff-history),
  ADR-0216 (per-side `--system-only-a`/`-b` on diff-history)

## Context

ADR-0226 introduced same-dimension set-intersection contradiction
detection (`--kind X` + `--kind-not X`, `--actor-id Y` + `--actor-id-not
Y`). The future-Qs section deferred multi-dimensional semantic
contradictions where flags in DIFFERENT dimensions produce empty results
by SQL construction.

The canonical multi-dimensional contradiction is:
- `--system-only` requires `actor_id IS NULL` (SQL WHERE clause)
- `--actor-id Y` requires `actor_id IN (Y)` where Y is non-null UUID

These two conditions are mutually exclusive at the SQL layer; PG returns
an empty result. Operators using both flags together silently get no
data; this milestone surfaces the contradiction as exit-2 BEFORE the
adapter call.

### Use cases caught now

1. **Copy-paste error** — operator copies `--system-only` from one
   shell var and `--actor-id $ACTOR` from another, not realizing they're
   mutually exclusive.
2. **Refactoring drift** — operator script updates `--actor-id` list
   but leaves `--system-only` in place.
3. **CI script regressions** — flag construction logic regresses to
   include both flags simultaneously.
4. **Operator learning the semantics** — `--system-only` = "no actor",
   `--actor-id` = "specific actor"; the contradiction surface helps
   operators internalize that these are different dimensions.

### Use cases NOT caught (intentional)

1. **`--no-system` + `--actor-id Y`** — NOT a contradiction. `--no-
   system` requires `actor_id IS NOT NULL`; `--actor-id Y` requires
   `actor_id IN (Y)` where Y is non-null UUID. The conditions are
   compatible (redundant `--no-system` since `--actor-id Y` already
   implies non-null).

2. **`--system-only` + `--actor-id-not Y`** — NOT a contradiction.
   `--system-only` requires `actor_id IS NULL`; `--actor-id-not Y`
   requires `(actor_id IS NULL OR actor_id NOT IN (Y))` per ADR-0211.
   The IS NULL branch satisfies both clauses; PG returns system events.
   Valid composition.

3. **`--system-only-a` + `--actor-id-b Y`** — NOT a contradiction.
   Cross-side flags on diff-history operate on different events; A's
   system-presence constraint doesn't conflict with B's actor-id
   constraint.

4. **`--system-only` + `--system-only-a` + `--actor-id-a Y`** —
   Contradictory at per-side level (`--system-only-a` + `--actor-id-a Y`
   is caught); the global `--system-only` is redundant once per-side
   contradicts.

## Decision

Add CLI-side eager detection for the `--system-only` + `--actor-id`
cross-dimensional contradiction across all 3 retention surfaces. Exit 2
with explicit error naming the conflicting flags BEFORE the adapter
call.

### Per-surface checks

**Retention history** (1 check):
- `--system-only` (actorPresence === "system_only") + `--actor-id`
  (actorIds !== undefined)

**Retention diff-timeline** (1 check):
- Same as history (parsing happens once at top of dispatcher).

**Retention diff-history** (3 checks for global + 2 per-side):
- Global `--system-only` + `--actor-id`
- Per-side `--system-only-a` + `--actor-id-a`
- Per-side `--system-only-b` + `--actor-id-b`

### Check structure

Uses a table-driven approach matching ADR-0226's pattern:

```ts
const presenceActorChecks: ReadonlyArray<{
  label: string;
  presence: "system_only" | "no_system" | undefined;
  actors: ReadonlyArray<string> | undefined;
}> = [
  { label: "--system-only + --actor-id", presence: actorPresence, actors: actorIds },
  { label: "--system-only-a + --actor-id-a", presence: actorPresenceA, actors: actorIdsA },
  { label: "--system-only-b + --actor-id-b", presence: actorPresenceB, actors: actorIdsB },
];
for (const check of presenceActorChecks) {
  if (check.presence === "system_only" && check.actors !== undefined) {
    printError(ctx.io, `retention diff-history: ${check.label} — ...`);
    return 2;
  }
}
```

### Check ordering

The cross-dimensional check fires AFTER same-dimension contradiction
detection (ADR-0226) but BEFORE the adapter call. Within the cross-
dimensional check:
- Global before per-side
- A before B

### Error format

```
retention {surface}: --system-only{+side} + --actor-id{+side} — system-only requires actor_id IS NULL but --actor-id requires a non-null UUID — empty result by construction
```

Includes:
- Surface name (history / diff-timeline / diff-history)
- Both contradicting flags
- Brief SQL semantic explanation (IS NULL vs IN UUID)
- "empty result by construction" suffix (matches ADR-0226's error format)

Exit code 2 (CLI validation error, distinct from exit 1 adapter error).

### Asymmetric --no-system + --actor-id treatment

`--no-system` + `--actor-id` is NOT detected as a contradiction:
- `--no-system` requires `actor_id IS NOT NULL`
- `--actor-id Y` requires `actor_id IN (Y)` where Y is non-null UUID
- Both satisfiable by any UUID; composition is valid (redundant but
  not wrong).

Operators using both pay a small redundancy cost; no harm. This is
intentional — same-dimension set-intersection (ADR-0226) flags ACTUAL
contradictions; cross-dimensional check only flags definite-empty-by-
construction patterns.

## Rejected alternatives

1. **Detect `--no-system` + `--actor-id` redundancy as a warning** —
   warnings on valid compositions add noise; operators may intentionally
   want explicit redundancy for self-documentation.
2. **Auto-resolve by dropping `--system-only` when `--actor-id` present
   ** — operator intent ambiguous; exit-2 forces them to clarify.
3. **CLI flag to disable semantic contradiction detection (`--allow-
   contradictory-semantics`)** — adds CLI complexity without enduring
   benefit; operators wanting empty result can construct it differently.
4. **Detect at adapter-side via SQL EXPLAIN ANALYZE preview** — wrong
   layer; CLI-side check fires before any database connection.
5. **Bundle with ADR-0226 same-dimension checks** — same-dimension
   (ADR-0226) and cross-dimensional (this ADR) checks have different
   semantic scopes; documenting them separately makes the operator
   contract clearer.
6. **Detect `--system-only` + `--no-system` (already detected by ADR-
   0212)** — out of scope; same-dimension mutual exclusion already
   handled.
7. **Detect cross-side per-side contradictions like `--system-only-a`
   + `--no-system-b`** — NOT a contradiction (different sides operate
   on different events); cross-side asymmetric assertions are
   intentional per ADR-0215.
8. **Group all cross-dimensional contradictions in a generic
   "constraint solver" framework** — premature abstraction; current
   `--system-only` + `--actor-id` is the only multi-dimensional
   contradiction in the current flag set; add framework when 2nd
   pattern emerges.
9. **Defer to a future "semantic linter" feature** — operators using
   the contradictory pattern today benefit from eager feedback;
   linter as separate tool adds friction.

## Future questions

1. **`--system-only` + `--actor-id-not Y` — NOT a contradiction
   confirmation test** — adapter-level test verifying that this
   composition returns valid system events when actor_id IS NULL or
   actor_id NOT IN (Y). Defer — already verified manually; could be
   added as a documentary test.

2. **Multi-dimensional contradictions in future flag families** — if
   new flag dimensions are added (e.g., `--tenant-tier` + `--actor-
   internal-only`), they may introduce new cross-dimensional
   contradictions. Document the detection pattern so new flags
   inherit it.

3. **Contradiction detection between global + per-side flags** —
   e.g., `--system-only` (global says BOTH events) + `--actor-id-a
   Y` (per-side A is specific UUID). Globally contradictory if A
   must be system AND must be Y. Adapter ordering handles this
   (global fires first). Defer — current adapter behavior is
   correct.

4. **Detection across all 3 retention surfaces uniformly for new
   flag dimensions** — if a new flag is added in a future milestone,
   it inherits the cross-dimensional check pattern via the table-
   driven structure. Document.

5. **CLI hint about valid alternatives** — when contradiction
   detected, suggest valid alternatives (e.g., "use --no-system
   --actor-id Y for human-authored events by Y"). Defer — current
   error message is precise; suggestions could be added later as
   operator UX polish.

6. **JSON output for contradiction errors** — currently errors go
   to stderr as plain text. For programmatic consumers, JSON-
   structured error responses (`{error: "contradiction", flags: [...],
   reason: "..."}`) might be useful. Defer — operators using
   programmatic flow can parse exit code 2 + stderr message; JSON
   error structure is operator-UX polish.

## Consequences

- **Operators get eager feedback on `--system-only` + `--actor-id`
  copy-paste/refactoring/CI regressions** — saves debugging time
  when silent empty results would otherwise mask the issue.
- **5 new contradiction checks** — 1 on history, 1 on diff-timeline,
  3 on diff-history (global + per-side A + per-side B).
- **Test count: 9,220 → 9,229** (+9 net: 9 CLI tests covering all 3
  surfaces + per-side variants + valid compositions + check-before-
  adapter).
- **No adapter changes** — pure CLI-side ergonomic check; adapter
  contract unchanged.
- **Asymmetric treatment between `--no-system` + `--actor-id`
  (valid) and `--system-only` + `--actor-id` (contradiction)** —
  documented intentionally; only definite-empty-by-construction
  patterns flagged.
- **Pattern documented for future cross-dimensional contradictions
  ** — table-driven structure; when new flag families introduce
  cross-dimensional contradictions, they extend the
  `presenceActorChecks`-style table.
- **Check ordering preserved** — same-dimension (ADR-0226) before
  cross-dimensional (this ADR) before adapter call; operators
  fixing one contradiction predict the next one.
- **Existing test updated** — one --explain plan test used
  `--system-only` + `--actor-id` together (now contradictory);
  updated to use `--no-system` + `--actor-id` (valid composition);
  test still verifies plan echo coverage.
