# ADR-0290: `tenant housekeeping --add-tenant` N-way pair-wise comparison

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0288 Q1 (closes), ADR-0288 (housekeeping --diff), ADR-0287 (policies N-way pattern) |

## Context

ADR-0288 Q1 deferred N-way extension to a
follow-up milestone. After M4.15.a shipped
the two-tenant housekeeping diff, the same
cohort-uniformity use case that drove the
policies N-way extension (ADR-0287) now
applies to housekeeping: operators
verifying that 3+ tenants in a cohort
received uniform retention overrides
after a migration.

Real workflows:

1. **Post-migration cohort verification**
   — auditor runs `tenant housekeeping
   --tenant acme-prod --diff acme-staging
   --add-tenant acme-dev
   --exit-on-divergence` to gate CI on
   uniform retention overrides across a
   3-tenant cohort.
2. **Multi-tenant uniformity sampling**
   — operator picks an anchor tenant and
   diffs against 5 peers to find any
   that drifted from cohort policy.

## Decision

Add `--add-tenant <other>` (repeatable,
requires `--diff`) to `tenant
housekeeping`. Mirrors the policies
M4.14.a pattern.

### Invocation shape

`tenant housekeeping --tenant <A>
--diff <B> [--add-tenant <C>
--add-tenant <D> ...]
[--exit-on-divergence
[--threshold N]] [--format json]`

`--add-tenant` REQUIRES `--diff`
(the first RHS comes from `--diff`;
`--add-tenant` adds more). Standalone
`--add-tenant` (no `--diff`) exits 2.

### Mutual-exclusivity

The existing `--diff` exclusivity
rules from M4.15.a propagate to
`--add-tenant`:
- `--diff` + `--all-tenants` → exit 2
- `--diff` + `--watch` → exit 2
- `--diff` + `--threshold-alert` → exit 2

`--add-tenant` adds:
- `--add-tenant` without `--diff` →
  exit 2.
- Duplicate RHS UUIDs in slots
  (same RHS via slug + UUID, or two
  slugs resolving to same UUID) →
  exit 2 with "appears in multiple
  RHS slots" message.
- Anchor matching ANY RHS slot →
  exit 2 with slot-labeled "left
  and right N resolve to the same
  tenant" message.

### Envelope shape

**Single comparison (N=1)**:
preserves M4.15.a envelope:

```json
{
  "action": "tenant.housekeeping.diff",
  "left": { ... },
  "right": { ... },
  "fieldDiffs": [ ... ]
}
```

**Multi comparison (N>1)**:

```json
{
  "action": "tenant.housekeeping.diff.multi",
  "anchor": { ... },
  "comparisons": [
    { "right": { ... },
      "fieldDiffs": [...] },
    { "right": { ... },
      "fieldDiffs": [...] }
  ]
}
```

Backward compat: single-comparison
keeps M4.15.a action name; consumers
parsing `tenant.housekeeping.diff`
stay unchanged.

### Human render

Multi-comparison emits one section
per comparison using existing
`renderHousekeepingDiffHuman`:

```
Multi-comparison tenant housekeeping (anchor: <uuid> input: '<input>', N comparisons):

=== Comparison 1/N ===
Diff between tenant housekeeping dashboards:
  Left:  <anchor>
  Right: <rhs[0]>
  Field changes (M):
    [axis] <table>.<field>: ...

=== Comparison 2/N ===
...
```

### Max-divergence exit code

