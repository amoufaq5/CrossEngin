# ADR-0315: Durable job cancellation, with four named checkpoints

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0269, ADR-0289 |

## Context

ADR-0269 recorded that "job cancellation is client-side only". A caller could abandon a request and
nothing about the abandonment reached the queue: the run stayed claimable, a worker picked it up, the
handler ran to completion, and the result was written. The only thing cancelled was the client's
interest in the answer.

A durable cancellation has to answer an awkward question honestly, which is why this took a contract and
not a column: **what exactly is promised?** An arbitrary handler cannot be preempted. Node has no way to
stop a function that is halfway through a network call and a transaction. So a cancellation that claims
"the work stops" is lying, and one that claims nothing is not worth recording.

## Decision

**`cancel_requested_at` *is* the cancellation.** It outlives the process that asked, it is what the claim
query consults, and it is what a worker holding the lease reads. Four columns on `meta.job_runs`:
`cancel_requested_at`, `cancel_requested_by` (TEXT — a structured actor, per ADR-0289's finding),
`cancel_reason`, and `cancelled_at_checkpoint`, plus a partial index
`WHERE cancel_requested_at IS NOT NULL`.

**The promise is stated, stored, and bounded: a cancellation guarantees that no further work will be
*started*.** It does not guarantee that work already inside a handler stops — only that the handler is
*told*, via an `AbortSignal`, and that a handler which ignores the signal still lands as `cancelled`
rather than `completed`, unless it genuinely finished first.

**Four checkpoints, and a run is cancelled at one of them and nowhere else.**
`JOB_CANCELLATION_CHECKPOINTS` + `JOB_CANCELLATION_GUARANTEES` spell out what each one means, and
`cancelled_at_checkpoint` is stored on the run — so the guarantee is readable *from the data* rather than
inferred from logs:

| Checkpoint | What it promises |
|---|---|
| `before_claim` | pending, no live lease → moved straight to `cancelled`; no worker ever saw it |
| `before_handler` | a worker held it but had not entered the handler; the handler was never invoked |
| `cooperative_abort` | the handler was running and was signalled |
| `lease_reaped` | the holding worker died; the reaper finalized it |

**`requestJobCancellation` is the only entry point, and the ordering between its two writes is the whole
race story.** `planJobCancellation` chooses between them:

1. **`cancel_now`** re-asserts the plan's premise *inside the `UPDATE` predicate* (still `pending`, still
   no live lease). A worker that claimed the run between the read and the write therefore wins the row,
   `rowCount` is 0, and we fall through to (2) — rather than publishing `cancelled` over a handler that
   is already running.
2. **`request_cancel`** stamps with `COALESCE`, so a second request never restates who asked or when:
   cancelling twice is a no-op on the record. It deliberately leaves `claimed_by` and `claim_expires_at`
   **alone** — the holding worker must keep its lease to finalize the run, and releasing it here would
   let a second worker claim work that is on its way out.

The fallback from (1) to (2) is bounded, never a retry loop, and always degrades towards the weaker,
safer action.

**`abortWhile` gives the task a channel, not a kill.** It runs the handler with an `AbortSignal` that
trips when the probe first says so; the task is still awaited, and one that ignores the signal runs to
completion. The watcher stops the moment the task settles and `abortWhile` awaits it, so no probe
outlives the work.

**A probe that throws mid-flight does not abort.** The handler is already part-done, and a database blip
is not a cancellation — discarding real work on an unanswered question is the expensive mistake. The next
probe retries. This is the **opposite** choice from the pre-flight check in `processJobBatch`, where
nothing has been done yet and deferring the item (`cancellation_unknown`) costs nothing. Two different
answers to "what if we cannot tell?", each correct for its position.

**The lease keeps being renewed while a cancellation is observed**, because the holding worker is the one
that must write the terminal `cancelled`; dropping the lease at the moment of cancellation would hand the
run to the reaper instead.

**`buildWorkflowJobWorker({ cancellation: true })` wires all of it** — the claim-side exclusion, the
pre-handler clear, the mid-flight poll, and the reaper for abandoned cancellations. Off by default: with
it off a recorded cancellation still keeps the run out of the claim set, but nothing finalizes it and
nothing aborts a handler.

**`POST /v1/meta/jobs/runs/{runId}/cancel`** is the HTTP surface, gated on the same roles as invoking a
run — being able to start work and being able to stop it are the same privilege over the same queue, and
splitting them would let somebody start work nobody can stop. The tenant comes from the credential and
never the path; `requestedBy` is the authenticated principal, not a body field, because a route that let
the body name the requester would make the column decorative. The four outcomes are reported distinctly
(`200` / `202` / `200` / `409` / `404`) rather than flattened — in particular `already_terminal` as a
409, because the work happened and reporting it as a successful cancellation would be false.

