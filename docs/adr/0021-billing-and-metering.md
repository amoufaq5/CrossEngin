# ADR-0021: Billing and Metering

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0006, ADR-0010, ADR-0011, ADR-0013, ADR-0014, ADR-0015, ADR-0017 |

## Context

CrossEngin's pricing model (Round 2 decision): **per-tenant flat tier + AI usage metered**, with **different list pricing models per family** (Round 7). The billing system must turn this into accurate invoices that customers can predict, dispute, and pay.

Three pricing complexities make this non-trivial:

1. **Hybrid pricing.** Tenants pay a flat base + variable AI Architect usage + variable file storage. The base is straightforward; usage requires accurate metering, transparent reporting, and predictable billing windows.
2. **Per-family pricing differs.** Operate is per-tenant flat + AI usage. Govern is per-project + deployment fee. Heal is per-million-citizen-record. Educate is per-student-FTE. Serve gets a non-profit discount tier.
3. **Multi-region tax + currency.** UAE has VAT 5%; EU member states have varying VAT; US has state-level sales tax (rare on SaaS but emerging); some MENA countries have no SaaS tax. Billing must compute correctly per tenant's billing address.

Beyond pricing complexity:

- **Trials** (Year 1: 30-day trial common). Free until conversion.
- **Plan changes** (upgrade / downgrade mid-cycle). Prorating.
- **Dunning** for failed payments.
- **Invoicing** with PDF generation, email delivery, payment-link follow-up.
- **Tax compliance** automated where possible.
- **Refunds and credits.**
- **Audit trail** for all billing events.
- **Customer-self-service** billing portal.

Round 1 picked **Stripe** as primary processor (mentioned across multiple ADRs). For MENA-specific payment methods (regional cards, bank transfers), regional processors may be needed at Year 2-3.

## Decision

`packages/billing` integrates **Stripe** as the primary billing platform with **Stripe Billing** for subscriptions, **Stripe Tax** for tax computation, and **Stripe Invoicing** for invoice generation. Usage metering is built on top of ClickHouse aggregations (per ADR-0013) shipped to Stripe as Usage Records.

```
┌──────────────────────────────────────────────────────────────┐
│ CrossEngin                                                     │
│   - Usage metering (AI calls, jobs, storage)                  │
│   - Aggregates in ClickHouse hourly                           │
│   - Stripe sync (daily Usage Records)                         │
│   - Plan management API                                       │
│   - Customer billing portal (apps/web admin)                  │
└──────────────────────────────────────────────────────────────┘
                          │
                          │  Stripe API
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ Stripe                                                         │
│   - Subscription management                                    │
│   - Tax computation (Stripe Tax)                              │
│   - Invoice generation                                         │
│   - Payment processing (cards, ACH, bank transfer)            │
│   - Dunning automation                                         │
│   - Customer-facing checkout + portal                         │
└──────────────────────────────────────────────────────────────┘
                          │
                          │  Webhooks
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ CrossEngin webhook handlers                                    │
│   - Invoice paid / failed                                      │
│   - Subscription canceled                                      │
│   - Plan changed                                               │
└──────────────────────────────────────────────────────────────┘
```

### Plan model

`meta.plans` table defines plan tiers. Each plan has:

```jsonc
{
  "id": "operate-base-monthly",
  "stripe_product_id": "prod_...",
  "family": "operate",
  "tier": "base",
  "currency": "USD",
  "base_price_cents": 19900,
  "billing_interval": "month",
  "included_quotas": {
    "users": 10,
    "ai_calls_per_month": 500,
    "storage_gb": 10,
    "integrations": 5,
    "tenants_per_org": 1
  },
  "metered_pricing": {
    "ai_call_overage": { "stripe_price_id": "price_...", "per_unit_cents": 8 },
    "storage_gb_overage": { "stripe_price_id": "price_...", "per_unit_cents": 50 }
  },
  "available_in_regions": ["eu-central", "us-east"],
  "min_kernel_version": "0.18.0"
}
```

v1 launches plans for **CrossEngin Operate** (base, professional, enterprise tiers). Other families add their plans when each ships per the per-family pricing structure (Round 7).

### Pricing per family (target shapes)

| Family | Pricing shape |
|---|---|
| **Operate** | Per-tenant tier (base/pro/enterprise) + AI overage + storage overage |
| **Govern** | Per-project subscription + deployment fee + AI overage |
| **Heal** | Per-million-citizen-record + AI overage + storage tiers |
| **Educate** | Per-student-FTE annual + AI overage |
| **Serve** | Non-profit discount tier + per-program + AI overage |
| **Partner (white-label)** | Negotiated; revenue share + per-tenant minimum |

