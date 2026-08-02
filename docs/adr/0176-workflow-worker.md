# ADR-0176: `@crossengin/workflow-worker` — the poll → claim → fire → ack loop

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0175 (durable timer claim), ADR-0077 (Phase 3 P2), ADR-0049 (workflow-runtime) |

## Context

ADR-0175 shipped the durable claim primitive (`claimDueTimers`, `FOR UPDATE SKIP LOCKED`). What
runs it is a worker: poll the queue, fire each claimed timer, hand failures back, back off when
idle, forever — across a horizontal fleet. This is that worker, built as a **pure** package so its
loop is fully unit-testable and carries no Postgres dependency.

## Decision

- **`@crossengin/workflow-worker`** — a new pure package (zero runtime deps). Three modules:
  - **types** — `ClaimedTimer` (structurally identical to the pg `ClaimedTimer`, so
    `claimDueTimers` / `releaseTimerClaim` adapt in behind the `TimerClaimer` interface with **no
    package dependency** either way), `TimerClaimer` (claim/release), `TimerProcessor` (fire a
    timer — advance the instance).
  - **batch** — `processTimerBatch(claimer, processor, opts)`: claim a batch, process each timer
    sequentially, and **release** any that threw so they retry promptly (a release that itself
    fails is swallowed — the lease recovers the timer regardless). Returns
    `{claimed, succeeded, failed}`. At-least-once: processors must be idempotent.
  - **worker** — `WorkflowTimerWorker`: `runOnce()` is one poll cycle; `start()` loops it (short
    `activePollMs` after a poll that found work → drain the backlog; `idlePollMs` backoff after an
    empty poll), reports claim errors via `onError` and keeps running; `stop()` signals + awaits a
    clean halt. `now` + `sleep` are injectable (deterministic tests); the default sleep timer is
    `unref`'d so a worker never holds the process open.
- **Horizontal by construction.** Many `WorkflowTimerWorker`s run against one queue; `SKIP LOCKED`
  hands each a disjoint batch, so adding workers adds throughput with zero coordination. The
  Postgres binding is a ~4-line adapter the deployment writes (`claim: (o) => claimDueTimers(conn,
  o)`), keeping this package free of `pg`.

## Consequences

- The claim primitive now *runs*: a fleet drains due timers concurrently, retries failures, and
  survives transient DB errors — the P2 worker loop, minus the instance-advance processor (next).
- Pure + injectable: the loop is tested with an in-memory claimer + a synchronous `sleep`, no DB,
  no real timers — deterministic and fast.
- The structural `ClaimedTimer` seam means neither package depends on the other; the deployment
  wires them, exactly like the operate-server adapters.
- 6,809 tests pass (+8: batch success / release-on-failure / swallowed-release / empty; worker
  claim-args delegation, active-then-idle drain loop, onError-survives-and-continues, idempotent
  start / safe stop). New package builds; full workspace build + typecheck green.
- Follow-ups: a `TimerProcessor` bound to `workflow-runtime-pg`'s engine (submit the timer-fired
  event under the timer's tenant, with lease renewal for slow fires); the same worker over
  scheduled **activities** and `jobs`; the P2 exit-criterion end-to-end (kill worker A → resume on B).
