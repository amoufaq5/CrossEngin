# ADR-0182: `crossengin retention effective-batch --pairs-file` CLI exposure (Phase 2 M6.7.zz.tenant.opt-out.cli.effective-batch)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0159 (effectiveRetention), ADR-0177 (effectiveRetentionBatch substrate), ADR-0165 (retention effective CLI) |

## Context

ADR-0177 shipped `effectiveRetentionBatch(pairs)` as a substrate-only milestone — the substrate gained a 2-query batch read API for dashboard performance, but operators wanting ad-hoc bulk lookups had to write Node scripts calling the adapter directly. ADR-0177 listed Q1 as:

> Q1: CLI retention effective-batch --pairs-file <file> for ad-hoc batch lookups reading CSV/JSON.

Use cases pile up:
- Compliance audit: "show effective retention for every tenant on this watchlist across these tables"
- Migration verification: "did all tenants in cohort X end up with the expected retention?"
- Periodic snapshot: "what was every active tenant's resolution at this hour?" feeding into a spreadsheet
- Reconciliation: "compare retention list (from upstream system) against actual substrate state"

Without a CLI surface, every operator builds their own Node script. M6.7.zz.tenant.opt-out.cli.effective-batch closes that gap.

## Decision

### CLI surface

```
crossengin retention effective-batch --pairs-file <path>
                                     [--format human|json]
```

`--pairs-file <path>` is the only required flag. No positional args (the pairs file IS the input).

### Input format: JSON only for v1

The pairs file contains a JSON array of `{tenantId, tableName}` objects:

```json
[
  {"tenantId": "00000000-...", "tableName": "workflow_traces"},
  {"tenantId": "11111111-...", "tableName": "llm_call_traces"},
  {"tenantId": "00000000-...", "tableName": "tenant_retention_opt_out_history"}
]
```

CSV deferred to future Q. Three reasons:
1. **Operators generating the pairs file from another command get JSON for free** — e.g., `crossengin retention list-policies --format json | jq '[.tenantPolicies[] | {tenantId, tableName}]' > pairs.json`.
2. **Type safety** — JSON's typed null + boolean + string + number maps cleanly to the adapter's `EffectiveRetentionBatchPair` shape; CSV needs per-field type inference + quoting rules.
3. **Smaller substrate surface for v1** — operators wanting CSV convert with one-liner `jq -R 'split(",") | {tenantId: .[0], tableName: .[1]}'` or similar; we can add native CSV support when measured demand.

### Validation at CLI boundary

Layered validation with explicit error messages:

| Failure | Exit | Message anchor |
|---|---|---|
| `--pairs-file` flag missing | 2 | `missing --pairs-file` |
| File doesn't exist / unreadable | 1 | `failed to read '<path>': <reason>` |
| File is not valid JSON | 2 | `'<path>' is not valid JSON: <reason>` |
| JSON is not an array | 2 | `must be a JSON array of {tenantId, tableName} objects` |
| Entry at index N is not an object | 2 | `entry at index N is not an object` |
| Entry missing `tenantId` | 2 | `entry at index N missing or empty tenantId (string)` |
| Entry missing `tableName` | 2 | `entry at index N missing or empty tableName (string)` |

Index-aware error messages so operators with a 1000-pair file find the bad entry by line number.

Exit code 1 reserved for runtime errors (file I/O, adapter throws); exit 2 for misuse (missing flag, invalid JSON shape).

### Output ordering: preserve input order, include duplicates

The adapter (`effectiveRetentionBatch`) deduplicates pairs internally — returns a `ReadonlyMap` keyed by `effectiveRetentionKey(tenantId, tableName)`. The CLI iterates the ORIGINAL input pairs and looks up each in the Map, emitting one output row per input entry. Duplicates in input → duplicates in output.

Three reasons:
1. **1:1 input/output contract** — operators reading the output count rows expecting their input count.
2. **Predictable ordering** — input order is preserved without sorting.
3. **Duplicate visibility** — operators with accidental duplicates see them in the output (rather than silent deduplication).

The adapter is still called with the original pairs list (not deduplicated); the adapter does internal deduplication for the queries, but the CLI doesn't pre-deduplicate before calling.

### Output format

**Human:**

```
Effective retention for 3 pair(s):
  <tenant-a>  workflow_traces      source=tenant         retention=30d  enabled=yes
  <tenant-a>  llm_call_traces      source=platform       retention=90d  enabled=yes
  <tenant-b>  workflow_traces      source=none           (no policy configured)
```

Empty input:

```
Effective retention for 0 pair(s): (empty input)
```

Per-pair line: `<tenantId>  <tableName-padded-to-20>  <summary>`. Summary line via internal `summarizeBatchResolution` helper covering the 4 resolution variants (tenant / tenant_opt_out / platform / none) with the established `indefinite` / `<no reason>` / `(no policy configured)` conventions.

**JSON:**

```json
{
  "action": "effective-batch",
  "count": 3,
  "results": [
    {
      "tenantId": "...",
      "tableName": "workflow_traces",
      "resolution": { "source": "tenant", "retentionDays": 30, "enabled": true, "tenantId": "..." }
    },
    ...
  ]
}
```

`count` field echoes `results.length` for jq filters that want a quick scalar without traversing the array.

