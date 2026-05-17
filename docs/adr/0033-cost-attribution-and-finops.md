# ADR-0033: Cost attribution and FinOps

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0006, ADR-0015, ADR-0017, ADR-0020, ADR-0021, ADR-0030 |

## Context

ADR-0021 defined billing — what tenants pay. This ADR defines the inverse: **what tenants cost us**. Per-tenant cost attribution, internal chargeback, budget guardrails, and unit economics (gross margin, contribution margin, LTV / CAC).

This is a business-critical layer for three reasons:

1. **Pricing accuracy.** Without per-tenant cost data, we can't know which plans are profitable. AI-heavy workflows can blow through unit economics if pricing doesn't reflect inference cost.
2. **Cost guardrails.** A runaway tenant — a poorly-written workflow that loops, an AI conversation that recurses, a backfill that imports 100M rows by accident — must hit a budget breach before our cloud bill does.
3. **FinOps maturity.** Internal cost-center chargeback is required for enterprise-grade financial discipline. Engineering, product, sales, support all consume platform capacity differently.

The platform integrates costs across many sources: Vercel build minutes, Fly machine seconds, Supabase compute, Cloudflare bandwidth, Anthropic / Fireworks AI tokens, Typesense queries, ClickHouse rows scanned, Stripe transaction fees. Each provider has its own granularity and billing cycle. Attribution must reconcile them into a canonical record.

A fourth concern — **estimation**. Some costs can't be attributed exactly (shared NAT bandwidth, multi-tenant DB query cycles). We need an `allocation_method='estimated'` with a confidence score that's auditable.

## Decision

The FinOps contract has **six modules** in `@crossengin/finops`:

1. **`categories.ts`.** Seventeen cost categories spanning compute (serverless, long_running, gpu), storage (hot, archive, cold), network (egress, ingress), database (compute, storage), AI (inference, training), third_party_api, search_index, observability, support_hours, license_fees. Six dimensions (tenant, app, region, environment, data_class, provider). `CATEGORY_DIMENSION` maps each category to which dimensions can be attributed.

2. **`attribution.ts`.** Five AllocationMethods (direct, proportional_usage, even_split, flat_rate, estimated) × 8 CurrencyCodes (USD, EUR, GBP, AED, SAR, SGD, INR, JPY). `CostAttributionRecord` enforces period validity + tenant-attributable categories require tenantId + isEstimated requires estimatedConfidence + non-zero cost requires non-zero usage + provider cost > 2× attributed is flagged. Helpers: `aggregateByCategory`, `aggregateByTenant`.

3. **`budgets.ts`.** Five BudgetPeriods (daily / weekly / monthly / quarterly / annual) × 4 BudgetActions (alert_only / throttle / block_new_usage / page_oncall). `BudgetThreshold` enforces throttle/block must trigger at >=80% (no over-aggressive auto-shutoff). page_oncall must include pagerduty channel. `BudgetBreachRecord` enforces actualSpend >= budget, breachPercent matches computed ratio, retroactive critical actions notify pagerduty. Helpers: `thresholdsCrossed`, `highestSeverityAction`.

4. **`margins.ts`.** Five MarginHealth states (healthy ≥60% / watch ≥30% / thin ≥0% / negative / loss_leader_approved). `TenantUnitEconomics` enforces accounting invariants: net = gross − refunds − credits, total = fixed + variable, margin = net − total, contribution = net − variable, grossMarginPercent matches computed. Negative margin requires health='negative' or 'loss_leader_approved' (with approver + reason). Helpers: `classifyMargin`, `paybackPeriodMonths`, `ltvToCacRatio`.

5. **`chargeback.ts`.** Seven cost center kinds (engineering, product, sales_revenue, shared_infrastructure, customer_support, compliance, research). `cc-NNNN` id pattern. `CostCenter` enforces no self-parenting. `ChargebackStatement` (5 statuses: draft / pending_approval / approved / posted / voided) enforces lines sum = totalAmountCents, percent sum = 100, unique cost centers per statement, approved/posted require approvedBy + approvedAt.

