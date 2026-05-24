# ADR-0240: Retention CLI `--explain-analyze` (executed EXPLAIN ANALYZE)

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.explain-analyze
- **Closes**: ADR-0228 future Q2 (`--explain analyze` for executed query
  plan) + ADR-0229 Q2 family
- **Related**: ADR-0228 (`--explain` offline plan), ADR-0229 (query
  builders), ADR-0232 (summary action)

## Context

ADR-0228 shipped `--explain` (offline query plan) and ADR-0229 added the
`buildXxxQuery` methods returning `{sql, params}`. The future-Qs noted
that operators sometimes need PostgreSQL's REAL execution plan — actual
timing, actual row counts, index-usage decisions — not just the static
plan shape. PG's `EXPLAIN ANALYZE` provides this by executing the query.

This ADR adds `--explain-analyze`, which runs `EXPLAIN (ANALYZE, FORMAT
JSON) <query>` against the database and returns PG's real execution
plan, closing ADR-0228 Q2.

### `--explain` vs `--explain-analyze`

| Aspect | `--explain` | `--explain-analyze` |
|--------|-------------|----------------------|
| Executes query? | No (offline) | Yes (read-only SELECT) |
| Output | filters + raw SQL + params | PG execution plan JSON |
| DB round-trip? | No (builds SQL locally) | Yes |
| Timing/row counts? | No | Yes (actual) |
| Use case | "what would run?" | "how does it actually perform?" |

### Operator use cases

1. **Index-usage diagnosis** — "is the partial index on (tenant_id,
   occurred_at) actually used for this filter combination?"
2. **Slow-query investigation** — actual timing per plan node for a
   summary over a large history table.
3. **Cardinality validation** — actual vs estimated row counts to spot
   stale statistics.

## Decision

Add `--explain-analyze` to the 4 read surfaces that support `--explain`
(history, summary, diff-history, diff-timeline). It builds the query via
the existing `buildXxxQuery` method, then runs `EXPLAIN (ANALYZE, FORMAT
JSON) <sql>` with the bound params and returns the plan.

### Adapter

```ts
async explainAnalyzeQuery(
  sql: string,
  params: ReadonlyArray<unknown>,
): Promise<unknown> {
  const result = await this.conn.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    params,
  );
  return result.rows[0]?.["QUERY PLAN"] ?? null;
}
```

`FORMAT JSON` makes PG return a single row with a `QUERY PLAN` column
containing the plan as a JSON array. The adapter returns that structure
verbatim. The method takes pre-built `{sql, params}` (from any
`buildXxxQuery`), so it's surface-agnostic.

### Read-only safety

`EXPLAIN ANALYZE` EXECUTES the query. For the retention read surfaces
(history / summary / diff-history / diff-timeline), the queries are
read-only SELECTs — `ANALYZE` runs them but discards output. No
mutations occur. (`--explain-analyze` is NOT wired to mutation actions
like `opt-out` / `set` / `restore`, which aren't query-builder-based and
would execute writes.)

### CLI

Each of the 4 surfaces:
1. Parses `--explain-analyze` (boolean).
2. Mutual-exclusivity check: `--explain` + `--explain-analyze` → exit 2.
3. If `--explain-analyze`: build query via the existing builder, call
   `runExplainAnalyze(ctx, command, retention, action, sql, params)`.

A shared `runExplainAnalyze` helper:
- Runs `explainAnalyzeQuery`; adapter errors → exit 1.
- Human format: header + pretty-printed plan JSON.
- json/csv/tsv/ndjson: `{action, explainAnalyze: true, executed: true,
  sql, params, plan}`.

### diff-timeline dispatch reuse

The diff-timeline `--explain` block already builds `{sql, params}` via
3-way dispatch (pair-wise / N-way / cross-table). Rather than duplicate
the dispatch, the condition is widened to `if (explainFlag ||
explainAnalyzeFlag)`, and after the build an early-return branches to
`runExplainAnalyze` when `--explain-analyze` is set.

### Output (json)

```json
{
  "action": "summary",
  "explainAnalyze": true,
  "executed": true,
  "sql": "SELECT h.event_kind AS key, COUNT(*)::bigint ...",
  "params": [],
  "plan": [{ "Plan": { "Node Type": "...", "Actual Total Time": ..., "Actual Rows": ... } }]
}
```

## Rejected alternatives