Stripe Subscriptions model handles base + metered combinations natively. Per-project and per-FTE pricing structures map to Stripe's licensed quantity + metered components.

### Usage metering

Three meter types tracked per tenant:

1. **AI Architect call.** Each conversation turn counted. Cost computed from token usage (per ADR-0006). Aggregated by hour in ClickHouse.
2. **Storage usage.** Daily snapshot of R2 storage per tenant (per ADR-0014). Average GB-month invoiced.
3. **Integration calls** (per ADR-0011) — Phase 5+ optional metering. Free up to plan quota; overage charged.

Metering pipeline:

```
Event (AI call / storage snapshot / integration)
    │
    ▼
Per-tenant hourly aggregation in ClickHouse
    │
    ▼
Daily job (Inngest, ADR-0015) → Stripe Usage Record
    │
    ▼
Stripe rolls into invoice at billing cycle end
```

Idempotency on Stripe sync via `idempotency_key = sha256(tenant_id + meter_id + day)`. Re-syncs are safe.

### Billing cycles

Default monthly cycle on tenant signup anniversary. Annual cycle option offers 15-20% discount.

Invoices issued day 1 of each cycle for the prior cycle's usage + base for current cycle. NET-30 default; large enterprise contracts may negotiate NET-60.

### Trial periods

- **Default trial:** 30 days for Operate base tier.
- **Trial sign-up requires credit card** at end-of-trial; explicit consent to convert.
- **Trial restrictions:** AI call quota reduced (50/month); storage 1 GB; no production-tenant features.
- **Trial-to-paid conversion** is one-click in the billing portal.
- **No trial for enterprise / regulated tier** — those go through sales motion.

### Plan changes (upgrade/downgrade)

- **Upgrade:** immediate; prorated charge for the remainder of the cycle; new included quotas effective immediately.
- **Downgrade:** effective at next cycle; current cycle's overage still billed.
- **Annual switch (monthly → annual):** discount applies from switch date; unused monthly time credited.
- **Plan cancellation:** subscription marked `cancel_at_period_end`; tenant data retained per ADR-0002 (30-day soft delete then hard).
- **Plan changes are audited** in `meta.billing_events`.

### Tax

**Stripe Tax** for v1:

- Computes correct tax per tenant's billing address.
- Generates tax-compliant invoices (VAT, GST, sales tax).
- Handles registration thresholds per jurisdiction.
- Supports reverse-charge VAT for B2B EU.

**UAE VAT 5%** — Stripe Tax supports UAE; CrossEngin must register for UAE TRN once revenue exceeds the threshold (likely Year 2). Until then, sales to UAE entities are zero-rated as imported services.

**GCC tax** — Saudi Arabia, Oman, Bahrain have VAT 5-15%; supported by Stripe Tax. Kuwait + Qatar have no VAT as of 2026.

**US sales tax on SaaS** — emerging in some states (NY, Washington, Massachusetts); Stripe Tax handles. Most states still exempt SaaS.

### Currency

**USD primary** at v1. EUR, AED, SAR, GBP available based on tenant billing region. Stripe handles multi-currency natively.

- Tenant chooses currency at signup; locked thereafter (changing requires plan re-issue).
- Conversion rate frozen at invoice generation.
- Display prices in tenant's currency in `apps/web` admin.

### Payment methods

| Method | Year 1 | Notes |
|---|---|---|
| Credit / debit card | Yes | Stripe native |
| ACH (US) | Yes | Stripe |
| SEPA Direct Debit (EU) | Yes | Stripe |
| Apple Pay / Google Pay | Yes | Stripe checkout |
| Bank transfer / Wire | Year 2 | Custom flow for enterprise invoices |
| UAE local cards (mada, KNET) | Year 2-3 | Stripe partial; may need Tap / MyFatoorah for some MENA markets |

For MENA-specific payment methods unavailable through Stripe, evaluate **Tap Payments** (UAE-headquartered) or **MyFatoorah** (Kuwait) at Year 2 when MENA tenant volume justifies.

### Dunning

Stripe's built-in dunning for failed payments:

- **Day 0:** Failed payment → notify tenant admin via email + in-app banner.
- **Day 3:** Retry attempt + reminder.
- **Day 7:** Second retry + escalation email.
- **Day 14:** Subscription marked `past_due`; tenant access partially restricted (read-only for non-admin users).
- **Day 30:** Subscription canceled; tenant data preserved per soft-delete policy.

Compliance-bound tenants may require alternative dunning windows; configured per-tenant in `meta.tenants.billing_policy`.

