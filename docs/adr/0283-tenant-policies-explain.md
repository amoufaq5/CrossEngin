# ADR-0283: `tenant policies --explain` what-if precedence walk

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-30 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0281 Q1 (closes), ADR-0281 (effective view foundation), ADR-0280 (host action), ADR-0282 (sibling --diff), ADR-0137 (cost ceiling precedence) |

## Context

ADR-0281 shipped `tenant policies --effective`
showing the precedence-resolved ceiling
(override→tier→none) for one tenant. Q1 carved
out a what-if extension:

> "`tenant policies --explain` mode surfacing
> 'what would change if you removed the override'
> by computing the precedence walk with the
> override stripped. Useful for operators
> planning to clear an override."

Operator workflows driving this:

1. **Override redundancy audit** — operator
   inherits a cost-ceiling override and wonders
   "is this actually doing anything different
   from what the tier produces?" Runs --explain;
   compares `effective` (with override) to
   `explain.withoutOverride` (without). Same
   answer → override is redundant and can be
   cleared. Different answer → override is
   actively shadowing the tier.
2. **Pre-deletion verification** — operator
   planning to delete an override runs --explain
   to preview the post-deletion ceiling before
   committing the change. Avoids the
   "configure → measure → revert" loop.
3. **Tier offboarding preview** — operator
   moving tenant out of a tier runs --explain
   to read `withoutTier` and confirm the
   tenant's override (if any) will still
   provide a ceiling, OR that the runtime
   will fall back to the router-level global
   (which may be permissive enough that the
   demotion is safe).

## Decision

Add `--explain` boolean flag to `tenant policies`.
When set, derive a two-scenario what-if block
client-side from the already-fetched raw axes by
calling `deriveEffectivePolicy` twice with each
input stripped to null. Pure function over the
existing report data — no extra PG query.

### Algorithm

```ts
function deriveExplainView(
  costCeiling: TenantCostCeilingRow | null,
  tier: TenantTierMembershipRow | null,
): TenantPolicyExplain {
  return {
    withoutOverride: deriveEffectivePolicy(null, tier),
    withoutTier: deriveEffectivePolicy(costCeiling, null),
  };
}
```

Both scenarios share the same `TenantPolicyEffective`
discriminated union from ADR-0281; the same
`source: override|tier|none` semantics apply
unchanged. Composing `deriveEffectivePolicy` with
stripped inputs gives us the what-if walk for
free — no parallel implementation, no drift risk.

### `--explain` implies `--effective`

Operators reading the what-if walk almost always
want the current effective view as the baseline
(otherwise the comparison is impossible).
Requiring both flags is friction; instead,
`--explain` force-enables `--effective`:

```ts
const explainFlag = getBooleanFlag(command, "explain");
const effectiveFlag = getBooleanFlag(command, "effective") || explainFlag;
```

Passing both flags is harmless (effective remains
on).

### `--explain` + `--diff` rejected in v1

Combining what-if with side-by-side comparison
muddles the mental model: which side gets
explained? Both? Selectively? Rejected with a
clear error:

> tenant policies: --diff and --explain are
> mutually exclusive in v1 (run --explain
> against each side separately)

Future Q could enable the combination if a
single-axis selection emerges (e.g.,
`--explain-left` / `--explain-right`).

### Output

- **JSON** — new `explain: TenantPolicyExplain`
  field on the envelope, only present when
  `--explain` was set:
  ```json
  {
    "explain": {
      "withoutOverride": { "source": "tier", "ceiling": {...}, "tierId": "pro" },
      "withoutTier": { "source": "override", "ceiling": {...} }
    }
  }
  ```
- **Human** — new
  `=== Explain (what-if precedence walk) ===`
  section appended after the `=== Effective
  policy ===` section. Each scenario renders
  on one line:
  ```
    without override: source=tier  req=$1.00000000 USD  win=$200.00000000 USD  windowSec=86400  tier=pro
    without tier:     source=override  req=$0.10000000 USD  win=$50.00000000 USD  windowSec=3600
  ```
  `source=none` scenarios collapse to a
  placeholder:
  ```
    without override: source=none  (falls back to router-level global)
  ```

### Why these two scenarios

`withoutOverride` and `withoutTier` cover the
operator's "what if I clear input X?" question
for the two substrate-level policy inputs.
`withoutBoth` is implicit (always `source: none`)
and adds zero signal — the substrate has nothing
to say, runtime falls back to the router-level
global config. Surfacing it would be noise.

