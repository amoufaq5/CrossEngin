# ADR-0191: `crossengin retention diff-timeline --add-tenant` N-way cross-tenant chronological merge (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.add-tenant)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0189 (diff-timeline pair-wise base), ADR-0190 (--with-actor-names on diff-timeline), ADR-0183 (--add-tenant on retention diff), ADR-0188 (--add-table N-way cross-table) |

## Context

ADR-0189 shipped `crossengin retention diff-timeline <a> <b> <table>` merging two tenants' history events into a single chronological timeline. ADR-0183 shipped `retention diff --add-tenant <c>` for N-way cross-tenant policy comparison. The cross-tenant N-way pattern was operationally proven; ADR-0189 Q1 listed N-way timeline as future work.

Operators investigating cohort-wide divergence — "across our 5 regulated tenants, who diverged from the reference policy first and when?" — couldn't answer with two-tenant `diff-timeline`. They ran N pair-wise commands and manually merged the outputs by timestamp.

M6.7.zz.tenant.opt-out.cli.diff-timeline.add-tenant closes ADR-0189 Q1 by adding `--add-tenant <c> [--add-tenant <d> ...]` to `retention diff-timeline`, mirroring the ADR-0183 N-way pattern on the timeline axis.

## Decision

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--add-tenant <tenant-c> ...]
                                   [--since DATE]
                                   [--until DATE]
                                   [--limit N]
                                   [--with-actor-names]
                                   [--format human|json]
```

- Base call still requires 2 positional tenants + 1 positional table matching ADR-0189.
- `--add-tenant <uuid>` is repeatable via `multiFlags` infrastructure from ADR-0183.
- N total tenants = 2 (positional) + count(`--add-tenant`). Minimum N for N-way mode = 3.
- All other flags compose: `--since`, `--until`, `--limit`, `--with-actor-names` work identically across pair-wise and N-way paths.

### Adapter

New method `diffHistoryTimelineNway` separate from `diffHistoryTimeline`, mirroring ADR-0183's separate-method pattern:

```ts
export interface DiffHistoryTimelineNwayInput {
  readonly tenantIds: ReadonlyArray<string>;  // length >= 2
  readonly tableName: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly joinActor?: boolean;
}

export interface NwayTimelineEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantLabel: string;  // "A", "B", "C", ..., "Z", "T27", ...
  readonly tableName: string;
  readonly eventKind: OptOutHistoryEventKind;
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly prevState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly attributes: Record<string, unknown>;
  readonly actorDisplayName?: string | null;
  readonly actorEmail?: string | null;
}

export interface DiffHistoryTimelineNwayResult {
  readonly tenantIds: ReadonlyArray<string>;
  readonly tableName: string;
  readonly entries: ReadonlyArray<NwayTimelineEntry>;
}
```

### Why separate adapter method (not widening the existing one)

ADR-0183 established the pattern: pair-wise `diffTenantPolicies` and N-way `diffTenantPoliciesNway` are distinct adapters with distinct input/result types. Keeping them separate has three benefits:

1. **TypeScript narrowing.** Operators calling `diffHistoryTimeline({tenantIdA, tenantIdB, ...})` get `TimelineEntry[]` with `tenantSide: "A" | "B"`; operators calling `diffHistoryTimelineNway({tenantIds, ...})` get `NwayTimelineEntry[]` with `tenantLabel: string`. No optional fields, no narrowing dance.
2. **Backward compat.** Pair-wise callers don't see new fields on their result shape.
3. **JSON envelope discriminator.** `nway: true` clearly distinguishes the two response shapes for downstream `jq` consumers.

The dispatcher in `runRetentionDiffTimeline` reads `--add-tenant` via `getMultiFlag`, branches to the N-way path when set, falls through to the existing pair-wise path otherwise.

### Algorithm: single IN-clause query

```sql
SELECT h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id,
       h.occurred_at, h.prev_state, h.next_state, h.attributes
       [, u.display_name AS actor_display_name, u.email AS actor_email]
FROM meta.tenant_retention_opt_out_history h
[LEFT JOIN meta.users u ON u.id = h.actor_id]
WHERE h.tenant_id IN ($1, $2, $3, ...)
  AND h.table_name = $tableParam
  [AND h.occurred_at >= $sinceParam]
  [AND h.occurred_at <= $untilParam]
