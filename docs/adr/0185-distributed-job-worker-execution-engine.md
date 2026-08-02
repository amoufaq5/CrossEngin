# ADR-0185: Distributed job worker + execution engine

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-24 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0183 (job claim), ADR-0182 (activity worker), ADR-0184 (activity retry + dead-letter), ADR-0077 (P2) |

## Context

ADR-0183 shipped the durable `meta.job_runs` claim (`claimDueJobs` / `releaseJobClaim` /
`renewJobClaim`) — the queue substrate for the third P2 work type — but deliberately ahead of its
consumer: nothing executed a claimed run. This closes that gap with the job worker + execution
engine, the exact analog of the activity worker (ADR-0182) and its retry/dead-letter (ADR-0184), so
jobs now run distributed end-to-end.

## Decision

- **A pure job worker loop** in `@crossengin/workflow-worker` — `job-types.ts` (`ClaimedJob` /
  `JobClaimer` / `JobProcessor`, structurally identical to the pg `ClaimedJob` so the binding plugs
  in with no cross-package dependency), `job-batch.ts` (`processJobBatch`: claim → process each →
  release failures for prompt retry; at-least-once, so processors must be idempotent), and
  `job-worker.ts` (`WorkflowJobWorker`: the same drain-then-idle-backoff poll loop as
  `WorkflowActivityWorker`, `onError`-resilient, `unref`'d default sleep).
- **A job execution engine** in `@crossengin/workflow-runtime-pg` — `PostgresJobRunEngine.
  executeJobRun(runId, tenantId)`:
  - Reads the `pending` run (scoped by `tenant_id` + `run_id`; the connection is platform-scoped /
    RLS-bypassing like the rest of the package), resolves a handler via a `JobHandlerRegistry`
    (exact `job_id` match, then a per-`job_kind` fallback — mirroring the activity `ActivityRegistry`),
    and dispatches with the run's trigger + input.
  - Finalizes from the handler result: `completed` → completed (output + duration); `failed`
    retryable with attempts remaining → back to `pending` (attempts + 1, claim cleared, immediately
    due); `failed` non-retryable → `failed`; `failed` retryable but ceiling reached → `dead-lettered`.
    An unresolved handler is a non-retryable `failed` (`handler_not_found`), never an infinite
    re-claim. A handler that *throws* propagates so the worker releases the claim — a transient infra
    error, retried without consuming a business attempt.
  - **Crash-safe**: the run stays `pending` through execution (mutual exclusion is the worker's
    lease, not a `running` status, which the claim would exclude), so a crashed worker's run is
    re-claimed once its lease lapses; every finalizing `UPDATE` is guarded by `status = 'pending'`,
    so a duplicate execution is an idempotent no-op (`rowCount = 0`).
- **The pg worker binding** — `buildJobClaimer` / `buildJobProcessor` / `buildWorkflowJobWorker`
  (with optional lease renewal via `buildJobClaimRenewer` + `renewWhile`), the job counterpart of
  `buildWorkflowActivityWorker`.

## Consequences

- The #83 job claim now runs: enqueue a `pending` `job_runs` row, and a fleet of `WorkflowJobWorker`s
  claims disjoint batches (`FOR UPDATE SKIP LOCKED`), executes each by kind, and drives it to a
  terminal status — with bounded retries and a clean dead-letter, matching the activity path.
- The retry ceiling comes from the registered handler (`maxAttempts`, from the job definition), since
  `job_runs` has no `max_attempts` column — as ADR-0183 anticipated. The `dead-lettered` status enum
  value is now actually reachable.
- All three P2 work types (timers, activities, jobs) share one shape: `FOR UPDATE SKIP LOCKED` claim
  → pure poll loop → log/row-driven targeted execute → lease renewal → at-least-once idempotent
  retry.
- 6,880 tests pass (+22: pure job worker loop batch/drain/error/idempotence — 8; job execution engine
  completed/not-claimable/retry/dead-letter/non-retryable/handler-not-found/throw-propagates/
  finalize-guard + registry resolution — 10; pg worker binding claimer/processor/renewal/worker — 4).
  Full build + typecheck green.
- Follow-ups: honor the definition's full `RetryPolicy` (backoff via a `next_retry_at` delay rather
  than immediate reschedule); event-trigger + cron enqueue writing `pending` `job_runs`; the P2
  exit-criterion end-to-end against real Postgres (kill worker A → run resumes on worker B).
