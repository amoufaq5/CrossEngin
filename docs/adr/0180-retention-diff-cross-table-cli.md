# ADR-0180: `crossengin retention diff --cross-table` cross-table-within-tenant comparison (Phase 2 M6.7.zz.tenant.opt-out.cli.diff.cross-table)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0159 (effectiveRetention), ADR-0173 (retention diff-history CLI), ADR-0177 (effectiveRetentionBatch), ADR-0178 (retention diff cross-tenant), ADR-0179 (retention diff --vs-platform) |

## Context

After ADR-0178 (cross-tenant-same-table) and ADR-0179 (tenant-vs-platform) shipped, the diff matrix had a missing axis: **cross-table-within-tenant**. Operators auditing a single tenant want to answer "is this tenant's retention consistent across all the trace tables they have data in?" — e.g., is the legal hold applied to `workflow_traces` ALSO applied to `llm_call_traces`?

Current workaround: two `retention effective <tenant> <table-a>` + `retention effective <tenant> <table-b>` invocations, mental-diffing the output. Tedious and error-prone for the common compliance audit pattern.

ADR-0178 listed cross-table-within-tenant as Q3:

> Q3: Cross-table comparison via `retention diff <tenant> <table-a> <table-b>` (operators may want to verify consistency across the trace tables for one tenant). Different semantic; future action if requested.

M6.7.zz.tenant.opt-out.cli.diff.cross-table closes it.

## Decision

### CLI surface

```
crossengin retention diff <tenant> <table-a> <table-b> --cross-table
                          [--format human|json]
```

- `--cross-table` is a boolean flag on the existing `diff` action — no new top-level action, matching the `--vs-platform` precedent.
- When `--cross-table` is set, the diff dispatcher expects 3 positional args (tenant + 2 tables) and routes to the cross-table adapter.
- `--cross-table` and `--vs-platform` are mutually exclusive — both set → exit 2 with clear error.
- Without either flag, the existing cross-tenant `diff <tenant-a> <tenant-b> <table>` path is unchanged.

### Adapter

New method `diffTenantTables` on `PostgresTraceRetention`:

```ts
export interface DiffTenantTablesInput {
  readonly tenantId: string;
  readonly tableNameA: string;
  readonly tableNameB: string;
}

export interface DiffTenantTablesResult {
  readonly tenantId: string;
  readonly tableNameA: string;
  readonly tableNameB: string;
  readonly resolutionA: EffectiveRetentionResolution;
  readonly resolutionB: EffectiveRetentionResolution;
  readonly fieldDiffs: ReadonlyArray<HistoryEntryFieldDiff>;
}

async diffTenantTables(
  input: DiffTenantTablesInput,
): Promise<DiffTenantTablesResult>;
```

### Implementation: reuse `effectiveRetentionBatch`

Unlike ADR-0179 which couldn't compose on the batch resolver (needed BOTH sides regardless of fallback), `diffTenantTables` wants the EFFECTIVE resolution for each (tenant, table) pair — which is exactly what `effectiveRetentionBatch` returns. So this milestone returns to the canonical composition pattern established by ADR-0177/0178.

The adapter calls `effectiveRetentionBatch({pairs: [{tenantId, tableNameA}, {tenantId, tableNameB}]})` — 2 queries total (one tenant lookup with both pairs in the `IN ((..., ...), (..., ...))` tuple-list, one platform lookup with both table names in `IN (...)`), Promise.all parallelized. Looks up both resolutions from the returned Map via the exported `effectiveRetentionKey` helper.

This restores the substrate's "single canonical batch-resolver pattern: any future comparison/aggregation operation that needs multiple resolutions should compose on top of `effectiveRetentionBatch`" — ADR-0179 is the documented exception, this milestone is the rule.

### Diff computation

Identical to ADR-0178's cross-tenant flow — `computeFieldDiffs(normalizeResolutionForDiff(resolutionA), normalizeResolutionForDiff(resolutionB))`. Reuses the existing `normalizeResolutionForDiff` helper from ADR-0178 + `computeFieldDiffs` from ADR-0173 unchanged. Same alphabetical-sort output, same `indefinite` / `<no reason>` conventions, same `'absent'` placeholder for undefined values.

