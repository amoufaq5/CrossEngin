# ADR-0237: `@crossengin/billing-runtime-pg` — usage + invoice persistence (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0236 (billing-runtime), ADR-0057 (ai-architect-pg — reuse-existing-table template), ADR-0230 (dr-runtime-pg — purpose-built-table template), ADR-0077 (Phase 4) |

## Context

`@crossengin/billing-runtime` (ADR-0236) meters usage and drafts invoices in-process, but the results
evaporated at process exit. Following the established runtime → `-pg` pattern, this persists them so the
metering history + draft invoices survive restarts and are queryable per tenant.

## Decision

- **Invoices reuse the canonical `meta.invoices` table.** The engine's draft `Invoice` is already a
  valid `Invoice` (it parses through `InvoiceSchema`), and the table's UUID PK + JSONB `line_items` +
  `(tenant_id, number)` unique match it exactly — so, like `ai-architect-pg` reusing `META_ARCHITECT_*`,
  the sibling `UPSERT`s into the existing table rather than a purpose-built one.
- **One new META table for usage** (129→…→133; `meta.billing_usage_records`): there was no usage table.
  A projected `UsageRecord` row (UUID id, tenant, subscription, meter/period/quantity/source, a UNIQUE
  `idempotency_key`, full `record` JSONB) under tenant RLS.
- **`@crossengin/billing-runtime-pg`** — `tenant-context.ts` (`withTenantContext`, since both tables are
  tenant-RLS-scoped), `PostgresUsageRecordStore` (`UPSERT … ON CONFLICT (idempotency_key)` — re-closing
  a period refreshes the same row; `listBySubscription` / `sumForMeter`), `PostgresInvoiceStore`
  (`UPSERT … ON CONFLICT (tenant_id, number)` — re-drafting refreshes; `getByNumber` / `listByTenant`
  round-trip the JSONB back through `InvoiceSchema`), and `PersistentBillingMeteringEngine` /
  `buildPersistentBillingEngine`, a wrapper whose `closePeriod` writes the rolled-up usage records + the
  draft invoice (metering `recordUsage` stays in-memory; persistence happens at close).

## Consequences

- Usage + invoicing is now durable + auditable: "every usage record for a subscription this period",
  "all draft invoices for a tenant" are single tenant-scoped queries. `closePeriod` is the persistence
  boundary — it flushes the period's rolled-up records + the invoice in one call.
- Reusing `meta.invoices` keeps one source of truth for invoices (the engine drafts; a later
  finalization step transitions draft → open → paid on the same row), and the idempotency keys
  (`idempotency_key` for usage, `(tenant_id, number)` for invoices) make re-closing a period safe.
- Every op is `withTenantContext`-wrapped, so RLS — not just a `WHERE tenant_id` — confines each
  read/write; the tenant id is bound + validated before any SQL.
- Fake-`PgConnection` tests (observing `set_config` + the UPSERT params + a JSONB round-trip through the
  schema) keep it offline-testable; the live-Postgres path is integration-only, like the other `-pg`
  siblings.
- 11 tests; **65 packages + 2 apps.** Full build + typecheck + workspace tests green. One new META table
  (`billing_usage_records`); no new dependency beyond `billing` + `billing-runtime` + `kernel-pg`.
- Follow-ups (open): wiring `recordUsage` into `operate-server`'s request/AI/job paths so real traffic
  meters + persists automatically; a Stripe usage-sync adapter (the `syncedToStripeAt` /
  `stripeUsageRecordId` columns are already on the record).
