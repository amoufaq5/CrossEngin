# ADR-0158: Stripe webhook → billing_subscriptions connector

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0156 (billing-stripe), ADR-0155 (Postgres resolver + table), ADR-0149 (entitlement gate) |

## Context

The pieces existed — a Stripe client (ADR-0156), the `billing_subscriptions` table + resolver
(ADR-0155), the gate (ADR-0149) — but nothing connected a real Stripe subscription event to the
row the resolver reads. This is the connector that closes the cloud loop: **Stripe event → row
→ gate**.

## Decision

Two modules in `operate-runtime-pg` (which now depends on `@crossengin/billing-stripe`):

- **`PostgresSubscriptionStore.insert(row)`** — appends a subscription snapshot to
  `billing_subscriptions` under `withTenantContext` (RLS confines the write to the row's tenant).
  Because the table `id` is an auto-generated UUID (not the Stripe id), each event **inserts a
  new snapshot** and the resolver reads the latest by `updated_at` — append-only, no schema
  change; compaction is a follow-up.
- **`subscriptionRowFromStripeEvent(event, {planLimits?, tenantMetadataKey?})`** (pure) — maps a
  parsed `customer.subscription.*` event to a row: tenant from the subscription's
  `metadata.tenant_id`, plan from the price id, status via `mapStripeSubscription`, periods
  unix→ISO, and record-cap/features from a deployment `planLimits(planId)` catalog (falling back
  to subscription metadata). Returns `null` for non-subscription events or unattributed ones.
- **`ingestStripeWebhook({payload, signatureHeader, secret, store, planLimits?, now?})`** —
  `verifyStripeWebhook` (ADR-0156) → map → `store.insert`. Returns `{ok:false, reason}` on a bad
  signature, `{ok:true, applied:false}` for a verified non-subscription/unattributed event, and
  `{ok:true, applied:true, tenantId, status}` on a persisted snapshot.

## Consequences

- The cloud billing loop is closed end-to-end: a deployment routes `POST /webhooks/stripe` to
  `ingestStripeWebhook`; a Stripe subscription change verifies, persists a snapshot, and the next
  request's `PostgresEntitlementResolver` read reflects it in the gate (status + record cap).
- Tenant attribution rides on the Stripe subscription's `metadata.tenant_id` (set at creation via
  the billing-stripe client). Unsigned/unattributed events are safely ignored, never persisted.
- 6,726 tests pass (+12: the pure mapper's attribution/plan-limits/cancel/skip paths, the
  insert's param binding + tenant context + schema safety, and the verify→persist / bad-sig /
  ignore connector paths). Full build + typecheck green.
- Follow-ups: snapshot compaction (or a `stripe_subscription_id` unique column for true upsert);
  an `operate-server` webhook route wiring this in; a plan-catalog source for `planLimits`.
