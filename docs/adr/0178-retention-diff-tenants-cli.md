# ADR-0178: `crossengin retention diff` cross-tenant policy comparison (Phase 2 M6.7.zz.tenant.opt-out.cli.diff)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0165 (retention effective CLI), ADR-0173 (retention diff-history CLI), ADR-0177 (effectiveRetentionBatch) |

## Context

ADR-0173 / M6.7.zz.tenant.opt-out.cli.diff-history shipped `retention diff-history <id-a> <id-b>` for comparing two history events on the same (tenant, table). ADR-0165 Q6 asked for the orthogonal axis:

> Q6: Comparison query. `retention diff <tenant-a> <tenant-b> <table>` showing policy differences between two tenants. Useful for tier migration verification. Defer until requested.

Use cases for cross-tenant comparison:

- **Tier migration verification**: "Did Tenant A (recently moved to enterprise) end up with the same effective retention as Tenant B (already on enterprise)?"
- **Drift detection**: "Two tenants on the same plan — are their policies divergent due to drift?"
- **Compliance audit**: "Why is Tenant A retaining 365 days while Tenant B (same regulated cohort) retains 90?"

Currently operators run `retention effective <tenant-a> <table>` twice and mentally compare. The substrate has the perfect primitive — `effectiveRetentionBatch` from ADR-0177 — for a one-command diff.

M6.7.zz.tenant.opt-out.cli.diff closes Q6.

## Decision

### Adapter

```ts
export interface DiffTenantPoliciesInput {
  readonly tenantIdA: string;
  readonly tenantIdB: string;
  readonly tableName: string;
}

export interface DiffTenantPoliciesResult {
  readonly tenantIdA: string;
  readonly tenantIdB: string;
  readonly tableName: string;
  readonly resolutionA: EffectiveRetentionResolution;
  readonly resolutionB: EffectiveRetentionResolution;
  readonly fieldDiffs: ReadonlyArray<HistoryEntryFieldDiff>;
}

async diffTenantPolicies(
  input: DiffTenantPoliciesInput,
): Promise<DiffTenantPoliciesResult>;
```

### Implementation: reuse `effectiveRetentionBatch`

The adapter calls `effectiveRetentionBatch({pairs: [{tenantIdA, tableName}, {tenantIdB, tableName}]})` — 2 queries total (one tenant lookup, one platform lookup with single table). Looks up both resolutions from the returned Map via the exported `effectiveRetentionKey` helper.

This is the single canonical batch-resolver pattern: any future comparison/aggregation operation that needs multiple resolutions should compose on top of `effectiveRetentionBatch` rather than issuing its own queries.

### Diff computation

The diff compares the two `EffectiveRetentionResolution` values' POLICY STATE, not the discriminated-union shape directly. New helper `normalizeResolutionForDiff(resolution)` flattens each variant to a comparable record:

```ts
function normalizeResolutionForDiff(r: EffectiveRetentionResolution) {
  const base = {
    source: r.source,
    retention_days: r.retentionDays,
    enabled: r.enabled,
    opt_out: r.source === "tenant_opt_out",
  };
  if (r.source === "tenant_opt_out") {
    base.opt_out_reason = r.optOutReason;
    base.opt_out_until = r.optOutUntil;
  }
  return base;
}
```

Then reuse the existing `computeFieldDiffs(normalizedA, normalizedB)` helper from ADR-0173 — same JSON.stringify deep comparison, same alphabetical-sort output. Operators see a uniform diff format across `retention diff-history` and `retention diff`.

### Same-table constraint

The diff compares two tenants on the **same table**. The result type carries a single `tableName`. Refusing cross-table comparisons keeps the semantic clear: "different tenants, same policy axis."

Future cross-axis operations (e.g., "what's tenant A's workflow_traces policy vs llm_call_traces policy?") are different concerns; a separate action could ship if requested.

### CLI

```
crossengin retention diff <tenant-a> <tenant-b> <table-name>
                          [--format human|json]
```

Three positional args required (exit 2 missing). No optional flags beyond `--format`.

**Human format:**

```
Diff between tenant policies (table: workflow_traces):
  Tenant A: <uuid>  source=tenant         retention=30d  enabled=yes
  Tenant B: <uuid>  source=platform       retention=90d  enabled=yes

Field changes (2):
  retention_days       30  →  90
  source               "tenant"  →  "platform"
```

When no differences:

```
Diff between tenant policies (table: workflow_traces):
  Tenant A: <uuid>  source=platform       retention=90d  enabled=yes
  Tenant B: <uuid>  source=platform       retention=90d  enabled=yes

No differences — both tenants have the same effective retention policy.
```

Per-tenant resolution summary line varies by variant via private `summarizeResolutionForDiff(r)` helper:

