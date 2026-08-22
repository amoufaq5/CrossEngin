# ADR-0268: AI-onboarding hardening — observability parity, DB-enforced activation, cross-replica invalidation, spend ceilings (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0267 (AI onboarding), ADR-0060/0062 (SLO enforcement), ADR-0057 (Architect cost ledger), ADR-0077 (Phase 4) |

## Context

ADR-0267 shipped per-tenant AI-designed manifests and left four production gaps on its
follow-up list, three of which are correctness or cost exposures rather than polish:

- **Observability was default-server-only.** A tenant that activated a custom manifest was
  served by a gateway built without the per-request observer chain, so its traffic produced no
  SLO burn/latency signal, no usage metering (i.e. no billing), and no audit-chain entries —
  silently exempting exactly the tenants doing the most novel things.
- **"One active manifest per tenant" was application-enforced only** (an advisory lock added
  during the ADR-0267 review), with nothing stopping a stray writer.
- **Activation was replica-local.** Replica A invalidated its own cache; B and C kept serving
  the previous manifest for up to the 30s TTL.
- **`POST /v1/ai/design` had no spend limit.** A tenant admin could loop it against a metered
  provider with no ceiling.

## Decision

- **Observability parity (`node.ts`)** — tenant gateways are now built with the same
  cross-cutting wiring as the default server: `onExecution` (SLO burn + latency, usage
  metering, audit chain), `additionalWriteEffects`, and job invocation, alongside the extra
  routes / entitlement gate / region guard added during the ADR-0267 review. Only the
  deployment-wide singletons that are not per-request (the Stripe webhook and billing-portal
  routes) remain on the default server, which still serves them for every tenant.
- **Partial indexes in the kernel** — `IndexSpec` gains an optional `where`, and the DDL
  emitter appends `WHERE <expr>` to `CREATE INDEX` (output byte-identical when absent).
  `META_OPERATE_TENANT_MANIFESTS` uses it for
  `uq_operate_tenant_manifests_active` — `UNIQUE (tenant_id) WHERE status = 'active'` — making
  the invariant a database constraint behind the advisory lock. No new table (still 137).
- **`ManifestActivationPoller`** — one cross-tenant aggregate per interval
  (`SELECT tenant_id, MAX(activated_at) … WHERE status = 'active' GROUP BY tenant_id`, a
  platform sweep, deliberately outside `withTenantContext`) diffed against an in-process
  watermark map. A changed or new watermark invalidates that tenant's cache entry; a tenant
  that *disappears* (its active manifest was archived) is invalidated once and dropped. The
  first poll primes the baseline silently. Cost is independent of tenant count. Enabled by
  `--manifest-refresh-ms` (≥1000); TTL-only remains the default.
- **`buildAiDesignBudget`** — a per-tenant monthly USD ceiling over
  `meta.architect_tenant_cost` via the existing `PostgresTenantCostStore` (atomic
  `INSERT … ON CONFLICT`, tenant-RLS, cross-node), so no new table and the ledger is shared
  with the Architect CLI. `POST /v1/ai/design` checks before the LLM call (**402
  `ai_budget_exceeded`**, fail-closed on a ledger read error) and records actual usage after —
  including on a failed design, because the tokens were spent either way. Ceiling via
  `--ai-max-usd-per-month` (default $25).

## Consequences

- Activating an AI-designed system no longer removes a tenant from enforcement, billing, or the
  tamper-evident audit trail — the gap that would have made per-tenant manifests unshippable
  for a metered or compliance-bound deployment.
- Two independent guards now hold the activation invariant: the advisory lock serializes the
  read-modify-write, and the partial unique index makes a second active row impossible.
  Partial-index support is a general kernel capability other tables can now use.
- Multi-replica deployments converge on activation within one poll interval instead of one TTL,
  at one query per interval regardless of tenant count.
- AI spend is bounded per tenant and durable across restarts and replicas; the denial is an
  explicit 402 rather than a silent failure or an unbounded bill.
- +46 tests (kernel +7 → 582; operate-server +54 → 596 across 39 files): emitter partial-index
  cases, the new index shape, observability parity through a per-tenant dispatch, poller
  semantics (baseline, change, disappearance, error recovery, timer lifecycle), budget
  semantics (fail-closed check, best-effort record, period rollover), the 402 gate, and the two
  new CLI flags. Full workspace build + typecheck + test green.
- Follow-ups still open from ADR-0267: the Stripe webhook / billing-portal routes on tenant
  gateways, a platform-level review queue for AI proposals, and design-time streaming progress.
