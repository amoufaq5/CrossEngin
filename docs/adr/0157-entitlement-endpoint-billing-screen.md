# ADR-0157: Entitlement endpoint + console Billing screen

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0149 (entitlement gate), ADR-0151 (payment-required banner), ADR-0153 (record caps) |

## Context

The gate resolves each tenant's `Entitlement`, but the console could only *react* to 402s (the
banner) — there was no way to *see* your subscription/plan. Delivered by an agent alongside the
Postgres resolver + Stripe client.

## Decision

- **`GET /v1/meta/entitlement` (`operate-runtime`).** `buildEntitlementHandler({resolver})`
  returns the caller tenant's own entitlement: `{status, planId, maxRecordsPerEntity, features}`
  (a null entitlement → all-null/`[]`); 401 without a tenant. No finance-role gate — a principal
  reads their own plan state. **Registered ungated** (like `meta.schema` / `admin.settings`), and
  only when an `entitlementResolver` is configured, so a lapsed tenant can still load billing.
- **Console Billing screen (`/admin/billing`).** Fetches the endpoint and renders status (badge:
  green active/trialing, amber past_due, red/neutral otherwise, "No subscription" when null), the
  plan id, the per-entity record cap ("Unlimited" when null), plan features as chips, and a
  "Manage billing" button (placeholder). A finance-agnostic **Administration → Billing** sidebar
  link beside Settings.

## Consequences

- Subscription state is now first-class data in the console: a user can see their plan, status,
  and record cap — the read-side complement to the write-side payment-required banner.
- Ungated by design, so the screen renders even when the tenant is lapsed (the whole point).
- operate-runtime 255 tests (+4: active/null/trialing bodies + 401); `operate-web` build green,
  `/admin/billing` route compiled.
- Follow-ups: wire "Manage billing" to a Stripe Billing-Portal session (ADR-0156); show
  "N of M used" per-entity usage against the cap; surface the current period + renewal date.
