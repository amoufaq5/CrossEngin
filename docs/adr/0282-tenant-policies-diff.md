# ADR-0282: `tenant policies --diff <other>` side-by-side comparison

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0280 Q5 (closes), ADR-0280 (host action), ADR-0281 (composes with `--effective`), ADR-0137 + ADR-0144 (substrate-level policy axes), `retention diff` pattern (mirrors structure) |

## Context

ADR-0280 shipped `tenant policies <slug|uuid>`
aggregating three policy axes for one tenant under
one envelope. Q5 carved out a side-by-side comparison
between two tenants:

> "`--diff <other-slug|uuid>` flag comparing two
> tenants' policy shapes side-by-side. Mirrors the
> `retention diff` matrix pattern but for the three
> policy axes."

Real workflows driving this:

1. **Cohort uniformity verification post-migration** —
   after promoting 200 tenants `free` → `pro`,
   operators sample-check 10 random tenants from the
   cohort against a known-good `pro` tenant to
   confirm uniform application.
2. **Differential debugging** — tenant X complains
   about throttling; operators run
   `tenant policies tenantX --diff <similar-tenant>`
   to find the policy delta explaining the
   divergent behavior.
3. **Pre-tier-change validation** — operator
   planning to move tenant from `enterprise` →
   `custom` runs the diff against a current
   `custom`-tier exemplar to preview the policy
   delta before committing.
4. **Compliance attestation across tenants** —
   auditor verifying tenant A and tenant B have
   identical retention policies for a specific
   table runs the diff and checks empty
   `fieldDiffs`.

## Decision

Add `--diff <other-slug|uuid>` string flag to
`tenant policies`. When set, resolve BOTH tenants
(independently — each gets its own slug→UUID +
"did you mean" treatment), gather BOTH reports
concurrently, compute field-level differences
client-side, render the result. Composes with
`--effective` (both sides get the `effective`
field). No server-side diff query — pure JS
diff on two already-fetched reports.

### Resolution + ordering

```ts
// Both calls fire concurrently — independent
// resolution paths so a slug typo on either side
// gets its own "did you mean" suggestion list.
const [resolvedA, resolvedB] = await Promise.all([
  resolveTenantIdentifier(conn, inputA),
  resolveTenantIdentifier(conn, inputB),
]);
```

If either side fails to resolve, the error message
includes a `left '<input>'` or `right '<input>'`
qualifier so operators see which side broke.

### Self-diff guard

`resolvedA.tenantId === resolvedB.tenantId` short-
circuits to exit 2 with a clear error — comparing
a tenant to itself yields empty fieldDiffs by
construction and is almost always an operator
typo. Better to fail fast than spend 6 queries
computing nothing.

### Field-diff computation

`computePolicyFieldDiffs(reportA, reportB)` returns
a flat `PolicyFieldDiff[]` array:

```ts
interface PolicyFieldDiff {
  axis: "retention" | "costCeiling" | "tier";
  field: string;           // dotted path
  valueA: string | number | boolean | null | undefined;
  valueB: ...;
}
```

`undefined` means "axis or sub-axis absent on that
side" — distinct from `null` which means "field
present but explicitly NULL."

**Retention axis** — per-table comparison. Walk the
UNION of `tableName`s from both sides (sorted for
deterministic output). For each table:
- absent on one side → emit single `retention.<table>.exists` diff
- present on both → walk each policy field
  (`retentionDays`, `enabled`, `optOut`,
  `optOutReason`, `optOutUntil`); emit diff per
  differing field

**Cost ceiling axis** — row-level comparison:
- one side has row, other doesn't → emit single
  `costCeiling.exists` diff (the per-field diffs
  would all show as undefined→value which is
  noisier; operators reading "exists: true → false"
  immediately understand)
- both have rows → walk each numeric field
  (`maxUsdPerRequest`, `maxUsdPerWindow`,
  `windowSeconds`); emit diff per differing field

**Tier axis** — tier identity drives it:
- one side has tier, other doesn't → emit
  `tier.exists`
- both share `tierId` → no diff (tier policy
  fields are identical by JOIN construction)
- different `tierId` → emit single `tier.tierId`
  diff (no per-field tier-policy walk — that
  information is intrinsic to the tier and
  available via `tenant policies` on each tier
  exemplar separately)

### Output

- **JSON** — envelope shape
  `{ action: "tenant.policies.diff", left:
  TenantPoliciesReport, right:
  TenantPoliciesReport, fieldDiffs:
  PolicyFieldDiff[] }`.
- **Human** — header with both resolved tenant
  IDs + the original inputs (for slug echoing).
  Empty fieldDiffs → "No differences" line.
  Non-empty → "Field changes (N):" header
  followed by per-axis grouped lines. Each line:
  dotted field path padded to 48 cols, then
  `valueA  →  valueB` rendering. Grouped by
  axis with `[retention]`, `[costCeiling]`,
  `[tier]` headers.

### Exit codes (CI integration)

Mirrors `retention diff` convention:

| Flags | Behavior |
|---|---|
| (none) | Exit 0 always, regardless of fieldDiffs |
| `--exit-on-divergence` | Exit 3 if `fieldDiffs.length ≥ 1` |
| `--exit-on-divergence --threshold N` | Exit 3 if `fieldDiffs.length ≥ N` |
| `--threshold N` without `--exit-on-divergence` | Exit 2 + error (invalid flag combo) |

`--threshold` requires a positive integer; non-
integer or negative values exit 2 with a clear
error.

### Composes with `--effective`

