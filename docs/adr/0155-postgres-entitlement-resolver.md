# ADR-0155: Postgres EntitlementResolver + billing_subscriptions table

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0149 (entitlement gate), ADR-0153 (record caps), `billing` (subscription contracts) |

## Context

The gate consumes an `EntitlementResolver`. Local uses an offline license; **cloud** needs one
backed by live subscription rows in Postgres. Delivered by an agent alongside the Stripe client
and the entitlement endpoint.

## Decision

- **`meta.billing_subscriptions` (kernel meta-schema, table #126).** Tenant-scoped
  (`tenant_id`, RLS-isolated, FK-free), columns: `plan_id`, `status`, `current_period_end`,
  `trial_end`, `max_records_per_entity`, `features` (JSONB), timestamps, plus a
  `(tenant_id, updated_at)` index for the resolver's latest-row lookup. The meta-schema test
  count went 125→126 with the name added to the sorted list; the RLS invariant is satisfied.
- **`PostgresEntitlementResolver` (`operate-runtime-pg`).** `resolve(tenantId)` runs inside
  `withTenantContext` (RLS applies) and `SELECT … WHERE tenant_id = $1 ORDER BY updated_at DESC
  LIMIT 1` — tenant id bound, the schema the only validated interpolated identifier. Maps a row
  → `Entitlement` (unknown status fail-closes to `incomplete`; JSONB/text `features` + numeric/
  text `max_records_per_entity` both tolerated); no row → `null` (gate denies).

## Consequences

- A cloud `operate-server` can wire `new PostgresEntitlementResolver(conn)` into the gate, so
  subscription status + plan caps come from live billing rows updated by (e.g.) Stripe webhooks.
- Drops into the exact `EntitlementResolver` seam — no gate change.
- kernel 572 tests + operate-runtime-pg 109 (+8: mapping, null, param-binding, schema safety).
- Follow-ups: an upsert/writer for the table fed by webhook events; period-end → status
  reconciliation; a cache with TTL in front of the resolver.
