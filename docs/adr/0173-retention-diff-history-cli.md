# ADR-0173: `crossengin retention diff-history` CLI action + `diffHistoryEntries` adapter (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0170 (META_TENANT_RETENTION_OPT_OUT_HISTORY), ADR-0171 (retention restore CLI) |

## Context

ADR-0170 / M6.7.zz.tenant.opt-out.history shipped the audit-log table with `prev_state` + `next_state` JSONB columns. Operators querying via `crossengin retention history` see a chronological list of events but can't easily answer "what changed between event A and event B?"

The current workflow requires manual JSONB comparison — operators run two `retention history --limit 1` queries with different filters, then mentally diff the JSON output. Error-prone for compliance audits.

ADR-0170 Q5 lined this up:

> Q5: `retention diff-history <history-id-a> <history-id-b>`. Compare two history events. Defer.

M6.7.zz.tenant.opt-out.cli.diff-history closes Q5 with a small mechanical addition: one adapter method + one CLI action + one pure helper function.

## Decision

### Adapter: `diffHistoryEntries({idA, idB})`

```ts
export interface DiffHistoryEntriesInput {
  readonly idA: string;
  readonly idB: string;
}

export interface HistoryEntryFieldDiff {
  readonly field: string;
  readonly valueA: unknown;
  readonly valueB: unknown;
}

export interface DiffHistoryEntriesResult {
  readonly idA: string;
  readonly idB: string;
  readonly tenantId: string;
  readonly tableName: string;
  readonly occurredAtA: string;
  readonly occurredAtB: string;
  readonly eventKindA: OptOutHistoryEventKind;
  readonly eventKindB: OptOutHistoryEventKind;
  readonly fieldDiffs: ReadonlyArray<HistoryEntryFieldDiff>;
}

async diffHistoryEntries(input): Promise<DiffHistoryEntriesResult>;
```

Single query: `SELECT id, tenant_id, table_name, event_kind, occurred_at, next_state FROM meta.tenant_retention_opt_out_history WHERE id IN ($1, $2)`. Computes the field-by-field diff client-side via `computeFieldDiffs(stateA, stateB)`.

### Pure helper: `computeFieldDiffs(stateA, stateB)`

```ts
export function computeFieldDiffs(
  stateA: Record<string, unknown> | null,
  stateB: Record<string, unknown> | null,
): ReadonlyArray<HistoryEntryFieldDiff>;
```

Algorithm:
1. Union of keys from both states (null state treated as empty object).
2. For each key (alphabetically sorted): compare via `JSON.stringify` for deep equality.
3. Returns only the differing fields. Empty array when both states are deeply equal.

Sorted output ensures stable diff rendering across runs.

### Same-(tenant, table) constraint

The method REFUSES events on different tenants or different tables:

```
diffHistoryEntries: events on different tenants (<tenantA> vs <tenantB>)
diffHistoryEntries: events on different tables (workflow_traces vs llm_call_traces)
```

Rationale: the use case is reconstructing "what did the policy look like at moment A vs moment B" for a single policy. Cross-tenant or cross-table comparisons are different workflows (covered by the future `retention diff <tenant-a> <tenant-b> <table>` — ADR-0165 Q6, separate milestone).

### Compare `next_state` only (not `prev_state`)

Each history row captures both prev_state and next_state. The diff compares `next_state`s — i.e., "the policy snapshot AFTER event A vs the policy snapshot AFTER event B."

Why not also expose prev_state diffs?
- `prev_state` is useful for "what did THIS event change?" — answered by the `retention history` command surfacing both fields.
- The cross-event question is "given two snapshots, what's different?" — that's `next_state` vs `next_state`.

A future Q could add `--compare prev-vs-next` for single-event inspection, but the cross-event use case is the priority.

### CLI: `crossengin retention diff-history`

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [--format human|json]
```

Both positional args required (exit 2 if missing). Output:

**Human format:**

```
Diff between history events:
  A: <id-a> at 2026-05-20T12:00:00.000Z (event_kind=opt_out_set)
  B: <id-b> at 2026-05-21T12:00:00.000Z (event_kind=retention_set)
  Tenant: <tenant-uuid>
  Table:  workflow_traces

Field changes (3):
  enabled              false  →  true
  opt_out              true   →  false
  retention_days       365    →  30
```

Or, with empty diff:

```
Diff between history events:
  ...

No differences between the two events' policy states.
```

For `absent` values (e.g., DELETE event's `next_state = null`):

```
Field changes (1):
  opt_out              absent  →  true