### Output format

**Human:**

```
Diff between tables for tenant <uuid>:
  Table A: workflow_traces      source=tenant         retention=30d  enabled=yes
  Table B: llm_call_traces      source=platform       retention=365d  enabled=yes

Field changes (2):
  retention_days       30  →  365
  source               "tenant"  →  "platform"
```

When no differences:

```
Diff between tables for tenant <uuid>:
  Table A: workflow_traces      source=platform       retention=90d  enabled=yes
  Table B: llm_call_traces      source=platform       retention=90d  enabled=yes

No differences — both tables resolve to the same effective retention policy for this tenant.
```

Per-table resolution summary line uses the shared `summarizeResolutionForDiff` helper from ADR-0178 — same 4-variant rendering. Table name padded to 20 chars for column alignment.

**JSON:**

```json
{
  "action": "diff",
  "crossTable": true,
  "result": {
    "tenantId": "...",
    "tableNameA": "workflow_traces",
    "tableNameB": "llm_call_traces",
    "resolutionA": { "source": "tenant", ... },
    "resolutionB": { "source": "platform", ... },
    "fieldDiffs": [...]
  }
}
```

`crossTable: true` is the JSON-envelope discriminator. Operators now have three diff envelope shapes:
- `result.{tenantIdA, tenantIdB, tableName, resolutionA, resolutionB}` — cross-tenant (ADR-0178)
- `result.{tenantId, tableName, tenantResolution, platformResolution}` with `vsPlatform: true` (ADR-0179)
- `result.{tenantId, tableNameA, tableNameB, resolutionA, resolutionB}` with `crossTable: true` — this

The two boolean discriminators (`vsPlatform` / `crossTable`) are mutually exclusive at the CLI boundary; their absence implies the cross-tenant default. JSON parsers branch on the boolean discriminator first.

### Mutual exclusivity enforcement

`--vs-platform` + `--cross-table` together → exit 2 with `"retention diff: --vs-platform and --cross-table are mutually exclusive"`. Checked early in the dispatcher before any other arg parsing.

### Why no validation on `tableNameA === tableNameB`

Substrate doesn't enforce semantic constraints unless they're critical. Passing the same table for both axes produces identical resolutions and empty `fieldDiffs` — operators see the redundancy immediately. Matches the existing `diffTenantPolicies` (ADR-0178) approach where `tenantA === tenantB` is also valid (though equally pointless). Keeps the adapter signature simple.

## Use cases unblocked

**1. Cross-table consistency audit for one tenant**

```bash
crossengin retention diff <tenant> workflow_traces llm_call_traces --cross-table
```

Operator confirms (or detects deviation) that a tenant's retention is consistent across multiple trace tables.

**2. Legal hold completeness check**

```bash
crossengin retention diff <legal-hold-tenant> workflow_traces llm_call_traces --cross-table --format json | \
  jq 'select(.result.resolutionA.source == "tenant_opt_out" and .result.resolutionB.source != "tenant_opt_out")'
```

Surfaces tenants where an opt-out was applied to one trace table but not the other (incomplete hold).

**3. Compliance migration verification**

```bash
for table_a in workflow_traces llm_call_traces; do
  for table_b in workflow_traces llm_call_traces tenant_retention_opt_out_history; do
    [ "$table_a" \< "$table_b" ] && \
      crossengin retention diff "$tenant" "$table_a" "$table_b" --cross-table --format json
  done
done | jq 'select(.result.fieldDiffs | length > 0)'
```

After a cross-table policy update operators verify all the trace tables under a tenant ended up with the matching retention.

**4. CI gate for cohort consistency**

```bash
DIFF=$(crossengin retention diff "$tenant" workflow_traces llm_call_traces --cross-table --format json)
if echo "$DIFF" | jq -e '.result.fieldDiffs | length > 0'; then
  echo "❌ tenant has inconsistent retention across trace tables"
  exit 1
fi
```

Build fails when cross-table retention drift is detected for monitored tenants.

## Drawbacks

