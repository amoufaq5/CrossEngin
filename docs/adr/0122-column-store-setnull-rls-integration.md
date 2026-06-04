# ADR-0122: column-store set_null + non-bypassing-role RLS integration test (Phase 3 P1.26)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0120 (m2m + FK integration), ADR-0093 (per-relation delete semantics), ADR-0086 (tenant RLS), ADR-0119 (column-store integration), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 (serving-stack) hardening increment (P1.26), the last
> two column-store integration follow-ups ADR-0119/0120 named.

## Context

ADR-0119/0120 proved the column store's typed tables, native query, at-rest
encryption, m2m links, and FK `ON DELETE CASCADE`/`RESTRICT` against real
Postgres. Two gaps remained: the third `ON DELETE` mode (`set_null`, ADR-0093,
which uses the column-list form so `tenant_id` is never nulled), and — the
deeper one — whether the **RLS policy itself** isolates tenants, since every
prior test ran as a superuser/owner (RLS bypassed) and relied on the store's
`WHERE tenant_id = $1`. P1.26 closes both.

## Decision

Two new cases in `apps/operate-server/src/integration-columns.test.ts` (gated on
`CROSSENGIN_PG_TEST=1`, random tenants, the `lk` schema):

- **`ON DELETE SET NULL`.** A `Bill → Vendor` `many_to_one` with `onDelete:
  "set_null"` and a **nullable** `vendor` reference. Removing the `Vendor`
  succeeds (not RESTRICT) and **nulls the bill's `vendor_id`** while the bill
  row — and its `tenant_id` — survive (verified by a raw `SELECT tenant_id,
  vendor_id`), proving the column-list `SET NULL (vendor_id)` form.
- **RLS policy enforced for a non-bypassing role.** A single-entity table seeded
  with two tenants' rows by the owner (RLS-bypassed), then queried as a freshly
  created `crossengin_rls` role (`LOGIN NOSUPERUSER NOBYPASSRLS`, granted
  `USAGE` + `SELECT`). A **raw `SELECT` with no `WHERE tenant_id`** inside a
  transaction that sets `app.current_tenant_id` returns **only that tenant's
  row** — proving the RLS `USING (tenant_id = current_setting(...)::UUID)`
  policy, not the store's filter. The role is created idempotently (existence
  check, idempotent grants) so re-runs are clean; a second `PgConnection` is
  opened with the role's credentials.

## Cross-cutting invariants enforced (real PG, gated)

- **SET NULL keeps the row + tenant.** Deleting the referenced `Vendor` nulls
  `Bill.vendor_id` only; the bill and its `tenant_id` are intact.
- **RLS isolates without the store.** As a `NOBYPASSRLS` non-owner role, a bare
  `SELECT * FROM lk.doc` returns exactly the rows for the tenant in
  `app.current_tenant_id` — the policy alone confines the read.

## Alternatives considered

- **Skip the non-bypassing-role RLS test (trust the store's WHERE).**
  - **Decision.** No — the store's `WHERE tenant_id` is defense-in-depth, but the
    *policy* is the real isolation boundary (a raw query, a tooling connection, a
    bug that drops the filter). Proving it under a NOBYPASSRLS role is the
    guarantee the prior suites explicitly deferred.
- **`FORCE ROW LEVEL SECURITY` instead of a separate role.**
  - **Decision.** No — `FORCE` would make RLS apply to the owner too, changing
    the store's own behavior in the test DB. A dedicated non-owner role models
    the real deployment (the app connects as a tenant-scoped, non-owning role).
- **A `required` reference for SET NULL.**
  - **Decision.** No — `SET NULL` on a `NOT NULL` column is invalid; the test's
    `vendor` reference is nullable, which is the correct shape for a `set_null`
    relation.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,521 offline tests + 22 gated
  real-Postgres integration tests** (11 worker + 11 serving; +2 this increment,
  0 new tables/columns/packages/production code). The column store's relational +
  isolation surface is now **fully proven against real Postgres** — typed tables,
  native query, at-rest encryption, m2m links, all three FK `ON DELETE` modes,
  and the **RLS policy under a non-bypassing role**.
- **Tenant isolation is verified at the policy level**, not just the store's
  query — the strongest form of the multi-tenant guarantee, demonstrated end to
  end.
- **The serving + worker persistence surface is comprehensively integration-
  tested** (22 cases); a CI job under `CROSSENGIN_PG_TEST=1` exercises all of it.
