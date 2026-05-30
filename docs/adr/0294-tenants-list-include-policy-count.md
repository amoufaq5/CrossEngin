# ADR-0294: `tenants list --include-policy-count` computed column

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0289 Q2 (closes), ADR-0293 Q1 (closes — partial), ADR-0289 (CSV/TSV pattern), ADR-0293 (csv-full) |

## Context

ADR-0289 Q2 deferred
"--include-policy-count flag adding
computed column for per-tenant
retention policy overrides" and
ADR-0293 Q1 deferred the same
concept under csv-full. Both close
together since the column shape +
SQL pattern is identical for both
compact and full variants.

After M4.15.b + M4.15.f shipped
the compact and full CSV
variants, cohort-analysis
workflows still couldn't sort
or filter by "tenants with the
most overrides" without
post-processing. Operators
wanted that count surfaced
directly.

Real workflows:

1. **Cohort drift analysis**
   — data team imports CSV,
   sorts by policy_count
   descending to find the
   most-customized tenants.
2. **Cohort uniformity
   sampling** — operators
   look for tenants with
   unusually low/high
   override counts.
3. **Migration verification**
   — after rolling out
   defaults, verify every
   tenant's override count
   hasn't drifted.

## Decision

Add `--include-policy-count`
boolean flag to `tenants list`.
Composes with all format
modes (json, csv, csv-full,
tsv, human).

### SQL shape

LEFT JOIN against a per-
tenant aggregation subquery:

```sql
LEFT JOIN (
  SELECT tenant_id,
         COUNT(*)::int AS policy_count
  FROM meta.tenant_retention_policies
  GROUP BY tenant_id
) pc ON pc.tenant_id = t.id
```

SELECT adds:

```sql
COALESCE(pc.policy_count, 0)::int AS policy_count
```

`COALESCE` converts the
LEFT-JOIN-missed case to 0 so
tenants with no overrides
report 0, not NULL. The `::int`
cast ensures pg.js returns a
JS number rather than a
string.

### Format integration

- **json**: extra `policy_count`
  field per tenant in the
  envelope.
- **csv**: appended as the 6th
  column.
- **csv-full**: appended as
  the 12th column.
- **tsv**: appended as the 6th
  column (tab-separated).
- **human**: appended as a
  right-padded "policies"
  column (8-char min width).

### Composition with
existing filters

- `--status` — composes
  cleanly; the SQL adds an
  AND clause as before.
- `--table-filter` —
  composes; the WHERE EXISTS
  is independent of the
  join.
- `--has-overrides` —
  composes; the WHERE
  EXISTS still gates
  tenant inclusion. With
  both, operators get only
  tenants with
  policy_count > 0 (the
  EXISTS guarantees ≥ 1).
  Acceptable; not
  redundant since
  --has-overrides could
  also have been
  unset.

### Why a flag, not
always-on?

The LEFT JOIN adds query
cost. For workflows that
don't need the count
(e.g., quick slug
lookups), keeping it
opt-in avoids paying for
data that's not used. The
flag is cheap to set
(`--include-policy-count`
in shell aliases) and
clear to read in CI
configs.

## Rejected alternatives

1. **Always include
   policy_count** — adds
   query cost to all
   `tenants list`
   invocations. Opt-in is
   cleaner.

2. **Use COUNT(*) directly
   in the SELECT with a
   subquery in each row**
   — slower than the
   LEFT-JOIN-aggregate
   pattern for large
   tenant lists. The
   GROUP BY subquery
   aggregates once.

3. **Stream the count
   via a separate query**
   — would require N+1
   round-trips. Defeats
   the bulk-list use
   case.

4. **Per-table count
   breakdown
   (`policy_count_by_table:
   {workflow_traces: 2,
   ...}`)** — more
   detailed but the
   shape doesn't map
   cleanly to CSV (nested
   data). The aggregate
   count covers the
   primary use case.

5. **Include policy
   counts for OTHER
   substrate tables**
   (cost-ceiling
   overrides, etc.) —
   meta.tenant_retention
   _policies is the most
   common variation
   surface. Other
   policy types could
   get their own flags
   in follow-up
   milestones.

6. **Conditional CSV
   column name** —
   always emit
   policy_count column
   header even when 0
   for all rows. Already
   does this; column
   appears whenever
   the flag is set.

## Drawbacks

- **LEFT JOIN adds query
  cost** — for tenant
  lists of ~10k, the
  aggregation is fast
  (~10ms typical) but
  measurable. Opt-in
  flag means it's only
  paid when needed.

- **`policy_count`
  semantic is
  retention-only** —
  doesn't include
  cost-ceiling or other
  override types. The
  name is specific
  enough that ambiguity
  is low but operators
  reading the column
  might assume
  "all overrides" when
  it's really "retention
  overrides". Document
  in CLI help.

- **Cannot sort by
  policy_count
  server-side** — the
  query is ORDER BY
  slug. Operators
  wanting count-sorted
  output use shell
  `sort -t, -k6 -nr`
  or pandas
  `sort_values`.

- **Human column
  width hardcoded to
  8 chars** — counts
  > 99,999,999 (8
  digits) would
  overflow. Acceptable
  bound; real-world
  per-tenant policy
  counts max out
  around 10-20.

## Future Qs

1. **`--sort-by
   policy_count`** —
   server-side sort
   replacing client-
   side post-processing.

2. **`--include-
   cost-ceiling-
   override`** —
   companion flag
   adding a boolean
   "has cost ceiling
   override" column.

3. **`--policy-count-
   by-table`** —
   denormalized JSONB
   column with per-
   table breakdown.

4. **`--min-policy-
   count N`** —
   server-side filter
   for tenants
   exceeding a
   threshold.

5. **Extend the
   pattern to other
   substrate tables**
   (e.g.,
   `--include-tier-
   ceiling-overrides`)
   as new override
   surfaces ship.

6. **Index hint** —
   if the LEFT JOIN
   aggregation
   becomes slow at
   scale, add an
   index hint or
   materialized
   view.