- `tenant` → `source=tenant         retention=Nd  enabled=yes`
- `tenant_opt_out` → `source=tenant_opt_out  reason=<reason>  until=<iso|indefinite>`
- `platform` → `source=platform       retention=Nd  enabled=yes|no`
- `none` → `source=none           (no policy configured)`

Uses the established conventions: `indefinite` for null `optOutUntil`, `<no reason>` for null `optOutReason`.

**JSON format:**

```json
{
  "action": "diff",
  "result": {
    "tenantIdA": "...",
    "tenantIdB": "...",
    "tableName": "workflow_traces",
    "resolutionA": { "source": "tenant", ... },
    "resolutionB": { "source": "platform", ... },
    "fieldDiffs": [...]
  }
}
```

Full structure preserved for downstream `jq`. The discriminated-union resolutions stay typed.

## Use cases unblocked

**1. Tier migration verification**

```bash
crossengin retention diff <migrated-tenant> <reference-tenant> workflow_traces
```

Operator confirms a freshly-migrated tenant has the same effective policy as a reference enterprise-tier tenant.

**2. Drift detection across same-tier tenants**

```bash
crossengin retention diff <tenant-1> <tenant-2> llm_call_traces
```

Two free-tier tenants should have identical resolutions; diff highlights drift.

**3. Compliance audit**

```bash
crossengin retention diff <hipaa-tenant> <reference-hipaa-tenant> workflow_traces --format json | \
  jq '.result.fieldDiffs'
```

Compliance team verifies HIPAA-cohort tenants match reference.

**4. Migration-script smoke test**

```bash
DIFF=$(crossengin retention diff <a> <b> workflow_traces --format json)
if echo "$DIFF" | jq -e '.result.fieldDiffs | length > 0'; then
  echo "❌ tenants diverged after migration"
  exit 1
fi
```

CI gate that fails the build when two tenants in the same cohort end up divergent.

## Drawbacks

1. **Same-table only.** Cross-table comparisons (`workflow_traces` vs `llm_call_traces` for one tenant) require a different command. Operators wanting that use two `retention effective` calls + manual compare.
2. **Two-tenant only.** Operators wanting n-way comparisons run multiple `diff` commands or write a Node script using `effectiveRetentionBatch` directly.
3. **No diff against current platform state.** Operators wanting "diff this tenant vs the platform default for this table" use `retention effective` twice (or against `none`). A future `--vs-platform` flag could close this.
4. **Discriminated-union JSON shape.** Operators using `jq` on `result.resolutionA` need to discriminate on `.source` — the typed shape requires it but adds steps.
5. **Field renames in the normalized diff.** `retentionDays` becomes `retention_days` in the diff to match the JSONB convention from history diffs. Consistent across diff outputs but different from the resolution's TypeScript field name.

## Alternatives considered

1. **Issue two `effectiveRetention` calls** instead of one `effectiveRetentionBatch`. Rejected — 4 queries vs 2; the batch resolver exists exactly for this composition.
2. **Compare resolutions via deep-equality without normalization.** Rejected — the discriminated-union shape differs across variants (e.g., `tenant_opt_out` carries `optOutReason`, others don't); operators would see "all fields different" when really only some fields are present.
3. **Allow cross-table comparison** (`<tenant-a> <table-a> <tenant-b> <table-b>`). Rejected — different semantic; if operators need it, a future `retention diff-cross` action.
4. **N-way diff (`<tenant-a> <tenant-b> <tenant-c> <table>`).** Rejected — pair-wise diff is the canonical pattern; operators chain commands for n-way.
5. **`--vs-platform` shortcut.** Considered for "diff this tenant vs platform default." Rejected this milestone — operators run two `effective` commands; defer for if requested.
6. **Use `retention effective-batch` (a deferred CLI) for the inputs.** Rejected — `retention diff` should be a focused single-purpose command; batch CLI is for ad-hoc bulk lookups, not pair comparisons.
7. **Render resolution variant fields without normalization.** Rejected — diff would show "different fields exist on each side" without telling operators which values differ. Normalization makes the diff actionable.
8. **Include tenant metadata (slug, display name) in the result.** Rejected — substrate stays minimal; operators join with `meta.tenants` at their layer.

## Open questions

1. **`--vs-platform` flag for tenant-vs-default comparison.** Defer.
2. **N-way diff via `--add-tenant <uuid>` repeated flag.** Defer.
3. **`retention diff <tenant> <table-a> <table-b>` for cross-table within one tenant.** Defer — different semantic.
4. **Visual color highlighting via opt-in flag.** Defer — substrate stays terminal-emoji-free; operators pipe to delta.
5. **Configurable comparison depth.** Defer — flat policy shape doesn't have nested fields in practice.
6. **`--field <name>` filter.** Defer — `jq` covers it on JSON output.
7. **Combined diff timeline (`retention diff-timeline` showing how A vs B evolved over time).** Defer — heavy semantic; build only if operators ask.
