# ADR-0193: Entity-event job emission — served writes fire event-triggered jobs

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-29 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0186 (event producer), ADR-0192 (operate-server scheduler), ADR-0087 (operate-server), ADR-0077 (P2) |

## Context

ADR-0186 built the event-triggered job producer (`enqueueJobsForEvent`) and ADR-0192 wired the *cron*
producer into `operate-server`. But nothing in the serving app emitted the **domain events** that
event/delayed-triggered jobs listen for — a served `SalesOrder` transition to `placed` never fired an
`order-placed-handler`. This closes that gap: a served entity write now produces a domain event that
enqueues matching jobs.

## Decision

- **The `WriteEffect` after-commit hook is the seam.** Handlers already run `writeEffects` after a
  successful create / update / delete / transition (the after-commit sibling of `WriteGuard`), with
  `{operation, entity, tenantId, id, before, after}`. `WriteEffectInput` gains an optional
  `transitionTo` (the lifecycle target state, set only on a transition) so an effect can name the
  event by the new state.
- **`entityEventEffect`** (`@crossengin/operate-runtime`) maps a write to an `EntityEvent`: name
  `<prefix?>.<entity>.<verb>` — `created` / `updated` / `deleted`, or the transition's target state
  (`salesorder.placed`) — with sanitized dotted segments, the after-record as `data`, and a stable
  `idempotencyKey` (`<entity>:<op>:<recordId>:<updated_at|verb>`). It is **best-effort**: a sink
  failure is routed to `onError` and swallowed — emitting an event must never fail the user's write
  (unlike the financial effects, which throw by design).
- **`PostgresEntityEventSink`** (`apps/operate-server`) turns each `EntityEvent` into `pending`
  `job_runs` via `enqueueJobsForEvent`, so every event/delayed job whose `eventName` matches fires
  through the durable queue the worker fleet drains — idempotent by the producer's deterministic
  `run_id` + `ON CONFLICT DO NOTHING` (keyed on the event's `idempotencyKey`). Also non-throwing.
- **Additive wiring.** A new `additionalWriteEffects` option on the gateway builder *appends* effects
  after the resolved defaults (so the manifest's financial effects are preserved), threaded through
  `buildOperateHttpServer`. `serve()` builds the sink over `Object.values(manifest.jobs)` and appends
  the effect when `--emit-entity-events` (+ optional `--event-prefix`) is set over a Postgres store.

## Consequences

- The event side of the loop now runs **end-to-end in the deployed app**: a served write →
  `entityEventEffect` → `PostgresEntityEventSink` → `enqueueJobsForEvent` → `job_runs` → the worker
  fleet (claim → execute → retry/dead-letter). Combined with ADR-0192's cron scheduler, both the
  **scheduled** and the **event/delayed** producers now fire from `operate-server` — the P2 producer
  story is complete inside the serving binary.
- The event-name convention (`<entity>.<verb>` / `<entity>.<state>`) is what a job's
  `trigger.eventName` matches; a `--event-prefix` namespaces it per deployment. The manifest author
  names the trigger to match.
- Safety-first by construction: entity-event emission is a best-effort side channel at **two** layers
  (the effect and the sink both swallow + route errors), so a queue outage degrades to "jobs didn't
  fire," never "the write 500'd." Financial `writeEffects` keep their throw-to-abort semantics —
  emission is appended, not substituted.
- 6,980 tests pass (+14: operate-runtime +7 — create/update/delete verbs, transition-by-state, prefix,
  segment sanitization, best-effort onError, id/updated_at fallback; operate-server +7 — sink enqueues
  on match / nothing on no-match / best-effort onError, plus 4 CLI parse + reject paths). Full build +
  typecheck green.
- Follow-ups: a `userInvoked` HTTP endpoint → `enqueueUserInvokedJob` (the last producer surface); a
  DB-backed `TenantSource` for the scheduler; and the P2 exit-criterion end-to-end against a live
  Postgres, still gated on real infrastructure.
