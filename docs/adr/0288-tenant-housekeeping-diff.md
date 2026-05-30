# ADR-0288: `tenant housekeeping --diff <other>` pair-wise dashboard comparison

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0284 Q5 (closes), ADR-0273 (housekeeping combined dashboard), ADR-0282 (policies --diff pattern) |

## Context

ADR-0284 deferred Q5 was "tenant housekeeping
--diff <other-tenant> comparing two tenants'
housekeeping dashboards side-by-side." After
shipping the M4.14.x family of `tenant
policies --diff` + `--vs-tier` +
`--add-tenant` (ADR-0282/0286/0287), the
same pair-wise comparison shape is now
desired for the cross-substrate
housekeeping dashboard.

Real workflows driving the change:

1. **Post-migration retention parity check**
   — auditor verifies that two tenants in
   the same cohort received the same
   per-tenant retention overrides after a
   migration via `tenant housekeeping
   --tenant acme-prod --diff acme-staging
   --exit-on-divergence`.
2. **CI gate for cohort uniformity** —
   pipeline checks that staging mirrors
   prod's retention configuration.
3. **Operator triage** — when prod and
   staging behave differently, the diff
   quickly surfaces "which retention
   override differs."

## Decision

Add `--diff <other-uuid|slug>` to `tenant
housekeeping`. The existing `--tenant`
flag supplies the LHS; `--diff` supplies
the RHS. Diff focuses on tenantPolicy
fields per table across BOTH gateway +
retention dashboards.

### Invocation shape

`tenant housekeeping --tenant <A>
--diff <B> [--exit-on-divergence
[--threshold N]] [--format json]`

`--diff` REQUIRES `--tenant` (the LHS).
The CLI rejects `--diff` standalone
since the housekeeping command has no
positional argument convention to
anchor against (unlike `tenant
policies <slug>` which does).

### Mutual-exclusivity

- `--diff` + `--all-tenants` → exit 2.
  Pair-wise vs matrix-mode don't
  compose semantically (which N×M
  cells get compared?).
- `--diff` + `--watch` → exit 2 in v1.
  Looped diff layouts garble badly;
  diff is one-shot.
- `--diff` + `--threshold-alert` →
  exit 2. Alert clauses target a
  single tenant view's table
  metrics; pair-wise divergence is
  a different gate semantic
  (--exit-on-divergence handles it).
- `--diff` + self (A == B after
  resolution) → exit 2.
  Tautological comparison; almost
  always operator typo. Mirrors
  policies --diff self-guard.

### Diff axis

The MEANINGFUL diff is per-tenant
override divergence. Global per-
table stats (totalRowCount,
oldestAt, wouldPruneCount,
retentionDays at platform level,
lastPrunedAt) are tenant-AGNOSTIC
under the same PG snapshot — both
tenants share the platform
defaults — so the diff EXCLUDES
those. Any divergence in global
stats would indicate a race
between the two gather calls,
not a meaningful policy
difference.

Diff walks:
- For each gateway table:
  tenantPolicy fields
  (retentionDays, enabled,
  optOut, optOutReason,
  optOutUntil). When one side
  has an override and the
  other doesn't, emit a single
  `tenantPolicy.exists` diff
  (not N field-level diffs)
  so operators see the
  presence mismatch clearly.
- For each retention table:
  same walk via the
  retention housekeeping
  report's `tenantPolicy`
  field.

### Envelope shape

JSON:

```json
{
  "action": "tenant.housekeeping.diff",
  "left": {
    "tenantId": "<uuid-a>",
    "input": "<slug-or-uuid-a>",
    "gateway": { ... },
    "retention": { ... }
  },
  "right": {
    "tenantId": "<uuid-b>",
    "input": "<slug-or-uuid-b>",
    "gateway": { ... },
    "retention": { ... }
  },
  "fieldDiffs": [
    {
      "axis": "gateway" | "retention",
      "tableName": "<name>",
      "field": "tenantPolicy.<field>"
        | "tenantPolicy.exists"
        | "exists",
      "valueA": ...,
      "valueB": ...
    }
  ]
}
```

Human render: header + per-side
labels + field-changes list,
mirrors `tenant policies --diff`
human shape but with the
[axis] tableName.field format
since housekeeping diffs are
per-table-keyed (not just
per-field like policies).

### Exit code

`diffDivergenceExitCode(command,
fieldDiffs.length)` — same gate
helper as policies --diff.
`--exit-on-divergence` +
optional `--threshold N`
controls exit 3 firing.

### Implementation

- New `runTenantHousekeepingDiff`
  orchestrator in tenant.ts
  alongside policies diff. Pure
  client-side comparison from
  two pairs of housekeeping
  reports — no server-side diff
  query.
- Reuses `gatherHousekeepingReport`
  + `gatherRetentionHousekeepingReport`
  with each tenant's tenantId
  passed through. 4 reports
  gathered concurrently via
  `Promise.all`.
