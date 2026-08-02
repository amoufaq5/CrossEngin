# ADR-0187: Scheduled (cron) job producer — the second enqueue path

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-25 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0186 (event enqueue), ADR-0185 (job worker + engine), ADR-0077 (P2), `jobs` package |

## Context

ADR-0186 shipped the *event-triggered* producer. Scheduled jobs — the `scheduled` (cron) trigger,
the second of the six `JOB_KINDS` — still had no producer: nothing fired a `pending` run when a cron
came due. This adds that path, reusing the deterministic-`run_id` idempotency mechanism from
ADR-0186.

## Decision

- **A pure cron evaluator in `@crossengin/jobs`** (`cron.ts`) — no new dependency, UTC-evaluated:
  - `parseCron(expr)` expands a 5- or 6-field crontab (`*`, `*/n`, `a-b`, `a-b/n`, lists; seconds
    field when 6-field; `dow` 7 → Sunday) into concrete matcher sets, recording whether `dom`/`dow`
    were narrowed from `*`.
  - `cronMatches(parsed, date)` applies the standard rule: when **both** day-of-month and
    day-of-week are restricted, a match on **either** fires; otherwise both must hold.
  - `cronPrevOnOrBefore(expr, now)` — the job's **current tick**: the latest fire instant ≤ `now`,
    found by stepping back one minute (or one second for a 6-field cron) within a bounded horizon.
    `cronNextAfter` is its forward twin.
  - `scheduledJobsDue(jobs, {now})` → the current tick per scheduled job (skipping non-scheduled +
    deprecated). Because the tick is **deterministic in `now`**, every scheduler pass within a tick
    window returns the same `fireAt` — the basis for stateless, idempotent enqueue.
- **The persistence in `@crossengin/workflow-runtime-pg`** (`enqueueScheduledJobs`, in
  `job-enqueue.ts`) — for each due job, the `run_id` is `deterministicRunId("scheduled::<tenant>::
  <job>::<fireAt>")`, so the `INSERT … ON CONFLICT (tenant_id, run_id) DO NOTHING` fires each tick
  **exactly once with no last-fired state table — the `job_runs` row itself is the state**.
  `started_at` is set to the tick instant (≤ now), so the run is immediately claimable; overlapping
  schedulers / multiple replicas race on the same id and only one wins.

## Consequences

- Two of the six job triggers now have producers: `event` (ADR-0186) and `scheduled`. A cron job
  installed for a tenant fires on schedule, claimed + executed by the same worker fleet — no separate
  scheduler process holds state, and running two scheduler replicas is safe by construction.
- **Stateless cron correctness** comes from the current-tick + deterministic-id design: no
  `last_fired_at` bookkeeping to drift or lose. The trade-off is deliberate — a scheduler outage
  spanning several ticks enqueues only the *current* tick on recovery, not every missed one (the sane
  default for cron; bounded catch-up is a follow-up).
- The evaluator is pure and offline-tested (dom/dow OR-semantics, tick stability across a window,
  month/year rollover for a yearly cron); only the `INSERT` is impure, the usual split.
- 6,910 tests pass (+18: cron evaluator — parse/steps/ranges/lists, seconds, dow-7, range validation,
  match exact + dom/dow OR + AND, prev/next tick, window-stability, yearly rollover, `scheduledJobsDue`
  filtering + stability — 14; pg scheduled enqueue — current-tick insert, cross-window idempotence,
  no-scheduled-job, invalid schema — 4). Full build + typecheck green.
- Follow-ups: the `delayed` trigger (`afterEvent` + `delay` → `started_at = now + delay`, a small
  extension of the event path); per-job **timezone** evaluation (cron is UTC today); bounded catch-up
  of missed ticks; wiring both producers into `operate-server` (a scheduler tick + entity-event
  emission). The full `RetryPolicy` backoff on the consumer stays the ADR-0185 follow-up.
