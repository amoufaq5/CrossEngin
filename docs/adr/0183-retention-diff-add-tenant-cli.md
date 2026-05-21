# ADR-0183: `crossengin retention diff --add-tenant` N-way cross-tenant comparison (Phase 2 M6.7.zz.tenant.opt-out.cli.diff.add-tenant)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0177 (effectiveRetentionBatch), ADR-0178 (retention diff cross-tenant), ADR-0179 (retention diff --vs-platform), ADR-0180 (retention diff --cross-table), ADR-0181 (retention diff --exit-on-divergence) |

## Context

ADR-0178 shipped pair-wise cross-tenant diff and listed Q2 as:

> Q2: N-way diff via repeated `--add-tenant <uuid>` flag. Defer — pair-wise is canonical pattern; operators chain commands.

Operators chained commands for a while. The pattern broke down when cohorts grew beyond 3 tenants — pair-wise diff produces N×(N-1)/2 commands for N tenants, and operators have to mentally assemble the per-field variation matrix from those pair-wise outputs. For a 5-tenant compliance cohort that's 10 commands and 10 outputs to correlate by hand.

M6.7.zz.tenant.opt-out.cli.diff.add-tenant closes ADR-0178 Q2 with a single command that returns a per-field variation analysis across N tenants.

## Decision

### CLI surface

```
crossengin retention diff <tenant-a> <tenant-b> <table-name> --add-tenant <tenant-c> [--add-tenant <tenant-d> ...]
                                                              [--format human|json]
                                                              [--exit-on-divergence]
```

- Base call still requires 2 positional tenants + 1 positional table (matching the cross-tenant default from ADR-0178).
- `--add-tenant <uuid>` is repeatable; each occurrence adds one tenant to the comparison.
- N total tenants = 2 (positional) + count(`--add-tenant`). Minimum N to trigger N-way mode = 3 (at least one `--add-tenant`).
- Mutually exclusive with `--vs-platform` and `--cross-table` (those modes have different semantics).
- `--exit-on-divergence` from ADR-0181 works on N-way too — exit 3 when `fieldVariations.length > 0`.

### Repeated-flag parsing

`parseArgs` extended additively to track repeated flag values. New `multiFlags: ReadonlyMap<string, ReadonlyArray<string>>` field on `ParsedCommand` records every string-valued occurrence of each flag (in argv order). Existing `flags` map keeps last-write-wins semantics — backward compatible.

New `getMultiFlag(command, name): ReadonlyArray<string>` helper reads from `multiFlags`. Existing callers using `getStringFlag` are unaffected.

### Adapter

New method `diffTenantPoliciesNway` on `PostgresTraceRetention`:

```ts
export interface DiffTenantPoliciesNwayInput {
  readonly tenantIds: ReadonlyArray<string>;  // length >= 2
  readonly tableName: string;
}

export interface TenantResolutionEntry {
  readonly tenantId: string;
  readonly resolution: EffectiveRetentionResolution;
}

export interface FieldVariationValueGroup {
  readonly value: unknown;
  readonly tenantIds: ReadonlyArray<string>;
}

export interface FieldVariation {
  readonly field: string;
  readonly distinctValues: ReadonlyArray<FieldVariationValueGroup>;
}

export interface DiffTenantPoliciesNwayResult {
  readonly tenantIds: ReadonlyArray<string>;
  readonly tableName: string;
  readonly resolutions: ReadonlyArray<TenantResolutionEntry>;
  readonly fieldVariations: ReadonlyArray<FieldVariation>;
}

async diffTenantPoliciesNway(
  input: DiffTenantPoliciesNwayInput,
): Promise<DiffTenantPoliciesNwayResult>;
```

Composes on `effectiveRetentionBatch` (the canonical pattern from ADR-0177 — same as ADR-0178's diffTenantPolicies and ADR-0180's diffTenantTables). Passes N pairs to the batch resolver → 2 queries total regardless of N. Looks up each tenant's resolution from the returned Map via `effectiveRetentionKey`.

### Variation analysis

For each field across all N normalized resolutions:
1. Group tenants by JSON-stringified value (handles primitives, null, undefined uniformly).
2. If only 1 distinct value group → field is uniform, skip.
3. If 2+ distinct value groups → include in `fieldVariations[]`.

Sort variations alphabetically by field name (matching ADR-0173 `computeFieldDiffs`).

New `computeFieldVariations(entries)` pure helper exported alongside the existing `computeFieldDiffs` and `normalizeResolutionForDiff`. Same shape: pure function over normalized records, no DB dependency, fully unit-testable.

