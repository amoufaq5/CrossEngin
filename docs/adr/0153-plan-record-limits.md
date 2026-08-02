# ADR-0153: Plan record-cap enforcement

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0149 (entitlement gate), ADR-0150 (license keys) |

## Context

The entitlement gate (ADR-0149) enforced subscription *status* but not plan *limits* — a plan
could declare `maxRecordsPerEntity` (already reserved on `Entitlement`) yet nothing enforced
it. This deepens the gate from "is the subscription live?" to "is the tenant within plan?".

## Decision

- **`withRecordLimit(handler, {resolver, store, entity})` (`entitlement.ts`).** A create-op
  wrapper that resolves the entitlement **once**, applies the write-status policy first (so a
  lapsed/past-due tenant is denied before any count), then — when the plan sets
  `maxRecordsPerEntity` — bounded-counts the entity's rows via `store.listPage({limit: cap+1})`
  and returns a 402 `record_limit_reached` when the tenant is already at the cap. The count
  reads at most `cap+1` rows (`length ≥ cap ⟺ at/over cap`), so it never scans the whole table.
- **`recordLimitProblem(entity, limit)`** — a 402 `problem+json` (distinct
  `plan-limit-reached` type) carrying `entity` + `limit` so the UI can message precisely.
- **Wiring (`compile.ts`).** When a resolver is configured, a **create** route uses
  `withRecordLimit` (status + cap in one resolve); every other op keeps the status-only gate.

## Consequences

- Plans can now cap records per entity: a Starter plan of 100 products denies the 101st create
  with a clear 402, while reads and existing records are untouched. Status denial still takes
  precedence (a lapsed tenant can't create regardless of headroom).
- One entitlement resolve per create (status + limit combined), and a bounded `cap+1` count —
  cheap even for large caps.
- Reads/updates/deletes/transitions are unaffected by the cap (it gates growth only).
- 6,651 tests pass (+7: the wrapper's under/at-cap/no-cap/lapsed/no-tenant paths, and two e2e
  gateway cases — 101st create → 402, under-cap → 201). Full build + typecheck green.
- Follow-ups: seat/user caps and metered-quota (period usage) enforcement using the same
  resolve; surfacing "N of M used" in the console; a Postgres resolver mapping a plan's limits.