```

**JSON format:** `{action: "diff-history", result: DiffHistoryEntriesResult}` — full structure for downstream jq.

### Why client-side diff vs PG-side

Considered PG `jsonb_each` to compute the diff inside SQL. Rejected:
1. The diff logic is small (10 lines of TypeScript).
2. PG-side diff would need to express "sort by key, then compare via text equality" — verbose.
3. Application-side diff is unit-testable as a pure function with no DB dependency.
4. The query result is just two JSONB blobs (~400 bytes each) — moving them to the application is cheap.

## Use cases unblocked

**1. Forensic audit "what changed between mutations X and Y?"**

```bash
crossengin retention diff-history <id-from-event-A> <id-from-event-B>
```

Operator sees exactly which fields differ. No mental JSONB diffing.

**2. Compliance report "policy state transitions over time"**

Pair with `retention history --tenant X` to get the timeline, then `diff-history` between consecutive events to see "exactly what changed at each transition." Generates a clean changelog.

**3. Restore validation**

Before running `retention restore <history-id-x>`, operator runs `retention diff-history <history-id-x> <current-state-history-id>` to confirm what the restore will change.

**4. JSON-driven compliance dashboards**

```bash
crossengin retention diff-history <a> <b> --format json | \
  jq '.result.fieldDiffs[] | "\(.field): \(.valueA) → \(.valueB)"'
```

Compliance dashboards render diffs in a consistent format.

## Drawbacks

1. **Same-(tenant, table) constraint.** Operators wanting cross-tenant or cross-table comparisons get an error. Documented; defer to future `retention diff` action.
2. **No diff visualization beyond "absent" / value.** Nested object diffs render as full JSON. For deep diffs, operators rely on `jq` / dedicated diff tools. The substrate keeps it simple.
3. **One-pair comparisons only.** Operators wanting "diff three events" run multiple `diff-history` commands or use external tools.
4. **No `--field` filter.** All differing fields render. Operators wanting "just opt_out changes" filter via `jq` on JSON output.
5. **`next_state` only.** Doesn't expose `prev_state` comparisons. Single-event prev-vs-next is covered by `retention history` showing both columns.
6. **No structural diff for nested fields.** Comparing `{nested: {x: 1}}` vs `{nested: {x: 2}}` shows the entire nested object on each side, not just `nested.x: 1 → 2`. Acceptable — flat policy shape doesn't have nested fields in practice.

## Alternatives considered

1. **PG-side diff via jsonb_each.** Rejected — adds SQL complexity for small win.
2. **Compare prev_state vs next_state of single event.** Rejected — that's covered by `retention history` rendering both columns. The cross-event use case is the priority.
3. **Allow cross-tenant comparison.** Rejected — different concern; covered by separate future `retention diff` action.
4. **Allow cross-table comparison.** Rejected — same.
5. **Three-way diff (idA, idB, idC).** Rejected — overengineered; operators chain pair-wise comparisons.
6. **`--field <name>` filter flag.** Rejected — `jq` covers it on JSON output.
7. **Visual color diff (red/green) in human output.** Rejected — substrate stays terminal-emoji-free; operators pipe to `diff` or `delta` for colored output.
8. **Compare full event metadata (kind, actor, attributes).** Rejected — the diff focuses on policy state; metadata diffs are operator-visible in the rendered headers.
9. **Apply restore implicitly when running diff against current state.** Rejected — conflates two operations. `diff-history` is read-only.
10. **Auto-sort by occurred_at so output is always "older → newer".** Rejected — operators may want B-then-A semantics; the argument order is preserved.

## Open questions

1. **Cross-tenant diff via `retention diff <tenant-a> <tenant-b> <table>`.** Separate milestone — closes ADR-0165 Q6.
2. **`--field <name>` filter flag.** Defer — `jq` covers it.
3. **Three-way diff or n-way merge view.** Defer.
4. **Visual diff with color highlighting via opt-in flag.** Defer — operators pipe to external tools.
5. **Diff `prev_state` vs `next_state` of single event.** Currently covered by `retention history` showing both columns. Future `retention show-event <id>` action could surface explicit "what this event changed."
6. **Configurable comparison depth.** Currently full JSON.stringify comparison. Operators wanting "compare retention_days only" use `jq` post-filter. Defer.
7. **Diff against current policy state.** `retention diff-history <id> --current` to compare against `effectiveRetention()`. Useful for "what would restore change?" workflows. Defer.
