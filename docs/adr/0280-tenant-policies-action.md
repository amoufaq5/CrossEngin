# ADR-0280: `crossengin tenant policies <slug|uuid>` action

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0276 Q3 (closes), ADR-0277 Q2 (closes), ADR-0276 (host `tenant` singular subcommand), ADR-0279 (sibling `tenants get`), ADR-0155 + ADR-0137 + ADR-0144 (source-of-truth substrates for the three policy axes) |

## Context

ADR-0276 shipped `crossengin tenant housekeeping` as the
cross-dashboard per-tenant view; the deferred Q3 carved
out a complementary policy summary:

> "`tenant policies <slug|uuid>` — full policy summary
> surface for one tenant covering retention + cost
> ceiling + rate-limit + future substrate policies."

ADR-0277 Q2 expressed the same gap from the tenants-
plural side. Three operator workflows accumulated demand:

1. **One-tenant compliance audit** — auditors verifying
   "what policies are configured for tenant X across
   all substrate axes?" without running 3-4 separate
   commands and stitching outputs.
2. **Tenant offboarding pre-check** — operators ending
   an engagement want a single envelope showing every
   piece of configured state to verify nothing surprising
   remains.
3. **Tier migration verification** — after moving a
   tenant from `free` to `enterprise`, operators want
   one command showing the new tier resolved with its
   policy shape PLUS any per-tenant override that
   would shadow it.

Currently operators run `retention list-policies
--tenant X` for retention, raw SQL against
`meta.llm_cost_ceilings` + `meta.llm_tenant_tier_memberships
JOIN meta.llm_cost_tiers` for cost policy, and manually
correlate. The three axes have substrate-level support
already (the retention adapter from ADR-0155, the
cost-ceiling resolver from ADR-0137, the tier substrate
from ADR-0144). The CLI gap is the unifying envelope.

## Decision

Add `crossengin tenant policies <slug|uuid>` as the
second action on the `tenant` (singular) namespace.
Aggregates three policy axes under one envelope:

1. **Retention overrides** — per-table
   `tenant_retention_policies` rows filtered to this
   tenant. Reuses `PostgresTraceRetention.listTenantPolicies()`
   with client-side `.filter()` by tenantId.
2. **Cost ceiling override** — zero or one row from
   `meta.llm_cost_ceilings` (PK on tenant_id).
3. **Tier membership** — zero or one row from
   `meta.llm_tenant_tier_memberships JOIN meta.llm_cost_tiers`
   (PK on tenant_id, FK to tiers with ON DELETE
   RESTRICT so the JOIN always resolves when a
   membership row exists).

Slug input resolves via `resolveTenantIdentifier`
(inherits M4.14.j "did you mean" suggestions). UUID
input short-circuits the resolve step.

### Output

- **Human** — three multi-section blocks with `===
  Section header ===` delimiters and placeholders for
  empty axes (`(no per-tenant retention overrides —
  inherits platform defaults)`, `(no per-tenant
  override — inherits from tier or global)`, `(no
  tier membership — inherits global ceiling)`).
  Per-axis content uses `key: value` with column-
  aligned padding.
- **JSON** — `{action: "tenant.policies", tenantId,
  input, retention: {tables: ...}, costCeiling:
  TenantCostCeilingRow | null, tier:
  TenantTierMembershipRow | null}`. `null` for empty
  axes (stable consumer parsing — operators don't
  need defensive existence checks).

### Concurrency

Three queries (retention + cost ceiling + tier) fire
via `Promise.all`. They share the PG connection
which is request-serial so this effectively
interleaves rather than parallelizes, but the code
shape mirrors how independent gather closures
compose elsewhere in the codebase.

### NUMERIC(18,8) precision preservation

Cost ceilings + tier policy use NUMERIC(18,8) for
sub-cent precision. The substrate casts to TEXT via
SQL `column::TEXT` (matching the pattern from
`PostgresCostCeilingResolver`) and exposes as
`string | null` in the envelope. JavaScript Number
would lose precision past ~15 significant digits;
strings round-trip cleanly. Operators consuming JSON
parse with BigDecimal at their layer; human format
renders verbatim.

### Why not include rate-limit per-tenant overrides

The substrate has NO per-tenant rate-limit override
table today. Rate-limit policy is platform-defined in
the gateway runtime; tenant variation goes through
tier membership (the tier's `max_usd_per_window` +
`window_seconds` indirectly shape rate semantics, but
there's no per-tenant rate-limit-policy override
distinct from the cost ceiling). When/if such a
substrate ships, adding a fourth section to this
action is mechanical. Documented as Q1.

### Why filter retention client-side

`PostgresTraceRetention.listTenantPolicies()` returns
all rows across all tenants. At ≤ 1K per-tenant policy
rows (typical deployment scale), filtering in-process
by tenantId is microsecond-cheap. Avoiding a new
adapter method keeps the substrate surface narrow.
Server-side filtering can be added later if measured
slow at larger deployments. Mirrors the retention
housekeeping pattern from ADR-0264.

### Why a separate `tenant policies` action vs extending
### `tenant housekeeping` with `--with-policies`

