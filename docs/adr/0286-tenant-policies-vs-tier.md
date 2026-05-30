# ADR-0286: `tenant policies --vs-tier <tier-id>` synthetic-RHS preview

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0282 Q2 + ADR-0283 Q3 (closes), ADR-0280 (tenant policies aggregate), ADR-0281 (--effective), ADR-0282 (--diff), ADR-0283 (--explain), ADR-0285 (CSV/TSV), ADR-0154 (PostgresCostCeilingResolver precedence) |

## Context

ADR-0282 deferred Q2 was "`--vs-tier <tier-id>`
synthetic-RHS comparison: useful pre-tier-
change preview." ADR-0283 deferred Q3 was the
same shape under the --explain umbrella.

Real workflows driving the change:

1. **Pre-membership-change preview** — an
   operator about to move `acme-prod` from
   `free` to `enterprise` runs
   `tenant policies acme-prod --vs-tier
   enterprise` to see EXACTLY what changes
   before the membership update commits.
2. **Override-shadow detection** — pair
   `--vs-tier --effective` to surface the
   canonical "your override is doing all
   the work" finding: when a tenant's
   per-tenant cost-ceiling override
   shadows the tier, BOTH sides of the
   synthetic diff show `effective.source
   = override` with identical ceilings.
   Operators see that the tier change
   has zero operational impact and
   either clear the override or accept
   the no-op.
3. **CI policy-drift gates** — pair
   `--vs-tier --exit-on-divergence` to
   catch tenants whose CURRENT tier
   differs from the intended tier; the
   divergence-exit semantic surfaces as
   exit 3 for the gate.

The existing `--diff <other-slug|uuid>`
already supports two-tenant comparisons,
but the "compare a tenant to a tier"
shape needs synthetic-RHS construction:
the right side is the SAME tenant with
only the tier swapped (retention +
override stay identical). Modeling it as
a third orchestrator (not a tweak of the
two-tenant diff) keeps the semantics
explicit.

## Decision

Add `--vs-tier <tier-id>` to `tenant
policies`. Mutually exclusive with
`--diff` (both define the RHS) and with
`--explain` (matches the existing ADR-
0283 rule). Composes with `--effective`,
`--format`, `--exit-on-divergence`,
`--threshold`.

### Synthetic RHS construction

```ts
const reportRhs: TenantPoliciesReport = {
  tenantId: resolvedLhs.tenantId,
  input: `vs-tier:${tierId}`,
  retention: reportLhs.retention,
  costCeiling: reportLhs.costCeiling,
  tier: tierDefinition,
  ...(effectiveFlag
    ? { effective: deriveEffectivePolicy(reportLhs.costCeiling, tierDefinition) }
    : {}),
};
```

- `tenantId` is the LHS tenant (same UUID
  on both sides).
- `input` carries a `vs-tier:` prefix so
  human + CSV output makes the synthetic
  nature obvious. Operators reading
  "Right: vs-tier:enterprise" know this
  isn't a second tenant.
- `retention` + `costCeiling` are
  IDENTICAL on both sides — only the
  tier changes. computePolicyFieldDiffs
  naturally surfaces zero retention/
  costCeiling diffs.
- `tier` is the lookup result from
  `meta.llm_cost_tiers WHERE tier_id =
  $1`. Shape matches
  `TenantTierMembershipRow` exactly so
  no coercion needed.
- `effective` (under `--effective`) is
  computed against the NEW tier — the
  precedence-walk result with the
  hypothetical tier substituted.

### Tier-definition lookup

New helper `gatherTierDefinition(conn,
tierId)` queries `meta.llm_cost_tiers`
directly (NOT via the membership join,
since we want the tier shape regardless
of whether THIS tenant currently
belongs). Returns `null` when the tier
doesn't exist; caller renders
`tenant policies --vs-tier: no tier with
id '<tierId>'` and exits 2.

### Diff render reuse

The existing `computePolicyFieldDiffs`,
`renderPoliciesDiffHuman`,
`buildPoliciesDiffCsvRows`, and JSON
envelope shape are reused as-is. To
avoid duplication, the format-branching
+ exit-code machinery from
`runTenantPoliciesDiff` was extracted
into `emitDiffOutput(command, ctx,
reportA, reportB)` — both orchestrators
call it. No behavioral changes; pure
refactor for reuse.

