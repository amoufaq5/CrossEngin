# ADR-0240: `--stripe-usage-sync` scheduler in operate-server (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0239 (Stripe usage sync), ADR-0238 (operate-server metering), ADR-0227 (--slo-config pattern), ADR-0077 (Phase 4) |

## Context

`UsageStripeSync` (ADR-0239) reports persisted usage records to Stripe, but nothing in the running
server drove it — an operator had to trigger a sync out-of-band. This is the serve-level wiring that
makes the sync run automatically on a cadence, the same pattern as every other operate-server lifecycle
(SLO, DR readiness, access reviews, metering flush).

## Decision

- **`stripe-usage-sync.ts`** — `StripeUsageSyncConfigSchema` reads `{intervalMs?, tenants: uuid[],
  subscriptionItems: {"<subscriptionId>|<meter>": subscriptionItemId}}`. `buildStripeUsageSync(conn,
  reporter, config)` composes a `UsageStripeSync` (a `PostgresUsageRecordStore` + the static
  subscription-item resolver) with a `StripeUsageSyncScheduler` (the `PruneScheduler` shape: `unref`'d
  timer). Each tick, `syncOnce` reports every configured tenant's un-synced usage; a tenant whose sync
  throws is routed to `onError` and does not abort the batch.
- **`--stripe-usage-sync-config` flag** — requires `--store pg` (the usage records) + `--stripe-api-key`
  (the reporter). `serve()` builds a real `StripeClient` (which satisfies the `UsageReporter` seam) and
  starts/stops the scheduler alongside the other schedulers.
- **Relaxed the `--stripe-api-key` coupling.** It previously required `--billing-portal-return-url`; now
  it requires *either* that *or* `--stripe-usage-sync-config`, so the key can drive usage sync without a
  billing portal. `--stripe-usage-sync-config` in turn requires the key.

## Consequences

- The billing loop now runs end-to-end in the deployed process: metering flushes usage to Postgres
  (ADR-0238), and this scheduler reports it to Stripe on a cadence and marks it synced — no out-of-band
  trigger. `operate-server --store pg --metering-config m.json --stripe-api-key … --stripe-usage-sync-config s.json`
  meters, persists, and bills live traffic on its own.
- Idempotency carries through from ADR-0239 (the DB `markSynced` guard + Stripe's `Idempotency-Key`), so
  a tick that overlaps a slow previous run, or a restart mid-batch, never double-charges.
- The scheduler is resilient per-tenant: one tenant's Stripe failure is logged and skipped, the rest
  proceed — a single bad subscription-item mapping can't stall the whole fleet's billing.
- The tenant set + subscription-item map are explicit config (the meter → Stripe-item link lives in the
  tenant's Stripe account, not the manifest); deriving the tenant set from the metering config, and the
  items live from Stripe, remain follow-ups.
- +8 tests (config parse/defaults/reject; scheduler reports per tenant, routes a per-tenant error,
  start/stop; CLI parse + the relaxed `--stripe-api-key` coupling). `serve()` stays offline-untestable,
  like the other schedulers. Full build + typecheck + workspace tests green. No META tables, no new
  package.
- Follow-up (open): a scheduled `closePeriod` drafting invoices from the persisted+synced usage once a
  plan source exists in the server.
