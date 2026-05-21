# ADR-0179: `crossengin retention diff --vs-platform` tenant-vs-default comparison (Phase 2 M6.7.zz.tenant.opt-out.cli.diff.vs-platform)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0159 (effectiveRetention), ADR-0165 (retention effective CLI), ADR-0177 (effectiveRetentionBatch), ADR-0178 (retention diff cross-tenant) |

## Context

ADR-0178 shipped `retention diff <tenant-a> <tenant-b> <table>` for cross-tenant comparison and listed `--vs-platform` (compare one tenant against the platform default) as Q1. Operators kept hitting it immediately after running the first `retention diff`: "I have one tenant — I just want to see how it differs from the default."

Current workarounds — `retention effective <tenant> <table>` + a separate query against the platform table or a second `retention effective` against a tenant without overrides — are mental-diff heavy and have no JSON envelope for downstream tooling.

M6.7.zz.tenant.opt-out.cli.diff.vs-platform closes ADR-0178 Q1.

## Decision

### CLI surface

```
crossengin retention diff <tenant> <table-name> --vs-platform
                          [--format human|json]
```

- `--vs-platform` is a boolean flag on the existing `diff` action — no new top-level action.
- When `--vs-platform` is set, the diff dispatcher branches BEFORE positional-arg validation. It expects 2 positional args (tenant + table) instead of 3.
- Without `--vs-platform`, the existing cross-tenant `diff <tenant-a> <tenant-b> <table>` path is unchanged.

### Adapter

New method `diffTenantVsPlatform` on `PostgresTraceRetention`:

```ts
export interface DiffTenantVsPlatformInput {
  readonly tenantId: string;
  readonly tableName: string;
}

export interface DiffTenantVsPlatformResult {
  readonly tenantId: string;
  readonly tableName: string;
  readonly tenantResolution: EffectiveRetentionResolution;
  readonly platformResolution: EffectiveRetentionResolution;
  readonly fieldDiffs: ReadonlyArray<HistoryEntryFieldDiff>;
}

async diffTenantVsPlatform(
  input: DiffTenantVsPlatformInput,
): Promise<DiffTenantVsPlatformResult>;
```

### Implementation: two parallel queries

