# ADR-0207: `prune-links --all-tenants` + `--dry-run` (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0206 (prune-links command), ADR-0205 (dangling-link sweep), ADR-0087 (operate-server), ADR-0077 (P3) |

## Context

ADR-0206 shipped `operate-server prune-links --tenant <uuid>` — a per-tenant dangling-link sweep. Two
gaps kept it from being an operable maintenance job: it swept exactly one tenant (a real deployment has
many), and it deleted immediately with no way to preview. This adds `--all-tenants` (fan out over the
DB-backed tenant registry, reusing the scheduler's `PostgresTenantSource`) and `--dry-run` (report what
would be pruned without deleting).

## Decision

- **`--dry-run` threads to the store** (`operate-runtime-pg`). `PostgresEntityStore.pruneDanglingLinks`
  gains a `{dryRun?: boolean}` option: it runs the identical read + `planLinkPrune` decision but skips
  the `DELETE` loop, so the transaction is effectively read-only and `pruned` becomes the *would-be*
  count. The option is added to the structural `DanglingLinkPruner` seam so the sweep passes it through.
- **`--all-tenants` fans out over the tenant registry** (`operate-server`). `runPruneLinks` resolves the
  tenant list from `PostgresTenantSource(conn).activeTenantIds()` (the exact source the cron scheduler
  uses for `--schedule-all-tenants`) when `--all-tenants` is set, else the single `--tenant`.
  `sweepDanglingLinksForTenants(pruner, pairs, tenantIds, {dryRun})` sweeps each tenant in turn — each
  independently RLS-confined by the pruner — and aggregates a `MultiTenantSweepReport` (per-tenant
  reports + grand total + a `dryRun` flag). `formatMultiTenantReport` prints a per-tenant section, a
  grand total, and a "dry-run — nothing deleted" banner when applicable.
- **CLI validation.** `parsePruneArgs` now requires **exactly one** of `--tenant` / `--all-tenants`
  (mutually exclusive), and accepts `--dry-run`. The command still has no `--store` flag — it is
  JSONB-store-only, because the column store's join-table FKs cascade.

## Consequences

- `prune-links` is now a real fleet maintenance job: `operate-server prune-links --pack erp-retail
  --all-tenants --dry-run` previews every active tenant's dangling links across the whole registry, and
  dropping `--dry-run` executes the cleanup — one command a cron / k8s Job can run platform-wide.
- The all-tenants path reuses the scheduler's `PostgresTenantSource`, so "active tenant" means the same
  thing for cron enqueue and for link pruning — no second definition to drift.
- `--dry-run` is safe by construction: the deletion loop is simply not entered, and the pure planner
  still produces the counts, so a preview and a real run report identically except that the preview
  changes nothing.
- 7,084 tests pass (+10: store dry-run (skips deletes, reports would-be count); `--all-tenants` +
  `--dry-run` parsing + tenant/all-tenants mutual-exclusion; multi-tenant sweep aggregation + dry-run
  passthrough + empty; multi-tenant report formatting incl. the dry-run banner). Full build + typecheck
  green.
- Follow-ups: the set-based `DELETE … WHERE NOT EXISTS` scalability variant (ADR-0205); scheduling the
  sweep in-process alongside the cron scheduler rather than as a separate invocation.
