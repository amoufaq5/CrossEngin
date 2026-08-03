# ADR-0194: userInvoked HTTP endpoint — the on-demand job producer surface

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-30 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0191 (userInvoked producer), ADR-0193 (entity-event emission), ADR-0087 (operate-server), ADR-0077 (P2) |

## Context

ADR-0191 built the `userInvoked` job producer (`enqueueUserInvokedJob`) — "run this job now" — but
it had no HTTP surface: nothing in `operate-server` let a caller actually trigger one. The other
three practical producers now fire from the server (scheduled + event/delayed, ADR-0192/0193); this
adds the last one, `userInvoked`, over HTTP.

## Decision

- **`POST /v1/meta/jobs/invoke`** — an authenticated caller runs a `userInvoked` job for **their own
  tenant** by naming its `action` (+ optional `data` / `idempotencyKey`). The route is a meta route
  registered through the gateway (modeled on `POST /v1/meta/billing-portal`), so the principal +
  tenant are resolved by the pipeline before the handler runs.
- **`buildJobInvokeHandler`** (`@crossengin/operate-runtime`) over an injected `JobInvoker` (keeps the
  package pg-free): `401` when the principal has no tenant (the caller-principal tenant is
  authoritative — a `tenantId` body field is ignored), `400` on a missing `action`, `404
  no_job_for_action` when no job listens, else `202` with the enqueued runs. Because the producer
  returns one entry per matched job (inserted or a dedup no-op), an empty result cleanly means "no
  match" → 404.
- **`PostgresJobInvoker`** (`apps/operate-server`) implements `JobInvoker` via `enqueueUserInvokedJob`
  — idempotent by the producer's deterministic `run_id` + `ON CONFLICT DO NOTHING` (keyed on the
  invocation's `idempotencyKey`), so a re-submitted invocation never double-runs.
- **Wiring.** A `jobInvoker` option on the gateway builder registers the route only when supplied
  (threaded through `buildOperateHttpServer`); `serve()` builds the invoker over
  `Object.values(manifest.jobs)` when `--enable-job-invoke` is set over a Postgres store.

## Consequences

- **All four practical job producers now fire from the deployed server**: `scheduled` (cron tick),
  `event` + `delayed` (entity-event emission), and `userInvoked` (this endpoint) — each landing a
  `pending` `job_runs` row the worker fleet drains. The P2 producer story is complete end-to-end in
  `operate-server`.
- Own-tenant only + own-token authoritative: the endpoint can't enqueue for another tenant (the
  principal's tenant is bound by the handler, not the body), matching the billing-portal route's
  posture. Role-gating the *set* of invokable actions is the deferred refinement.
- 6,989 tests pass (+9: operate-runtime +5 — 202-with-runs, idempotencyKey passthrough + data default,
  404-no-match, 400-missing-action, 401-no-tenant; operate-server +4 — invoker enqueue map / no-match,
  2 CLI parse + reject). Full build + typecheck green.
- Follow-ups: role-gating invokable actions; a DB-backed `TenantSource` for the scheduler; the
  `workflow` / `cdc` producers; and the P2 exit-criterion end-to-end against a live Postgres, still
  gated on real infrastructure.
