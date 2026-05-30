# ADR-0287: `tenant policies` N-way comparison (`--add-tenant` + repeated `--vs-tier`)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0282 Q1 + ADR-0286 Q1 (closes), ADR-0282 (--diff), ADR-0286 (--vs-tier), ADR-0285 (CSV/TSV) |

## Context

ADR-0282 deferred Q1 was "N-way diff with
--add-tenant repeated flags: useful for
cohort verification but exit-code semantics
get muddy (which pair trips divergence?)."
ADR-0286 deferred Q1 was the same shape for
the synthetic-RHS path: "N-way --vs-tier
free --vs-tier pro --vs-tier enterprise for
multi-tier preview matrix. Pairs with ADR-
0282 Q1 (N-way --diff). Both share the
'what's the exit code semantic with
multiple comparisons?' problem."

Real workflows driving the change:

1. **Post-migration cohort uniformity
   sampling** — auditor verifying that
   tenants `acme-prod`, `staging`, `dev`
   all received the same retention policy
   after a migration runs `tenant policies
   acme-prod --diff staging --add-tenant
   dev --exit-on-divergence` to gate the
   release.
2. **Multi-tier preview matrix** — operator
   evaluating which tier best fits a tenant
   runs `tenant policies acme-prod
   --vs-tier free --vs-tier pro --vs-tier
   enterprise --effective` to see the
   effective ceiling at each candidate tier.
3. **CI compliance gates** — gate `tenant
   policies anchor --diff cohort-a
   --add-tenant cohort-b --add-tenant
   cohort-c --exit-on-divergence` to catch
   ANY cohort drift.

## Decision

Add `--add-tenant <slug|uuid>` repeatable
flag (requires `--diff`) for tenant-vs-
tenant N-way comparison. Allow `--vs-tier
<tier-id>` to repeat for synthetic-RHS
N-way comparison. Exit code = max-
divergence across all comparisons.
Envelope shape switches when N>1.

### Repeatable-flag shape

- `--diff <other>` (single, M4.14.f shape)
  + `--add-tenant <other>` (zero or more)
  → N = 1 + count(--add-tenant)
  comparisons against the anchor.
- `--vs-tier <tier-id>` (one or more) → N
  comparisons; each tier is a separate
  synthetic RHS.

Mutual-exclusivity:
- `--add-tenant` requires `--diff` (the
  first RHS comes from `--diff`;
  `--add-tenant` adds more).
