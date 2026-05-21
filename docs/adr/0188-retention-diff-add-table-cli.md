# ADR-0188: `crossengin retention diff --cross-table --add-table` N-way cross-table comparison (Phase 2 M6.7.zz.tenant.opt-out.cli.diff.add-table)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0180 (--cross-table 2-way), ADR-0183 (--add-tenant N-way cross-tenant), ADR-0177 (effectiveRetentionBatch), ADR-0181 (--exit-on-divergence), ADR-0184 (--threshold) |

## Context

ADR-0180 shipped pair-wise cross-table diff (`--cross-table`) — compares one tenant across 2 tables. ADR-0183 shipped N-way cross-tenant diff (`--add-tenant`) for comparing 3+ tenants on the same table. ADR-0180 listed Q1 explicitly:

> Q1: N-way table diff via repeated `--add-table <name>` flag. Defer — chain commands.

Operators running compliance audits across the substrate's 4 prunable tables (`workflow_traces`, `llm_call_traces`, `tenant_retention_opt_out_history`, `llm_latency_samples`) for one tenant kept running 3 pair-wise commands and manually correlating. The N-way precedent from ADR-0183 made the missing cross-table N-way visibly asymmetric.

M6.7.zz.tenant.opt-out.cli.diff.add-table closes ADR-0180 Q1.

## Decision

### CLI surface

```
crossengin retention diff <tenant> <table-a> <table-b>
                          --cross-table
                          --add-table <table-c> [--add-table <table-d> ...]
                          [--format human|json]
                          [--exit-on-divergence [--threshold N]]
```

- Base call still requires 2 positional tables matching ADR-0180's cross-table shape.
- `--cross-table` is REQUIRED when `--add-table` is set — operators passing `--add-table` without `--cross-table` get exit 2 with `"--add-table requires --cross-table"`. Strict-require pattern matching ADR-0184's `--threshold requires --exit-on-divergence`.
- `--add-table <name>` is repeatable via `multiFlags` infrastructure from ADR-0183.
- N total tables = 2 (positional) + count(`--add-table`). Minimum N for N-way mode = 3 (at least one `--add-table`).
- Mutually exclusive with `--vs-platform` and `--add-tenant` via existing conflict-detection.

### Why require `--cross-table`

`--add-table` without `--cross-table` is semantically ambiguous — the default `retention diff` shape is cross-tenant (2 tenants + 1 table positional). Adding `--add-table` to that mode wouldn't make sense (which positional becomes the table list?). Strict-require eliminates ambiguity at the CLI boundary.

### Adapter

New method `diffTenantTablesNway` on `PostgresTraceRetention`:

```ts
export interface DiffTenantTablesNwayInput {
  readonly tenantId: string;
  readonly tableNames: ReadonlyArray<string>;  // length >= 2
}

export interface TableResolutionEntry {
  readonly tableName: string;
  readonly resolution: EffectiveRetentionResolution;
}

export interface DiffTenantTablesNwayResult {
  readonly tenantId: string;
  readonly tableNames: ReadonlyArray<string>;
  readonly resolutions: ReadonlyArray<TableResolutionEntry>;
  readonly fieldVariations: ReadonlyArray<FieldVariation>;
}
```

Composes on `effectiveRetentionBatch` (canonical pattern from ADR-0177): passes N pairs `[{tenantId, tableName: tables[i]}]` → 2 queries total regardless of N.

Mirrors `diffTenantPoliciesNway` from ADR-0183 in shape but with the axes swapped — one tenant, multiple tables (vs multiple tenants, one table).

### `FieldVariationValueGroup` field rename: `tenantIds` → `labels`

ADR-0183's `computeFieldVariations` helper output type carried a `tenantIds: ReadonlyArray<string>` field on each `FieldVariationValueGroup`. For cross-table N-way the "labels" are table names, not tenant IDs — semantically inaccurate.

This milestone renames `FieldVariationValueGroup.tenantIds` → `FieldVariationValueGroup.labels`. The helper's input field also renames from `tenantId` → `label`. Generic naming makes the helper truly cross-axis reusable.

