# ADR-0239: Stripe usage sync (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0237 (billing-runtime-pg), ADR-0238 (operate-server metering), `@crossengin/billing-stripe`, ADR-0077 (Phase 4) |

## Context

`operate-server` now meters live traffic into `meta.billing_usage_records` (ADR-0238), but the persisted
`UsageRecord`s never left the platform — the `syncedToStripeAt` / `stripeUsageRecordId` fields on the
record were always null. This closes the billing loop: report persisted usage to Stripe so it becomes an
actual charge on the tenant's subscription.

## Decision

- **`billing-stripe` gains usage reporting.** `StripeClient.createUsageRecord({subscriptionItemId,
  quantity, timestamp?, action?, idempotencyKey?})` POSTs to
  `/v1/subscription_items/{id}/usage_records` (legacy usage-records API); the `idempotencyKey` rides as
  Stripe's `Idempotency-Key` header (the private `request` helper gained an optional key), so a retried
  report is de-duplicated by Stripe. `mapStripeUsageRecord` normalizes the response.
- **Two sync-state columns** on `meta.billing_usage_records` (`synced_to_stripe_at` TIMESTAMPTZ,
  `stripe_usage_record_id` TEXT) + an `(tenant_id, synced_to_stripe_at)` index — no new table, count
  stays 133.
- **`billing-runtime-pg`** — `PostgresUsageRecordStore.listUnsynced(tenantId, limit)` /
  `markSynced(tenantId, recordId, stripeUsageRecordId, syncedAt)` (the mark is guarded on
  `synced_to_stripe_at IS NULL`, so a concurrent re-sync is a no-op). A new `stripe-sync.ts`:
  - `UsageReporter` — the structural Stripe surface the sync needs (`createUsageRecord(input) →
    {id}`); `StripeClient` satisfies it, so `billing-runtime-pg` never depends on `billing-stripe`.
  - `SubscriptionItemResolver` + `staticSubscriptionItemResolver({"<subscriptionId>|<meter>":
    subscriptionItemId})` — maps a usage record to the Stripe subscription item; the deployment supplies
    the map (its plan's metered prices → the tenant's Stripe subscription items).
  - `UsageStripeSync.syncTenant(tenantId)` — reports each un-synced record (quantity rounded, timestamp =
    the record's period end, the record's period idempotency key as the Stripe idempotency key) and marks
    it synced; an unresolvable record is **skipped** (left un-synced for a later run) rather than failing
    the batch.

## Consequences

- The billing loop is closed end-to-end: meter live traffic → persist `UsageRecord`s → **report to
  Stripe** → charge appears on the subscription. Sync is idempotent on both sides — the DB guard
  (`markSynced` only from un-synced) and Stripe's `Idempotency-Key`, so a retried or concurrent sync
  never double-charges.
- The `UsageReporter` seam keeps `billing-runtime-pg` free of a `billing-stripe` dependency (structural,
  like the other runtime seams); a different usage sink (a test double, a different provider) drops in.
- The subscription-item mapping is a deployment concern (a static map for now), because the
  meter → Stripe-subscription-item link lives in the tenant's Stripe account, not the manifest; resolving
  it live from Stripe subscription items is a follow-up.
- +10 tests (billing-stripe: createUsageRecord path/form/idempotency-header + mapper; billing-runtime-pg:
  listUnsynced/markSynced SQL + the sync reporting/skip/idempotency). Full build + typecheck + workspace
  tests green. No new package; two columns added to an existing table.
- Follow-ups (open): a `--stripe-usage-sync` scheduler in `operate-server` (report on a cadence over the
  metered subscriptions); resolving subscription items live from the Stripe subscription; the modern
  Meter Events API as an alternative to legacy usage records.