### Customer billing portal

`apps/web/admin/billing` (tenant admin view):

- Current plan + included quotas + usage to date.
- Upcoming invoice preview.
- Past invoices (PDF + payment status).
- Payment method management (Stripe Customer Portal embedded).
- Plan change UI.
- Usage projections + alerts.
- Cancel subscription flow.

For Year-2 MENA tenants, AR localization + RTL on billing pages is essential.

### Invoicing

- **Stripe-generated invoices** as PDF; emailed to tenant admin + finance contact.
- **Custom-branded invoices** for premium tiers (CrossEngin logo + customer logo).
- **Invoice numbering** per Stripe; sequential within tenant.
- **Per-line-item detail:** base subscription + AI overage + storage overage + tax.
- **Audit:** every invoice recorded in `meta.invoices` for cross-reference with usage data.

### Refunds and credits

- **Refund authority:** founder Year 1; commercial hire Year 2+.
- **Credit issuance:** `meta.tenant_credits` with applied-against logic at invoice generation.
- **SLA credit policy:** SLA breaches (per ADR-0017) result in automatic credits per published policy. Document in `apps/docs-site/sla.md`.

### Audit trail

`meta.billing_events` records every billing-relevant action:

- Subscription created / changed / canceled.
- Invoice issued / paid / failed.
- Payment method added / removed.
- Refund issued.
- Credit applied.
- Plan tier changed.

Retention 7 years (financial audit requirement; aligns with SOX-light pack).

### AI Architect billing visibility

Tenants see (per ADR-0006 cost telemetry):

- Per-session AI cost.
- Monthly AI cost rolling.
- Cost per conversation (so they understand value).
- Projection vs. quota.

If usage projects > 200% of monthly quota, in-app alert: "You're projected to exceed 1000 AI calls this month. Consider upgrading to Professional, or pre-purchase overage credit."

### CrossEngin Partner channel billing (Year 2-3)

Partners (per renamed `Power` → `Partner` in ADR-0001) bill end-customers under their own brand:

- Partner pays CrossEngin a per-tenant wholesale rate + AI usage at cost+margin.
- Partner re-invoices end-customer at their list price.
- CrossEngin's relationship is with the partner; end-customers are anonymous to CrossEngin billing.
- Reseller agreements + commission structure managed outside Stripe.

## Alternatives considered

### Option A — Build custom billing instead of Stripe

- **Pros:** Maximum flexibility on pricing models.
- **Cons:** Months of engineering for table-stakes (PCI compliance, tax computation, dunning, subscriptions). Not realistic pre-revenue.
- **Why not:** Stripe is the right fit. Revisit at $50M+ ARR.

### Option B — Paddle instead of Stripe (merchant-of-record model)