ADR-0178's `diffTenantPolicies` reused `effectiveRetentionBatch` because both pairs needed full resolution. Here we want BOTH the tenant's effective resolution AND the platform-default resolution, regardless of whether the tenant has a per-tenant policy. `effectiveRetentionBatch` would return only the resolved value (tenant's, possibly already fallen-through to platform) — losing the distinction we need to surface.

Instead: 2 parallel queries via `Promise.all` — one against `meta.tenant_retention_policies`, one against `meta.retention_policies`. Both fire in the same tick.

Algorithm:

1. Query both tables in parallel.
2. Build `platformResolution` directly from the platform row (or `{source: "none", ...}` when absent).
3. Build `tenantResolution` using the same logic as `effectiveRetention` (opt-out active → `tenant_opt_out`, enabled → `tenant`, otherwise → fall back to the platformResolution we already built).
4. Compute `fieldDiffs` via the existing `computeFieldDiffs(normalize(tenantResolution), normalize(platformResolution))` from ADR-0173.

Total cost: 2 queries, single wall-clock round-trip. Same `this.clock()` source as `effectiveRetention` for opt-out expiry boundary semantics.

### Why not reuse `effectiveRetentionBatch`?

Because the batch resolver returns the EFFECTIVE resolution per pair — meaning when the tenant has no per-tenant policy, the result is already the platform-fallback value. Operators wanting to know "is this tenant on the platform default or has an override?" lose that signal. The `--vs-platform` workflow explicitly wants BOTH sides regardless of fallback, so direct parallel queries are simpler than composing on top of `effectiveRetentionBatch`.

This is the FIRST adapter method in the retention substrate that doesn't compose on top of `effectiveRetention` / `effectiveRetentionBatch`. The composition pattern from ADR-0177/0178 still holds for cases where the resolved value is what callers want; this case is the documented exception.

### Output format

**Human:**

```
Diff between tenant and platform default (table: workflow_traces):
  Tenant:   <uuid>  source=tenant         retention=30d  enabled=yes
  Platform: source=platform       retention=90d  enabled=yes

Field changes (2):
  retention_days       30  →  90
  source               "tenant"  →  "platform"
```

When no differences:

```
Diff between tenant and platform default (table: workflow_traces):
  Tenant:   <uuid>  source=platform       retention=90d  enabled=yes
  Platform: source=platform       retention=90d  enabled=yes

No differences — tenant has the same effective retention policy as the platform default.
```

Per-tenant resolution summary line reuses the shared `summarizeResolutionForDiff` helper from ADR-0178 — same 4-variant rendering (`tenant` / `tenant_opt_out` / `platform` / `none`). Same `indefinite` / `<no reason>` conventions for null fields.

The platform row omits a tenantId column — platform policy isn't tenant-scoped. Tenant row prefixes with the queried tenantId.

**JSON:**

```json
{
  "action": "diff",
  "vsPlatform": true,
  "result": {
    "tenantId": "...",
    "tableName": "workflow_traces",
    "tenantResolution": { "source": "tenant", ... },
    "platformResolution": { "source": "platform", ... },
    "fieldDiffs": [...]
  }
}
```

`vsPlatform: true` is the JSON-envelope discriminator distinguishing this from the cross-tenant variant from ADR-0178. Operators parsing JSON output use it to pick which fields to expect (`tenantId` + `tenantResolution` + `platformResolution` here vs `tenantIdA` + `tenantIdB` + `resolutionA` + `resolutionB` for cross-tenant).

## Use cases unblocked

**1. "Is this tenant on the default?"**

```bash
crossengin retention diff <tenant> workflow_traces --vs-platform
```

One command answers the question; JSON output's `fieldDiffs: []` is the machine-readable "no, same as default" signal.

**2. Compliance audit "show every deviation from default"**

```bash
for tenant in $(crossengin retention list-policies --format json | jq -r '.tenantPolicies[].tenantId'); do
  crossengin retention diff "$tenant" workflow_traces --vs-platform --format json
done | jq 'select(.result.fieldDiffs | length > 0)'
```

Surfaces only tenants whose effective retention deviates from the platform default. Auditors get a clean list.

**3. Tier migration verification (vs default tier)**

```bash
crossengin retention diff <newly-migrated-tenant> workflow_traces --vs-platform --format json | \
  jq '.result.tenantResolution.source'
```

Returns `"platform"` if migration succeeded (tenant inherits default), `"tenant"` or `"tenant_opt_out"` if a per-tenant policy still applies.

**4. Pre-deletion safety check**

```bash
crossengin retention diff <tenant> workflow_traces --vs-platform
# operator sees "Field changes (N)" — knows deletion will revert to platform default
crossengin retention delete <tenant> workflow_traces
# confirmed semantic
```

## Drawbacks

1. **Single-flag overload on `diff` action.** The `diff` action now has two arg shapes (3 positionals or 2 positionals + flag). Operators reading help may not immediately notice. Mitigated by separate usage line in helpText.
2. **Doesn't compose on `effectiveRetentionBatch`.** ADR-0178 set the precedent that diff operations compose on the batch resolver; this milestone breaks that pattern because the batch resolver hides the "tenant vs platform" distinction. Documented as the exception, not the rule.
3. **2 queries always.** No short-circuit when tenant has no per-tenant policy (we always query both anyway). Same query count as `effectiveRetention` when it falls through to platform, so no regression.
4. **No `--vs-tier` companion.** Operators wanting "tenant vs their tier default" run `retention diff` against a reference tenant on the same tier instead. Future Q if requested.
5. **Discriminated JSON shape.** Operators parsing JSON envelope now have two diff shapes — `result.{tenantIdA, tenantIdB, resolutionA, resolutionB}` (ADR-0178) and `result.{tenantId, tenantResolution, platformResolution}` (this). The `vsPlatform: true` envelope discriminator addresses it, but operators still write 2 jq branches.

## Alternatives considered

1. **New action `retention diff-platform <tenant> <table>`** — cleaner separation but adds CLI surface, divides the diff vocabulary across two action names. Rejected — operators learn `--vs-platform` more naturally than a new action name.
2. **Use a sentinel `--platform` token in tenant-b position** (`retention diff <tenant> --platform <table>`) — magical flag-in-positional-arg; harder to parse and document. Rejected.
3. **Always 3 positionals + `--vs-platform` ignores 3rd** — error-prone; operators may pass real tenant ids that get silently ignored. Rejected.
4. **Compose on `effectiveRetentionBatch` with sentinel tenant** — would require a fake tenant id known to not exist; semantically awkward + relies on a query short-circuit; doesn't return the platform resolution as a separate field anyway. Rejected.
5. **Return only the platform resolution + fieldDiffs (no tenantResolution echo)** — operators rendering output would re-query for the tenant side; redundant. Rejected — both sides in the result is cheap (no extra query, just 2 fields).
6. **Implicit fallback when only 2 positionals given to `diff`** — operators forgetting tenant-b would get this behavior instead of an error; surprising. Rejected — explicit flag is clearer.
7. **`retention vs-default <tenant> <table>`** as standalone action — diverges from established `diff-*` naming. Rejected.
8. **JSON envelope with same shape as cross-tenant diff** (use tenantIdA + tenantIdB with B = "platform" string sentinel) — type pollution + operators discriminating on sentinel string instead of typed discriminator. Rejected.

## Open questions

1. **`--vs-tier <tier-id>` flag for "tenant vs their tier default."** Defer — requires tier-substrate aware resolution.
2. **`--all-tables` for one-tenant-vs-platform across every prunable table.** Defer — chain via shell loop.
3. **Combined `retention diff <tenant>` (default to `--vs-platform`) without flag.** Considered for ergonomics — rejected because explicit is clearer; operators discovering the action via help see all variants.
4. **Render diff as table format (jq covers but human eyes scan tables faster).** Defer.
5. **Bulk variant `retention diff --bulk file.csv --vs-platform` for many tenants in one call.** Defer — shell loops cover; per-call overhead bounded.
6. **`--exit-on-divergence` for CI gates that fail when tenant differs from platform.** Defer — operators wrap with `jq .result.fieldDiffs | length` + `[ "$N" -eq 0 ]`.
7. **JSON envelope unification with cross-tenant diff via tagged union shape** (e.g., `{kind: "vs-tenant", ...}` / `{kind: "vs-platform", ...}`). Would simplify operator jq scripts but break backward compat with M6.7.zz.tenant.opt-out.cli.diff JSON envelope from ADR-0178. Defer — `vsPlatform: true` discriminator is sufficient.