Per-field result lists every distinct value seen and which tenants have it. Operators reading "source: tenant (A) | platform (B, C)" know immediately:
- Tenant A is on its own per-tenant policy.
- Tenants B and C share the platform default.

### Resolution dedup

Adapter does NOT deduplicate input `tenantIds`. If the same tenant appears twice in the input array, it appears twice in `resolutions[]` (matching the input). Mirrors the ADR-0182 effective-batch CLI 1:1 input/output contract — operators with accidentally-duplicated input see the duplication.

The underlying `effectiveRetentionBatch` deduplicates pairs internally for query efficiency, but the N-way adapter iterates the original input order looking up from the Map.

### Output format

**Human:**

```
N-way diff between 4 tenants (table: workflow_traces):
  Tenant A: <uuid-a>  source=tenant         retention=30d  enabled=yes
  Tenant B: <uuid-b>  source=platform       retention=90d  enabled=yes
  Tenant C: <uuid-c>  source=platform       retention=90d  enabled=yes
  Tenant D: <uuid-d>  source=tenant_opt_out  reason=legal_hold  until=2099-01-01T00:00:00.000Z

Field variations (4):
  opt_out              false (A, B, C) | true (D)
  opt_out_reason       absent (A, B, C) | "legal_hold" (D)
  retention_days       30 (A) | 90 (B, C) | null (D)
  source               "tenant" (A) | "platform" (B, C) | "tenant_opt_out" (D)
```

When no variations:

```
N-way diff between 3 tenants (table: workflow_traces):
  Tenant A: <uuid>  source=platform       retention=90d  enabled=yes
  Tenant B: <uuid>  source=platform       retention=90d  enabled=yes
  Tenant C: <uuid>  source=platform       retention=90d  enabled=yes

No differences — all 3 tenants have the same effective retention policy.
```

Tenant labels A, B, C, ... map to input order. Beyond 26 tenants, labels become T27, T28, ... (operators with >26-tenant cohorts are unusual; documented but not optimized).

Per-tenant summary line reuses the shared `summarizeResolutionForDiff` helper from ADR-0178. `'absent'` placeholder for undefined values in variation groups.

**JSON:**

```json
{
  "action": "diff",
  "nway": true,
  "result": {
    "tenantIds": ["<uuid-a>", "<uuid-b>", "<uuid-c>"],
    "tableName": "workflow_traces",
    "resolutions": [
      {"tenantId": "<uuid-a>", "resolution": {"source": "tenant", ...}},
      ...
    ],
    "fieldVariations": [
      {
        "field": "source",
        "distinctValues": [
          {"value": "tenant", "tenantIds": ["<uuid-a>"]},
          {"value": "platform", "tenantIds": ["<uuid-b>", "<uuid-c>"]}
        ]
      }
    ]
  }
}
```

`nway: true` is the JSON-envelope discriminator. Operators now have 4 diff envelope shapes:
- Cross-tenant (no discriminator) — ADR-0178
- `vsPlatform: true` — ADR-0179
- `crossTable: true` — ADR-0180
- `nway: true` — this

All four boolean discriminators are mutually exclusive at the CLI boundary. JSON parsers branch on discriminator first.

### Exit-on-divergence integration

ADR-0181's `--exit-on-divergence` flag works uniformly. The CLI passes `result.fieldVariations.length` to `divergenceExitCode` — non-zero variations → exit 3 (same semantic as fieldDiffs for the pair-wise variants).

## Use cases unblocked

**1. Compliance cohort drift detection**

```bash
crossengin retention diff "$reference_tenant" "$tenant_b" workflow_traces \
  --add-tenant "$tenant_c" \
  --add-tenant "$tenant_d" \
  --add-tenant "$tenant_e" \
  --exit-on-divergence
# exit 3 → 5-tenant cohort has drift on at least one field
```

Single CI command replaces 10 pair-wise commands + manual correlation.

**2. Tier migration verification (n-way)**

```bash
crossengin retention diff "$ref" "$migrated_1" workflow_traces \
  --add-tenant "$migrated_2" --add-tenant "$migrated_3" --format json | \
  jq '.result.fieldVariations[] | select(.field == "source")'
```

After migrating N tenants to a new tier, verify they all resolve to the same source as a reference.

**3. Legal-hold cohort verification**

```bash
crossengin retention diff "$tenant_1" "$tenant_2" workflow_traces \
  --add-tenant "$tenant_3" --format json | \
  jq '[.result.resolutions[] | select(.resolution.source != "tenant_opt_out")] | length'
```

