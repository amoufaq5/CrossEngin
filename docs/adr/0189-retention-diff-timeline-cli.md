# ADR-0189: `crossengin retention diff-timeline <tenant-a> <tenant-b> <table>` cross-tenant chronological event merge (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0170 (history audit log + listOptOutHistory), ADR-0173 (diff-history pair-wise event comparison), ADR-0175 (history cursor pagination), ADR-0178 (cross-tenant diff), ADR-0185 (--with-actor-names) |

## Context

The retention CLI diff matrix shipped over ADR-0178/0179/0180/0181/0183/0184/0188 answers "what's different RIGHT NOW between these tenants/tables?" — point-in-time comparisons against the live policy state.

The audit-log surface shipped over ADR-0170/0175/0185/0186/0187 answers "what mutations happened on ONE tenant+table over time?" — single-axis chronological audit.

Operators investigating "why did Tenant A end up with retention X while Tenant B got retention Y" needed to correlate the two surfaces manually — fetch Tenant A's history, fetch Tenant B's history, mentally interleave by `occurred_at`, identify divergence points. Two `retention history` commands + jq merge + spreadsheet correlation per audit.

ADR-0178 Q7 listed this future work explicitly:

> Q7: Combined diff-timeline showing how A vs B evolved over time — pairs cross-tenant diff with history-row enumeration. Defer.

M6.7.zz.tenant.opt-out.cli.diff-timeline closes ADR-0178 Q7 by adding a single command that merges two tenants' history events for one shared table into a single chronological timeline tagged with which tenant each event came from.

## Decision

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--since DATE]
                                   [--until DATE]
                                   [--limit N]
                                   [--format human|json]
```

- 3 positional args (tenantIdA, tenantIdB, tableName) — all required; missing → exit 2.
- `--since` / `--until` filter the timeline window (ISO 8601 parseable via `Date.parse`; normalised to canonical ISO).
- `--limit N` caps results (default 100, must be integer >= 1).
- No actor filter, no event-kind filter, no cursor pagination — focused single-purpose command. Operators wanting those run `retention history` per tenant.

### Adapter

New method `diffHistoryTimeline` on `PostgresTraceRetention`:

```ts
export interface DiffHistoryTimelineInput {
  readonly tenantIdA: string;
  readonly tenantIdB: string;
  readonly tableName: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface TimelineEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantSide: "A" | "B";
  readonly tableName: string;
  readonly eventKind: OptOutHistoryEventKind;
  readonly occurredAt: string;
  readonly prevState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly attributes: Record<string, unknown>;
}

export interface DiffHistoryTimelineResult {
  readonly tenantIdA: string;
  readonly tenantIdB: string;
  readonly tableName: string;
  readonly entries: ReadonlyArray<TimelineEntry>;
}
```

### Algorithm: single OR-clause query

```sql
SELECT id, tenant_id, table_name, event_kind, occurred_at,
       prev_state, next_state, attributes
FROM meta.tenant_retention_opt_out_history
WHERE (tenant_id = $1 OR tenant_id = $2)
  AND table_name = $3
  [AND occurred_at >= $4]
  [AND occurred_at <= $5]
ORDER BY occurred_at ASC, id ASC
LIMIT $N
```

Single query is the right shape — PG can use the existing `(table_name, occurred_at)` index efficiently with the OR-clause + table_name filter. Two parallel queries (one per tenant) would need application-side merge + would double-count under shared occurred_at ties.

Per-row `tenantSide` field tagged at the adapter via runtime comparison: `r.tenant_id === input.tenantIdA ? "A" : "B"`. The runtime check is intentional — SQL-side `CASE WHEN tenant_id = $1 THEN 'A' ELSE 'B' END` would add parser noise without meaningful benefit.

### Why ASC chronological (not DESC like `retention history`)

`retention history` orders DESC because operators usually want "what's the latest activity" first. `diff-timeline` orders ASC because the use case is reading divergence over time — you want to see Tenant A's first mutation, then Tenant B's, then how they continue to evolve. Reading top-to-bottom mirrors the timeline left-to-right.

### Output format

**Human:**

```
Timeline for tenants on workflow_traces:
  Tenant A: 11111111-1111-1111-1111-111111111111
  Tenant B: 22222222-2222-2222-2222-222222222222

