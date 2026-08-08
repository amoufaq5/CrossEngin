# ADR-0221: `ai-architect-runtime-pg` — durable per-tenant Architect cost (Phase 3 P7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-27 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0220 (chat-guard wiring), ADR-0219 (ai-architect-runtime), ADR-0086 (tenant RLS pattern), ADR-0077 (P3 plan — P7) |

## Context

ADR-0219's `SessionCostTracker` holds all cost state in memory, so a tenant's monthly dollar ceiling
resets every process restart and isn't shared across nodes — a tenant could exceed its budget by
spreading spend across instances or CLI invocations. Session token/tool state is genuinely ephemeral
(one session, one process), but the **per-tenant monthly dollar total** must be durable. This adds the
Postgres sibling for exactly that.

## Decision

- **New META table** `meta.architect_tenant_cost` (#129): `tenant_id` + `period_key` (`YYYY-MM`,
  format-checked) as the PK, `dollars_used` (`NUMERIC(14,6)`, `>= 0`), `updated_at`. Tenant-scoped RLS.
- **`@crossengin/ai-architect-runtime-pg`** — `PostgresTenantCostStore` over that table:
  - `getMonthly(tenantId, periodKey)` → the dollars spent so far this period (0 if none).
  - `addMonthly(tenantId, periodKey, dollars)` → an **atomic** `INSERT … ON CONFLICT DO UPDATE SET
    dollars_used = existing + delta RETURNING dollars_used`, so concurrent nodes accumulate without a
    read-modify-write race.
  Both run under `withTenantContext` (RLS-confined). `monthlyPeriodKey(date)` derives the UTC `YYYY-MM`
  bucket (the ceiling resets each calendar month).
- **`seedTenantMonthlyCost(store, tracker, tenantId, date)`** — the seam back to the in-memory guard:
  loads the persisted monthly total into a `SessionCostTracker` (`recordDollars`) so a fresh process
  enforces the ceiling against real accumulated spend from the first `evaluate`. The intended pattern is
  seed-at-session-start + `addMonthly(turn cost)` after each turn (the tracker holds the running total,
  the store the durable delta-accumulated truth).

## Consequences

- The Architect's per-tenant monthly dollar ceiling is now durable and cross-node: spend accumulates in
  one row per `(tenant, month)`, atomically, so a tenant can't beat its budget by restarting or fanning
  across instances. Session token/tool caps stay in-memory (correct — they're per-session).
- The store is deliberately narrow: it persists only the tenant monthly dollars (the shared, durable
  quantity), leaving the fast per-session accounting in memory. `seedTenantMonthlyCost` bridges the two,
  so wiring it into `architect-cli` (seed at start, `addMonthly` after each turn) is a small follow-up
  rather than a guard-API change.
- Atomic accumulation (`existing + delta` in one statement) means no lost updates when multiple
  Architect instances serve the same tenant concurrently.
- 7,299 tests pass (+8 ai-architect-runtime-pg: `monthlyPeriodKey` UTC formatting; `getMonthly`
  zero-default; `addMonthly` atomic accumulate; per-period bucketing; tenant isolation; schema+tenant-id
  guards; default-schema targeting; `seedTenantMonthlyCost` loads into a tracker; meta-schema count
  128 → 129 + architect-cli assertion). Full build + typecheck green.
- Follow-ups: wire the store into `architect-cli`'s chat command (seed + persist per turn); a periodic
  reset/rollover job or query; surfacing monthly spend in a control-plane view.
