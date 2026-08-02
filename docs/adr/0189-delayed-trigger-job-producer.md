# ADR-0189: Delayed-trigger job producer — the third enqueue path

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-26 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0186 (event enqueue), ADR-0187 (scheduled producer), ADR-0188 (retry backoff), ADR-0077 (P2) |

## Context

ADR-0186 (event) and ADR-0187 (scheduled/cron) shipped two of the six job producers. The `delayed`
trigger — `{afterEvent, delay}`, "run this job N after event X" — was the natural third: it fires off
the same event stream as `event`, just deferred. This extends the event producer to cover it, reusing
the exact idempotency + deferral mechanisms already built (ADR-0186's deterministic `run_id`,
ADR-0188's `started_at`-as-due-time).

## Decision

- **The event producer now matches delayed jobs too** (`@crossengin/jobs`, `enqueue.ts`):
  - `matchEventJobs` returns `event`-trigger jobs whose `eventName` matches **and** `delayed`-trigger
    jobs whose `afterEvent` matches the event (still excluding deprecated).
  - `PlannedJobRun` gains `delayMs` (0 for `event`; `durationToMillis(delay)` for `delayed`) and its
    `trigger` carries the `delay`; `planJobRunsForEvent` sets `jobKind: "delayed"` + `delayMs` for a
    delayed match. The `runKey` is unchanged (`event::discriminator::jobId`), so idempotency is
    identical.
- **The persistence defers `started_at`** (`enqueueJobsForEvent`): the inserted run's `started_at` is
  `now + delayMs` when `delayMs > 0`, else `now` verbatim. Because the claim's due-check is
  `started_at <= now`, the run stays out of the queue until its delay elapses, then a worker claims +
  executes it — the same deferral the retry backoff (ADR-0188) uses, no new column or timer.

## Consequences

- Three of six job triggers now have producers (`event`, `scheduled`, `delayed`). "Send a review
  request 24 h after `order_placed`" is now a one-line `delayed` declaration that fires end-to-end
  through the existing claim + worker + engine.
- Delayed runs inherit every event-producer guarantee: deterministic `run_id` → `ON CONFLICT DO
  NOTHING`, so a re-delivered `afterEvent` never double-schedules; the event payload is the run input;
  data classes carry through.
- Zero new surface — the change is additive to `matchEventJobs` / `planJobRunsForEvent` and a
  one-line `started_at` computation. Event-trigger behavior is byte-identical (`delayMs 0 → started_at
  = now`), so every existing test passes unchanged.
- 6,923 tests pass (+3: delayed match by `afterEvent`, delayed plan carries `delayMs` from the ISO
  duration, pg defers `started_at = now + delay`). Full build + typecheck green.
- Follow-ups: the remaining producers (`userInvoked`, `workflow`, `cdc`); per-job timezone for the
  cron producer; wiring all producers + a scheduler tick into `operate-server`'s event emission; the
  activity-side retry backoff (ADR-0188 follow-up).
