# ADR-0263: Gateway housekeeping unified dashboard

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0262 Q5 (operator UI surface — closes this Q), ADR-0258 (pipeline-execution retention), ADR-0259/0260 (idempotency-record prune + scope flags), ADR-0262 (rate-limit-decisions retention), ADR-0143 (retention substrate baseline) |

## Context

After M4.11 (ADR-0258), M4.12/M4.13 (ADR-0259/0260), and
M4.11.x (ADR-0262), the workspace has three operator-facing
housekeeping surfaces for the gateway:

| Table                              | Mechanism                 | Adapter API                          | CLI action               |
|------------------------------------|---------------------------|--------------------------------------|--------------------------|
| `gateway_pipeline_executions`      | retention substrate       | `PostgresTraceRetention.prune`       | `retention prune`        |
| `rate_limit_decisions`             | retention substrate       | `PostgresTraceRetention.prune`       | `retention prune`        |
| `gateway_idempotency_records`      | row-owned `expires_at`    | `PostgresIdempotencyStore.deleteExpired` | `gateway prune-idempotency` |

Each works in isolation, but operators investigating gateway
health have no aggregate read. Today the answer to *"how big are
my gateway housekeeping tables, when were they last pruned,
how many rows are eligible for pruning right now?"* requires
running 5+ separate commands and stitching together CSV/JSON
output by hand:

- `crossengin retention list-policies` for last_pruned_at +
  retention days.
- `crossengin retention effective <tenant> gateway_pipeline_executions`.
- `crossengin retention effective <tenant> rate_limit_decisions`.
- `crossengin gateway prune-idempotency --dry-run` for would-
  delete count.
- Raw SQL `SELECT COUNT(*), MIN(time_col) FROM meta.<table>`
  for total + oldest.

ADR-0262 Q5 explicitly listed this as a deferred Q:

> "Operator UI surface for rate-limit retention specifically —
> currently shares the generic `crossengin retention *` actions;
> a gateway-focused dashboard could combine pipeline + rate-
> limit + idempotency prune metrics."

M4.14 closes that Q with a single read-only CLI action that
queries all three tables + their respective housekeeping
mechanisms + renders a unified report.

## Decision

Add `crossengin gateway housekeeping` as a fourth gateway
subcommand action joining `start`, `routes`, and
`prune-idempotency`. The action issues no DELETEs — it's
purely a health snapshot.

**Per-table report shape:**

```ts
interface HousekeepingTableReport {
  readonly tableName: string;
  readonly pruneSemantic: "retention_days" | "expires_at";
  readonly totalRowCount: number;
  readonly oldestAt: string | null;          // ISO 8601 timestamp from MIN(time_col)
  readonly wouldPruneCount: number;          // what running prune now would delete
  readonly retentionDays: number | null;     // null for expires_at semantic OR no policy
  readonly lastPrunedAt: string | null;      // null for expires_at semantic OR never pruned
}

interface HousekeepingReport {
  readonly asOf: string;                     // ISO timestamp evaluated once at the top
  readonly tables: ReadonlyArray<HousekeepingTableReport>;
}
```

**The three tables** are hardcoded in
`HOUSEKEEPING_TABLES` — one entry per concern with its time
column + prune semantic:

```ts
const HOUSEKEEPING_TABLES = [
  { tableName: "gateway_pipeline_executions", timeColumn: "started_at", pruneSemantic: "retention_days" },
  { tableName: "gateway_idempotency_records", timeColumn: "expires_at", pruneSemantic: "expires_at" },
  { tableName: "rate_limit_decisions",        timeColumn: "decided_at", pruneSemantic: "retention_days" },
];
```

This is a deliberate operator-curated list. The retention
substrate exposes 6 prunable tables total (per ADR-0262); the
other 3 (workflow_traces, llm_call_traces, llm_latency_samples,
tenant_retention_opt_out_history) belong to different operator
domains (workflow runtime + ai-router + retention substrate
itself) — surfacing them under the `gateway` subcommand would
muddle ownership.

**Pipeline.**

1. Read PG env (or use test override) → instantiate
   `PostgresTraceRetention` + `PostgresIdempotencyStore`.
