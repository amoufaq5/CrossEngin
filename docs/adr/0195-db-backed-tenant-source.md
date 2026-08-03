# ADR-0195: DB-backed TenantSource — the scheduler fires for every active tenant

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0192 (operate-server scheduler), ADR-0187 (scheduled producer), ADR-0077 (P2) |

## Context

ADR-0192 wired the cron scheduler into `operate-server` behind an explicit `TenantSource` seam, but
shipped only `StaticTenantSource` — a hand-listed set of tenant ids on the command line. That does not
scale: a real deployment has a growing, changing tenant set, and cron should fire for every active
tenant without re-listing them. This fills the seam with a DB-backed source, exactly as ADR-0192
anticipated ("a dynamic implementation querying the tenant table drops in without touching the
scheduler").

## Decision

- **`PostgresTenantSource`** (`apps/operate-server`) implements `TenantSource` by enumerating live
  tenants from `meta.tenants`: `SELECT id FROM meta.tenants WHERE status = ANY($1::text[])`, the active
  statuses bound as a parameter (default `['active']`; configurable, e.g. to include `suspended`). The
  schema identifier is validated; the registry is platform-scoped (not RLS-guarded). It is re-queried
  **each tick**, so a newly-provisioned tenant starts getting cron on the next pass and a suspended one
  stops — no restart.
- **The tenant registry is always `meta`.** `meta.tenants` lives in `meta` regardless of the entity
  store's `--schema` (which controls where *entity data* lives), so the source defaults to `meta` and
  does not inherit the entity schema — a correctness point the static source didn't have to consider.
- **CLI.** `--schedule-all-tenants` selects the DB-backed source; `--schedule-ms` now requires
  **exactly one** of `--schedule-tenant` (static list) or `--schedule-all-tenants` (mutually
  exclusive). `serve()` builds `PostgresTenantSource(conn)` for the all-tenants case, else the static
  source — the `JobScheduler` itself is unchanged (the seam did its job).

## Consequences

- The scheduler is now production-usable: `operate-server --store pg --schedule-ms 60000
  --schedule-all-tenants` fires every manifest cron job for every active tenant, picking up
  provisioning/suspension changes live. The static list remains for fixed/single-tenant deployments.
- Because the source is re-queried per tick and the enqueue is idempotent (deterministic `run_id` per
  cron tick + `ON CONFLICT DO NOTHING`), running multiple replicas with `--schedule-all-tenants` is
  safe with zero coordination — each replica enumerates the same tenants and races on the same run
  ids.
- Confined to `apps/operate-server` (no schema, no other package) — `PostgresTenantSource` slots into
  the existing `TenantSource` contract; the change is the source + the CLI selection.
- 6,994 tests pass (+5: `PostgresTenantSource` active-select / custom-statuses + invalid-schema; CLI
  `--schedule-all-tenants` parse + mutual-exclusion + missing-interval, and the updated
  missing-source message). Full build + typecheck green.
- Follow-ups: a residency/region filter on the tenant query (fire only tenants a replica owns); a
  per-tenant "installed packs" join so a cron fires only for tenants that have the job's pack; and the
  P2 exit-criterion end-to-end against a live Postgres, still gated on real infrastructure.
