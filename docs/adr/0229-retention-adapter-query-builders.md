# ADR-0229: Retention adapter query-builder methods (raw SQL for --explain)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.explain-flag.raw-sql
- **Closes**: ADR-0228 future Q1 (adapter-level explainXxxQuery returning
  raw SQL + bound parameters, Option B from --explain milestone)
- **Related**: ADR-0228 (--explain flag with CLI-side query plan)

## Context

ADR-0228 deferred adapter-level raw SQL output as Option B because it
required refactoring 5 adapter methods to extract SQL-building into
shared helpers. The CLI-side query plan (Option A) shipped in ADR-0228
gives operators structured filter echoes but not the actual PG SQL.

Operators debugging legitimate empty results or learning the query shape
benefit from seeing the raw SQL — especially when filter combinations
become complex (multi-value flags, per-side variants, cursor pagination,
etc.).

This ADR closes ADR-0228 Q1 by refactoring all 5 retention adapter
methods to expose public query-builder methods that return `{sql,
params}` without executing.

## Decision

Refactor 5 retention adapter methods to extract SQL-building into public
builder methods. Existing methods call the builders + execute; builders
are exposed for `--explain` to get raw SQL.

### Refactor pattern

For each of 5 methods, extract the SQL-building logic into a public
`buildXxxQuery(input): {sql, params}` method. The existing async method
becomes "call builder, execute via this.conn.query, post-process rows".

```ts
// Before:
async listOptOutHistory(input): Promise<ReadonlyArray<...>> {
  // 100+ lines: build conditions, build params, build SQL, execute, process
}

// After:
buildListOptOutHistoryQuery(input): {sql: string; params: unknown[]} {
  // 100 lines: build conditions, build params, return {sql, params}
}

async listOptOutHistory(input): Promise<ReadonlyArray<...>> {
  const {sql, params} = this.buildListOptOutHistoryQuery(input);
  const result = await this.conn.query<...>(sql, params);
  return result.rows.map(...);  // post-process
}
```

### 5 new builder methods

1. `buildListOptOutHistoryQuery(input)` — retention history surface
2. `buildDiffHistoryEntriesQuery(input)` — diff-history surface
3. `buildDiffHistoryTimelineQuery(input)` — diff-timeline pair-wise
4. `buildDiffHistoryTimelineNwayQuery(input)` — diff-timeline N-way
5. `buildDiffHistoryTimelineCrossTableQuery(input)` — diff-timeline cross-
   table

All return `{sql: string; params: unknown[]}`. All are public methods
(no `private` keyword, no underscore prefix) — operators using the
adapter directly can call them.

### Validation in builders

Builders include validation that previously lived in adapter methods:
- `buildListOptOutHistoryQuery` validates limit (`>=1, integer`)
- `buildDiffHistoryTimelineQuery` validates limit
- `buildDiffHistoryTimelineNwayQuery` validates `tenantIds.length >= 2` +
  limit
- `buildDiffHistoryTimelineCrossTableQuery` validates `tableNames.length
  >= 2` + limit

Validation throws synchronously (not in a Promise). Tests verify both
the SQL output for valid inputs and the throws for invalid inputs.

### CLI `--explain` integration

Each `--explain` branch in the CLI calls the corresponding builder and
includes `sql` + `params` in the plan output:

```json
{
  "action": "history",
  "explain": true,
  "executed": false,
  "filters": {...},
  "pagination": {...},
  "output": {...},
  "sql": "SELECT h.id, h.tenant_id, ... FROM meta.tenant_retention_opt_out_history h WHERE h.tenant_id = $1 ORDER BY h.occurred_at DESC, h.id DESC LIMIT $2",
  "params": ["00000000-...", 100]
}
```

Operators can copy the SQL + params into psql, EXPLAIN ANALYZE, or
SQL debugging tools.

### `diff-history` special case

`diff-history` builds a fixed-shape SELECT (`WHERE h.id IN ($1, $2)`)
because the expectation checks (kind / actor / per-side / actorPresence)
are applied in JS POST-fetch, not in the SQL WHERE clause. The CLI's
`--explain` output for diff-history includes the raw SQL plus a
`sqlNote` field explaining:

> "expectation checks (kind/actor/per-side/presence) are applied in
> adapter post-fetch; only base SELECT shown"

This is intentional — diff-history's expectation checks are JS-layer
validations on the fetched rows, not SQL WHERE clauses. Operators see
the raw query but understand the additional JS-side semantic.

### Existing test coverage preserved