## Alternatives considered

- **Option A:** release the claim when a cancellation is recorded, so the run stops being anybody's.
  - **Pros:** intuitive; the run is immediately free.
  - **Cons:** a second worker claims a run that is on its way out, and two workers then race to write
    its terminal status. The holding worker is the only one that knows whether the handler finished.
  - **Why not:** the lease is what makes the terminal write unambiguous.

- **Option B:** `UPDATE … SET status = 'cancelled'` unconditionally, without re-asserting the premise.
  - **Pros:** one statement; always succeeds.
  - **Cons:** it publishes `cancelled` over a run whose handler is mid-flight and may already have
    committed its effects. The audit trail would then say cancelled about work that happened.
  - **Why not:** the predicate is the race fix. `rowCount = 0` is information, not a failure.

- **Option C:** abort on a probe failure, treating "cannot tell" as "cancel".
  - **Pros:** consistent with CLAUDE.md's fail-closed rule; a cancellation is never missed.
  - **Cons:** a transient database blip discards a part-finished handler's work. Fail-closed is about
    *access*; here the expensive mistake is throwing away work on an unanswered question.
  - **Why not:** declined mid-flight, adopted pre-flight. The asymmetry is stated in both places.

- **Option D:** cooperative only — hand the handler a signal and record nothing.
  - **Pros:** no schema change; no claim-query change.
  - **Cons:** the request dies with the process that made it, which is ADR-0269's state.
  - **Why not:** durability is the entire point.

- **Option E:** a separate `job_cancellations` table rather than columns on the run.
  - **Pros:** append-only; a second request is a second row with its own actor.
  - **Cons:** the claim query would need a join or a subquery on its hot path, and `COALESCE`-stamping
    already gives the property that matters (the first request's actor and reason stand).
  - **Why not:** the claim query's cost is the constraint. A partial index on four columns of the run is
    cheaper than a join.

## Consequences

- **Positive:** a cancellation outlives the client, the process and a worker death. The promise is
  explicit and stored per run, so "was this cancelled before or during the handler?" is answerable from
  the row. A cancelled run cannot be claimed, and a handler that ignores its signal still lands as
  `cancelled`.
- **Negative:** a handler that ignores the signal still runs to completion and may commit its effects —
  the cancellation then records that the work was cancelled while its side effects happened. That is
  unavoidable without preemption, and it is why the guarantee is phrased as "no further work will be
  *started*".
- **Neutral:** `cancellation: true` is opt-in. With it off the claim-side exclusion still applies, so a
  recorded cancellation keeps the run out of the queue but nothing finalizes it — a half-state worth
  knowing about, which is why the option's doc comment says so.
- **Reversibility:** the columns are additive and nullable; the worker option defaults off; the HTTP route
  is mounted only when job invocation is enabled. Turning all of it off leaves the rows, unread.

## Implementation notes

- `packages/jobs/src/cancellation.ts` (the vocabulary, the guarantees, `planJobCancellation`),
  `packages/workflow-worker/src/abort.ts` (`abortWhile`, mirroring `renewWhile`'s shape),
  `packages/workflow-runtime-pg/src/job-cancellation.ts` (`requestJobCancellation`, the claimer's
  exclusion, the reaper), `apps/operate-server/src/job-cancel-routes.ts` (the HTTP surface).
- `cancel_requested_by` is TEXT, not a `meta.users` UUID — the sixth instance of ADR-0289's finding, and
  a cancellation may come from a system actor.
- `cancelled_at_checkpoint` carries a 4-value CHECK matching `JOB_CANCELLATION_CHECKPOINTS`;
  `idx_job_runs_cancel_requested` is partial on `cancel_requested_at IS NOT NULL`, since the predicate
  is false for almost every row.
- `TERMINAL_JOB_RUN_STATUSES` includes `cancelled`; `CANCELLABLE_JOB_RUN_STATUSES` is `pending` and
  `running` only, with `cancelled` deliberately absent so re-cancelling is `already_requested` rather
  than a transition.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A handler that ignores its `AbortSignal` commits its effects and is recorded `cancelled`. Should a handler's effects be rolled back, and could they be? | amoufaq5 | _unscheduled_ |
| With `cancellation: false` a recorded cancellation keeps a run out of the queue and nothing finalizes it. Should the claimer refuse to exclude without the finalizer? | amoufaq5 | _unscheduled_ |
| Nothing cancels a *workflow* instance's timers or activities; this is jobs only. | amoufaq5 | _unscheduled_ |

## References

- ADR-0269 (cancellation was client-side only), ADR-0289 (a column narrower than its contract).
- `AbortController` / `AbortSignal`; PostgreSQL `FOR UPDATE SKIP LOCKED` claims and partial indexes.