Returns 0 if all hold-tenants are correctly opted out; >0 if any escaped.

**4. Bulk diff visualization**

Operators piping JSON output into a small renderer get one-screen visualization of cohort variation — operator dashboards can render this directly.

## Drawbacks

1. **Output gets dense at high N.** A 20-tenant cohort with 5 variations renders 5 lines of `value (A, B, ...) | value (...)` that may wrap on narrow terminals. Operators with very large cohorts pipe to `less` or use JSON + jq.
2. **Tenant labels A..Z then T27, T28, ...** — operators with >26 cohort tenants get a less-readable label scheme. Acceptable since >26-tenant N-way comparisons are unusual.
3. **`parseArgs` interface change.** `ParsedCommand` gained a `multiFlags` field. Additive but extant ParsedCommand consumers seeing the new field; backward compat preserved since existing fields unchanged.
4. **No grouping in variation rendering** — fields are sorted alphabetically + each rendered independently. Operators wanting "group by retention_days then by source" use jq on JSON.
5. **No de-duplication.** Operators passing the same tenant twice see it twice in output. By design (1:1 input/output) but may confuse.
6. **N-way is pair-wise-superset** — a 2-tenant N-way call works but the output is wordier ("Field variations (1)" vs "Field changes (1)"). Operators using `--add-tenant` deliberately get N-way semantics; those using the default cross-tenant path get pair-wise. CLI doesn't auto-route.
7. **Mutual-exclusivity error lists 3 flag candidates** when more than one of `--vs-platform`, `--cross-table`, `--add-tenant` is set. Operators get a clear message but the error path is more complex than the previous 2-way exclusion.

## Alternatives considered

1. **Comma-separated `--tenants <a,b,c,d>`** — fragile, doesn't compose well with shell-quoted UUIDs containing punctuation, and breaks if operators have tenant IDs with embedded commas (UUIDs don't but custom IDs might). Rejected.
2. **Auto-promote to N-way when more than 3 positional args supplied** — magical; operators may pass extra accidental args. Rejected.
3. **New action `retention diff-nway`** — adds CLI surface, divides the diff vocabulary across four action names. Rejected — `--add-tenant` matches the precedent of `--vs-platform` / `--cross-table` operators already learned.
4. **Pair-wise output for N tenants (A vs B, A vs C, B vs C, ...)** — operators reading N×(N-1)/2 outputs manually correlate. Rejected — per-field variation analysis is the right abstraction.
5. **JSON-only output (no human format)** — N-way visualizations are useful in terminals. Rejected.
6. **Restrict to N ≤ 10** — arbitrary; PG IN list handles thousands. No cap.
7. **Return a Map<tenantId, Resolution> instead of ordered array** — loses input order. Rejected.
8. **`--limit N` to truncate variation rendering at high N** — operators pipe through `head` or `jq`. Rejected — out of scope.
9. **Use a separate adapter method that doesn't compose on `effectiveRetentionBatch`** — would duplicate the batch resolver logic. Rejected — composition is the established pattern (only ADR-0179's diffTenantVsPlatform deviates, with documented reason).

## Open questions

1. **`--exclude-tenant <uuid>`** for set-subtraction (compare cohort minus one tenant). Defer.
2. **`--input-file <path>`** reading tenant IDs from a JSON/text file (matching ADR-0182's `--pairs-file` pattern). Defer — useful for cohorts loaded from upstream systems.
3. **`--add-tenant <slug>` resolving via `meta.tenants.slug`** for human-readable input. Defer — substrate doesn't validate tenant IDs against meta; operators pass UUIDs.
4. **Render variations grouped by tenant** ("Tenant A differs from {B, C, D} on: source, retention_days") in addition to per-field grouping. Operator-specific view; defer.
5. **`--threshold N`** combined with `--exit-on-divergence` (only exit 3 when N+ field variations). Pairs with ADR-0181 Q2.
6. **N-way `--vs-platform`** — add platform default as a synthetic "tenant" in the comparison. Different semantic from pair-wise `--vs-platform`; defer.
7. **N-way `--cross-table`** — compare one tenant across N tables. Pairs with ADR-0180 Q1.
8. **Tagged-union JSON envelope** (`{kind: "vs-tenant"|"vs-platform"|"cross-table"|"nway", ...}`) — would simplify operator jq scripts across 4 diff variants but break backward compat with ADR-0178/0179/0180/0183 envelopes. Defer.
