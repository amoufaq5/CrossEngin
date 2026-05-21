# ADR-0167: `crossengin retention list-policies` CLI action (Phase 2 M6.7.zz.tenant.opt-out.cli.list)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0143 (M6.7.zz META_RETENTION_POLICIES), ADR-0155 (M6.7.zz.tenant META_TENANT_RETENTION_POLICIES), ADR-0164 (retention expiring CLI), ADR-0165 (retention effective CLI), ADR-0166 (retention opt-out/opt-in mutation CLI) |

## Context

ADRs 0164-0166 shipped four CLI actions: `expiring`, `effective`, `opt-out`, `opt-in`. The read side covered targeted queries (window-of-expiring + single (tenant, table) resolution), and the write side covered mutations. The remaining gap: **a broad audit query** — "show me every retention policy on the platform."

Compliance audits routinely answer questions like:
- Which tables have platform-default retention configured?
- Which tenants have per-tenant overrides?
- Which tenants are currently opted out (regardless of expiry window)?

Today operators write three SQL queries against `meta.retention_policies` + `meta.tenant_retention_policies`, mentally combine the results, and format for the auditor. The CLI should do this with one command.

The substrate-side methods already exist — `listPolicies()` and `listTenantPolicies()` on `PostgresTraceRetention`. This milestone adds the CLI surface.

## Decision

Add `list-policies` action to the `retention` subcommand:

```
crossengin retention list-policies [--tenant <uuid>] [--table <name>]
                                   [--format human|json]
```

Both flags are optional. Without filters, the command returns every platform policy and every per-tenant policy.

### Output sections

The command always emits **two sections** — platform defaults and per-tenant policies — each with an explicit `(N total)` count. Empty sections render as `(none configured)`. Operators get a complete picture in one glance, including the negative space ("no platform default for llm_call_traces means platform pruning is off").

### Filter semantics

- `--tenant <uuid>` scopes the **per-tenant** section to one tenant. Platform defaults remain visible (they apply to every tenant by default, so a tenant audit needs the platform context too).
- `--table <name>` scopes **both** sections to one table. Operators answering "what's the retention picture for workflow_traces?" filter once and see both sides.
- Both flags AND together.

Filter values appear in a `(filtered: tenant=..., table=...)` suffix on each section header so operators reading saved output remember the query parameters.

No filter-value validation against an allowlist — operators passing `--table=typo` see an empty result and notice their mistake. Matches the substrate's "doesn't prescribe" stance.

### Human output

```
Platform defaults (3 total):
  workflow_traces          90d      enabled    last pruned 2026-05-20T10:00:00.000Z
  llm_latency_samples      30d      enabled    last pruned never
  llm_call_traces          180d     disabled   last pruned never

Per-tenant policies (2 total):
  <tenant-uuid-A>  workflow_traces       365d     disabled  opt-out=yes (until 2027-01-01T00:00:00.000Z, reason: legal_hold:case#42)
  <tenant-uuid-B>  llm_call_traces       90d      enabled   opt-out=no
```

Per-tenant rows show one of three opt-out states:
- `opt-out=no` (normal per-tenant override)
- `opt-out=yes (until <iso>, reason: <reason>)` (active time-bound opt-out)
- `opt-out=yes (until indefinite, reason: <reason>)` (active indefinite opt-out)

Null `optOutReason` renders as `<no reason>` — consistent with `expiring` and `effective`.

### JSON output

```json
{
  "tenantFilter": null,
  "tableFilter": null,
  "platform": [
    { "tableName": "workflow_traces", "retentionDays": 90,
      "enabled": true, "lastPrunedAt": "2026-05-20T..." },
    ...
  ],
  "tenantPolicies": [
    { "tenantId": "...", "tableName": "...", "retentionDays": 365,
      "enabled": false, "optOut": true,
      "optOutReason": "legal_hold:case#42",
      "optOutUntil": "2027-01-01T00:00:00.000Z",
      "lastPrunedAt": null },
    ...
  ]
}
```

Echoes the filter values (or `null` for unset) so downstream consumers can confirm without re-parsing the command line.

### Parallel adapter calls

`listPolicies()` and `listTenantPolicies()` are independent queries — issued via `Promise.all` for one-round-trip wall-clock latency.

### Why client-side filtering vs adapter-side WHERE clauses

The adapter methods currently scan the full tables. Adding `WHERE` clauses would push filtering server-side; net win for very large policy tables. But:

1. Production policy-table sizes are bounded — `meta.retention_policies` has at most 3 rows (one per prunable table), `meta.tenant_retention_policies` has ≤ N tenants × 2 tables = ~2N rows. At 10K tenants, ~20K rows. PG returns this in milliseconds.
2. Adding optional filter args to the adapter methods would expand their signatures; the CLI is the only consumer that needs filtering.
3. The substrate keeps adapter methods simple; CLI does the filtering.

If operators with multi-region deployments report slow `list-policies` runs, the adapter methods can grow filter args additively in a future milestone.

### Why `list-policies` not `list`

Action names under `retention`:
- `expiring` (adjective; lists expiring opt-outs)
- `effective` (adjective; resolves effective policy)
- `opt-out` / `opt-in` (verbs; mutate state)
- `list-policies` (verb-object; lists policies)

`retention list` alone would be ambiguous — list what? Tenants? Opt-outs? The hyphenated `list-policies` is explicit and reserves namespace for future siblings like `list-tenants` (if needed; not planned) or `list-expirations` (alias for `expiring` — not adding).

Action-verb-object naming is established in adjacent CLI surfaces (e.g., `gateway routes register-pack`, `gateway routes unregister-pack`).

