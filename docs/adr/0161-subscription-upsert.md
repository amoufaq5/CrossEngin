# ADR-0161: `stripe_subscription_id` upsert — snapshots stop piling up

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0158 (webhook connector), ADR-0155 (Postgres resolver + table), ADR-0149 (entitlement gate) |

## Context

`PostgresSubscriptionStore.insert` **appended** a new `billing_subscriptions` row on every Stripe
event (the table `id` is an auto-generated UUID), and `PostgresEntitlementResolver` read the
latest by `updated_at`. Correct, but a busy subscription accumulates a row per webhook forever —
the compaction / true-upsert follow-up ADR-0158 flagged.

## Decision

- **Schema (`meta.billing_subscriptions`, table #126).** A nullable `stripe_subscription_id TEXT`
  column, plus a **unique index on `(tenant_id, stripe_subscription_id)`**
  (`uq_billing_subscriptions_tenant_stripe_sub`). Tenant-scoped, and — because NULLs are distinct
  in a unique index — rows with no Stripe id (offline license / manual) still append, keeping the
  non-Stripe audit trail. No table added; count stays 126.
- **`PostgresSubscriptionStore.insert` is now an upsert.** `INSERT … ON CONFLICT (tenant_id,
  stripe_subscription_id) DO UPDATE SET … updated_at = now()`. A repeat event for the same Stripe
  subscription **updates the one row** in place; a NULL sub id never conflicts, so it inserts
  (append preserved). `SubscriptionUpsertRow` gains `stripeSubscriptionId: string | null`.
- **`subscriptionRowFromStripeEvent`** now carries `stripeSubscriptionId` from the Stripe
  subscription object's `id` (`sub_…`), so a mapped webhook event upserts on its real identity.

## Consequences

- The cloud path no longer grows unbounded: N events for one subscription = one row, not N. The
  resolver's `ORDER BY updated_at DESC LIMIT 1` still returns the current state (now the *only*
  Stripe row per subscription), so the gate is unchanged.
- The offline license / manual path is deliberately still append-only (NULL sub id), preserving a
  subscription-state history where there's no external identity to key on.
- Tenant isolation holds: the upsert runs under `withTenantContext` (RLS), and the unique index
  is composite on `tenant_id` — a subscription id can only ever resolve within its own tenant.
- 6,746 tests pass (+1 net: the upsert-SQL assertion + a NULL-sub-id append case; the existing
  snapshot/optional-null tests + the mapper test carry the new field). Full build + typecheck
  green.
- Follow-ups: surface "N of M records used" on the console Billing screen (the cap now lives on
  the single current row); a per-tenant plan-override source.
