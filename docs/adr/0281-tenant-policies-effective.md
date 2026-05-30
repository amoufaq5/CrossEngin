# ADR-0281: `tenant policies --effective` precedence-resolved view

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0280 Q2 (closes), ADR-0154 Q1 (closes — applies to a CLI consumer), ADR-0280 (host action), ADR-0137 + ADR-0144 (substrate-level cost ceiling + tier substrates) |

## Context

ADR-0280 shipped `tenant policies <slug|uuid>` showing
raw configured rows per axis (retention overrides, cost
ceiling override, tier membership). The deferred Q2
carved out an effective-policy view:

> "`--effective` flag rendering precedence-resolved
> policy — show what the runtime actually enforces vs
> the raw configured rows. Pairs with
> `PostgresCostCeilingResolver.resolveDetailed` from
> ADR-0154."

ADR-0154 Q1 also pointed at this from the substrate
side:

> "Future enhancement: a RouterInstrumentation event
> kind='ceiling_resolved' emitted automatically from
> DefaultLlmRouter.enforceCeilingPreflight, building on
> this synchronous foundation."

That event surface shipped in ADR-0157; this milestone
ships the corresponding CLI surface for the
`resolveDetailed` shape so operators can preview at
authoring time what the runtime will emit at request
time.

Real operator workflows for the effective view:

1. **Override-vs-tier audit** — operators viewing a
   tenant with BOTH an override and a tier membership
   want to verify the override is shadowing the tier
   as expected (not the other way around — the
   precedence rule applies but glancing at raw rows
   doesn't make this explicit).
2. **Post-migration verification** — after promoting
   a tenant from `free` to `enterprise`, operators
   want one number to confirm "what ceiling is
   actually enforced now?"
3. **Compliance attestation** — auditors asking "what
   policy applies to tenant X" want a single
   precedence-resolved answer, not three rows they
   must mentally combine.

## Decision

Add `--effective` boolean flag to `tenant policies`.
When set, derive the precedence-resolved policy
client-side from the already-fetched raw axes and add
an `effective` block to the report — NO extra PG
query. Backward compatible — omitting `--effective`
leaves the envelope shape unchanged.

### Algorithm

Pure precedence walk, identical to
`PostgresCostCeilingResolver.resolveDetailed`:

```ts
function deriveEffectivePolicy(
  costCeiling: TenantCostCeilingRow | null,
  tier: TenantTierMembershipRow | null,
): TenantPolicyEffective {
  if (costCeiling !== null) {
    return { source: "override", ceiling: { ...costCeiling fields... } };
  }
  if (tier !== null) {
    return {
      source: "tier",
      ceiling: { ...tier policy fields... },
      tierId: tier.tierId,
    };
  }
  return { source: "none" };
}
```

The `"none"` variant has NO `ceiling` field — runtime
falls back to the router-level global config which
lives outside the substrate (the `DefaultLlmRouter`
constructor's `costCeiling` option). Operators reading
"source: none" know the substrate has nothing to say
about this tenant and the router will apply its
default.

### TypeScript discriminated union

`TenantPolicyEffective` is a 3-way discriminated union
on `source`:

```ts
export type TenantPolicyEffective =
  | { source: "override"; ceiling: TenantPolicyEffectiveCeiling }
  | { source: "tier"; ceiling: TenantPolicyEffectiveCeiling; tierId: string }
  | { source: "none" };
```

Consumers narrow on `source` to access `ceiling` (only
present for `"override"` and `"tier"`) and `tierId`
(only present for `"tier"`). Mirrors the
`CostCeilingResolution` shape from ADR-0154 so
operators reading the substrate-level resolver source
see the same contract.

### Output

- **Human** — new `=== Effective policy (source: X)
  ===` section appended after the existing three.
  Shows the resolved ceiling values (max per request,
  max per window, window seconds, optional tier id);
  `"none"` renders the placeholder `(no per-tenant or
  tier policy configured — runtime falls back to
  router-level global)`.
- **JSON** — new `effective: TenantPolicyEffective`
  field on the envelope. Only present when
  `--effective` was set; consumers detect via key
  existence.

### Why client-side derivation, not a 4th PG query

The data is already in the report (cost ceiling +
tier rows). A second `resolveDetailed` call would
re-issue the same two queries the report already
made. Pure waste. Mirroring the resolver's CONTRACT
without re-issuing its QUERIES is the right
abstraction here — the substrate and the CLI both
implement the same precedence walk against the same
data.

The CLI-side function is `deriveEffectivePolicy` and
is unit-testable as a pure function over the two
input rows. Verified by the `does NOT issue an extra
PG query` test which asserts only 2 queries fire.

### Help text

Updated `cli.ts` helpText with `[--effective]` in the
usage line and a 3-line description explaining the
override→tier→none walk + the
`resolveDetailed` source attribution mirror.

## Rejected alternatives

1. **Wire `PostgresCostCeilingResolver.resolveDetailed`
   directly via ai-router-pg dependency** — would
   re-issue the same queries the report already made
   AND add a cross-package dependency to architect-
   cli for a 5-line precedence walk. Client-side
   derivation is the right abstraction.

2. **Always emit `effective` in the envelope** —
   breaks backward compat for ADR-0280 consumers
   parsing the envelope shape. Opt-in via flag
   preserves the existing contract.

3. **Render `effective` as a flat `{maxUsdPerRequest,
   ..., source}` shape** — would emit `source: none`
   alongside null ceiling fields, losing the
   "definitely no policy" vs "policy with null
   fields" distinction. Discriminated union makes the
   absence explicit.

4. **Default `--effective` ON** — would hide the raw
   rows from auditors who specifically want to verify
   "what's CONFIGURED" rather than "what's
   ENFORCED." Raw-rows-by-default + opt-in effective
   matches the operator mental model.

5. **`--only-effective` flag suppressing the three
   raw axes** — would force operators wanting just
   the effective view to pipe through `jq` to extract.
   The 4-section output isn't too verbose; operators
   wanting brevity use JSON + jq.

6. **Include retention precedence in the effective
   view** — retention is per-table not per-tenant;
   there's no single "effective retention policy"
   for a tenant. The retention block already shows
   per-table effective state (override-or-platform-
   fallback is per-row not requiring a precedence
   walk).

7. **`--effective` emits a structured `policySource`
   audit log** — out of scope; operators wanting
   audit-grade attribution use the
   `ceiling_resolved` instrumentation event from
   ADR-0157.

8. **Render the global router-level ceiling under
   `source: none`** — the substrate doesn't know the
   router's constructor config; emitting a value
   would force the CLI to read operator
   configuration outside its substrate scope.
   `(no per-tenant or tier policy configured —
   runtime falls back to router-level global)` is
   the right placeholder.

9. **Promote `source: tier` to include the tier's
   policy as a nested object alongside the resolved
   ceiling** — adds redundancy (tier policy is
   already in the `tier` section). Just echo
   `tierId` and let consumers cross-reference.

## Drawbacks

- **Opt-in via flag means default consumers don't
  see the precedence-resolved view** — documented;
  operators who want it pass `--effective`.
- **No "diff against tier" view showing what the
  override is shadowing** — operators see both the
  override and the tier in the raw sections and the
  resolved override in the effective section; the
  comparison is mental. Q1 covers an `--explain` mode
  that could surface this explicitly.
- **TypeScript discriminated union forces consumers
  to narrow on `source` before accessing `ceiling`**
  — that's the point. Type-system enforcement of
  the precedence semantic.
- **`source: "none"` has no ceiling field** —
  consumers expecting `effective.ceiling` to always
  exist must narrow. Mirrors the resolver contract.
- **No precedence-source-attribution INSIDE the
  retention block** — retention has its own
  per-table precedence (override-or-platform-
  fallback) but it's already explicit in the row
  shape (`retentionDays` is either the per-tenant or
  the inherited platform value depending on the
  fetch path). Cost-ceiling precedence needs the
  explicit `source` field because the same ceiling
  value could come from override, tier, or runtime
  global.

## Future Qs

1. **`tenant policies --explain` mode** — surface
   "what would change if you removed the override"
   by computing the precedence walk with the
   override stripped. Useful for operators planning
   to clear an override.

2. **Render the router-level global ceiling under
   `source: none`** — if operators wire the router's
   `costCeiling` into a known location (env var,
   config file), the CLI could read it and surface
   the effective value. Defer until operator demand
   emerges.

3. **`--effective` for retention** — currently
   retention's effective state is per-table not per-
   tenant, but a future `--effective` flag could
   surface "what retention would the runtime use
   for tenant X on table Y after fall-through to
   platform default?". Pairs with `effectiveRetention`
   from ADR-0159.

4. **CSV/TSV output for the effective view** —
   single-row policy summary cleanly fits CSV.
   Defer; pairs with ADR-0280 Q6.

5. **`tenant effective-policy <slug|uuid>` as a
   standalone action** — operators who ALWAYS want
   the effective view could prefer a dedicated
   action over a flag. Defer; usage will tell us.

6. **Surface the `effective_from` timestamp on
   `source: "override"`** — would let auditors see
   when the override became active. The cost ceiling
   row already has it (rendered in the raw section).
   Adding it to the effective view is mechanical.
   Defer.
