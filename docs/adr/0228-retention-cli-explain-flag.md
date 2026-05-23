# ADR-0228: Retention CLI `--explain` flag (query plan output)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.explain-flag
- **Closes**: ADR-0226 future Q5 (`--explain` flag showing why a query
  would return empty)
- **Related**: ADR-0224 (family-wide JSON envelope conventions), ADR-0226
  (cross-flag contradiction detection), ADR-0227 (CSV output format)

## Context

ADR-0226 deferred the `--explain` flag as a future Q. Operators
encountering empty result sets need to understand:
1. Whether the empty result is from a query that returned no matches
   (legitimate empty) vs. a contradictory filter combination (caught now
   by ADR-0226 contradiction detection).
2. What effective filters their flag combinations actually produce
   (especially with multi-value flag families introduced in 13 prior
   milestones).
3. What pagination cursor / output format would be applied.

`--explain` provides a CLI-side preview of the query plan WITHOUT
executing the adapter call, complementing ADR-0226's eager contradiction
detection.

### Scope tradeoff: CLI-side plan vs adapter-level raw SQL

Two implementation approaches were considered:

**Option A (chosen)**: CLI-side query plan that echoes operator flags and
describes effective filters in structured form. No adapter changes.

**Option B (deferred)**: Adapter exposes `explainXxxQuery(input): {sql,
params}` methods that return raw PG SQL + bound parameters. Operators see
the actual SQL. Requires refactoring 5 adapter methods to extract SQL-
building into shared helpers.