1. **Two flags on `diff` (`--vs-platform` + `--cross-table`)** — operators may forget to set one and fall through to the default cross-tenant path. Mitigated by clear missing-args error messages naming the expected flag.
2. **Three positional-arg shapes on one action** — cross-tenant (`tenant-a tenant-b table`), --vs-platform (`tenant table`), --cross-table (`tenant table-a table-b`). Documented in three separate helpText usage lines. Pattern continues from ADR-0179.
3. **Mutual-exclusivity error at CLI boundary** — operators passing both flags get exit 2; no automatic disambiguation. Acceptable since semantic is ambiguous (cross-table vs vs-platform aren't composable).
4. **JSON envelope discriminator proliferation** — `vsPlatform: true` vs `crossTable: true` vs neither. Operators parsing JSON across diff variants write 3 jq branches. Could be unified via tagged union (future Q from ADR-0179) but would break ADR-0178 + 0179 compatibility.
5. **N-way table diff not in scope** — operators wanting "compare retention across ALL of this tenant's prunable tables" chain multiple commands. Future Q if requested.
6. **Same-tenant constraint** — both axes share the tenant; operators wanting "tenant A on table X vs tenant B on table Y" run two `retention effective` commands manually. Different semantic; out of scope.

## Alternatives considered

1. **New action `retention diff-tables <tenant> <table-a> <table-b>`** — cleaner separation but adds CLI surface, divides the diff vocabulary across three action names. Rejected — `--cross-table` matches the `--vs-platform` precedent operators have already learned.
2. **Implicit detection: if positional args look like `<tenant> <table> <table>` route to cross-table** — heuristic-based; ambiguous when table names look like UUIDs. Rejected.
3. **Compose on two single-pair `effectiveRetention` calls** — 4 queries vs 2 batch; defeats the composition pattern. Rejected.
4. **N-way diff via repeated `--add-table <name>`** — overkill for v1; pair-wise is the canonical pattern from ADR-0178/0179 (which also rejected N-way). Operators chain commands.
5. **Cross-table without `--cross-table` flag (default to it when 2 of 3 positionals look like table names)** — fragile + magic. Rejected.
6. **`retention compare-tables <tenant>` returning all-table-pairs combinations** — operator-unrequested; bulk variants deferred. Rejected.
7. **Allow `--cross-table` + `--vs-platform` to mean "compare two tables' platform defaults for one tenant"** — semantic stretch + operators wanting that use `retention list-policies --table` + `--table` + manual compare. Rejected — mutual exclusivity is cleaner.
8. **Return a Map<tableName, EffectiveRetentionResolution> instead of A/B labeled fields** — more general but breaks the pair-wise diff shape established by ADR-0178. Operators rendering output would need to know how to label two map entries. Rejected — A/B labeling matches the existing diff shapes.

## Open questions

1. **N-way table diff via repeated `--add-table <name>` flag.** Defer — chain commands.
2. **`--all-tables` for one-tenant-across-every-prunable-table.** Defer — bounded set (currently 4 tables); shell loop covers.
3. **`--exit-on-divergence` for CI gates.** Defer — operators wrap with `jq .result.fieldDiffs | length` + `[ "$N" -eq 0 ]`.
4. **JSON envelope unification across all 3 diff variants via tagged union** (`{kind: "vs-tenant"/"vs-platform"/"cross-table", ...}`) — would simplify operator jq scripts but break backward compat with ADR-0178 + 0179 envelopes. Defer.
5. **Table-name validation against the PRUNABLE_TABLES allowlist** — substrate currently doesn't validate (returns `source: "none"` for unknown tables which surfaces the typo). Could add CLI-side validation for crisper errors but matches existing `retention effective` non-validation stance. Defer.
6. **Combined cross-table + diff-history** (`retention diff <tenant> <table-a> <table-b> --cross-table --at-time DATE`) for point-in-time cross-table comparison. Requires the deferred `--at-time` substrate from ADR-0162; defer.
7. **`--field <name>` filter on JSON output** to narrow which fields surface in `fieldDiffs`. Defer — `jq` covers it on JSON.