### No self-diff guard

`runTenantPoliciesDiff` rejects
self-diff (left and right resolve to
same tenantId) because operators
comparing a tenant to itself is almost
always a typo. `--vs-tier` does NOT
apply the guard: comparing a tenant's
current tier to its own current tier
yields empty fieldDiffs, which is the
USEFUL "moving here changes nothing"
answer — not a typo. Exit 0, human
output "No differences", JSON
fieldDiffs = []. Operators write
scripts like `if [ $(... --vs-tier
target --exit-on-divergence) -eq 0 ];
then echo "already on target tier";
fi`.

### Mutual exclusivity

- `--diff` + `--vs-tier`: both define
  the RHS. Rejected with exit 2 +
  clear error.
- `--explain` + `--vs-tier`: --vs-tier
  IS a what-if walk (the synthetic RHS
  already answers the what-if
  question); --explain's per-axis
  walk would muddle the diff semantics.
  Rejected with exit 2.
- `--effective` + `--vs-tier`: composes
  cleanly. Both sides get an effective
  field computed against their
  respective tier.
- `--format` (human|json|csv|tsv) +
  `--vs-tier`: composes via shared
  `emitDiffOutput`.

### Effective-source convergence

The canonical insight that motivates
pairing `--vs-tier` with `--effective`:
when a per-tenant cost-ceiling override
is set, the override shadows the tier
regardless of which tier the tenant is
in. So the synthetic RHS's effective
ceiling equals the LHS's effective
ceiling — both `effective.source =
override`. The tier change has zero
operational impact for ceilings.
Operators read this and either (a)
proceed knowing the tier change is
free, or (b) clear the override first
to let the tier take effect.

Without `--effective`, the diff shows
only the raw `tier.tierId` change,
which is operationally obvious.
`--effective` is where the value
emerges.

### CLI help text

Extended the existing `tenant policies`
block with a 9-line paragraph
documenting the synthetic-RHS shape,
the "what would change if I moved this
tenant to <tier-id>?" workflow, the
override-shadow detection pattern via
`--effective`, and the mutual-
exclusivity rules.

## Rejected alternatives

1. **Add a `--vs-tier <tier-id>
   --vs-no-override` flag that strips
   the override on the synthetic RHS
   to force the tier to take effect**
   — that's exactly what `--explain
   withoutOverride` already provides;
   --vs-tier composing with --explain
   would muddle semantics, and the
   --explain path is the right way
   to ask "what if I cleared the
   override?".

2. **Compute a `effective.diff` field
   in the JSON envelope under
   `--vs-tier --effective`** — adds
   API surface for a marginal
   readability gain. Operators
   reading both `left.effective` and
   `right.effective` see the answer
   directly; computing an extra
   diff field is redundant.

3. **`--vs-tier` accepts a comma-
   separated list of tier IDs for
   N-way comparison** — same scope
   concern as ADR-0282 Q1 (N-way
   --diff). Defer; if operators want
   to preview multiple tiers, they
   run the command N times. Pairs
   with ADR-0282 Q1 if both
   eventually ship.

4. **Resolve `--vs-tier <slug>` by
   tier displayName instead of
   tier_id** — tier_id is the
   canonical FK; displayName is
   human-friendly but not unique
   under schema constraints. Stick
   with tier_id.

5. **Reject `--vs-tier <currentTierId>`
   as a self-diff** — that's the
   useful "moving here changes
   nothing" answer, not a typo.
   Different semantic from
   `--diff <self>` which IS a typo.

6. **Emit a synthetic `vs-tier:` row
   in the human output explaining
   the synthesis context** — the
   "Right: vs-tier:enterprise" line
   already signals it. Extra
   explanation would be noise.

7. **Allow `--vs-tier none` to model
   tier removal** — useful but
   special-cases the input parsing.
   Operators wanting "what if I
   removed this tenant from its
   tier" run the existing
   `--explain` and read
   `explain.withoutTier`. Defer
   unless operator demand emerges.

8. **`--vs-tier-override <ceiling-
   spec>` to also override the
   ceiling synthetically** — too
   open-ended (the override has
   3 fields: maxUsdPerRequest,
   maxUsdPerWindow, windowSeconds).
   Operators wanting that workflow
   write a SQL migration in
   staging and re-run --vs-tier.

9. **Reject `--vs-tier` when the
   tenant has no current tier**
   — that's the useful "what if
   I added this tenant to a tier"
   workflow. Empty-tier LHS +
   tier-defined RHS yields a
   `tier.exists: false → true`
   diff, which is exactly the
   right output.

10. **Render `--vs-tier` output
    with a distinct envelope
    (`action:
    "tenant.policies.vs-tier"`)
    instead of reusing
    `tenant.policies.diff`** —
    the diff shape is the same;
    a separate action name
    fragments JSON consumers who
    handle policy diffs uniformly.
    The `input: "vs-tier:<tier-
    id>"` marker is enough to
    disambiguate.