ORDER BY h.occurred_at ASC, h.id ASC
LIMIT $limitParam
```

PG handles the IN-list efficiently with the existing `(table_name, occurred_at)` index. Two parallel queries per tenant + application-side merge would be O(N) round-trips and need careful tie handling under shared `occurred_at`.

Per-row `tenantLabel` is tagged at the adapter via a `Map<tenantId, label>` built from input order. Duplicate `tenantIds` in input — first occurrence wins the label (matches ADR-0183's deduplication-by-first-occurrence pattern).

### Label assignment

New `labelForIndex(index: number): string` exported helper:

```ts
export function labelForIndex(index: number): string {
  if (index < 26) return String.fromCharCode(65 + index);
  return `T${index + 1}`;
}
```

Same convention as ADR-0183/0188 cohort labels. Beyond 26 tenants, labels become `T27`, `T28`, ... — operators with >26-tenant cohorts are unusual but the substrate handles them.

### Output format

**Human (3-tenant N-way):**

```
N-way timeline for 3 tenants on workflow_traces:
  Tenant A: 11111111-1111-1111-1111-111111111111
  Tenant B: 22222222-2222-2222-2222-222222222222
  Tenant C: 33333333-3333-3333-3333-333333333333

Events (4):
  2026-01-15T10:00:00.000Z  [A] retention_set    retention=30 opt_out=false enabled=true
  2026-02-01T14:23:11.000Z  [B] retention_set    retention=90 opt_out=false enabled=true
  2026-03-10T08:45:00.000Z  [C] retention_set    retention=365 opt_out=false enabled=true
  2026-04-22T16:30:00.000Z  [A] opt_out_set      retention=30 opt_out=true reason=legal-hold
```

When no events match:

```
N-way timeline for 3 tenants on workflow_traces:
  Tenant A: ...
  Tenant B: ...
  Tenant C: ...

