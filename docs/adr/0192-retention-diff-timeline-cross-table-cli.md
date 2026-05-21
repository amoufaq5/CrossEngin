# ADR-0192: `crossengin retention diff-timeline --cross-table` cross-table-within-tenant chronological merge (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.cross-table)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0189 (diff-timeline pair-wise), ADR-0190 (--with-actor-names), ADR-0191 (--add-tenant N-way), ADR-0180 (--cross-table on retention diff), ADR-0188 (--add-table N-way cross-table) |

## Context

ADR-0191 shipped `retention diff-timeline --add-tenant` for N-way cross-tenant chronological merge. ADR-0180/0188 shipped cross-table comparisons (`--cross-table`/`--add-table`) on the point-in-time `retention diff` action. ADR-0189 Q2 listed cross-table timeline as future work.

Operators investigating per-tenant cross-table consistency over time — "across this tenant's 4 prunable tables (workflow_traces, llm_call_traces, llm_latency_samples, tenant_retention_opt_out_history), when did each table's retention policy get applied, and did any get missed?" — needed M `retention history` calls per table + manual jq merge + spreadsheet correlation per audit.

M6.7.zz.tenant.opt-out.cli.diff-timeline.cross-table closes ADR-0189 Q2 by adding `--cross-table` (+ optional `--add-table`) to `retention diff-timeline`, mirroring ADR-0180/0188's cross-table pattern on the timeline axis. Completes the matrix symmetry — both `retention diff` and `retention diff-timeline` now support cross-tenant + cross-table axes uniformly.

## Decision

### CLI surface

```
crossengin retention diff-timeline <tenant> <table-a> <table-b> --cross-table
                                   [--add-table <table-c> ...]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--format human|json]
```

- 3 positional args under `--cross-table`: `<tenant> <table-a> <table-b>` (vs pair-wise/N-way which uses `<tenant-a> <tenant-b> <table>`).
- `--cross-table` is required to opt into the cross-table semantic.
- `--add-table <name>` repeatable for N-way cross-table — extends the table list beyond the 2 positional tables. Strict-require: `--add-table` without `--cross-table` → exit 2 (matches ADR-0188 pattern).
- Mutually exclusive with `--add-tenant` (different N-way axis) → exit 2.
- All other flags (`--since`, `--until`, `--limit`, `--with-actor-names`) compose uniformly across all 3 timeline paths (pair-wise cross-tenant + N-way cross-tenant + cross-table).

### Adapter

New method `diffHistoryTimelineCrossTable` separate from `diffHistoryTimeline` + `diffHistoryTimelineNway`, mirroring the ADR-0180/0188 separate-method pattern:

```ts
export interface DiffHistoryTimelineCrossTableInput {
  readonly tenantId: string;
  readonly tableNames: ReadonlyArray<string>;  // length >= 2
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly joinActor?: boolean;
}

export interface CrossTableTimelineEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly tableName: string;
  readonly tableLabel: string;  // "A", "B", "C", ..., "Z", "T27", ...
  readonly eventKind: OptOutHistoryEventKind;
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly prevState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly attributes: Record<string, unknown>;
  readonly actorDisplayName?: string | null;
  readonly actorEmail?: string | null;
}

export interface DiffHistoryTimelineCrossTableResult {
  readonly tenantId: string;
  readonly tableNames: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<CrossTableTimelineEntry>;
}
```

`tableLabel: string` mirrors ADR-0191's `tenantLabel: string` field on the timeline-cross-tenant variant. Both use the shared `labelForIndex(index)` helper exported from `trace-retention.ts`.

### Why separate adapter method (vs. widening diffHistoryTimeline)

Three adapters now exist for diff-timeline:
- `diffHistoryTimeline` — pair-wise cross-tenant (2 tenants on 1 table). Entry has `tenantSide: "A" | "B"`.
- `diffHistoryTimelineNway` — N-way cross-tenant (2+ tenants on 1 table). Entry has `tenantLabel: string`.
- `diffHistoryTimelineCrossTable` — N tables on 1 tenant. Entry has `tableLabel: string`.

Each axis gets its own adapter for the same three reasons as ADR-0183/0191: narrow TypeScript types per axis, backward compat, JSON envelope discriminator clarity.

### Algorithm: single IN-clause query

```sql
SELECT h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id,
       h.occurred_at, h.prev_state, h.next_state, h.attributes
       [, u.display_name AS actor_display_name, u.email AS actor_email]
FROM meta.tenant_retention_opt_out_history h
[LEFT JOIN meta.users u ON u.id = h.actor_id]
WHERE h.tenant_id = $1
  AND h.table_name IN ($2, $3, $4, ...)
  [AND h.occurred_at >= $sinceParam]
  [AND h.occurred_at <= $untilParam]
ORDER BY h.occurred_at ASC, h.id ASC
LIMIT $limitParam
```