Events (4):
  2026-01-15T10:00:00.000Z  [A] retention_set      retention=30 opt_out=false enabled=true
  2026-02-01T14:23:11.000Z  [B] retention_set      retention=90 opt_out=false enabled=true
  2026-03-10T08:45:00.000Z  [A] opt_out_set        retention=30 opt_out=true reason=legal_hold:case#42
  2026-04-22T16:30:00.000Z  [A] policy_deleted     (policy deleted)
```

Each event prefixed with `[A]` or `[B]` indicating which tenant the change happened on. Event-kind column padded to 16 chars for alignment. State summary derived from `nextState` JSONB — `null` renders `(policy deleted)`, otherwise renders flat key=value with `retention=N opt_out=bool enabled=bool reason=X` covering the four fields operators care about.

When no events match:

```
Timeline for tenants on workflow_traces:
  Tenant A: 11111111-1111-1111-1111-111111111111
  Tenant B: 22222222-2222-2222-2222-222222222222

No history events for either tenant on this table.
```

**JSON:**

```json
{
  "action": "diff-timeline",
  "tenantIdA": "...",
  "tenantIdB": "...",
  "tableName": "workflow_traces",
  "since": null,
  "until": null,
  "limit": 100,
  "count": 4,
  "entries": [
    {
      "id": "...",
      "tenantId": "...",
      "tenantSide": "A",
      "tableName": "workflow_traces",
      "eventKind": "retention_set",
      "occurredAt": "2026-01-15T10:00:00.000Z",
      "prevState": null,
      "nextState": {"retention_days": 30, "opt_out": false, "enabled": true},
      "attributes": {}
    },
    ...
  ]
}
```

`tenantSide` field on each entry is the chief discriminator — operators jq-filter on `.entries[] | select(.tenantSide == "A")` to extract one tenant's events from the merged timeline.

### Why no state-replay at each event

A richer variant would replay each tenant's policy state at every event boundary and emit a per-row diff showing the divergence delta. This would be expensive (O(N) state replays per query) and adds significant complexity for a feature operators can achieve by combining `diff-timeline` for the event list with `retention diff` for current-state divergence. Substrate stays simple; operator-side correlation handles the richer view.

## Use cases unblocked

**1. "Why did Tenant A end up with retention X while Tenant B got retention Y?"**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces
# Reads top-to-bottom showing each tenant's mutation sequence interleaved by time.
```

**2. Compliance audit comparing two cohort tenants**

```bash
crossengin retention diff-timeline <ref-tenant> <test-tenant> workflow_traces \
  --since 2026-01-01 --until 2026-03-31 \
  --format json > q1-2026-audit.json
# Quarterly export for compliance review.
```

**3. Drift root-cause analysis**

```bash
# Cross-tenant diff says A and B differ:
crossengin retention diff <a> <b> workflow_traces
# diff-timeline shows when they diverged:
crossengin retention diff-timeline <a> <b> workflow_traces --limit 50
# First [A] vs [B] discrepancy reveals where the divergence began.
```

**4. Tier-migration verification**

```bash
crossengin retention diff-timeline <pre-migration-ref> <post-migration> workflow_traces \
  --since <migration-start> --format json | \
  jq '.entries | group_by(.tenantSide) | map({side: .[0].tenantSide, count: length})'
# Counts mutations per tenant since migration start — should be roughly equal for parallel cohorts.
```

## Drawbacks