`--effective` populates the `effective` field on
both `left` and `right` independently. The diff
itself doesn't compare effective values (that
would duplicate the raw-axis diff via a different
lens; operators wanting to verify "do these two
tenants enforce the same ceiling at runtime?"
read the JSON `left.effective` and `right.effective`
directly). Adding effective-value diffs to
`fieldDiffs` would muddle the per-axis grouping
without adding signal.

### Why pure client-side diff

Both reports are already in memory after the
concurrent gather. A SQL-side diff would require
either:
1. A new dedicated CTE running 3 JOINs across
   meta.tenant_retention_policies +
   meta.llm_cost_ceilings +
   meta.llm_tenant_tier_memberships per
   tenant pair — substantially more PG round-trip
   complexity for the same answer.
2. Calling `retention.diffTenantPolicies` (which
   exists at substrate level) — but that's
   single-table; we'd need to call it once per
   table-name in the union + add separate
   per-axis calls for ceiling + tier. Composition
   would still happen in TS.

Pure TS diff is the right abstraction.

## Rejected alternatives

1. **Compare effective values, not raw rows** —
   would lose the "configured-vs-enforced"
   distinction. Operators auditing want to see
   the raw delta; effective comparison is
   derivable via `left.effective` vs
   `right.effective` from the JSON.

2. **Surface per-tier-policy-field diffs when
   `tierId` differs** — tier policy fields are
   intrinsic to the tier definition (not the
   tenant); operators wanting that comparison
   should examine the tiers themselves, not
   re-derive them through tenant context.

3. **Render full reports side-by-side as a
   3-column matrix (axis | tenantA | tenantB)** —
   would balloon output for large retention
   tables. Field-diff-only output stays focused
   on what changed; operators wanting the full
   reports can run `tenant policies` twice
   without `--diff`.

4. **N-way diff with `--add-tenant` repeated
   flags** — useful for cohort verification but
   exit-code semantics get muddy (which pair
   trips divergence?). Deferred to a future Q.

5. **SQL-side CTE computing the diff server-
   side** — adds PG complexity for zero
   observable difference at typical scale.
   Client-side composition trivially handles
   ≤ 1K rows total across both sides.

6. **`exists` diffs decomposed into per-field
   `undefined → value` lines** — would
   surface N diff lines for a missing N-field
   row. Single `exists` line is cleaner; the
   row's contents are visible in the raw
   `left`/`right` reports for operators who
   want them.

7. **`tenant diff <a> <b>` as standalone
   top-level action instead of a flag on
   `tenant policies`** — would fragment the
   policies surface and force operators to
   remember a second action. Flag composition
   keeps the policies surface unified.

8. **Threshold defaulting to 0 (always trips)**
   — confusing semantic; 0 ≥ 0 is always true.
   Default of 1 means "any divergence trips."

9. **`tenant policies --diff <other>` without
   self-diff guard** — would spend 6 queries
   to compute an empty result for an obvious
   operator typo. Fail fast at the boundary.

10. **Render `valueA → valueB` with `↔` instead
    of `→` for "they differ"** — direction-
    less arrows obscure the "left-right reading
    direction" mental model operators bring to
    diffs. `→` matches the `retention diff`
    convention from ADR-0145.

11. **Sort fieldDiffs by axis precedence (eg
    most-critical first)** — every axis is
    equally critical for compliance use cases;
    grouping by axis for readability beats
    artificial precedence.

## Drawbacks

- **`--diff` reuses the same flag name pattern
  as `retention diff` but uses positional
  `<a> <b>` there vs flag `<a> --diff <b>`
  here** — operators familiar with retention
  diff need to mentally adapt. We could have
  made `tenant policies diff <a> <b>` a
  sub-action but that fragments the policies
  surface across two action names.
- **No per-tier-policy comparison when tiers
  differ** — operators wanting to compare
  the `free` tier vs the `pro` tier should
  examine the tiers, not roundtrip through
  tenant context.
- **Self-diff is an error, not a no-op** —
  some operators might script "diff tenant X
  against tenant X" in a loop as a smoke
  test. Catching as an error means scripts
  must handle exit 2. Documented; alternative
  is silent empty fieldDiffs which is also
  documentation-needed.
- **Cost ceiling `exists` diffs collapse
  per-field detail** — operators wanting the
  per-numeric-field comparison must read the
  raw `left.costCeiling` vs `right.costCeiling`
  JSON.
- **Sorted retention table order doesn't
  match the natural order in the raw report**
  — the raw retention block uses listTenantPolicies
  insertion order; the diff sorts alphabetically
  for determinism. Two different orderings
  for the same underlying data.

## Future Qs

1. **`tenant policies --diff --add-tenant ...
   --add-tenant ...` for N-way comparison** —
   useful for cohort sampling after
   migrations. Exit-code semantics need
   design.
2. **`tenant policies --diff --vs-tier <tierId>`
   comparing a single tenant against a tier's
   policy shape (synthetic right-hand-side)** —
   useful for "would this tenant change if we
   moved them to tier X?" pre-flight.
3. **Persist diff outputs to a structured
   audit table** — useful for compliance.
   Out of scope.
4. **CSV/TSV output for the diff** — single-
   record-per-diff layout fits CSV cleanly.
   Pairs with ADR-0280 Q6.
5. **`--diff-no-noise` flag suppressing
   `exists` diffs and only emitting per-field
   diffs** — narrower output for operators
   who treat absence as expected (not a
   delta).
6. **Render the `effective` field comparison
   in fieldDiffs** — would surface the same
   information through a different lens but
   muddle per-axis grouping. Deferred until
   operator demand emerges.