### Pure CLI wrap

The adapter (`PostgresTraceRetention.effectiveRetentionBatch`) is unchanged. No new types in `@crossengin/kernel-pg`. Pure CLI delivery — same pattern as ADR-0174 (`retention prune` wrapping prune/previewPrune), ADR-0181 (`--exit-on-divergence` CLI flag).

### No max-pairs limit at CLI boundary

Operators are local; if they want 100K pairs, PG's IN-list size limit (or the deferred ADR-0177 chunking Q) is the constraint. CLI doesn't second-guess. Documented in helpText.

## Use cases unblocked

**1. Compliance audit across watchlist**

```bash
crossengin retention effective-batch \
  --pairs-file watchlist.json --format json | \
  jq '[.results[] | select(.resolution.source == "tenant_opt_out")] | length'
```

Counts how many watchlist tenants are currently in active opt-out.

**2. Migration verification**

```bash
# Generate expected pairs file
jq '[.tenants[] | {tenantId: .id, tableName: "workflow_traces"}]' \
  cohort.json > expected.json

# Verify
crossengin retention effective-batch \
  --pairs-file expected.json --format json | \
  jq '.results[] | select(.resolution.source != "tenant" or .resolution.retentionDays != 365)'
```

Lists tenants whose effective retention is NOT the expected `tenant=365d`.

**3. Spreadsheet export**

```bash
crossengin retention effective-batch \
  --pairs-file tenant-table-watchlist.json --format json | \
  jq -r '.results[] | [.tenantId, .tableName, .resolution.source, .resolution.retentionDays] | @csv' \
  > snapshot.csv
```

CSV export for downstream BI tools.

**4. Reconciliation against upstream tier system**

```bash
diff <(crossengin retention effective-batch --pairs-file from-substrate.json --format json | \
       jq -S '.results | sort_by(.tenantId, .tableName)') \
     <(crossengin retention effective-batch --pairs-file from-upstream.json --format json | \
       jq -S '.results | sort_by(.tenantId, .tableName)')
```

Diffs the substrate's view against an upstream system's expected view.

## Drawbacks

1. **JSON-only input (no CSV in v1).** Operators with CSV must convert. Documented; CSV support deferred to future Q.
2. **No streaming output.** All pairs are resolved + held in memory; for very large inputs (>100K pairs) operators see latency. Bounded by the deferred ADR-0177 chunking Q — for now, not a problem at typical scales.
3. **No per-pair validation against PRUNABLE_TABLES allowlist.** Operators passing unknown table names get `source: "none"` for those entries — surfaces typos but not as an error. Matches `retention effective` non-validation stance.
4. **No deduplication in CLI output** even though adapter deduplicates for queries. Operators with accidentally-duplicated input pairs see duplicates in output. By design (1:1 contract) but may confuse operators expecting deduplication.
5. **Output ordering preserves input** — operators wanting sorted output use `jq` on JSON or `sort` on tabular text. No `--sort` flag yet.
6. **File-based input only.** No `--pairs <json>` inline arg or stdin support. Operators with one-off ad-hoc queries write to a temp file. Future Q.

## Alternatives considered

1. **Support stdin via `--pairs-file -`** — adds platform-specific stdin handling; defer until requested.
2. **Inline `--pairs '[...]'` flag** — flag-value-as-JSON gets unwieldy past 2-3 pairs; file is the right scale boundary.
3. **CSV support in v1** — adds tokenizer + quoting + type-inference complexity; defer.
4. **Auto-detect file format by extension** — magic; explicit `--pairs-file` + JSON-only contract is simpler. Deferred.
5. **Deduplicate output to match adapter's internal dedup** — breaks 1:1 input/output contract; operators preferring dedup wrap with `jq '.results | unique'`. Rejected.
6. **Return adapter Map shape directly as JSON object** (`{"<tenantId>:<tableName>": {resolution}}`) — JSON object property ordering is implementation-defined + colon-as-key-separator is fragile; array of records is cleaner. Rejected.
7. **Pre-deduplicate before calling adapter** — adapter already dedupes; CLI dedup is redundant. Rejected.
8. **Add `--max-pairs N` validation at CLI boundary** — operator policy choice; PG IN-list limit is the real constraint; CLI doesn't second-guess. Rejected.
9. **Auto-chunk large inputs** — deferred to ADR-0177 Q2 substrate work; not a CLI concern.

## Open questions

1. **CSV input format** — operators with CSV pipes; add when measured demand.
2. **Stdin support via `--pairs-file -`** — operators wanting `... | crossengin retention effective-batch --pairs-file -` shell pipelines. Defer.
3. **Inline `--pairs '[...]'`** for one-off queries.
4. **`--sort` flag** for output sorted by tenantId / tableName / source / retentionDays.
5. **`--include-only <source>` filter** — exit-on-zero-matches as a CI gate (similar to ADR-0181's `--exit-on-divergence`).
6. **Auto-chunking for >10K pairs** — pairs with ADR-0177 Q2 substrate work.
7. **Pretty-printed JSON output** (currently single-line). Defer — jq covers.
8. **Per-pair source-attribution from `PostgresCostCeilingResolver.resolveDetailed` style** — return the tier/override/global signal alongside the resolution. Different substrate; separate ADR if requested.