## Use cases unblocked

**1. One-command compliance audit**

```bash
$ crossengin retention list-policies
Platform defaults (3 total):
  workflow_traces       90d     enabled   last pruned 2026-05-20T10:00:00.000Z
  llm_latency_samples   30d     enabled   last pruned never
  llm_call_traces       180d    disabled  last pruned never

Per-tenant policies (5 total):
  <uuid-A>  workflow_traces  365d  disabled  opt-out=yes (until 2027-01-01T..., reason: legal_hold:case#42)
  <uuid-B>  workflow_traces  30d   enabled   opt-out=no
  ...
```

SOC 2 / HIPAA / 21 CFR 11 auditor gets the complete retention picture in one screenshot.

**2. Per-tenant retention summary**

```bash
$ crossengin retention list-policies --tenant <uuid>
Platform defaults (3 total) (filtered: tenant=<uuid>):
  ...

Per-tenant policies (2 total) (filtered: tenant=<uuid>):
  <uuid>  workflow_traces  365d  disabled  opt-out=yes (...)
  <uuid>  llm_call_traces  90d   enabled   opt-out=no
```

Customer-success agent answering "what's tenant X's retention?" sees both their overrides and the platform context they fall back to for unconfigured tables.

**3. Per-table compliance check**

```bash
$ crossengin retention list-policies --table workflow_traces
```

Compliance team auditing one table's deviations across all tenants.

**4. JSON export for compliance reports**

```bash
crossengin retention list-policies --format json > retention-snapshot-2026-q3.json
```

Quarterly snapshot saved alongside other compliance artifacts. The `lastPrunedAt` timestamp gives auditors a "was pruning actually running?" signal.

**5. CI sanity check**

```bash
DISABLED=$(crossengin retention list-policies --format json \
  | jq '.platform | map(select(.enabled == false)) | length')
if [[ $DISABLED -gt 0 ]]; then
  echo "⚠️ $DISABLED platform policy disabled" >&2
fi
```

CI fails if a platform policy got accidentally disabled.

## Drawbacks

1. **Two PG queries.** Independent + parallel, but two round-trips. A single JOIN-or-UNION query would halve the wall-clock time; deferred until measured.
2. **No pagination.** The current shape returns all rows. Bounded in practice (20K rows at 10K-tenant scale); operators with concerns chain `--tenant` / `--table` filters or pipe through `jq` / `head`.
3. **No sort flag.** Platform sorted by table_name (per adapter ORDER BY); per-tenant sorted by table_name, tenant_id. Operators wanting "sort by last_pruned_at DESC to find stale platforms" use `jq` on JSON output.
4. **Dual sections in JSON.** Downstream JSON consumers must handle both keys (`platform` + `tenantPolicies`). Flatter alternatives exist but conflate concerns; the two-section design matches the substrate's table topology.
5. **Filter validation absent.** `--table=typo` returns empty results without error. Could surface a helpful "did you mean..." hint; defer.
6. **No `lastPrunedAt` filter.** Operators wanting "policies not pruned in 7+ days" use `jq` on JSON output. A future `--stale-days N` flag could push the filter into the CLI; defer.

## Alternatives considered

1. **Single flat list mixing platform + per-tenant rows.** Rejected — operators reading the output have to mentally segment; the two-section design matches the substrate's table topology and operator mental model.
2. **`retention list` (no `-policies` suffix).** Rejected — too generic; ambiguous when sibling actions like `list-tenants` or `list-expirations` might be added.
3. **`retention policies` (noun-only).** Rejected — inconsistent with the action-verb pattern (`expiring`, `effective`, `opt-out`, `opt-in`).
4. **Adapter-side `WHERE` filtering.** Rejected this milestone — policy table is small enough that client-side filtering is fine; adapter signatures stay simple. Add if measured.
5. **JSON-only output (no human format).** Rejected — operators running ad-hoc audits at the terminal want readable output without `jq`.
6. **Built-in pagination flags (`--limit N` / `--offset N`).** Rejected — bounded data size; pipe through `head` / `jq` for ad-hoc subsetting.
7. **Single JOIN query at adapter level.** Rejected — `meta.retention_policies` and `meta.tenant_retention_policies` have orthogonal shapes (different PKs, different columns); UNION-ALL'ing them into a flat result would lose typed shape information. Two parallel queries preserve the discriminated structure.
8. **Sort flags `--sort table|tenant|days|pruned`.** Rejected — JSON output + `jq` covers it; CLI stays minimal.

## Open questions

1. **`--stale-days N` filter.** Show policies whose `last_pruned_at` is older than N days (or never). Useful for "is pruning actually running?" CI gates. Defer.
2. **`--opt-out-only` filter.** Restrict per-tenant section to opt-outs only. Defer — `jq '[.tenantPolicies[] | select(.optOut == true)]'` covers it.
3. **`--include-history` flag.** Combine current state with the future ADR-0161-alt-1 history table. Pairs with the deferred history-table milestone.
4. **Adapter-side filtering.** Add optional `tenantId` / `tableName` args to `listPolicies` / `listTenantPolicies`. Defer until measured slow.
5. **Sort flags.** `--sort table|tenant|days|pruned`. Defer.
6. **Column-selection flag.** `--columns tenant,table,days` to drop unneeded columns in human output. Defer; rarely needed.
7. **Aggregation flag.** `--summary` to emit counts by status (enabled platforms, disabled platforms, opt-out tenants, etc.) instead of the full row list. Defer.
8. **CSV format.** `--format csv` for spreadsheet exports. Defer — `jq -r '.platform[] | [.tableName, .retentionDays] | @csv'` covers ad-hoc cases.