The refactor preserves all 599 pre-existing adapter tests by routing
the existing methods through the builder. Tests verifying SQL output
(via `mockConnection` capture) continue to work unchanged because the
final SQL string and params are identical.

A "builder/adapter consistency" test verifies that
`buildListOptOutHistoryQuery(input).sql === capture[0]?.sql` when
`listOptOutHistory(input)` is called — guarding against future drift
between builder and execute path.

## Rejected alternatives

1. **Duplicate SQL-building logic in separate explainXxx methods** —
   maintenance burden (two places to update on any WHERE clause
   change); refactor is cleaner.
2. **Add explain parameter to adapter Input types** (`explainOnly:
   true`) — return type would need to support both rows and
   `{sql, params}`; messy.
3. **Refactor in 2 milestones (3 methods now + 2 methods later)** —
   partial refactor leaves operators with inconsistent --explain
   output (some surfaces have raw SQL, others don't); cleaner to do
   all 5 in one milestone.
4. **Private builders + separate public explainXxx methods** — public
   builders simplify the public API; operators calling the adapter
   directly already have access to the SQL string. Naming `buildXxx`
   over `explainXxxQuery` because it accurately describes the method
   (constructs SQL from input).
5. **Keep validation in async methods, move only SQL-building to
   builder** — synchronous validation in builder gives faster
   feedback for `--explain` paths (invalid inputs throw before the
   plan is constructed).
6. **Use a SQL templating library** — adds external dependency; the
   in-repo string concatenation is straightforward; testing with
   mockConnection capture verifies correctness.
7. **Expose the SQL string as a static const + parameterize separately**
   — the SQL structure varies based on input (joinActor, conditions
   present); dynamic construction is required.
8. **Skip diff-history SQL output entirely (it's too simple to be
   useful)** — operators may want to verify the base SELECT is
   correct; including with sqlNote is clearer than omitting.

## Future questions

1. **Per-condition annotations in the SQL output** — annotate each
   WHERE clause with the originating CLI flag (e.g., `-- from --kind
   flag\nh.event_kind IN ($2, $3)`). Defer — adds rendering complexity;
   operators can map params back to flags via the plan's `filters`
   field.

2. **EXPLAIN ANALYZE integration** — actually execute `EXPLAIN
   ANALYZE <sql>` against PG and return the plan + timing. Would
   require executing against the database (`--explain` currently
   doesn't); naturally pairs with a separate `--explain-analyze`
   flag. Defer.

3. **SQL formatting via prettier-sql or similar** — current SQL is
   templated strings with whitespace from template literals; not
   "pretty". A formatter would make `--explain` output more
   readable. Defer — operators copying into psql don't need pretty
   formatting.

4. **Type-narrow params array as `ReadonlyArray<unknown>`** —
   builders return `unknown[]` (mutable); could narrow to readonly.
   Defer — internal implementation detail; minimal benefit.

5. **Builder cache for identical inputs** — same input produces same
   `{sql, params}`; cache could amortize builder cost. Defer —
   builder cost is microseconds; not a bottleneck.

6. **Expose builders in the package's public API surface (types
   exported from the package's index.ts)** — currently the methods
   are public on the class but not explicitly re-exported. Operators
   importing the adapter class get the methods automatically. Defer
   — no actionable change.

## Consequences

- **Operators get raw PG SQL in `--explain` output** — closes the
  highest-impact follow-up from ADR-0228; --explain plan now
  includes both structured filter echo AND raw SQL + bound
  parameters.
- **Adapter contract enriched** — 5 new public builder methods on
  `PostgresTraceRetention`; downstream consumers can use them
  directly without going through the CLI.
- **Test count: 9,205 → 9,220** (+15 net: 10 adapter builder tests +
  5 CLI --explain raw-SQL tests).
- **No behavioral change to existing adapter methods** — refactor
  preserves SQL output character-for-character (verified by
  builder/adapter consistency test).
- **diff-history `--explain` is partial** — base SELECT shown +
  `sqlNote` clarifying that expectation checks are applied JS-side
  post-fetch. Operators understand the limitation.
- **Validation moves into builders** — limit/tenantIds/tableNames
  validation throws synchronously from the builder; operators using
  `--explain` see validation errors before plan construction.
- **Builder/adapter consistency is testable** — a "sql identical"
  test guards against future drift between builder and the
  execution path; refactor risk reduced.
- **Pattern documented for future adapter methods** — when new
  retention CLI actions are added, the adapter contributes a builder
  method that the CLI's `--explain` uses for raw SQL output.