## Drawbacks

- **Both sides of the diff have
  the same `tenantId`** — operators
  reading the JSON envelope's
  `left.tenantId` and `right.tenantId`
  might wonder why they match. The
  `right.input` marker
  (`vs-tier:enterprise`) is the
  disambiguator; documentation
  covers it in the CLI help.
- **`--vs-tier` and `--explain`
  rejection means operators wanting
  the full what-if surface (current
  tier + alternate tier + without-
  override + without-tier) run TWO
  commands** — one with `--vs-tier
  X --effective` and one with
  `--explain`. Acceptable v1
  trade-off; combining the two
  cleanly is non-trivial.
- **The synthetic RHS shares
  `costCeiling` + `retention` with
  the LHS** — modifications to one
  side's data structure would
  propagate (shallow copy). Not a
  concern in practice since
  `TenantPoliciesReport` is
  `readonly` throughout and the
  values are immutable, but worth
  noting if the shapes ever become
  mutable.
- **`emitDiffOutput` extraction is
  a pre-existing refactor for
  reuse** — slight behavioral
  surface area expansion (one
  more helper) for symmetric
  reuse between two orchestrators.
  Worth the simplicity.
- **`--vs-tier-id` would be a
  clearer flag name** —
  `--vs-tier` is concise but
  ambiguous: tier ID or tier
  displayName? CLI help
  disambiguates; the alternative
  is a longer flag name.

## Future Qs

1. **N-way `--vs-tier free
   --vs-tier pro --vs-tier
   enterprise`** for multi-tier
   preview matrix. Pairs with
   ADR-0282 Q1 (N-way --diff).
   Both share the "what's the
   exit code semantic with
   multiple comparisons?"
   problem.

2. **`--vs-tier <tier-id>
   --vs-no-override` to model
   tier-change AND override-clear
   simultaneously** — combines
   --vs-tier with --explain's
   withoutOverride walk. Adds
   API surface; defer.

3. **`--vs-tier-effective-only`
   flag emitting just the
   effective-ceiling change
   (suppresses raw tier.tierId
   diff)** — pairs with the
   --csv-effective-only future Q
   from ADR-0285. Useful for
   bulk policy-impact
   reporting.

4. **Bulk preview: `tenants list
   --vs-tier enterprise` to
   preview tier-impact across
   ALL tenants** — pairs with
   the bulk-export surface
   from ADR-0285 Q4 +
   future tenants-list
   extensions. Defer.

5. **`--vs-tier` against a
   tier from a different
   environment (staging tier
   def vs prod tenant)** —
   adds a `--tier-source
   <url>` complexity that
   the substrate doesn't
   support today. Defer.

6. **Render the tier-policy
   delta inline in human
   output (numeric ceiling
   change deltas)** — useful
   when operators want
   "$0.05/req → $5.00/req
   (+9900%)" rendering.
   Pairs with a broader
   numeric-delta render
   feature. Defer.

7. **GitHub Actions
   integration:
   `tenant policies <tenant>
   --vs-tier <target>
   --exit-on-divergence
   --format json` to gate
   tier migrations on
   override clearing** —
   already works with the
   existing exit-3 semantic;
   could add a `--gh-summary`
   render path emitting
   Markdown ready for GHA.
   Pairs with broader
   summary-md feature.