6. **`reports.ts`.** Seven report kinds (tenant_invoice_attachment, executive_summary, cost_center_chargeback, anomaly_alert, weekly_review, monthly_close, annual_review) × 4 formats (json / pdf / csv / html) × 6 anomaly kinds. `CostReport` enforces breakdown sum = totalCostCents, no duplicate categories, top spenders sorted descending, tenant_invoice requires tenantScope. `Anomaly` enforces category_spike needs affectedCategory + tenant_spike needs affectedTenantId.

Four meta-schema tables: `META_COST_ATTRIBUTION` (RLS, supports tenant_id=null for shared), `META_COST_BUDGETS` (RLS), `META_TENANT_UNIT_ECONOMICS` (RLS), `META_CHARGEBACK_STATEMENTS` (platform-wide).

## Alternatives considered

- **Option A:** Pass-through pricing — charge tenants their actual provider cost plus a markup.
  - **Pros:** Simplest economic model.
  - **Cons:** Tenants want predictable pricing; pass-through means their bill fluctuates with our infra costs. Eliminates the value of bundling.
  - **Why not:** Plans (ADR-0021) provide bundle pricing; FinOps tells us internally whether the bundle is profitable.

- **Option B:** No per-tenant attribution; bulk-allocate by tenant count.
  - **Pros:** Cheap to compute.
  - **Cons:** Heavy AI users subsidized by light users; can't identify cost outliers.
  - **Why not:** AI workloads have order-of-magnitude variance; can't ignore.

- **Option C:** Provider-cost only; no internal chargeback.
  - **Pros:** Smaller surface.
  - **Cons:** Enterprises require cost-center accountability for budget approvals. Engineering can't justify R&D spend without a chargeback line.
  - **Why not:** Internal chargeback is a finance-required capability.

- **Option D:** Single-currency only (USD).
  - **Pros:** No FX handling.
  - **Cons:** Eight regions; multiple currencies. Local currency invoices are a buyer expectation.
  - **Why not:** Multi-currency is required.

## Consequences

- **Positive.** Per-tenant cost visibility enables pricing decisions. Budget guards prevent cost runaways. Unit economics surface margin-thin or loss-leader tenants. Chargeback gives finance the line items they need.
- **Negative.** Significant data volume — every cost line is a record. Provider API integrations are an ops burden (each provider has different export formats, frequencies, retroactive corrections).
- **Neutral.** Currency choices are explicit. FX conversion happens upstream; this layer records the as-billed currency.
- **Reversibility.** Schema changes are tractable while volume is low. Once historical data accumulates, schema migrations need careful sequencing.

## Implementation notes

- **Provider cost guard.** `providerCostCents > costCents * 2` is rejected as suspicious. Catches misallocated rows where one tenant is charged double what the provider actually billed. Investigate the upstream feed before saving.
- **Margin health thresholds.** healthy ≥ 60% (SaaS gold standard), watch ≥ 30%, thin ≥ 0%. Negative requires correct health + approval. These thresholds are configurable in operations; the contract enforces the bands, not the specific numbers.
- **Loss-leader approval.** A tenant operating at negative margin needs `loss_leader_approved` health, `lossLeaderApprovedBy`, and a reason. Common cases: strategic enterprise customer, design partner, regulated industry beachhead.
- **Payback period.** `paybackPeriodMonths()` uses contribution margin per month. Returns null if missing CAC or zero contribution margin.
- **Currency mixing.** Each `CostAttributionRecord` is in a single currency. Aggregating across currencies requires upstream conversion; the helpers do not do FX.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| FX rate sourcing — daily fix vs spot vs hedged | _pending_ | Phase 3 |
| Cost forecast — extend `margins.ts` to project next period | _pending_ | Phase 3 |
| Anomaly detection algorithm — threshold-based vs ML | _pending_ | Phase 3 |
| Marketplace pack revenue share accounting — defer to ADR-0021 amendment | _pending_ | Phase 2 |

## References

- ADR-0021 (billing and metering) — the customer-facing side.
- ADR-0006 (LLM provider router) — per-call AI cost telemetry feeds this attribution.
- ADR-0015 (jobs and async runtime) — job cost ledger feeds compute attribution.
- `packages/finops/src/` for the zod schemas and helpers.
