# ADR-0153: PostgresTraceRetention.previewPrune — dry-run mode for retention dashboards (Phase 2 M6.7.zz.dry-run)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0143 (M6.7.zz META_RETENTION_POLICIES + PostgresTraceRetention) |

## Context

ADR-0143 / M6.7.zz shipped the trace retention substrate. `prune()` deletes rows older than each policy's `retention_days` window. Operators wiring `prune()` on a schedule cap unbounded growth across the three trace tables. ADR-0143 Q4 lined up a follow-up:

> Q4: Should the adapter support a `--dry-run` mode (count what WOULD be deleted)?
> _Current direction:_ Useful. Additive method `previewPrune()` returning counts without DELETEs. Future enhancement.

M6.7.zz.dry-run closes Q4. Operator pain it solves:

1. **First-run trepidation.** A retention policy newly introduced over millions of accumulated rows is scary to run cold. Operators want to see "this would delete 1.4M rows from workflow_traces" before committing.
2. **Policy verification.** "Did I set the retention period right? Is the threshold doing what I expect?"
3. **Dashboard reporting.** "How many rows are pending deletion?" — useful for capacity planning even when retention is running steady-state.
4. **CI / safety checks.** Operator pipelines verify "prune would delete <N rows" before allowing a destructive run.

## Decision

Add `previewPrune()` to `PostgresTraceRetention` with a distinct `RetentionPreviewResult` shape so callers can't confuse "would-delete" with actual deletes.

```ts
async previewPrune(): Promise<ReadonlyArray<RetentionPreviewResult>>;

export type RetentionPreviewStatus =
  | "previewed"
  | "skipped_disabled"
  | "skipped_unknown_table";

export interface RetentionPreviewResult {
  readonly tableName: string;
  readonly status: RetentionPreviewStatus;
  readonly retentionDays: number;
  readonly wouldDeleteCount: number;
  readonly cutoffMs: number | null;
}
```

### Implementation

`previewPrune()` mirrors `prune()` step-by-step but:

1. Reads `META_RETENTION_POLICIES` (same query as prune).
2. For each policy:
   - Skip disabled → `status: "skipped_disabled"`, `wouldDeleteCount: 0`.
   - Skip unknown table → `status: "skipped_unknown_table"`, `wouldDeleteCount: 0`.
   - **Compute the same cutoffMs**, then issue a `SELECT COUNT(*)::TEXT AS count FROM meta.{tableName} WHERE {timeColumn} < to_timestamp($1 / 1000.0)`.
3. **Does NOT issue DELETE.** Read-only.
4. **Does NOT update `last_pruned_at`.** Preview leaves audit state untouched.

### Why a distinct result type?

The alternative is reusing `RetentionRunResult` with a different status enum value (`"previewed"` instead of `"pruned"`). Cons:

- Operators piping results into dashboards see `deletedCount` field on a preview row, which is wrong (nothing was deleted).
- Type system can't catch "I meant to call prune but used preview" mistakes.

Distinct type `RetentionPreviewResult` with `wouldDeleteCount` field signals "this is a forecast, not a fact." Callers handling both shapes do so explicitly:

```ts
const previews = await retention.previewPrune();
const runs = await retention.prune();  // distinct types; type-checked
```

### Why `wouldDeleteCount: number` (not `string`)?

PG's `COUNT(*)` returns `BIGINT`, which the driver typically surfaces as a string to avoid JS number precision loss (`2^53 - 1`). The query uses `COUNT(*)::TEXT AS count` to make the string explicit; TS-side `Number()` converts to a JS number.

Trace tables at 1M rows/day stay safely under `2^53 - 1` for ~285 years before precision matters. If a single retention policy is somehow watching 10^16+ rows, the operator has bigger problems than precision loss; the number remains a valid signal.

### Why `cutoffMs` matches `prune()` for the same clock?

Operators running `previewPrune()` → review → `prune()` expect identical row counts. Both use:

```ts
const now = this.clock();
const cutoffMs = now - policy.retentionDays * 86_400 * 1_000;
```

The same clock injection means deterministic clock-mocked tests; production `Date.now()` clocks shift by milliseconds between calls but the row count drifts only at the edge (rows aging into the cutoff between preview + prune). For 30-day retention policies, sub-second drift means at most a few rows differ.

## Cross-cutting invariants enforced

- **Read-only.** `previewPrune` issues only `SELECT` against `meta.retention_policies` (policy read) and `SELECT COUNT(*)` against each pruable table. No DELETE. No UPDATE.
- **Same allowlist + skip semantics as prune.** Disabled policies and unknown-table policies are skipped with explicit status values.
- **Same cutoff computation as prune.** Operators sequencing preview → prune get matching counts (modulo sub-second clock drift in production).
- **Distinct return type from prune.** `RetentionPreviewResult` with `wouldDeleteCount` (vs `RetentionRunResult.deletedCount`). Type system prevents mix-ups.
- **Distinct status enum.** `"previewed"` is the success status (vs `prune`'s `"pruned"`), making logs + dashboards self-documenting.
- **No `last_pruned_at` mutation.** Preview leaves audit fields untouched; only real prune updates the watermark.
- **PG BIGINT precision via `::TEXT` cast.** Same pattern as `PostgresCostCeilingResolver` (NUMERIC precision via ::TEXT). Loud-failure if PG ever returns a non-numeric count.
- **No new dependencies.** Same `PgConnection` surface. Existing kernel-pg package.

## End-to-end semantic

```ts
import { createNodePgConnection } from "@crossengin/kernel-pg";
import { PostgresTraceRetention } from "@crossengin/kernel-pg";

const conn = createNodePgConnection(parsePgEnvConfig());
const retention = new PostgresTraceRetention({ conn });

// 1. Operator runs dry-run before scheduled prune.
const previews = await retention.previewPrune();
for (const p of previews) {
  if (p.status === "previewed") {
    console.log(
      `${p.tableName}: would delete ${p.wouldDeleteCount.toString()} rows older than ${p.retentionDays.toString()}d`,
    );
  } else {
    console.log(`${p.tableName}: ${p.status}`);
  }
}

// 2. CI safety gate — refuse to run prune if any policy would delete > 10M rows.
const dangerous = previews.find(
  (p) => p.status === "previewed" && p.wouldDeleteCount > 10_000_000,
);
if (dangerous !== undefined) {
  throw new Error(
    `Refusing to prune: ${dangerous.tableName} would delete ${dangerous.wouldDeleteCount.toString()} rows`,
  );
}

// 3. Run the actual prune.
const runs = await retention.prune();

// 4. Dashboard — show pending deletion counts across all retained tables.
// SELECT table_name, retention_days, last_pruned_at FROM meta.retention_policies;
// + JOIN with the previewPrune output to show "5M rows pending deletion".
```

## Alternatives considered

- **Reuse `RetentionRunResult` with a new status value.**
  - **Considered.** Single type for prune + preview.
  - **Cons.** `deletedCount` field name is wrong for a preview ("nothing was deleted"). Type system can't distinguish a preview from a prune in operator code.
  - **Decision.** Distinct type.

- **Add a `dryRun: boolean` parameter to `prune()`.**
  - **Considered.** Boolean parameter signals intent.
  - **Cons.** Boolean parameters are a code smell (see "Refactoring: Improving the Design of Existing Code"). Method name confusion (a "prune" that doesn't prune is surprising). Distinct method name is the clearer API.
  - **Decision.** Distinct method name `previewPrune`.

- **Make `previewPrune` return rows that would be deleted (not just counts).**
  - **Considered.** Per-row preview.
  - **Cons.** Could return millions of rows in one call. Heavy memory + transport. Counts are the operator-actionable signal; if operators want to inspect actual rows they can query the table directly.
  - **Decision.** Counts only.

- **Use `EXPLAIN` plan to estimate the count without scanning.**
  - **Considered.** Faster on huge tables.
  - **Cons.** PG `EXPLAIN` estimates can be wildly off (within an order of magnitude on indexed scans, way off on full scans). Operators reading "would delete 100M rows" need accuracy. Real `COUNT(*)` is the truthful answer.
  - **Decision.** Real COUNT.

- **Cache the preview result for `prune()` to reuse.**
  - **Considered.** Skip the COUNT round-trip if previewPrune was called recently.
  - **Cons.** Cache invalidation. Operators might run preview + manual SQL + prune; cache becomes stale. PG can answer COUNT fast enough on indexed tables. Operators wanting cached numbers can store the preview result themselves.
  - **Decision.** No cache.

- **Combine preview + prune into a single "report" method (returns both prune results AND preview counts).**
  - **Considered.** Operators want both.
  - **Cons.** Two methods are clearer. Sequence `preview → review → prune` is a natural workflow; combining into one call removes the operator decision point.
  - **Decision.** Separate methods.

- **Validate the COUNT result against an upper bound (refuse to preview if > some limit).**
  - **Considered.** Safety guard against accidental scans of huge tables.
  - **Cons.** Operators with legitimately huge retention sweeps would be blocked. PG COUNT on an indexed time column is fast even at 100M+ rows.
  - **Decision.** No upper bound.

- **Stream COUNT results via cursors for very large tables.**
  - **Considered.** Memory efficiency.
  - **Cons.** COUNT returns ONE number. No streaming needed.
  - **Decision.** Direct query.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 8,016 tests** (+13 from M6.7.zz.dry-run: all in `trace-retention.test.ts`). All green, zero type errors.
- **Closes ADR-0143 Q4.**
- **Operator workflow `preview → review → prune` is now first-class.** First-run trepidation, policy verification, dashboard reporting, and CI safety gates all unblocked.
- **Distinct type `RetentionPreviewResult` prevents mixing with prune results.** TypeScript catches misuse at compile time.
- **`previewPrune()` is idempotent + read-only.** Safe to call from any context including monitoring + UI dashboards.
- **No schema change.** Pure code addition.
- **No new dependencies.** Same `PgConnection` interface.

## Open questions

- **Q1:** Should there be a `previewPrunePerTable(tableName)` variant for inspecting a single policy?
  - _Current direction:_ Operator filters the result array. Future enhancement if real-world need.
- **Q2:** Should `previewPrune` accept a `maxAge?: Duration` override to preview with a different threshold than the policy?
  - _Current direction:_ Out of scope. Operators wanting "what if I changed retention to 7 days?" temporarily update the policy + preview + revert.
- **Q3:** Should there be a CLI command `crossengin retention preview` wrapping this method?
  - _Current direction:_ Yes — natural ergonomic. Future architect-cli enhancement.
- **Q4:** Should the substrate emit a `RetentionInstrumentation`-style event when preview is run?
  - _Current direction:_ Out of scope. Preview is read-only, low operational risk. If demand exists, additive future Q.
- **Q5:** Should `previewPrune` show the OLDEST row age per table (not just count)?
  - _Current direction:_ Additive field `oldestRowAt?: string`. Useful for "this table has rows older than the retention threshold." Defer.
- **Q6:** Should there be a `previewPruneAcrossTimeRange(start, end)` for what-if analysis ("what would have been pruned 30 days ago")?
  - _Current direction:_ Operator workflow. Substrate stays minimal.
- **Q7:** Multi-tenant preview (if M6.7.zz.tenant ships per-tenant retention)?
  - _Current direction:_ Additive extension when per-tenant retention lands. Same shape, just per-tenant grouping in the result.
- **Q8:** Should the COUNT query use an index hint to ensure it doesn't fall back to a sequential scan on a large table?
  - _Current direction:_ PG's planner handles this. The indexed `(provider_id, recorded_at)` on samples and `(tenant_id, occurred_at)` on traces should make COUNT cheap. If operators see slow previews on huge tables, revisit.