1. **`--explain analyze` (sub-value) instead of a separate flag** —
   `--explain` is a boolean; adding a sub-value (`--explain=analyze`)
   complicates parsing. A distinct `--explain-analyze` boolean is
   clearer + matches PG's `EXPLAIN` vs `EXPLAIN ANALYZE` distinction.
2. **`EXPLAIN (ANALYZE, FORMAT TEXT)`** — TEXT format is human-readable
   but not machine-parseable; JSON format supports both (pretty-print
   for human, structured for json). JSON is the better default.
3. **`EXPLAIN (ANALYZE, BUFFERS)`** — buffer stats are useful but
   verbose + IO-dependent; defer to a `--explain-analyze-buffers` future
   flag if operators need it.
4. **Run `--explain-analyze` inside a rolled-back transaction** — for
   read-only SELECTs there's nothing to roll back; the transaction
   wrapper adds overhead without benefit. (Would matter for EXPLAIN
   ANALYZE on a mutation, which we don't support.)
5. **Allow `--explain` + `--explain-analyze` together (show both)** —
   conflicting intents (offline vs executed); exit-2 forces operator
   clarity.
6. **Wire `--explain-analyze` to mutation actions** — EXPLAIN ANALYZE on
   an INSERT/UPDATE/DELETE executes the write; dangerous. Restricted to
   read surfaces.
7. **Parse + summarize the plan (extract total time / node types)** —
   operators familiar with EXPLAIN want the raw plan; summarizing would
   lose detail. Emit the plan verbatim; tools like
   explain.dalibo.com/depesz consume the JSON.
8. **A separate `retention explain-analyze <action>` subcommand** — a
   flag on the existing action is more discoverable + reuses the action's
   flag parsing.

## Future questions

1. **`--explain-analyze-buffers`** — add `BUFFERS` to the EXPLAIN options
   for IO/cache diagnostics. Defer — verbose; add if operators need it.

2. **Plan summarization** — extract a one-line summary (total time, top
   node) for quick reading without the full JSON. Defer — operators use
   plan-visualization tools.

3. **`--explain-analyze` timeout guard** — EXPLAIN ANALYZE executes the
   query; a pathological query could be slow. A statement_timeout guard
   could bound it. Defer — operators control via PG session config.

4. **`--explain-analyze` on `effective` / `effective-batch`** — those
   use different query shapes (not the buildXxxQuery family); could add
   builders + explain-analyze. Defer — the 4 main read surfaces cover
   the analytics-heavy queries.

5. **EXPLAIN-only (no ANALYZE) via `--explain-plan`** — PG's `EXPLAIN`
   (without ANALYZE) gives the estimated plan without executing. Our
   `--explain` shows raw SQL but not PG's estimated plan. A
   `--explain-plan` could run `EXPLAIN (FORMAT JSON)` (no ANALYZE) for
   the estimated plan without execution. Defer — `--explain`
   (offline SQL) + `--explain-analyze` (executed) cover the common
   needs.

6. **Comparing actual vs estimated rows automatically** — flag plan
   nodes where actual >> estimated (stale stats). Defer — plan-
   visualization tools do this.

## Consequences

- **Operators get real execution plans** — actual timing + row counts +
  index-usage from PG, for diagnosing slow retention queries.
- **Test count: 9,342 → 9,353** (+11 net: 3 adapter tests for
  explainAnalyzeQuery, 8 CLI tests across the 4 surfaces + mutual
  exclusivity + error propagation).
- **`explainAnalyzeQuery` is surface-agnostic** — takes pre-built
  `{sql, params}` from any builder; one adapter method serves all 4
  surfaces.
- **Read-only safety** — wired only to read surfaces (SELECT); EXPLAIN
  ANALYZE discards SELECT output; no mutations.
- **Mutually exclusive with `--explain`** — offline-plan vs executed-
  plan are conflicting intents; exit 2 if both.
- **Shared `runExplainAnalyze` helper** — DRY across the 4 surfaces;
  human pretty-print + structured json/etc.
- **No breaking changes** — `--explain-analyze` is ADDITIVE.
- **Plan emitted verbatim** — JSON-format PG plan consumable by
  plan-visualization tools (depesz, dalibo).
- **`--explain-analyze-buffers` + EXPLAIN-only `--explain-plan` are the
  natural follow-ups** for deeper diagnostics.