1. **Same-table only** — operators wanting `Tenant A on table X vs Tenant B on table Y` chain two `retention history` calls. Documented; cross-axis combinations out of scope for v1.
2. **Two-tenant only** — N-way timeline merging would multiply complexity (label assignment, tenantSide widens to A|B|C|...). Operators chain multiple `diff-timeline` commands.
3. **No state-replay** — operators wanting "show me the actual diff between A's state and B's state at each timestamp" do this client-side via the `nextState` JSONB blobs or wrap with `retention diff` for current state. Substrate stays simple.
4. **No actor or event-kind filter** — focused single-purpose command. Operators wanting finer scoping use `retention history` per tenant + jq merge.
5. **No cursor pagination** — `--limit N` is the only pagination knob. Operators auditing >100-event tenant pairs use `--since` to window. Cursor support deferable when measured demand emerges.
6. **`tenantSide: "A" | "B"` field tied to argument order** — `retention diff-timeline <a> <b>` and `retention diff-timeline <b> <a>` produce identical events but swapped sides. Operators relying on JSON output must be consistent about argument order.
7. **PG OR-clause performance at very large scale** — single-query OR over two tenant IDs may not use the most efficient plan vs a UNION ALL with two index scans + merge sort. PG planner usually handles this well; defer optimization until measured slow.

## Alternatives considered

1. **Two parallel queries (one per tenant) + application-side merge** — would need careful handling of shared `occurred_at` ties + LIMIT semantic across pages. Single OR-query is simpler and PG handles it efficiently with the existing index.
2. **State replay at each event** — operators get richer per-event diff but query cost is O(N) state replays. Rejected for v1; operators correlate with `retention diff` for current state.
3. **N-way timeline merging** (`--add-tenant`) — same shape as ADR-0183 but on the timeline axis. Defer until measured demand; pair-wise is the canonical pattern.
4. **DESC ordering matching `retention history`** — DESC reads "latest first" but timeline-divergence reading is naturally ASC top-to-bottom. ASC chosen for use case.
5. **Compute and surface per-event divergence delta** (e.g., "[A] retention 30 → 60, A now differs from B which is at 90") — replay complexity high; defer.
6. **Make `tenantSide` literal `"<tenantA-uuid-prefix>"` not `"A"/"B"`** — verbose; A/B labels match ADR-0183 cohort labels. Operators map back via `tenantIdA` / `tenantIdB` envelope fields.
7. **Embed actor display name in human output without `--with-actor-names` flag** — couples to ADR-0185 join cost on every call; flag-gated would add LEFT JOIN complexity for marginal benefit; defer.
8. **--cross-table mode for one tenant on two tables instead of cross-tenant** — different axis; the ADR-0178 / ADR-0180 distinction applies here too. If cross-table timeline is desired, separate flag or action.
9. **Include `prev_state` rendering in human output** — adds vertical noise + most operators care about resulting state not the from-state. `nextState` summary is the canonical view. Operators wanting prev-state inspect JSON output.
10. **Auto-sort by `(occurred_at, tenant_id)` so ties resolve deterministically across runs** — ORDER BY already includes `id ASC` as secondary key matching UUID v7 time-ordering. Sufficient for operator-visible determinism.

## Open questions

1. **N-way timeline via `--add-tenant <c> [--add-tenant <d> ...]`** — operators with 3+ tenant cohorts would benefit; defer until measured demand.
2. **Cross-table timeline** (one tenant, two tables, merged) — mirrors ADR-0180 axis on the timeline surface; defer.
3. **`--with-actor-names`** flag composing ADR-0185's LEFT JOIN — would render `[A] retention_set by Alice (uuid)` per event. Adds query cost but useful for human-readable timelines. Defer.
4. **Actor / kind / attributes filters** — focused single-purpose command for v1; could compose with the 5 history filter dimensions in future. Defer.
5. **Cursor pagination via `--after-id`** — matches ADR-0175's pattern for >100-event windows. Defer until measured demand.
6. **Surface `prev_state` → `nextState` deltas inline** in human output ("[A] retention_set: retention 30 → 60") — adds complexity + JSONB diff logic. Defer.
7. **State-replay variant emitting per-event divergence delta** — "at this event, A and B differ on field X". Significant query cost; defer to future ADR if requested.
8. **Tagged-union JSON envelope** across all retention diff-* actions ({kind: "diff" | "diff-history" | "diff-timeline"}) — would simplify operator jq scripts but break backward compat. Pairs with similar deferred Qs across ADR-0173/0178/0179/0180/0183/0188.