- **Pros:** Paddle is the merchant; they handle all tax + compliance.
- **Cons:** Higher fee (~5% vs. Stripe's ~3%). Less flexible for custom pricing shapes. Newer + smaller ecosystem.
- **Why not:** Stripe's flexibility wins; we'll handle our own tax via Stripe Tax.

### Option C — Lago / Metronome for usage-based metering

- **Pros:** Purpose-built metering platforms with more flexibility than Stripe Usage Records.
- **Cons:** Adds a vendor; integration cost; metering complexity isn't yet justified by complexity of pricing shape.
- **Why not:** Stripe Usage Records cover v1; revisit Lago / Metronome if pricing shapes become more sophisticated (per-API-call breakdown across many SKUs).

### Option D — Free tier forever

- **Pros:** Faster adoption.
- **Cons:** Conflicts with vision section 9: "Not a free-tier consumer product." Compliance-bound buyers don't trust free tiers.
- **Why not:** 30-day trial yes; free-forever no.

### Option E — Annual-only contracts

- **Pros:** Predictable revenue.
- **Cons:** Friction for small tenants. Monthly is the SaaS norm.
- **Why not:** Offer both; annual discounted.

### Option F — Skip metering; flat pricing only

- **Pros:** Simpler.
- **Cons:** Misaligned with AI cost variance. A heavy-AI-Architect-using tenant must pay more.
- **Why not:** Metered AI usage aligns cost + value.

## Consequences

### Positive

- **Stripe handles 80% of billing complexity** out of the box: subscriptions, invoicing, dunning, tax, multi-currency.
- **Per-family pricing flexibility.** Stripe Products + Prices model accommodates the different pricing shapes.
- **Tenant-facing transparency.** Customers see exactly what drives their bill.
- **Metering pipeline reuses ClickHouse infrastructure** (per ADR-0013); no separate metering data store.
- **Audit trail satisfies SOX-light + financial compliance.**

### Negative

- **Stripe fees** (~3% of revenue) are real cost. Mitigation: built into pricing.
- **Pricing model evolution friction.** Every pricing change touches Stripe Products + Prices + ClickHouse mapping + UI. Mitigation: scheduled pricing-review windows (quarterly Year 1; semi-annually after).
- **MENA payment method gaps.** Stripe doesn't support some local cards (mada, KNET) without additional integrations. Mitigation: add Tap / MyFatoorah Year 2-3 as needed.
- **Stripe outage** disrupts billing operations but not tenant data access. Mitigation: queue billing operations; replay when recovered.

### Neutral

- **Customer-self-service portal** is mostly Stripe Customer Portal embedded; minimal custom work.
- **Refunds policy** is mostly judgment; document in CRM-like tooling Year 2+.

### Reversibility

**Moderate cost** to swap Stripe for Paddle / Chargebee / etc. Customer migration is non-trivial; metering data transferable.

**Low cost** to evolve plans and prices in Stripe.

**Low cost** to add additional payment processors (Tap, MyFatoorah) alongside Stripe.

**High cost** to fundamentally change pricing model after customers depend on it. Plan changes are easier than model changes.

## Implementation notes

- **Package location:** `packages/billing` with sub-modules for Stripe client, plan management, metering pipeline, webhook handlers.
- **Stripe API version:** pinned in code; upgrade quarterly with test coverage.
- **Webhook handler:** `apps/web/api/v1/stripe/webhook` with signature verification (per ADR-0011 inbound webhook pattern).
- **Idempotency:** Stripe-provided idempotency keys on every API call.
- **Usage Record sync:** Inngest job daily; per-tenant per-meter idempotency key.
- **Plan management API:** `POST /api/v1/billing/subscriptions` etc.; tenant-admin permission required.
- **Tax data:** stored in `meta.tenant_billing_addresses`; Stripe Tax pulls automatically.
- **Trial expiration:** Inngest scheduled job daily; converts or expires trials.
- **SLA credit automation:** ADR-0017 alerts trigger Inngest job that issues credit per published policy.
- **Receipt PDF generation:** Stripe-rendered for v1; CrossEngin-rendered custom-branded (Phase 5+).
- **Per-family launch plan:** Operate plans Phase 5; other families when each ships (Year 2+).
- **Testing:**
  - Unit tests on plan resolution + tax computation logic.
  - Integration tests against Stripe test mode.
  - Property tests on metering aggregation correctness.
  - E2E test for subscription lifecycle (signup → trial → convert → upgrade → cancel).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Exact tier pricing for Operate base/pro/enterprise. Defaults to USD 199 / 599 / 1999 placeholder; finalize with commercial-hire input. | amoufaq5 + commercial hire | Phase 5 |
| MENA payment method gap — when do mada / KNET tenants justify Tap / MyFatoorah integration? | amoufaq5 | Year 2 |
| Annual discount magnitude — 15-20% range; precise number affects conversion. | amoufaq5 + commercial hire | Phase 5 |
| Refund policy specifics — full-refund window, partial-refund triggers, SLA-credit calculation. | amoufaq5 | Phase 5 |
| Partner-channel billing — wholesale rate structure, revenue share, commission. | amoufaq5 + commercial hire | Year 2-3 |
| AI overage pricing — $0.08 / call placeholder; per-token vs. per-call vs. tiered. | amoufaq5 | Phase 5 |
| Storage overage pricing — $0.50 / GB placeholder; volume tiers? | amoufaq5 | Phase 5 |
| Stripe Tax registration thresholds across jurisdictions — when does CrossEngin register for VAT in each MENA / EU country? | _pending compliance hire_ | Year 2 |
| Cryptocurrency / non-Stripe payment for ME enterprise tenants who prefer wire transfers — manual flow vs. automated? | amoufaq5 | Year 2 |

## References

- ADR-0006 (LLM provider router) — defines AI cost telemetry that feeds metering.
- ADR-0010 (Multi-region and data residency) — defines region-specific tax + currency.
- ADR-0011 (Integration mesh) — defines Stripe webhook ingestion.
- ADR-0013 (Reporting and analytics) — defines ClickHouse aggregations for metering.
- ADR-0014 (Files and storage) — defines storage metering.
- ADR-0015 (Jobs and async runtime) — defines Inngest sync jobs.
- ADR-0017 (Observability and SLOs) — defines SLA credit triggers.
- Stripe Billing documentation; Stripe Tax documentation; UAE FTA VAT requirements; EU VAT B2B rules.