Option A chosen because:
- Pure CLI-side; no adapter changes.
- Sufficient for the most common operator use case ("what filters are
  effective here?").
- Smaller scope; can be shipped in a single milestone.
- Raw SQL deferred as future Q (Option B for follow-up milestone).

## Decision

Add `--explain` boolean flag to all 3 retention surfaces. When set:
- Skip the adapter call entirely
- Emit a structured "query plan" object describing the operator's
  effective filters, pagination, and output spec
- Exit 0 (success)

### `ExplainPlan` interface

```ts
interface ExplainPlan {
  readonly action: string;            // "history" / "diff-history" / "diff-timeline"
  readonly explain: boolean;          // always true
  readonly executed: boolean;         // always false
  readonly [key: string]: unknown;    // surface-specific fields
}
```

### Per-surface plan shapes

**Retention history**:
```json
{
  "action": "history",
  "explain": true,
  "executed": false,
  "filters": {
    "tenantId": "...", "tableName": "...", "kinds": [...], "kindsNot": [...],
    "actorIds": [...], "actorIdsNot": [...], "actorPresence": "...",
    "since": "...", "until": "..."
  },
  "pagination": {
    "limit": 100, "afterId": "...", "beforeId": "...", "range": "..."
  },
  "output": {
    "ordering": "occurred_at DESC, id DESC",
    "withActorNames": false
  }
}
```

**Retention diff-history**:
```json
{
  "action": "diff-history",
  "explain": true,
  "executed": false,
  "idA": "...",
  "idB": "...",
  "filters": {
    "kinds": [...], "kindsA": [...], "kindsB": [...],
    "kindsNot": [...], "kindsNotA": [...], "kindsNotB": [...],
    "actorIds": [...], "actorIdsA": [...], "actorIdsB": [...],
    "actorIdsNot": [...], "actorIdsNotA": [...], "actorIdsNotB": [...],
    "actorPresence": "...", "actorPresenceA": "...", "actorPresenceB": "..."
  },
  "output": { "withActorNames": false }
}
```

**Retention diff-timeline** (3 dispatch paths discriminated):
```json
{
  "action": "diff-timeline",
  "explain": true,
  "executed": false,
  "dispatchPath": "pair-wise" | "nway" | "cross-table",
  "tenants": [...],
  "tables": [...],
  "filters": { ... },
  "pagination": { ... },
  "output": {
    "ordering": "occurred_at ASC, id ASC",
    "withActorNames": false
  }
}
```

### Human-readable rendering (default format)

When `--format=human` (default), the plan is rendered as:

```
Query plan: retention history (NOT executed; remove --explain to run)
  filters:
    tenantId: '...'
    kinds: ["opt_out_set"]
    kindsNot: (any)
    actorIds: (any)
    ...
  pagination:
    limit: 100
    afterId: (any)
    ...
  output:
    ordering: 'occurred_at DESC, id DESC'
    withActorNames: false
```

Format conventions:
- `null` / `undefined` → `(any)` (filter not active)
- Arrays → `[v1, v2, v3]` (JSON-stringified values)
- Strings → `'value'` (quoted)
- Other primitives → `String(value)`

### JSON / CSV format handling

When `--format=json` or `--format=csv` is set, the plan is emitted as
pretty-printed JSON (CSV doesn't make sense for a single-row plan
object; falls back to JSON).

### Execution order with other CLI checks

`--explain` fires AFTER:
1. Flag parsing + validation (invalid flag values exit 2 before --explain).
2. ADR-0226 contradiction detection (contradictions exit 2 before
   --explain).
3. Other CLI-side validation (e.g., `--system-only` + `--no-system`
   mutual exclusion).

`--explain` fires BEFORE:
- Any adapter call.
- Any database connection.

This ordering ensures `--explain` doesn't bypass important error paths;
operators using `--explain` with a contradictory flag combination still
see the contradiction error (exit 2) rather than a misleading plan.

### Composition with other flags

- `--explain` + `--format=csv` → emits JSON plan (CSV-of-single-row
  doesn't make sense).
- `--explain` + `--with-actor-names` → plan echoes `withActorNames: true`.
- `--explain` + contradictory flag pair → contradiction error fires
  first (exit 2).
- `--explain` + `--tenant X --kind opt_out_set --kind-not opt_out_set` →
  exit 2 with contradiction error; no plan emitted.

## Rejected alternatives

1. **Adapter-level explainXxxQuery methods returning raw SQL** (Option
   B above) — useful but requires refactoring 5 adapter methods to
   extract SQL-building into shared helpers; scope creep for a single
   milestone; defer as future Q.
2. **Print SQL by reconstructing it at the CLI layer** — would
   duplicate the adapter's SQL-building logic; maintenance burden;
   defer to adapter refactor.
3. **`--dry-run` instead of `--explain`** — `--dry-run` is already
   used by `retention restore` and `retention prune` with the semantic
   "show what would change without writing". `--explain` is read-only
   query inspection; semantic distinct. Operators familiar with PG's
   `EXPLAIN` will recognize the naming.
4. **`--plan` instead of `--explain`** — `--explain` matches the
   conceptual mental model from `EXPLAIN` in SQL; `--plan` is less
   immediately recognizable.
5. **Auto-execute when --explain produces an empty filter set** —
   operators may intentionally want to see a "no-filter" plan; auto-
   executing would skip the documentation step.
6. **Skip --explain handling when contradiction detected** — operator
   may chain --explain expecting it to surface even invalid flag
   combinations; checking BEFORE --explain ensures errors aren't
   silently swallowed.
7. **Add --explain to non-list retention actions (`retention set`,
   `retention restore`, etc.)** — those actions emit success/failure
   results; a "plan" without execution adds little value. Defer.
8. **CSV output for --explain plan** — single-row plan doesn't
   naturally fit CSV's tabular shape; falling back to JSON is
   cleaner.

## Future questions

1. **Adapter-level explainXxxQuery methods returning raw SQL + bound
   parameters** — Option B from the scope tradeoff above. Refactor 5
   adapter methods to extract `_buildXxxQuery(input): {sql, params}`
   helpers; expose public `explainXxxQuery` methods. Operators get
   actual PG SQL. Defer to a follow-up milestone.

2. **`--explain analyze` for executed query plan** — analogous to PG's
   `EXPLAIN ANALYZE`; would execute the query AND show timing /
   row-count statistics. Larger scope; defer.

3. **Plan rendering options** (`--explain-format=tree`, `--explain-
   format=compact`) — operators may want different human-readable
   layouts. Defer — current format works.

4. **--explain output to a separate file** (`--explain-to <path>`) —
   for scripts that need to log the plan separately from data output.
   Defer; operators can redirect stdout in shell.

5. **Plan stability across retention CLI versions** — when new flags
   are added, plan shape changes (additive). Document plan shape as
   part of canonical envelope conventions (extend ADR-0224 + ADR-0225)
   so operators can rely on field paths. Defer.

6. **CLI hash/cache for repeated `--explain` invocations** — operators
   exploring flag combinations may re-invoke many times; caching the
   plan generation would be premature optimization since plan generation
   is microseconds. Defer indefinitely.

## Consequences

- **Operator ergonomic improvement** — operators can preview retention
  query intent without database round-trip; complements ADR-0226's eager
  contradiction detection by handling the legitimate-empty cases.
- **Test count: 9,194 → 9,205** (+11 net: 11 CLI tests across all 3
  retention surfaces + 3 diff-timeline dispatch paths).
- **No adapter changes** — pure CLI-side feature; adapter contract
  unchanged.
- **No breaking changes** — `--explain` is ADDITIVE; default behavior
  (without `--explain`) unchanged.
- **Plan shape is canonical** — `action` + `explain` + `executed` +
  surface-specific fields; follows ADR-0224 envelope conventions
  (array-or-null for multi-value, etc.).
- **3 retention surfaces have --explain** — history (single-path),
  diff-history (per-event-pair), diff-timeline (3 dispatch paths with
  discriminated plan).
- **Execution order documented** — `--explain` fires AFTER validation +
  ADR-0226 contradiction detection but BEFORE adapter call; operators
  can chain `--explain` with any flag combination and get either the
  plan (legitimate) or an error (invalid/contradictory).
- **Raw SQL deferred** — operators wanting actual PG SQL with bound
  parameters will need to wait for the adapter-refactor follow-up
  milestone (future Q1 above).
- **Pattern documented for future surfaces** — when new retention
  actions are added, they inherit the `--explain` pattern via the
  shared `formatExplainPlan` helper and `ExplainPlan` interface.