Housekeeping answers "what's the operational state of
substrate tables?" (row counts, prune candidates,
last-pruned timestamps). Policies answers "what's
configured?" (override rows, tier assignments,
opt-out state). Different conceptual questions;
mixing them under one action would bloat output and
confuse `--threshold-alert` semantics (alerts trip on
operational drift, not policy presence). Separate
actions match the operator mental model.

### Help text

Added to `cli.ts` helpText after `tenant
housekeeping`:

```
  tenant policies <slug|uuid>
                          Per-tenant cross-substrate policy summary:
                          aggregates retention overrides + cost-ceiling
                          override + tier membership for one tenant
                          under one envelope. Resolves slug→UUID via
                          the same path as `tenants resolve` (inherits
                          'did you mean' suggestions on slug typos).
                          Output: human key:value sections with
                          placeholders for empty axes, or JSON envelope
                          with all three axes preserved.
                          (requires PG env)
                          Rate-limit per-tenant overrides not included
                          in v1 (substrate has no per-tenant override
                          table today; tenant variation goes through
                          tier membership).
```

## Rejected alternatives

1. **Extend `tenant housekeeping` with `--with-policies`
   flag** — conflates two conceptual questions
   (operational state vs configured state). Separate
   actions keep output focused + threshold-alert
   semantics clean.

2. **Include rate-limit per-tenant overrides via JOIN
   against a hypothetical substrate** — no per-tenant
   override substrate exists today. Documented as Q1.

3. **Server-side WHERE tenant_id = $1 filter on
   retention via a new adapter method** — premature
   optimization at typical scale; client-side filter
   keeps substrate surface narrow.

4. **Return all per-tenant ceiling history rows** —
   the cost-ceiling table has `effective_from` but PK
   on `tenant_id` (one current row max). The history
   substrate doesn't exist yet. Q3.

5. **Resolve cost ceiling via
   `PostgresCostCeilingResolver.resolveDetailed`** —
   that resolver applies the precedence walk
   (override → tier → global → none) and returns the
   EFFECTIVE policy. `tenant policies` wants the RAW
   configured rows per axis so operators can see what
   would shadow what. Documented in Q4 as a sibling
   `--effective` flag possibility.

6. **Emit residency / search_locale / status from
   meta.tenants too** — those are tenant-row
   attributes, not policies. Operators wanting those
   use `tenants get <slug|uuid>` (M4.14.i).

7. **Render NUMERIC as JS number** — would lose
   precision at high values. String preserves the
   canonical wire shape.

8. **One huge SQL query joining all three axes** —
   would force per-table OUTER joins making the
   query plan opaque. Three focused queries are
   simpler + each substrate maintains its own data
   access.

9. **Render tiers' policy IF override is present** —
   the override SHADOWS the tier but the tier is
   still useful context (operators verifying the
   tier assignment came through correctly). Both
   sections render when both exist.

10. **JSON envelope omits `null` axes** — would
    force consumers to check existence per key.
    Always emitting `null` for empty axes is
    stable-shape friendly.

## Drawbacks

- **Three PG queries per call** — minor; ~3ms total
  on an interactive audit path. Could be optimized
  to a single multi-CTE query if measured slow.
- **Client-side retention filter at large scale** —
  fetches all per-tenant policy rows; at 10K-tenant
  deployments with ~6 tables average that's 60K rows
  / ~3MB. Future Q for server-side WHERE filter.
- **No effective-policy view** — operators wanting
  "what policy is ACTUALLY enforced after precedence
  resolution?" need to mentally apply the override-
  beats-tier-beats-global rule. Q4 covers a sibling
  `--effective` flag.
- **`tenant policies` typed as `unknown` on residency
  field** — wait, residency isn't included; that's
  `tenants get`. No drawback here.
- **Cost-ceiling timestamp pinned via SQL `to_char`
  cast** — adds an extra column transformation in the
  SELECT for format consistency. Same pattern as
  ADR-0279 for `tenants get`.
- **No rate-limit axis** — documented; future Q.

## Future Qs

1. **Rate-limit per-tenant override axis** — when a
   per-tenant rate-limit policy substrate ships, add
   a fourth section + envelope key.

2. **`--effective` flag rendering precedence-resolved
   policy** — show what the runtime actually
   enforces vs the raw configured rows. Pairs with
   `PostgresCostCeilingResolver.resolveDetailed` from
   ADR-0154.

3. **Cost-ceiling history axis** — if `meta.llm_cost_ceilings`
   gains an append-only history sibling, surface
   prior overrides + `effective_from` timeline.

4. **`--watch` for live policy refresh during
   incident monitoring** — operators correlating
   policy changes with substrate behavior during
   tier migration. Defer.

5. **`--diff <other-tenant>` comparing two tenants'
   policy shapes** — operators verifying cohort
   uniformity. Defer.

6. **CSV/TSV output** — single-row exports for
   spreadsheet correlation. Defer; JSON + jq
   covers it.

7. **YAML output** — nested envelope renders
   cleanly. Defer; pairs with ADR-0241 Q3 (yaml
   for chat/gateway/apply surfaces).

8. **`tenant policies-history <slug|uuid>` append-
   only audit of policy changes** — requires
   policy-change history substrates that don't
   exist yet for cost ceilings + tier memberships.
   Pairs with ADR-0170 retention history.
