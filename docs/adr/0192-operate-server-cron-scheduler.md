# ADR-0192: operate-server cron scheduler — the producer loop inside the serving app

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-28 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0187 (scheduled producer), ADR-0191 (cron timezones), ADR-0085/0077 (P2), ADR-0087 (operate-server) |

## Context

The scheduled-job producer (`enqueueScheduledJobs`, ADR-0187) existed as a library function, but
nothing in the running system *called* it — a deployed `operate-server` served requests and the worker
fleet drained the queue, yet no cron ever fired because there was no scheduler tick. This wires the
producer loop into the serving binary, so a cron job declared in a manifest actually runs on a live
deployment.

The one real design question is **which tenants a cron fires for**: a scheduled job installed with a
pack fires per tenant that has the pack, and `operate-server` has no tenant registry of its own. The
answer is an explicit seam rather than a hidden assumption.

## Decision

- **`JobScheduler`** (`apps/operate-server/src/scheduler.ts`) — the cron tick, modeled on
  `JwksRefreshPoller`: an `unref`'d interval that, each tick, calls `enqueueScheduledJobs(conn, {jobs,
  tenantId, now})` for every tenant from a `TenantSource`. Only `scheduled`-trigger jobs enqueue (the
  producer filters); a per-tenant enqueue error routes to `onError` and the loop continues (one
  tenant never blocks another); `start()` is idempotent and fires one immediate tick.
- **`TenantSource` is the explicit seam.** `activeTenantIds()` returns the tenants to fire for;
  `StaticTenantSource` covers a fixed deployment, and a dynamic implementation (querying the tenant
  table) drops in unchanged. The serving app supplies what the schema can't know.
- **Idempotent by construction.** Because `enqueueScheduledJobs` derives a deterministic `run_id` per
  `(tenant, job, cron-tick)` and inserts `ON CONFLICT DO NOTHING`, running the scheduler on *every*
  replica and firing an extra tick on `start()` are both safe — there is no leader election and no
  last-fired state to coordinate.
- **CLI + serve wiring.** `--schedule-ms <n>` (≥ 1000) + repeatable `--schedule-tenant <uuid>` enable
  it, gated to a Postgres store (it needs the `conn`) and requiring at least one tenant. `serve()`
  builds the `JobScheduler` over `Object.values(manifest.jobs)` + a `StaticTenantSource`, starts it
  alongside the JWKS poller, and stops it in the graceful-shutdown handle.

## Consequences

- The distributed job loop now runs **end-to-end inside the deployed app**: `operate-server`
  (scheduler tick → `job_runs`) + the worker fleet (claim → execute → retry/dead-letter). Combined
  with the event/delayed/userInvoked producers, three of the four practical triggers can fire from the
  server; only entity-event emission (hooking `enqueueJobsForEvent` into lifecycle writes) and an
  on-demand `userInvoked` HTTP entry remain to be surfaced.
- Multi-replica safe with zero coordination — the idempotent enqueue is the whole mechanism. A
  static tenant list is the v1; a DB-backed `TenantSource` is a drop-in when tenant enumeration lands.
- `operate-server` gains `@crossengin/jobs` + `@crossengin/workflow-runtime-pg` dependencies for the
  producer + `JobDeclaration` type (the manifest's `jobs` already use that exact schema, so no
  mapping).
- 6,966 tests pass (+11: scheduler — per-tenant tick, non-scheduled ignored, per-tenant error
  isolation, start/stop + immediate tick, start idempotent — 5; CLI — parse + defaults + memory-store
  / missing-tenant / missing-interval / too-small-interval rejects — 6). Full build + typecheck green.
- Follow-ups: a DB-backed `TenantSource`; entity-lifecycle events → `enqueueJobsForEvent`; a
  `userInvoked` HTTP endpoint → `enqueueUserInvokedJob`; and the P2 exit-criterion end-to-end against
  a live Postgres (kill worker A → resume on B), still gated on real infrastructure.
