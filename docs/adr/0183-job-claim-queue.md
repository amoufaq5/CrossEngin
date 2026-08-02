# ADR-0183: Durable job-run claim — the queue substrate for distributed jobs

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0180 (activity claim), ADR-0175 (timer claim), ADR-0077 (P2), `jobs` package |

## Context

Timers and activities each have a durable `FOR UPDATE SKIP LOCKED` claim (ADRs 0175, 0180). Jobs —
the cron/event-triggered work in the `jobs` package, materialized as `meta.job_runs` — are the third
work type. This ships their claim substrate, the exact analog of the activity claim, so a future job
worker + execution engine plug into a proven primitive.

## Decision

- **Lease columns on `meta.job_runs`** — `claimed_by TEXT` + `claim_expires_at TIMESTAMPTZ` + an
  `idx_job_runs_due (status, started_at)`. No new table; count unchanged.
- **`claimDueJobs` / `releaseJobClaim` / `renewJobClaim`** (`workflow-runtime-pg`), mirroring the
  activity claim:
  - claim — CTE selects up to `limit` `pending` runs with `started_at <= now` (the enqueue/due
    column) and no live claim, `FOR UPDATE SKIP LOCKED`, then `UPDATE … RETURNING` a `ClaimedJob`
    keyed on `run_id` (the per-tenant run id), carrying `tenantId`, `job_id` (the job-definition key,
    the analog of `definitionActivityKey`), `job_kind`, `attempts`, and the lease. Concurrent workers
    get disjoint batches; a lapsed lease recovers a crashed worker's runs.
  - release / renew — owner-scoped, `pending`-scoped; renew returns `true` only if the row updated.
- Every value bound; schema identifier validated; the worker connection is platform-scoped, so one
  fleet serves every tenant with `tenant_id` on each claimed row.

## Consequences

- The job queue behaves exactly like the timer/activity queues — concurrent-safe claiming, crash
  recovery, lease renewal — so a job worker will be a near-copy of the activity worker (claimer +
  processor + the `WorkflowActivityWorker`-shaped loop).
- `job_runs` has no `max_attempts` column (only `attempts`), so `ClaimedJob` carries `attempts`
  alone; the retry ceiling comes from the job definition, applied by the future job engine.
- Additive/nullable — nothing changes for existing job records; no run is `pending`-claimed by
  anything until the job worker lands. Substrate deliberately ahead of the consumer, as with the
  timer and activity claims before their workers.
- Full workspace green (job-claim: 5 tests; kernel meta-schema invariants + table count unchanged);
  build + typecheck clean.
- Follow-ups: the job worker binding (claim → execute the job kind → complete/fail) + a job
  execution engine; retry + `dead-lettered` after the definition's max attempts (the status enum
  already has `dead-lettered`); event-trigger + cron enqueue writing `pending` `job_runs`.
