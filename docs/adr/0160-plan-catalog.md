# ADR-0160: Declarative plan catalog — the single source of plan → limits

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0159 (operate-server webhook route), ADR-0158 (webhook connector), ADR-0153 (plan record limits), ADR-0149 (entitlement gate) |

## Context

Plan limits — a per-entity record cap + feature flags — were resolved **ad-hoc** everywhere they
were needed: from license claims (the offline minter), from Stripe subscription metadata
(`max_records_per_entity`, `features`), and from a deployment-supplied `PlanLimitsLookup` the
webhook connector accepted but nobody supplied. There was no declarative source that said "plan
`pro` caps entities at 100k and grants advanced reporting." This is the follow-up ADR-0158/0159
flagged: **a plan-catalog source for `planLimits`.**

## Decision

- **`plan-catalog.ts` in `operate-runtime`** (pure, zod). A `PlanDefinition` (`{id, name,
  maxRecordsPerEntity?, features[], stripePriceIds[]}`) and a `PlanCatalog` class that indexes
  plans by id **and** by the Stripe price ids that map to them, so `resolve(planId)` and
  `limitsFor(planId)` answer for either a plan id or a price id — exactly what the webhook needs
  (a subscription event's plan is a Stripe price). `PlanCatalog.toLookup()` returns a
  `PlanLimitsLookup` usable directly as the webhook's `planLimits`. `buildPlanCatalog(doc)`
  parses + validates a `{plans:[...]}` document; `DEFAULT_PLAN_CATALOG` ships a free / pro /
  enterprise ladder a deployment overrides with its own price ids + caps.
- **`PlanLimitsLookup` is now canonical in `operate-runtime`.** `operate-runtime-pg`'s
  `stripe-webhook.ts` imported its own structural copy; it now imports (and re-exports, for API
  stability) the type from `operate-runtime` — one definition, no drift.
- **`operate-server --plan-catalog <file>`.** Loads a catalog JSON at boot and passes
  `catalog.toLookup()` as the webhook's `planLimits`, so a Stripe subscription event resolves its
  record cap + features from the declarative catalog (by plan or price id), falling back to the
  subscription's own metadata when the plan is unlisted. The flag requires
  `--stripe-webhook-secret` (its only consumer today) and errors otherwise, so a misconfiguration
  is never a silent no-op.

## Consequences

- One declarative source of plan limits now feeds the cloud path end-to-end: `--plan-catalog
  plans.json` → webhook resolves caps by price id → snapshot carries the cap → the gate enforces
  it. The offline license minter and the console can read the same catalog next (follow-ups).
- The catalog is pure `operate-runtime` (no billing dep), matching the redaction-registry
  pattern — a deployment supplies the document; the runtime just resolves against it.
- 6,745 tests pass (+15: catalog resolve-by-id / resolve-by-price / limits / unlimited / lookup /
  list / build-validation / default-ladder, and the operate-server flag parse + requires-webhook
  guard). Full build + typecheck green.
- Follow-ups: draw license-mint limits from the catalog too (a `--plan` in the licensor CLI
  resolving caps from the catalog); surface the catalog on the console Billing screen for the
  "N of M used" meter; a per-tenant plan-override source.
