# ADR-0211: In-process scheduled dangling-link prune (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0207 (prune-links --all-tenants), ADR-0206 (prune-links command), ADR-0205 (dangling-link sweep), ADR-0087 (operate-server), ADR-0077 (P3) |

## Context

ADR-0205 → ADR-0207 built the dangling-link sweep and a `prune-links` CLI that runs it across every
active tenant. Running it still required invoking the binary out-of-band (cron / k8s Job). For a
single-process deployment that already runs the in-process cron scheduler (`--schedule-ms`), a
sidecar/cron just to prune links is overhead. This runs the sweep on an interval inside the serving
process, next to the cron scheduler.

## Decision

- **`PruneScheduler`** (`apps/operate-server`, new `prune-scheduler.ts`), modeled on the existing
  `JobScheduler`: an injectable timer, `start()` runs one immediate sweep then fires every `intervalMs`
  (the timer is `unref`'d so it never holds the process open), `stop()` clears it, and a failed sweep is
  routed to `onError` rather than escaping the timer. Each tick resolves the active tenants from a
  `TenantSource` and calls `sweepDanglingLinksForTenants(pruner, pairs, tenantIds, {})` (ADR-0207),
  optionally reporting via `onSwept`.
- **`--prune-links-ms <n>`** (`cli.ts`). Integer `>= 1000`, defaults off. It requires **`--store pg`
  specifically** — not memory, not `pg-columns` — because only the JSONB `PostgresEntityStore` satisfies
  the `DanglingLinkPruner` seam (the column store's join-table FKs cascade, so it can't dangle). A new
  `isDanglingLinkPruner` structural guard (`link-sweep.ts`) enforces this at wiring time.
- **Wiring** (`node.ts`). In `serve()`, when `pruneLinksMs !== null && conn !== undefined &&
  isDanglingLinkPruner(store)`, a `PruneScheduler` is built over the store, the manifest's m2m relation
  pairs, and a `PostgresTenantSource(conn)` — the *same* tenant source the cron scheduler uses — then
  `start()`ed and `stop()`ed in the returned `close` handle, exactly like `jobScheduler`.

## Consequences

- A single serving process can now self-maintain: `operate-server --pack erp-retail --store pg
  --schedule-ms 60000 --prune-links-ms 3600000` runs cron jobs every minute and prunes fleet-wide
  dangling links hourly, with no external scheduler. The CLI `prune-links` command (ADR-0206) remains
  for one-shot / out-of-band runs.
- The prune scheduler reuses `PostgresTenantSource` and `sweepDanglingLinksForTenants`, so "active
  tenant" and the sweep semantics are identical to the cron scheduler and the CLI — one definition, no
  drift.
- The store gate is fail-safe: with `--store pg-columns` or `memory` the flag is rejected at parse time
  with a clear message, so a deployment can't silently schedule a no-op prune against a store that
  doesn't need it.
- 7,096 tests pass (+10: `PruneScheduler` immediate + interval sweep, `onSwept`/`onError` routing, `stop`
  clears; `--prune-links-ms` parse, store-gate rejection for memory + pg-columns, `>= 1000` bound).
  Full build + typecheck green.
- Follow-ups: a jitter/backoff so many replicas don't sweep in lockstep; surfacing `onSwept` reports to
  the observability runtime.