Breaking change scope: 1 type field + 1 helper-input field + ~15 test assertions across kernel-pg and architect-cli. No production consumers (operators reading JSON output would see the new field name only if they were already using ADR-0183's N-way output).

Migration cost is one-time and contained. Worth it for forever-clean semantics across both N-way axes.

### CLI dispatcher

```ts
const vsPlatform = getBooleanFlag(command, "vs-platform");
const crossTable = getBooleanFlag(command, "cross-table");
const addTenants = getMultiFlag(command, "add-tenant");
const addTables = getMultiFlag(command, "add-table");
const hasAddTenant = addTenants.length > 0;
const hasAddTable = addTables.length > 0;

if (hasAddTable && !crossTable) {
  return exit-2("--add-table requires --cross-table");
}

// conflicts check unchanged (already catches --cross-table + --add-tenant)
if ([--vs-platform, --cross-table, --add-tenant].filter(set).length > 1) {
  return exit-2("mutually exclusive");
}

if (vsPlatform) return vsPlatform-runner;
if (crossTable) {
  if (hasAddTable) return cross-table-nway-runner;
  return cross-table-2way-runner;  // existing
}
if (hasAddTenant) return cross-tenant-nway-runner;
return cross-tenant-default-runner;
```

`--add-table` + `--add-tenant` is caught implicitly: `--add-table` requires `--cross-table`, `--cross-table` excludes `--add-tenant`, so the combination is impossible.

### Output format

**Human:**

```
N-way diff across 4 tables for tenant <uuid>:
  Table A: workflow_traces                       source=tenant         retention=30d  enabled=yes
  Table B: llm_call_traces                       source=platform       retention=90d  enabled=yes
  Table C: tenant_retention_opt_out_history      source=platform       retention=365d enabled=yes
  Table D: llm_latency_samples                   source=none           (no policy configured)

Field variations (3):
  enabled              true (A, B, C) | false (D)
  retention_days       30 (A) | 90 (B) | 365 (C) | null (D)
  source               "tenant" (A) | "platform" (B, C) | "none" (D)
```

Table labels A, B, C, ... assigned by input order (same as ADR-0183 tenant labels). Table-name column padded to 36 chars (longer than the 20-char tenant-UUID column) to fit `tenant_retention_opt_out_history`.

When no variations:

```
N-way diff across 3 tables for tenant <uuid>:
  Table A: workflow_traces                source=platform retention=90d enabled=yes
  Table B: llm_call_traces                source=platform retention=90d enabled=yes
  Table C: tenant_retention_opt_out_history source=platform retention=90d enabled=yes

No differences — all 3 tables resolve to the same effective retention policy for this tenant.
```

**JSON:**

```json
{
  "action": "diff",
  "nway": true,
  "crossTable": true,
  "result": {
    "tenantId": "...",
    "tableNames": ["workflow_traces", "llm_call_traces", "tenant_retention_opt_out_history"],
    "resolutions": [
      {"tableName": "workflow_traces", "resolution": {"source": "tenant", ...}},
      ...
    ],
    "fieldVariations": [
      {
        "field": "source",
        "distinctValues": [
          {"value": "tenant", "labels": ["workflow_traces"]},
          {"value": "platform", "labels": ["llm_call_traces", "tenant_retention_opt_out_history"]}
        ]
      }
    ]
  }
}
```

**Dual discriminator** `nway: true, crossTable: true` — operators parsing JSON branch on `nway` to know it's an N-way comparison + `crossTable` to know the axis is tables (not tenants). Existing ADR-0183 cross-tenant N-way has `nway: true` only (no `crossTable`). Existing ADR-0180 cross-table 2-way has `crossTable: true` only (no `nway`). The 4 diff envelope discriminators now form a 2×2 matrix:

| | Pair-wise | N-way |
|---|---|---|
| Cross-tenant | (none) | `nway: true` |
| Cross-table | `crossTable: true` | `nway: true, crossTable: true` |
| Vs platform | `vsPlatform: true` | — |

`vsPlatform` doesn't combine with N-way (different semantic — would compare one tenant against the platform default across multiple tables; future Q if requested).

### `--exit-on-divergence` + `--threshold` integration

Both work uniformly across all diff variants. `divergenceExitCode(command, result.fieldVariations.length)` is called at the end of the new runner — same as ADR-0183's cross-tenant N-way runner.

## Use cases unblocked

**1. Full-cohort cross-table audit for one tenant**

```bash
crossengin retention diff <tenant> workflow_traces llm_call_traces \
  --cross-table \
  --add-table tenant_retention_opt_out_history \
  --add-table llm_latency_samples
# Compares all 4 prunable tables for one tenant in one command.
```

**2. Legal-hold completeness across trace tables**

```bash
crossengin retention diff <hold-tenant> workflow_traces llm_call_traces \
  --cross-table \
  --add-table tenant_retention_opt_out_history \
  --exit-on-divergence
# Exit 3 if the hold isn't uniformly applied across all 3 trace tables.
```

**3. JSON-driven dashboard**

```bash
crossengin retention diff <tenant> <table-a> <table-b> \
  --cross-table \
  --add-table <table-c> \
  --format json | \
  jq '.result.fieldVariations[] | select(.field == "source") | .distinctValues'
# Returns which tables share which source value for a quick visual.
```

**4. Migration-script CI gate across all tables**

```bash
THRESHOLD=2
crossengin retention diff <tenant> workflow_traces llm_call_traces \
  --cross-table \
  --add-table tenant_retention_opt_out_history \
  --add-table llm_latency_samples \
  --exit-on-divergence --threshold $THRESHOLD
# Allows up to 1 field difference (e.g., the always-expected llm_latency_samples=none
# variation); fails CI when 2+ fields differ across the cohort.
```

## Drawbacks

1. **`--add-table` requires `--cross-table`** — operators must remember the pairing. Documented; matches ADR-0184's `--threshold requires --exit-on-divergence` precedent.
2. **Dual JSON discriminator (`nway: true, crossTable: true`)** — operators write `if (nway && crossTable)` branches. Acceptable since each flag tracks a single semantic dimension; composition is natural.
3. **`FieldVariationValueGroup.tenantIds` → `labels` breaking rename** — operators relying on the ADR-0183 field name need to migrate. Mitigated: change is contained (one field name) + no Phase-2-shipped client uses it externally + new name is semantically correct for both N-way axes going forward.
4. **No way to combine `--add-tenant` + `--add-table`** — cross-tenant × cross-table matrix not supported. Operators wanting "Alice's vs Bob's retention across all tables" run multiple commands. Documented as future Q.
5. **Output dense at high N (especially with long table names)** — `tenant_retention_opt_out_history` is 32 chars; padded to 36 the line gets long. Operators with narrow terminals pipe to `less -S` or use JSON.
6. **Table-label A..Z limit** — same as ADR-0183 (beyond 26 becomes T27, T28, ...). The substrate has 4 prunable tables today; no realistic chance of exceeding the alphabet.

## Alternatives considered

1. **Auto-imply `--cross-table` when `--add-table` is set** — magical; operators may pass `--add-table` thinking it'd do something for the default cross-tenant shape. Rejected — strict-require is clearer.
2. **`--add-table` standalone (without `--cross-table`)** — would require redesigning the positional-arg parser since the default shape is `<tenant-a> <tenant-b> <table>`. Rejected — pairing with `--cross-table` is cheaper.
3. **New action `retention diff-tables-nway`** — adds CLI surface; flag-on-existing matches `--add-tenant` from ADR-0183. Rejected.
4. **N-way cross-table + N-way cross-tenant in one call (matrix mode)** — N×M comparison; complex output; defer until measured demand.
5. **`--all-tables` shorthand for "compare all prunable tables for this tenant"** — operator-policy concern; substrate doesn't enumerate prunable tables externally. Defer.
6. **Keep `FieldVariationValueGroup.tenantIds` name + tolerate semantic mismatch** — operators reading cross-table N-way JSON would see `tenantIds: ["workflow_traces", ...]` which is misleading. Rejected — rename is cheap.
7. **Add a parallel `FieldVariationValueGroup.tableNames` field with `tenantIds` deprecated** — schema bloat. Rejected — clean rename is better.
8. **Make `--add-table` accept comma-separated values** — fragile to embedded commas. Rejected — repeated flag via `multiFlags` is established pattern.

## Open questions

1. **Combined `--add-tenant` + `--add-table` matrix comparison** (cross-tenant × cross-table N×M). Defer until measured demand.
2. **`--all-tables` shorthand** that enumerates all PRUNABLE_TABLES for the tenant. Operator-policy concern; defer.
3. **`--exclude-table <name>`** for set-subtraction. Defer.
4. **Render variations grouped by table** (vs per-field) for compact rendering at high N. Defer.
5. **Tagged-union JSON envelope** consolidating all 4 diff variant discriminators into one `kind` field. Pairs with similar deferred Qs from ADR-0178/0179/0180/0183.
6. **Cross-tenant N-way + `--vs-platform`** synthetic "N tenants vs the platform default" — different semantic from pair-wise; defer.
7. **Surface `attributes` from history-derived restore context in diff output** — different surface; future ADR if requested.