- New `HousekeepingFieldDiff`
  type + `computeHousekeepingFieldDiffs`
  function. Exports both for
  future reuse / extension
  (e.g., M4.15.b N-way
  housekeeping comparison).
- New `renderHousekeepingDiffHuman`
  for human format.
- Help text in cli.ts extended.

## Rejected alternatives

1. **Include global per-table stats
   in the diff** — would surface
   noise from race conditions
   between the two gather calls
   (totalRowCount changes between
   queries under load). Operators
   want POLICY differences, not
   metric noise.

2. **Make `--diff` standalone (no
   `--tenant` required)** — would
   require positional LHS
   argument, breaking the no-
   positional convention of
   `tenant housekeeping`. The
   `--tenant <A> --diff <B>`
   shape is clear and matches
   how operators think about the
   query ("show housekeeping
   for A, in diff mode against
   B").

3. **N-way diff (--add-tenant
   pattern from policies)** —
   future M4.15.b. Single
   milestone keeps M4.15.a
   focused on the core diff
   semantic.

4. **CSV/TSV output** — future
   M4.15.c (closes ADR-0285 Q5
   alongside the broader
   housekeeping CSV ask).
   Keeping M4.15.a JSON+human
   only matches scope of
   policies --diff M4.14.f
   shipping order.

5. **Allow --watch (loop the
   diff)** — diff output layouts
   don't compose with watch
   loops (per-tick re-rendering
   the diff layout garbles
   under terminal scroll).
   Defer; revisit if operators
   ask.

6. **Allow --threshold-alert
   alongside --diff (alert on
   per-table metrics in either
   tenant)** — semantically
   confusing. Alert clauses
   target a single tenant
   view; pair-wise divergence
   is a different gate. Use
   --exit-on-divergence.

7. **Synthetic --vs-defaults
   (compare A vs the platform
   defaults with no overrides)
   ** — interesting but a
   different what-if mode.
   Defer; revisit as a
   future ADR.

8. **Bidirectional diff
   semantics (A → B AND B → A
   shown separately)** — the
   tenantPolicy.exists
   bidirectional case is
   already covered by a single
   diff entry showing
   valueA=true / valueB=false
   (or vice versa). No need
   for duplicate rendering.

9. **Custom diff threshold per
   axis (--gateway-threshold N
   --retention-threshold M)** —
   over-engineered for v1.
   Single --threshold flag
   covers the gate semantic.
   Defer.

## Drawbacks

- **Diff EXCLUDES global stats**
  — operators wanting to see
  "did totalRowCount diverge
  between snapshots?" need
  separate tooling. The
  rationale (race noise
  dominates signal) is
  documented but might
  occasionally surprise users.

- **4 PG round-trips for
  diff** (gateway×2 +
  retention×2) — parallelized
  via Promise.all. Linear
  cost; acceptable for
  one-shot diff. Bulk diffs
  >5 tenants would benefit
  from a future N-way mode.

- **--diff + --watch
  rejection means continuous
  monitoring of cohort
  uniformity requires
  external loop** — operators
  scripting CI gates use
  one-shot diff invocations,
  which is the intended
  pattern. Wallclock loops
  can be implemented in
  shell.

- **No CSV output in M4.15.a
  means CSV-pipeline workflows
  must use jq on JSON** —
  documented in ADR; CSV
  arrives in M4.15.b/c.

- **tenantPolicy.exists single
  diff vs N field-level diffs
  for one-sided overrides** —
  operators might prefer
  seeing the override's
  retentionDays etc. fields
  listed too. The "exists"
  diff form is intentionally
  compact; full per-field
  diffs would surface when
  BOTH sides have overrides
  with different values.

## Future Qs

1. **N-way --add-tenant
   extension (M4.15.b)** —
   `tenant housekeeping
   --tenant A --diff B
   --add-tenant C --add-tenant
   D` for cohort uniformity
   across 3+ tenants. Mirrors
   M4.14.a shape (multi
   envelope with
   comparison_index column
   for CSV when added).

2. **CSV/TSV format (M4.15.c)**
   — closes ADR-0285 Q5 +
   carries the diff into
   spreadsheet workflows.

3. **--gh-summary Markdown
   output (M4.15.d)** — pairs
   with ADR-0287 Q3 across
   all diff variants.

4. **--vs-defaults synthetic
   comparison (compare A vs
   platform defaults, no
   overrides)** — analogue
   to policies --vs-tier
   for housekeeping. Niche
   but documents the "is
   my override actually
   doing anything?"
   question.

5. **Side-by-side table view
   in human render** — for
   operators reading
   visually, a two-column
   "Left | Right" format
   per table might surface
   intent better than the
   linear diff list. Defer.

6. **Include retentionDays
   platform-level diff
   when policies disagree
   between snapshots** —
   only useful if operators
   are debugging mid-flight
   platform changes. Niche;
   defer.

7. **--include-global-stats
   opt-in flag** — operators
   investigating a specific
   race could opt INTO
   seeing global-stat
   divergences. Defer
   unless requested.
