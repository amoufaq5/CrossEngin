# ADR-0238: Wire usage metering into operate-server (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0236 (billing-runtime), ADR-0237 (billing-runtime-pg), ADR-0226 (onExecution seam), ADR-0077 (Phase 4) |

## Context

`billing-runtime(+pg)` meter usage and persist it, but nothing fed them the platform's real traffic —
metering ran only on hand-fed events. This is the "config → live data" step for billing: the running
`operate-server` now meters each billable request into the billing engine and flushes the accumulated
usage to Postgres, the same way SLO/DR/access-review lifecycles were wired to live data.

## Decision

- **Reuse the `onExecution` seam.** Each dispatched request's `PipelineExecution` (already surfaced for
  SLO enforcement) is mapped to a billable usage event; `serve()` now **composes** the SLO observer and
  the metering observer into one `onExecution` sink.
- **`metering.ts`** — `meteredEventFromExecution(execution, policy)` (pure): a request becomes a
  `MeteredUsageEvent` only when it carries a tenant, has a counted status (default `< 400`; overridable
  via `countStatuses`), and the tenant maps to a subscription; the **request id is the idempotency key**,
  so each request meters exactly once. `RequestMeteringObserver` accumulates billable requests into a
  `PersistentBillingMeteringEngine`'s in-memory meter (idempotent by request id) and tracks the metered
  subscriptions. `flushUsage` persists each subscription's accumulated buckets as `UsageRecord`s for the
  flush window then clears them (each window a distinct period ⇒ distinct idempotency key ⇒ distinct
  row); `MeteringFlushScheduler` runs it on an interval over the `[lastFlush, now]` window (`unref`'d
  timer, `onFlush`/`onError` sinks). `MeteringConfigSchema` reads `{meter?, source?, quantityPerRequest?,
  tenantSubscriptions, countStatuses?, flushIntervalMs?}`.
- **`--metering-config` flag** (needs `--store pg`): `serve()` builds the metering over the connection,
  adds its sink to `onExecution`, and starts/stops the flush scheduler alongside the other schedulers.
- **`BillingMeteringEngine.clearSubscription`** — a thin addition exposing the meter's existing
  per-subscription clear, so a usage flush can reset buckets without drafting an invoice (invoicing needs
  a plan; the flush persists usage records only).

## Consequences

- The deployed server now bills for what it serves: a billable request accumulates into the tenant's
  subscription meter and is flushed to `meta.billing_usage_records` on a cadence — real, durable,
  idempotent usage from live traffic. Metering composes cleanly with SLO enforcement over the same
  request stream.
- Idempotency is end-to-end: the request id dedups at ingest, and the flush's per-window period key
  dedups at persistence, so at-least-once request handling never over-bills.
- The flush persists usage records only (no invoice) because operate-server has no plan store; drafting
  the invoice from the persisted usage is a billing-service concern (`billing-runtime-pg`'s
  `closePeriod`, out of the server's scope). The meter mapping is intentionally simple (one meter per
  request, default `integration_call`); a per-operation meter map is a follow-up.
- `meteredEventFromExecution`, the observer, `flushUsage`, and the scheduler are unit-tested (fake
  `PgConnection`, injected clock, real `PipelineExecution` fixtures); the socket-binding `serve()` path
  stays offline-untestable, like the other schedulers.
- +12 operate-server tests (+1 billing-runtime for `clearSubscription`). `@crossengin/billing`,
  `billing-runtime`, `billing-runtime-pg` join operate-server's deps. Full build + typecheck + workspace
  tests green. No META tables, no new package.
- Follow-ups (open): a per-operation → meter map (bill `job.invoke` as `job_run`, etc.); scheduled
  `closePeriod` drafting invoices from persisted usage once a plan source exists; Stripe usage sync.