No history events for any of these tenants on this table.
```

**JSON:**

```json
{
  "action": "diff-timeline",
  "nway": true,
  "since": null,
  "until": null,
  "limit": 100,
  "withActorNames": false,
  "result": {
    "tenantIds": ["...", "...", "..."],
    "tableName": "workflow_traces",
    "entries": [
      {
        "id": "...",
        "tenantId": "...",
        "tenantLabel": "A",
        "tableName": "workflow_traces",
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

Operators jq-filter on `.result.entries[] | select(.tenantLabel == "A")` to extract one tenant's events. The `nway: true` discriminator distinguishes from ADR-0189's pair-wise envelope (which has no discriminator).

### `formatTimelineNwayDiff` helper

New exported helper alongside `formatTimelineDiff`. Reuses the existing `summarizeTimelineEntry` + `formatActor` helpers — no duplication. The pair-wise vs N-way split is one new public helper function (separate from `formatTimelineDiff`) + one new dispatcher branch (in `runRetentionDiffTimeline`).

## Use cases unblocked

**1. Cohort-wide divergence audit**

```bash
crossengin retention diff-timeline <ref-tenant> <a> workflow_traces \
  --add-tenant <b> --add-tenant <c> --add-tenant <d> --add-tenant <e> \
  --since 2026-Q1 --format json | \
  jq '.result.entries | group_by(.tenantLabel) | map({tenant: .[0].tenantLabel, mutations: length})'
# Counts mutations per tenant across the 5-tenant cohort.
```

**2. Legal-hold cohort verification**

```bash
crossengin retention diff-timeline <hold-tenant-1> <hold-tenant-2> workflow_traces \
  --add-tenant <hold-tenant-3> --add-tenant <hold-tenant-4> \
  --with-actor-names
# Single command shows who applied (or didn't) the hold across all 4 tenants.
```

**3. Tier migration drift detection**

```bash
crossengin retention diff-timeline <baseline> <migrated-1> workflow_traces \
  --add-tenant <migrated-2> --add-tenant <migrated-3> \
  --since <migration-start> --format json | \
  jq '.result.entries[] | select(.tenantLabel != "A")'
# Excludes the baseline's events, showing only the migrated tenants' actions.
```

**4. Compliance attestation across regulated cohort**

```bash
for table in workflow_traces llm_call_traces tenant_retention_opt_out_history; do
  crossengin retention diff-timeline <regulated-a> <regulated-b> $table \
    --add-tenant <regulated-c> --add-tenant <regulated-d> \
    --since 2026-Q1 --with-actor-names --format json > "audit-$table.json"
done
# Quarterly attestation export across cohort + all prunable tables.
```

## Drawbacks

1. **Two adapter methods to maintain** — `diffHistoryTimeline` (pair-wise) + `diffHistoryTimelineNway`. Mirrors ADR-0183's pattern. The pair-wise variant could in principle be expressed as a degenerate N-way call but distinct types give cleaner TypeScript narrowing for the common pair-wise case.
2. **`tenantSide: "A" | "B"`** on pair-wise entries vs **`tenantLabel: string`** on N-way entries — different field names for the same conceptual property. Pair-wise narrowed type (literal union) is friendlier to TypeScript consumers; widened-string type loses the literal. Acceptable since callers branch on `nway` discriminator first.
3. **Label collision at >26 tenants** — operators with cohorts >26 tenants get `T27`/`T28`/... which is less readable than alphabet labels but the substrate handles them. Documented.
4. **No deduplication of input `tenantIds`** — duplicate UUIDs in the input array survive (first occurrence wins the label, subsequent occurrences see their tenant_id mapped to the same label). Matches ADR-0183 behavior. Operators passing duplicates accidentally see the duplicate UUID in `tenantIds[]` but events are de facto deduplicated by the IN-clause SQL.
5. **No N-way + `--cross-table`** — operators wanting "across N tenants × M tables" matrix run multiple commands. Different semantic axis. Defer.
6. **Single adapter call, single IN-clause query** — PG handles tens of tenants fine (IN-list up to ~32K parameters); operators with thousands of tenants would hit parser limits. Defer chunking until measured demand.
7. **No state-replay** — same caveat as ADR-0189. The timeline shows what changed; operators wrap with `retention diff --add-tenant` for current-state divergence across the cohort.

## Alternatives considered

1. **Widen `diffHistoryTimeline` to accept `tenantIds: ReadonlyArray<string>` of length 2..N** — narrower TypeScript types lost (pair-wise consumers get `tenantSide: string` instead of literal `"A" | "B"`). Rejected — separate methods give better narrowing.
2. **N-way via `--tenants <a,b,c,d>` comma-separated single flag** — fragile (UUIDs don't contain commas but operators passing variables with embedded commas hit edge cases). Rejected — repeated `--add-tenant` matches ADR-0183 precedent.
3. **Auto-promote to N-way when >3 positional args** — magical; operators may pass typo-extra args. Rejected.
4. **New action `retention diff-timeline-nway`** — adds CLI surface; flag-on-existing matches `--add-tenant` precedent from ADR-0183. Rejected.
5. **Use `tenantSide` field on `NwayTimelineEntry` too** — would type as `string` (widened). Less honest about the cross-axis semantic. Rejected — `tenantLabel: string` is structurally consistent with ADR-0188's `FieldVariationValueGroup.labels` rename.
6. **JSON envelope without `nway: true` discriminator** — operators would have to detect N-way by checking `tenantIds[]` vs `tenantIdA`/`tenantIdB`. Rejected — explicit discriminator is the established pattern (ADR-0183 / 0180 / 0188).
7. **N-way with `--vs-platform`** — synthetic "N tenants vs the platform default across history events" — different semantic from N tenant-vs-tenant. Defer.
8. **State-replay per event in N-way mode** — would emit per-event divergence delta against the cohort. Significant query cost. Defer.
9. **`--exclude-tenant <uuid>`** for set-subtraction — operators want this when starting from "all tenants" semantic. Defer.

## Open questions

1. **N-way + `--cross-table` matrix mode** — "across N tenants × M tables, merged timeline." Output dimensions multiply; defer.
2. **N-way + `--vs-platform`** synthetic comparison. Defer.
3. **`--exclude-tenant <uuid>`** for set-subtraction. Defer.
4. **`--add-tenant <slug>`** resolving via `meta.tenants.slug` for human-readable input. Pairs with similar deferred Qs across ADRs. Defer.
5. **Cursor pagination via `--after-id`** on N-way matching ADR-0175. Same pattern; defer.
6. **State-replay variant** emitting per-event divergence delta against the cohort. Defer.
7. **Tagged-union JSON envelope** across all retention diff-* actions. Pairs with similar deferred Qs across ADR-0173/0178/0179/0180/0183/0188/0189/0190. Defer.
8. **Auto-deduplicate `tenantIds`** at the CLI boundary (drop duplicates before adapter call). Operators wanting deduplication wrap with `sort -u` on input. Defer.