`diffDivergenceExitCode(command,
maxFieldDiffsLength)` where
`maxFieldDiffsLength = max(c.fieldDiffs.length
for c in comparisons)`. Any single
comparison's diff count ≥ threshold
trips exit 3. Matches policies
M4.14.a semantic + ADR-0287
rationale (operator intent: "ANY
cohort drift trips the gate").

### Implementation

- `runTenantHousekeepingDiff`
  refactored to accept
  `rhsInputs: ReadonlyArray<string>`
  rather than single `inputRhs`.
- Resolves anchor + all RHSes
  concurrently via `Promise.all`.
- Self-diff guard iterates over
  every RHS slot with updated
  "right N" labeling (preserves
  "right" label when N=1 for
  M4.15.a backward compat).
- Duplicate-RHS-UUID guard
  catches "appears in multiple
  RHS slots" via UUID set
  iteration.
- Gathers anchor's 2 reports + each
  RHS's 2 reports concurrently
  (total = 2*(1+N) reports). Stable
  slice ordering: gateway_anchor,
  gateway_rhs[0..N-1],
  retention_anchor,
  retention_rhs[0..N-1].
- For N=1: emits single-comparison
  envelope (M4.15.a shape).
- For N>1: emits multi-comparison
  envelope via new
  `renderHousekeepingMultiDiffHuman`.

## Rejected alternatives

1. **Default to multi-comparison
   envelope even when N=1** —
   breaks every existing JSON
   consumer parsing
   `tenant.housekeeping.diff`. The
   backward-compat rule from
   ADR-0287 applies identically.

2. **`--add-tenant` works without
   `--diff`** — ambiguous which is
   "the" RHS. `--diff` anchors the
   first RHS explicitly;
   `--add-tenant` adds. Cleaner
   mental model.

3. **Sum-divergence exit code** —
   conflates "ALL comparisons trip
   slightly" with "ONE comparison
   trips massively". Operators
   want the latter to trip; sum
   hides it. Same rationale as
   ADR-0287.

4. **Per-comparison threshold
   flags** — over-engineered for
   v1. Single `--threshold` flag
   covers the gate semantic.

5. **Allow `--diff` to repeat**
   (instead of separate
   `--add-tenant`) — conflicts
   with single-comparison
   backward compat;
   `getStringFlag` would have
   to switch to `getMulti`
   silently.
   `--add-tenant` convention
   is clearer.

6. **N-way diff against
   --all-tenants matrix** —
   semantically muddled (which
   N×M cells get compared?).
   Existing exclusivity rule
   rejects it.

7. **Comparison index in
   human render** (like CSV's
   `comparison_index` from
   M4.14.a) — already
   surfaced via "=== Comparison
   i/N ===" markers; no
   additional indexing needed.

8. **Custom comparison label
   (anchor vs rhs[i].tenantId)
   in render** — the per-section
   Left/Right labels already
   carry tenantId; redundant.

## Drawbacks

- **2*(1+N) PG round-trips for
  N RHSes** — parallelized
  via Promise.all so wall-
  clock cost is roughly the
  slowest gather, but the
  total query work grows
  linearly. Acceptable for
  operator-driven CI gates
  (N typically ≤ 5);
  bulk-cohort comparisons
  >10 tenants benefit from
  a future tenants-list-vs-
  matrix surface.

- **Envelope shape switches
  on N=1 vs N>1** —
  operators reading JSON
  handle both
  `tenant.housekeeping.diff`
  and
  `tenant.housekeeping.diff.multi`.
  The switch is explicit via
  action name; documented in
  CLI help.

- **Max-divergence exit code
  obscures which comparison
  tripped** — operators
  reading exit code alone
  can't tell whether
  comparison 0/1/2 caused
  exit 3. Pair with
  --format json for
  per-comparison inspection.

- **CSV/TSV output for N-way
  not in M4.15.c scope** —
  consumers of bulk diff in
  spreadsheets need to wait
  for ADR-0288 Q2 closure
  (future M4.15.x).

## Future Qs

1. **CSV/TSV output for
   multi-comparison
   envelope** (closes
   ADR-0288 Q2). Adds
   `comparison_index` column
   per row, matching the
   policies CSV pattern from
   M4.14.a.

2. **`--gh-summary` Markdown
   for N-way housekeeping
   diff** (pairs with
   ADR-0287 Q3 + ADR-0288
   Q3 across all diff
   variants).

3. **N-way --vs-defaults
   synthetic comparison**
   — analogue to policies
   --vs-tier. Not in
   M4.15.c scope; defer.

4. **Stream NDJSON for
   very large N (>50
   comparisons)** —
   future surface; not
   needed for current
   operator workflows.

5. **Anchor-first
   field-grouped CSV
   alternative** — group
   diffs by axis+table
   then comparison_index
   secondary, instead of
   comparison_index
   primary. Trade-off:
   spreadsheets pivot
   either way. Defer.

6. **`--summary-only`
   flag emitting just
   `[comparison_index,
   field_diff_count]`
   rows** — for bulk
   reporting where
   operators want
   "which comparisons
   tripped" at a
   glance. Pairs with
   ADR-0287 Q1.