`withAddedOverride` / `withAddedTier` are not
included — those are forward-projection
questions ("if I added an override of X, what
would happen?") which require operator-supplied
hypothetical values. That's a different surface
("preview an override" → `tenants policies set
--dry-run`) and out of scope here.

## Rejected alternatives

1. **`--explain` takes an axis arg
   (`--explain override` vs `--explain tier`)** —
   would let operators ask only one question at
   a time. Both scenarios fit on two lines;
   forcing operator choice is friction for
   negligible output cost.

2. **`--explain` does NOT imply `--effective`** —
   would force operators to pass both flags
   together. The baseline (`effective`) is
   needed for the comparison to make sense;
   implying it removes friction with no loss
   of clarity.

3. **Surface a `wouldChange` boolean (e.g.
   `clearingOverrideWouldChange: true`)** —
   computable via simple visual comparison;
   adds API surface + test surface for
   convenience. Defer until script-driven
   consumers ask.

4. **Include `withAddedOverride` /
   `withAddedTier` forward-projection
   scenarios** — requires operator-supplied
   hypothetical values; different command
   surface entirely (e.g., a `--preview-set`
   flag). Out of scope.

5. **Server-side what-if via a dedicated SQL
   function** — PG complexity for zero
   observable difference at typical scale.
   Client-side derivation reuses
   `deriveEffectivePolicy` and is
   trivially correct.

6. **Allow `--explain` + `--diff` to render
   both reports' explain blocks** — muddles
   the diff focus (which side's what-if
   matters?). Operators wanting both run
   `--explain` against each side separately.

7. **Render `withoutBoth` scenario explicitly
   even though it's always `source: none`** —
   noise. The substrate "no policy" → runtime
   global is self-evident from the structure.

8. **Make `--explain` default-on (always
   compute)** — adds output noise for the
   common case where operators just want
   `tenant policies <slug>` to show raw axes.
   Opt-in matches the M4.14.g + M4.14.f
   pattern.

9. **Compute explain as a property of the
   effective field
   (`effective.alternatives.withoutOverride`)**
   — couples two opt-in views into one shape.
   Separating preserves backward compat for
   M4.14.g consumers and lets operators
   request what they need.

10. **Render explain values in human format
    with full `key: value` per-line layout
    (like the effective block)** — would
    triple line count per scenario. Single-
    line summary is dense but readable;
    operators wanting per-field detail use
    JSON.

## Drawbacks

- **Two flags doing related-but-distinct things
  (`--effective` and `--explain`)** — operators
  must learn both. `--explain` implies the other
  so the common path is fine, but the API
  surface grows.
- **Mutually exclusive with `--diff` means
  operators investigating "do these two tenants
  enforce the same thing AND would clearing
  their overrides change anything?" run two
  commands** — acceptable trade-off; the
  combined view design is non-trivial.
- **The single-line human renderer is
  information-dense and harder to skim than the
  multi-line effective block** — operators
  wanting detail use JSON. Single-line
  preserves vertical density.
- **`source: none` placeholder lies slightly
  about the runtime behavior** — strictly the
  runtime applies a router-level global which
  the substrate doesn't know about. Documented
  in the placeholder text ("falls back to
  router-level global") but operators auditing
  the actual enforced ceiling need to read
  operator config.
- **Two scenarios doubles the surface to test
  vs `--effective` alone** — addressed via
  pure-function composition; tests exercise
  the same `deriveEffectivePolicy` logic just
  with different inputs.

## Future Qs

1. **`--explain` + `--diff` cross-tenant
   what-if comparison** — render both sides'
   explain blocks under one envelope, with a
   second-order diff on the what-if results.
   Useful for migration planning across
   tenants but complex output design.

2. **`--explain --axis override` arg to
   render only one scenario** — defer until
   operator output-width complaints surface.

3. **Forward-projection scenarios
   (`--preview-override`)** — requires
   operator-supplied hypothetical values; a
   different command surface. Pairs with a
   future `tenants policies set --dry-run`
   action.

4. **`explain.wouldChange` boolean field for
   script consumers** — easy add if demand
   emerges; computable client-side from
   `effective` vs scenario equality.

5. **`--explain` for retention** — retention
   has its own per-table precedence
   (override-or-platform); a `withoutOverride`
   for retention would surface "what platform
   default would apply if you cleared this
   per-tenant override?" Pairs with
   `effectiveRetention` from ADR-0159 if
   operators ask.

6. **Render explain values as a structured
   YAML table in human format** — operators
   skimming long lines might prefer a multi-
   line layout. Defer; YAML output is also
   reachable via `--format yaml` (currently
   not wired through tenant policies but
   trivially addable).

7. **Persist explain outputs to an audit
   table when an operator is about to clear
   an override (e.g., via
   `tenants policies clear --record-explain`)**
   — out of scope; pairs with a future
   audit-log surface.
