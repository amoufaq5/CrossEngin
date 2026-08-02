# ADR-0162: Record-usage meter — "N of M used" on the billing screen

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0161 (subscription upsert), ADR-0157 (entitlement endpoint + billing screen), ADR-0153 (plan record limits), ADR-0149 (entitlement gate) |

## Context

The billing screen showed the plan's record cap (`maxRecordsPerEntity`) but not how much of it a
tenant was using. The record-limit gate (ADR-0153) already bounded-counts an entity on create, so
the count mechanism existed — it just wasn't surfaced. This is the "N of M used" follow-up.

## Decision

- **`buildUsageHandler` → `GET /v1/meta/usage` (`operate-runtime`).** Returns the caller tenant's
  per-entity record usage against its plan cap: `{maxRecordsPerEntity, entities:[{entity, used,
  overflow, atLimit}]}`. Counts are **bounded** — each entity is probed for at most `cap+1` (or a
  `displayCeiling+1`, default 1000, when the plan is unlimited) rows via `listPage`, so the
  endpoint never scans a full table. `overflow` flags an entity whose true count exceeds the
  probe; `atLimit` flags one at/over the cap; `used` is bounded at the probe ceiling. A null
  entitlement yields a null cap with every entity `atLimit:false`.
- **Registered ungated**, alongside the entitlement route (own tenant only, via
  `principal.tenantId`) — a lapsed tenant can still see why they're blocked. It reuses the same
  store the gate uses, so no new store capability (`EntityStore` still has no `count`; the bounded
  `listPage` probe is the store-agnostic count, matching `withRecordLimit`).
- **Console (`operate-web`).** `fetchUsage()` + a `UsageMeter` on the billing screen: a per-entity
  bar (sorted by usage) showing `used of cap` (or `used records` when unlimited), amber ≥80%, red
  at limit. Usage is fetched **after** the entitlement and is best-effort — a failure never blanks
  the plan card.

## Consequences

- A tenant sees exactly how close each entity is to the plan cap, so a `record_limit_reached` 402
  is no longer a surprise — the meter warns as it approaches.
- The endpoint is O(entities) bounded `listPage` probes, each capped at `cap+1` rows — cheap
  enough for an on-demand billing screen; it deliberately does not run an exact `COUNT(*)` (no
  store-interface change, no full-table scan).
- 6,752 tests pass (+6: usage under-cap, over-cap, exactly-at-cap, unlimited-ceiling,
  no-subscription, and the 401 no-tenant path — the console is typecheck-verified). Full build +
  typecheck green.
- Follow-ups: a real `COUNT(*)` store method for exact large-tenant counts; "Manage billing" →
  Stripe Billing-Portal session; the licensor CLI drawing caps from the plan catalog.