Per-row `tableLabel` is tagged at the adapter via a `Map<tableName, label>` built from input order, identical to ADR-0191's tenantLabel tagging. Duplicate `tableNames` in input — first occurrence wins the label (matches ADR-0191's first-occurrence-wins).

### CLI dispatcher

```ts
// 1. Read flags first
const crossTable = getBooleanFlag(command, "cross-table");
const addTenants = getMultiFlag(command, "add-tenant");
const addTables = getMultiFlag(command, "add-table");

// 2. Validate flag combinations BEFORE reading positionals
if (hasAddTable && !crossTable) return exit-2("--add-table requires --cross-table");
if (crossTable && hasAddTenant) return exit-2("mutually exclusive");

// 3. Re-interpret positionals based on flag
if (crossTable) {
  tenantId = positional[1]; tableNames = [positional[2], positional[3], ...addTables];
  → diffHistoryTimelineCrossTable
} else if (hasAddTenant) {
  tenantIds = [positional[1], positional[2], ...addTenants]; tableName = positional[3];
  → diffHistoryTimelineNway
} else {
  → diffHistoryTimeline (pair-wise default)
}
```

Three positional args always required; their semantic depends on `--cross-table`. Mirrors ADR-0180's dispatch pattern on `retention diff`.

### Output format

**Human:**

```
Cross-table timeline for tenant <uuid> across 4 tables:
  Table A: workflow_traces
  Table B: llm_call_traces
  Table C: llm_latency_samples
  Table D: tenant_retention_opt_out_history

Events (5):
  2026-01-15T10:00:00.000Z  [A] retention_set    retention=30 opt_out=false enabled=true
  2026-02-01T14:23:11.000Z  [B] retention_set    retention=90 opt_out=false enabled=true
  2026-03-10T08:45:00.000Z  [A] opt_out_set      retention=30 opt_out=true reason=legal-hold
  2026-04-22T16:30:00.000Z  [C] retention_set    retention=7 opt_out=false enabled=true
  2026-05-01T09:00:00.000Z  [D] retention_set    retention=2555 opt_out=false enabled=true
```

`Cross-table timeline for tenant <uuid> across N tables:` header explicitly names the tenant + table count to disambiguate from cross-tenant variants. Each event tagged with `[<table-label>]` (single-letter for ≤26 tables, `T27`/`T28`/... beyond).

When no events match:

```
Cross-table timeline for tenant <uuid> across 2 tables:
  Table A: workflow_traces
  Table B: llm_call_traces

No history events for this tenant on any of these tables.
```

**JSON:**

```json
{
  "action": "diff-timeline",
  "crossTable": true,
  "since": null,
  "until": null,
  "limit": 100,
  "withActorNames": false,
  "result": {
    "tenantId": "...",
    "tableNames": ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
    "entries": [
      {
        "id": "...",
        "tenantId": "...",
        "tableName": "workflow_traces",
        "tableLabel": "A",
        "eventKind": "retention_set",
        "actorId": null,
        "occurredAt": "...",
        "prevState": null,
        "nextState": {...},
        "attributes": {}
      }
    ]
  }
}
```

`crossTable: true` is the discriminator. Operators jq-filter on `.result.entries[] | select(.tableLabel == "B")` to extract one table's events from the merged tenant timeline.

### Diff envelope discriminator matrix

After this milestone the 4 diff-timeline JSON envelope shapes form a 2×2:

| | Pair-wise | N-way |
|---|---|---|
| Cross-tenant | (no discriminator) | `nway: true` |
| Cross-table | `crossTable: true` (2 tables) | `crossTable: true` (3+ tables) |

Cross-table uses a single discriminator (`crossTable: true`) for both 2-table and N-table cases — `result.tableNames.length` distinguishes. This matches the principle that cross-table is one axis of compression (1 tenant, N tables) regardless of N.

`crossTable: true, nway: true` combination isn't used here — adding `--add-tenant` × `--cross-table` is rejected at the CLI boundary as a different conceptual matrix (N tenants × M tables) deferred to future work.

### `formatTimelineCrossTableDiff` helper

New exported helper alongside `formatTimelineDiff` + `formatTimelineNwayDiff`. Reuses the existing `summarizeTimelineEntry` + `formatActor` helpers — no duplication. Three formatters now exist for diff-timeline (one per adapter variant).

## Use cases unblocked

**1. Full-cohort cross-table audit for one tenant over time**

```bash
crossengin retention diff-timeline <tenant> workflow_traces llm_call_traces \
  --cross-table \
  --add-table llm_latency_samples \
  --add-table tenant_retention_opt_out_history \
  --since 2026-01-01
# One command shows when each of the 4 prunable tables had its policy
# changed across the audit window — was the legal hold applied uniformly?
```

**2. Legal-hold uniformity verification**

