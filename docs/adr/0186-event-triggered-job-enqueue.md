# ADR-0186: Event-triggered job enqueue — the producer half of the distributed job loop

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-24 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0185 (job worker + engine), ADR-0183 (job claim), ADR-0077 (P2), `jobs` package |

## Context

ADR-0183 → ADR-0185 built the *consumer* half of the distributed job loop: a durable claim, a poll
loop, and an execution engine that drives a `pending` `job_runs` row to a terminal status. But nothing
*wrote* a `pending` run — the queue had no producer. This ships the first one: event-triggered enqueue,
so a domain event (`retail.order_placed`) actually materializes the runs a worker then executes.

## Decision

- **A pure producer in `@crossengin/jobs`** (`enqueue.ts`) — the package that owns job semantics owns
  the matching:
  - `DomainEvent` (`name` + `tenantId` + `data` + optional emitter `idempotencyKey` + `occurredAt`).
  - `matchEventJobs(event, jobs)` — the event-trigger jobs whose `eventName` matches, excluding
    deprecated ones.
  - `enqueueKeyForEvent(event, jobId)` — the deterministic idempotency key: the emitter's
    `idempotencyKey` when present, else a **key-order-invariant** stable hash-input of the payload, so
    a re-delivered event collapses to one run while a genuinely different payload does not.
  - `planJobRunsForEvent(event, jobs)` → a `PlannedJobRun` per match (job kind, event trigger, event
    as input, data classes, `runKey`). Pure — no I/O.
- **The persistence in `@crossengin/workflow-runtime-pg`** (`job-enqueue.ts`) —
  `enqueueJobsForEvent(conn, {event, jobs, now})` inserts a `pending` `job_runs` row per planned run.
  The `run_id` is a **deterministic RFC 4122 v5 UUID** over the plan's `runKey`
  (`deterministicRunId`, SHA-1 over a fixed CrossEngin namespace + key), so the insert is
  `ON CONFLICT (tenant_id, run_id) DO NOTHING` — a re-delivered event never enqueues a duplicate
  (`inserted: false`). `started_at` is set to `now`, so the run is immediately due for the claim. All
  values are bound; the validated schema is the only interpolated identifier; the connection is
  platform-scoped with `tenant_id` bound per row.

## Consequences

- The distributed job loop is now closed end-to-end for events: emit `retail.order_placed` →
  `enqueueJobsForEvent` writes a `pending` run → a `WorkflowJobWorker` claims it (`FOR UPDATE SKIP
  LOCKED`) → `PostgresJobRunEngine` executes + finalizes it. The P2 "a job fires from a
  `retail.order_placed` event, exactly once under concurrent workers" story now has its trigger side.
- **Exactly-once enqueue under at-least-once delivery** is the deterministic-`run_id` +
  `ON CONFLICT DO NOTHING`: two deliveries of the same event derive the same run id and the second is
  a no-op. Combined with the engine's `status = 'pending'` finalize guard, the whole chain is
  idempotent from event to completion.
- The matching lives in `jobs` (pure, reusable, testable offline); only the `INSERT` lives in the pg
  package — the usual pure-contract / impure-binding split. `workflow-runtime-pg` gains a
  `@crossengin/jobs` dependency for the shared types + planner.
- 6,892 tests pass (+12: pure enqueue — event/schema validation, match-by-name skipping
  other-trigger/deprecated, deterministic + payload-fallback + key-order-invariant keys, plan shape —
  7; pg enqueue — deterministic v5 run id, bound insert + ON CONFLICT, re-delivery no-op, no-match,
  invalid schema — 5). Full build + typecheck green.
- Follow-ups: the **cron/scheduled** producer (a due-scan enqueuing `pending` runs at their fire time)
  and the **delayed** trigger (`afterEvent` + `delay` → `started_at = now + delay`); wiring
  `enqueueJobsForEvent` into `operate-server`'s lifecycle/event emission so entity events drive jobs;
  the full `RetryPolicy` backoff on the consumer side (ADR-0185 follow-up).