- `--add-tenant` + `--vs-tier` rejected
  (tenant-vs-tenant and tenant-vs-tier
  comparisons can't mix in one envelope).
- `--diff` + `--vs-tier` already rejected
  from ADR-0286.
- `--explain` + `--vs-tier` already
  rejected from ADR-0286; `--explain` +
  `--diff` already rejected from ADR-0283.

### Envelope shape switching

**Single comparison (N=1)**: preserves
the M4.14.f / M4.14.b envelope:

```json
{
  "action": "tenant.policies.diff",
  "left": { ... },
  "right": { ... },
  "fieldDiffs": [ ... ]
}
```

**Multi comparison (N>1)**: new envelope:

```json
{
  "action": "tenant.policies.diff.multi",
  "anchor": { ... },
  "comparisons": [
    { "right": { ... }, "fieldDiffs": [...] },
    { "right": { ... }, "fieldDiffs": [...] }
  ]
}
```

Different `action` names so consumers
parsing `tenant.policies.diff` stay
unchanged; new consumers handle
`tenant.policies.diff.multi`
explicitly.

### CSV/TSV layout

Single-comparison: existing M4.14.c
shape (8 columns, one row per fieldDiff).

Multi-comparison: prepends a
`comparison_index` column (0..N-1):

```
comparison_index,tenant_a_id,tenant_a_input,
tenant_b_id,tenant_b_input,axis,field,
value_a,value_b
```

Operators reading the CSV in pandas
group by `comparison_index` to per-pair-
analyze; in Excel they filter the
column. Empty-fieldDiffs across all
comparisons still emits header-only
(valid CSV).

### Human render

Multi-comparison emits one section per
comparison, each using the existing
`renderPoliciesDiffHuman` shape so the
per-comparison layout matches what
operators see in single mode:

```
Multi-comparison tenant policies (anchor: ...):

=== Comparison 1/N ===
Diff between tenant policies:
  Left:  ...
  Right: ...
  Field changes (...):
    ...

=== Comparison 2/N ===
...
```

### Max-divergence exit code

`diffDivergenceExitCode(command,
maxFieldDiffsLength)` where
`maxFieldDiffsLength = max(c.fieldDiffs.length
for c in comparisons)`. Any single
comparison's diff count ≥ threshold
trips exit 3.

Why max instead of sum:
- Sum exits 3 even when only ONE
  comparison trips (correct), but the
  semantic of "did ANY drift?" is
  cleaner than "is the cumulative drift
  large?"
- Operators gating on "no cohort
  drifted" naturally express it as
  "max diff count >= 1"; the threshold
  flag accepts a per-comparison
  threshold not a total.

### Duplicate-target guards

- Multiple `--diff` / `--add-tenant`
  targets resolving to the SAME
  tenantId → exit 2 with "appears in
  multiple RHS slots". Avoids
  tautological comparisons.
- Multiple `--vs-tier` flags with the
  same tier-id → exit 2 with "appears
  in multiple --vs-tier slots". Same
  guard semantic.
- Anchor (LHS) matching any RHS slot
  still triggers the existing M4.14.f
  self-diff guard but with an updated
  message naming which RHS slot
  ("right 2" etc. when N>1).

### Test injection

Reuses existing fixtures. Test data
extended with `tierDefinitions` keyed
by tier-id (already added in M4.14.b)
+ a new `TENANT_C` UUID for 3-way
cohort tests.

### CLI help text

Extended the existing `tenant policies`
block with a 10-line paragraph
documenting the `--add-tenant`
repeatable flag, the repeated
`--vs-tier`, the multi-comparison
envelope name, the `comparison_index`
column, the max-divergence exit code,
and the duplicate-target rejection.

## Rejected alternatives

1. **Default to multi-comparison
   envelope even when N=1** — would
   break every existing JSON consumer
   parsing `tenant.policies.diff`.
   Backward compat dominates.

2. **`--add-tenant` works without
   `--diff` (anchor + just
   `--add-tenant`)** — ambiguous which
   one is "RHS". The `--diff` flag
   anchors the first RHS explicitly;
   `--add-tenant` adds. Cleaner
   mental model.

3. **Sum-divergence exit code (exit 3
   when total fieldDiffs across all
   comparisons ≥ threshold)** —
   conflates "ALL comparisons trip
   slightly" with "ONE comparison
   trips massively". Operators want
   the latter to trip; sum hides it
   when paired with high thresholds.

4. **N-way diff against tier
   definitions intermixed with tenant
   diffs (`--diff tenant-a --vs-tier
   tier-x`)** — semantically muddled
   ("which side gets the synthetic
   construction?"). Rejected with
   exit 2.

5. **Per-comparison threshold flags
   (`--threshold-for-1`,
   `--threshold-for-2`)** — useful but
   over-engineered for v1; operators
   set a single threshold that
   applies across comparisons. Defer.

6. **Allow `--diff` to repeat** —
   conflicts with single-comparison
   backward compat; getStringFlag
   would have to switch to getMulti
   silently. The `--add-tenant`
   convention is clearer.

7. **`--vs-tier` requires
   `--add-vs-tier` for second+
   occurrences** — symmetric with
   `--diff` + `--add-tenant`, but
   tier-id has no
   "anchor RHS / additional RHS"
   distinction (each --vs-tier is
   independent synthetic
   construction). Allowing
   `--vs-tier` to repeat directly is
   simpler.

8. **`comparison_index` column at
   the END of the CSV rows instead
   of the start** — putting it
   first surfaces the grouping
   structure naturally when reading
   left-to-right. Tail position
   loses that.

9. **Suppress the
   `comparison_index` column under
   N=1 multi-fallback (use multi
   envelope but single-format
   csv)** — N=1 stays
   single-envelope. No exception.

10. **Stream comparisons (write
    each envelope as soon as its
    fieldDiffs computed)** —
    breaks the single-envelope
    JSON contract. NDJSON would
    be the right path but it's a
    new format flag for marginal
    workflow value (operators
    rarely run N>5 comparisons).
    Defer.

## Drawbacks

- **Envelope shape switches on N=1
  vs N>1** — operators reading the
  JSON need to handle both
  `tenant.policies.diff` and
  `tenant.policies.diff.multi`. The
  switch is explicit (action name);
  documented in the CLI help.
- **Max-divergence exit code obscures
  which comparison tripped** —
  operators reading the exit code
  alone can't tell whether
  comparison 0, 1, or 2 caused exit
  3. Pair with `--format json` for
  per-comparison fieldDiffs.length
  inspection.
- **N-way CSV adds a column that
  N=1 CSV doesn't have** —
  consumers loading both shapes
  into the same spreadsheet
  workflow need to handle the
  extra column. Acceptable; the
  `comparison_index` column is
  obvious in its meaning.
- **N=1 + multi-output flag would
  be useful for consistent
  output** — operators wanting
  the multi-envelope shape always
  would need a `--multi-always`
  flag. Defer; can add if
  operator demand surfaces.
- **N RHSes mean N+1 PG round-
  trips for slug resolution + N+1
  for gather** — linear cost in
  comparison count, parallelized
  via `Promise.all`. Acceptable;
  bulk operators use the gather
  pipeline for >10 tenants via a
  future tenants-list-vs-tier
  surface.
- **Duplicate-target rejection
  uses RESOLVED UUID matching** —
  operators passing the same
  tenant via slug AND UUID get
  rejected with a clear error.
  Operators passing two distinct
  slugs that happen to resolve to
  the same UUID also rejected
  (which is correct — they ARE
  the same tenant).

## Future Qs

1. **`--summary-only` flag emitting
   just `[comparison_index,
   field_diff_count]` rows for
   bulk reporting** — useful when
   operators want a "which
   comparisons tripped"
   one-glance view.

2. **`--max-divergent N` to exit
   3 when ANY comparison's diff
   count > N (per-comparison
   threshold variant)** — pairs
   with sum-divergence trade-off
   from rejected #3.

3. **`--gh-summary` rendering
   Multi-comparison output as
   Markdown ready for GitHub
   Step Summary** — pairs with
   future summary-md feature
   (multiple ADRs queue this).

4. **`tenants list --diff
   --tenant-filter ...` for
   bulk cohort comparison
   (anchor = filter[0], RHS =
   filter[1..N])** — useful but
   needs a separate orchestrator
   in `tenants-list.ts`. Defer.

5. **N-way `--vs-tier --effective
   --effective-summary-only`
   emitting just the effective-
   ceiling change per tier** —
   pairs with the --csv-
   effective-only future Q from
   ADR-0285.

6. **NDJSON streaming for very
   large N (>100 comparisons)** —
   not needed in v1; operators
   running 100-tenant audits go
   to JSON with jq pipelines.

7. **`--add-tier <tier-id>`
   alternate flag name for
   second+ `--vs-tier`
   occurrences for symmetry
   with `--add-tenant`** —
   ergonomic question; the
   repeated-flag convention is
   simpler. Defer unless
   operator demand surfaces.