```bash
crossengin retention diff-timeline <hold-tenant> workflow_traces llm_call_traces \
  --cross-table \
  --add-table tenant_retention_opt_out_history \
  --format json | \
  jq '.result.entries | group_by(.tableLabel) | map({table: .[0].tableName, events: length})'
# Shows per-table event count — uneven counts surface tables missing
# the hold mutation.
```

**3. Cross-table tier migration verification**

```bash
crossengin retention diff-timeline <tenant> workflow_traces llm_call_traces \
  --cross-table --add-table llm_latency_samples \
  --since <migration-start> --with-actor-names
# Did the migration touch all 3 tables? Who ran it?
```

**4. Compliance attestation per tenant × all tables**

```bash
for tenant in $(cat regulated-tenants.txt); do
  crossengin retention diff-timeline "$tenant" workflow_traces llm_call_traces \
    --cross-table --add-table llm_latency_samples \
    --add-table tenant_retention_opt_out_history \
    --since 2026-Q1 --with-actor-names --format json > "audit-$tenant.json"
done
# Per-tenant quarterly export across all prunable tables.
```

## Drawbacks

1. **Three adapter methods for diff-timeline** (pair-wise + N-way + cross-table). Mirrors ADR-0183/0188's separate-method pattern. Each has narrow TypeScript types appropriate to its axis.
2. **Positional arg shape depends on `--cross-table` flag** — same 3 positional args but different semantics (`<tenant-a> <tenant-b> <table>` without flag vs `<tenant> <table-a> <table-b>` with flag). Mirrors ADR-0180 on `retention diff`. Operators must read flag carefully; documented in helpText with separate usage lines.
3. **`tenantLabel` vs `tableLabel` field name divergence** between N-way cross-tenant and cross-table variants — different field names for the same conceptual label property. Honest about which axis is varying; callers branch on JSON envelope discriminator first.
4. **No combined cross-tenant × cross-table matrix** — operators wanting "N tenants × M tables" run multiple commands. Different conceptual axis; defer.
5. **Strict-require `--add-table` needs `--cross-table`** — operators must remember pairing. Matches ADR-0188 precedent; clear error message on misuse.
6. **PG IN-list parser limit at thousands of tables** — not a practical concern (substrate has 4 prunable tables today); defer until measured.
7. **No state-replay** — same caveat as ADR-0189/0191. Operators wrap with `retention diff --cross-table` for current-state divergence.

## Alternatives considered

1. **Widen `diffHistoryTimeline` to accept `tableNames: ReadonlyArray<string>` and infer cross-table vs cross-tenant based on `tenantIds.length === 1`** — confuses pair-wise narrowing. Rejected.
2. **Auto-detect cross-table when positional[2] looks like a table name (regex `[a-z_]+`) rather than UUID** — magical; would break for tenants with table-like UUIDs (impossible but fragile to assume). Rejected — explicit `--cross-table` flag clearer.
3. **New action `retention diff-timeline-cross-table`** — adds CLI surface; flag-on-existing matches ADR-0180/0188 precedent. Rejected.
4. **Use `tenantSide` field on cross-table entries widened to string** — type system would lie ("side" implies tenant axis). Rejected.
5. **JSON envelope without `crossTable: true` discriminator** — operators detect by `tableNames[]` vs `tenantIdA`/`tenantIdB`. Rejected — explicit discriminator matches ADR-0180 pattern.
6. **Allow `--cross-table` + `--add-tenant` for "N tenants × M tables"** — different conceptual matrix; output dimensions multiply; defer.
7. **Compose on `diffHistoryTimelineNway` by treating tableName as the varying axis** — confused semantics; separate adapter clearer.
8. **`--all-tables` shorthand expanding to PRUNABLE_TABLES set** — operator-policy concern; substrate doesn't enumerate prunable tables externally. Defer.
9. **Table-name validation against PRUNABLE_TABLES allowlist at CLI boundary** — substrate currently doesn't validate (returns empty results for unknown tables). Matches existing pattern; defer.

## Open questions

1. **Combined cross-tenant × cross-table matrix** — N tenants × M tables merged timeline. Different semantic axis; defer.
2. **`--all-tables` shorthand** enumerating PRUNABLE_TABLES for the tenant. Operator-policy concern; defer.
3. **`--exclude-table <name>`** for set-subtraction. Defer.
4. **Table-name validation against PRUNABLE_TABLES allowlist at CLI boundary**. Defer.
5. **Cursor pagination via `--after-id`** on cross-table matching ADR-0175. Same pattern; defer.
6. **State-replay variant** emitting per-event divergence delta across tables. Defer.
7. **Tagged-union JSON envelope** across all retention diff-* actions. Pairs with similar deferred Qs across ADR-0173/0178/0179/0180/0183/0188/0189/0190/0191. Defer.
8. **Grouped human output** (events grouped by table column) — operators with many tables may prefer per-table sub-timelines. Defer.