2. Call `retention.listPolicies()` once → map by tableName for
   retention_days + lastPrunedAt.
3. Call `retention.previewPrune()` once → filter to
   platform-level entries (`tenantId === undefined`) → map by
   tableName for wouldPruneCount on retention-governed tables.
4. For each of the 3 tables, run `SELECT COUNT(*)::TEXT AS
   total, MIN(<time_col>)::TEXT AS oldest FROM
   meta.<tableName>` directly via the PG connection.
5. For the idempotency table, call
   `idempotencyStore.previewDeleteExpired(now)` for its
   wouldPruneCount (since it's not retention-substrate-governed).

Total round-trips: **5 SELECTs** (1 listPolicies + 1
previewPrune + 3 table stats) — bounded regardless of workspace
state.

**Output.**

- **Human format:** A multi-section text report — one block per
  table with semantic, total rows (locale-formatted with
  commas), oldest row timestamp, would-prune count,
  retention-days line (for retention semantic), last-pruned-at
  line (for retention semantic). Empty tables render `(empty)`
  for oldest; missing retention policy renders `(no platform
  policy configured)`.
- **JSON format:** `{action: "gateway.housekeeping", asOf,
  tables[]}` envelope. Always emits all 3 tables; null fields
  surface as `null` (not omitted) for stable consumer parsing.

**Exit codes** follow the established convention (ADR-0181):

| Exit | Cause |
|------|-------|
| 0    | Success (report emitted). Empty tables and missing policies are not errors. |
| 1    | I/O failure (PG env missing, connection refused, adapter throws). |
| 2    | (unused — no validation gate; the action takes no positional args or scoped flags). |

**Test injection.** `GatewayContext` (extended in M4.12) already
has `pgConnectionOverride`, `idempotencyStoreOverride`, and
`clockOverride`. M4.14 adds `retentionOverride?:
PostgresTraceRetention`. All four are optional with undefined
default — production callers provide none; tests inject the
fakes.

## Alternatives considered

- **Make the action mutating with a `--prune` flag.**
  - **Why not:** breaks the operational model. Retention
    pruning is scheduled-job territory (cron / Inngest /
    K8s CronJob) per ADR-0143's design; surfacing a one-shot
    prune button on the dashboard would let operators tap it
    without the safety of preview-then-apply. The existing
    `retention prune --dry-run` + live `prune` are the right
    mutating flows.

- **Surface ALL 6 prunable tables (workflow + llm + history
  + the 3 gateway tables) under one action.**
  - **Why not:** different operator domains. The dashboard
    target is "gateway operator checking gateway health" —
    workflow tables belong under a hypothetical
    `crossengin workflow housekeeping`. The action name
    `gateway housekeeping` is honest about scope.

- **Add scope flags (`--table <name>`, `--include-tenant-rollup`).**
  - **Why not:** dashboard is a snapshot — operators wanting
    per-table detail already have specific actions
    (`retention effective`, `prune-idempotency --dry-run`).
    Scope flags would add a third mode of access.

- **Issue a single PG query that UNIONs all 3 table stats.**
  - **Why not:** the 3 tables have different time columns +
    different schemas. The UNION would require column aliasing
    + the planner can't push down stats per-table; 3
    separate SELECTs are simpler and faster (each hits a
    single index).

- **Embed coverage of retention policies' per-tenant overrides.**
  - **Why not:** scope creep + per-tenant rollup is a different
    operator question ("which tenants are configured for
    longer retention?"). The dashboard surfaces platform-level
    state; per-tenant detail stays under `retention
    list-policies`.

- **Add `previewDeleteExpired` to `IdempotencyStore` interface
  + thread it through every substrate.**
  - **Why not:** the interface is for runtime use (request
    dispatch). Housekeeping is admin-side; the PG-specific
    method on `PostgresIdempotencyStore` is sufficient. In-
    memory implementations (used for testing the gateway
    runtime) have no expired-record concept.

- **Use `EXPLAIN ANALYZE` to estimate row counts faster than
  `COUNT(*)`.**
  - **Why not:** estimates can drift wildly from reality after
    bulk writes. Exact `COUNT(*)` on indexed tables is fine for
    a one-shot operator query; if scale requires faster
    estimates, future Q.

## Consequences

- **Positive:** operators have a single-command health snapshot
  for the gateway housekeeping story. The "how much, how old,
  how stale, what's pending" answers are all in one place.
- **Positive:** no schema change, no new adapter methods
  (`previewDeleteExpired` already exists from M4.12;
  `listPolicies` + `previewPrune` from M6.7.zz/M6.7.zz.dry-run).
  The new code is one helper module + one dispatch branch.
- **Positive:** the action is read-only — no risk of an
  accidental DELETE during a debugging session.
- **Neutral:** `GatewayContext` gains one optional field
  (`retentionOverride`). Existing call sites unaffected.
- **Neutral:** `HOUSEKEEPING_TABLES` is hardcoded. If a fourth
  gateway housekeeping concern lands, an additional entry is
  required + an additional SELECT round-trip; bounded growth.
- **Reversibility:** trivial — drop the action branch, the
  helper module, the `retentionOverride` context field, and
  the help-text entry. Pure additive.

## Implementation notes

- The action issues exactly 5 PG round-trips (1 listPolicies +
  1 previewPrune + 3 table stats SELECTs). Direct stats
  queries use `MIN(<col>)::TEXT` to round-trip the timestamp as
  a stable string regardless of PG client driver.
- Per-tenant entries from `previewPrune()` are filtered out
  (`entry.tenantId !== undefined` → skip) — the dashboard
  surfaces the platform-level sweep total. Operators wanting
  per-tenant rollup use `retention list-policies --tenant ...`.
- Human format uses `Number.toLocaleString("en-US")` for the
  row-count columns (e.g. `987,654`). Locale is fixed to en-US
  for stable test assertions + consistency with operator-
  facing audit output across the CLI surface.
- 6 new CLI tests under `runGateway housekeeping (M4.14)`:
  default human-format renders all 3 tables with locale-
  formatted counts + retention days + lastPrunedAt; JSON
  envelope shape with all 3 tables + null fields where
  applicable; `(empty)` + `(no platform policy configured)`
  fallbacks; adapter throw → exit 1; PG env missing → exit 1;
  dispatcher unknown-action error message lists
  `housekeeping`.
- CLI smoke-tested end-to-end: `crossengin gateway
  housekeeping` without PG env → exit 1 with clear
  PG-env-required message; `gateway nuke` → exit 2 with
  message listing all 4 known actions.
- architect-cli test count 1,241 → **1,247** (+6). Workspace
  test count 9,512 → **9,518**. Coverage gate (ADR-0261) still
  passes (verified `pnpm coverage` exits 0).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `--tenant <uuid>` rollup mode that adds per-tenant retention override count + per-tenant would-prune count per table | platform | _deferred_ |
| Workflow housekeeping equivalent — `crossengin workflow housekeeping` covering workflow_traces + llm_call_traces + tenant_retention_opt_out_history + llm_latency_samples (the other 4 PRUNABLE_TABLES entries) | platform | _deferred_ |
| Auto-refresh / watch mode (e.g. `--watch 30s`) for operators monitoring during incident windows | platform | _deferred_ |
| Threshold alerting flags (`--alert-on-old-rows-days N` / `--exit-on-would-prune-gt N` for CI gate use) | platform | _deferred_ |
| Estimated-row-count mode using PG's `pg_class.reltuples` instead of `COUNT(*)` for very-high-volume tables | platform | _deferred_ |
| Index health (size, bloat) + table size in MB to surface storage pressure alongside row counts | platform | _deferred_ |

## References

- ADR-0262 — the Q5 this milestone closes.
- ADR-0258 — gateway pipeline-execution retention.
- ADR-0259/0260 — gateway idempotency-record prune.
- ADR-0143 — retention substrate baseline.
- ADR-0153 — preview/run dual-method pattern that `previewPrune` follows.
- `apps/architect-cli/src/gateway-housekeeping.ts` — new
  module containing `gatherHousekeepingReport` +
  `runGatewayHousekeeping`.
- `apps/architect-cli/src/gateway.ts` — dispatcher branch +
  `retentionOverride` context field.
