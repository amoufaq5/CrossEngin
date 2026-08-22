# ADR-0269: Async design jobs with live progress (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0267 (AI onboarding), ADR-0268 (hardening), ADR-0087 (operate-server), ADR-0077 (Phase 4) |

## Context

`POST /v1/ai/design` ran the whole design inline: up to three LLM attempts with kernel
validation between them, ~30–60s, on one request. The wizard showed a static "Designing your
system…" note for the entire time, with no signal that anything was happening — the most
user-visible weakness of the AI onboarding flow. A long silent request is also fragile: a
client disconnect, proxy timeout, or reload loses the work with no record it ever ran.

Streaming the response was considered and rejected: the 17-stage gateway pipeline produces a
single `RawHttpResponse` (a `Handler` returns json/empty/bytes), so real SSE would mean
bypassing the gateway — and with it authentication, RBAC, redaction, and the
`PipelineExecution` audit record. The one existing pre-gateway route (the Stripe webhook) is
signature-authenticated precisely because it sits outside that pipeline; the AI routes are
principal-authenticated and must stay inside it.

## Decision

A **durable job** the client polls, rather than a stream.

- **`meta.operate_design_jobs` (table #138, tenant RLS)** — status (`queued|running|succeeded|
  failed`), phase (`queued|generating|validating|retrying|done|error`), attempt/max_attempts,
  output_chars, issues JSONB, proposal_id, provider_label, error. A partial index on
  `updated_at WHERE status IN ('succeeded','failed')` backs retention (using the partial-index
  support from ADR-0268).
- **Engine progress (`ai-design.ts`)** — `DesignProgress` events emitted at the start of each
  attempt, during streaming, before validation, and on each failure path, carrying the issues
  that caused a retry. Throttled to one event per `DESIGN_PROGRESS_CHARS_STEP` (400) chars so a
  chatty model cannot produce thousands of downstream writes; never emitted after the final
  attempt (there is no retry to announce); a throwing listener can never break a design.
- **`design-jobs.ts`** — `PostgresDesignJobStore`, tenant-scoped through `withTenantContext`
  plus a bound tenant predicate, with `updateProgress` building its SET list from a fixed
  literal column map over bound parameters. `deleteExpired` is a platform-wide retention sweep
  and deliberately runs outside the tenant context.
- **`design-runner.ts`** — maps progress events onto job rows. Progress writes are chained on
  an internal promise queue and **drained before the terminal `succeed`/`fail`**, so a slow
  write can never overwrite the final state. Every throw becomes `jobs.fail` (a runner that
  threw would leave a job stuck `running` forever) and it never rejects. Failed designs are
  still charged to the tenant's AI budget — the tokens were spent.
- **Routes** — `POST /v1/ai/design/jobs` → **202 `{job}`** behind the same guard and budget
  gate as the sync route; `GET /v1/ai/design/jobs/:id` → the job, plus `proposal` + `summary`
  once succeeded so the wizard transitions in a single poll. The route table is always 7 (the
  job handlers self-503 when async isn't wired), keeping the surface stable. The synchronous
  route is unchanged for scripts.
- **Wizard** — submits, then polls every 1.2s, rendering the phase in human terms, the attempt
  counter, a live character readout and progress bar, and — on `retrying` — the validation
  issues being fixed. The poll timer lives only inside a `jobId`-keyed effect with a `cancelled`
  flag, so it cannot leak; Cancel stops watching client-side while the server job continues.

## Consequences

- **Verified live** against a real Postgres with a deliberately slow OpenAI-compatible model:
  `202` in 0.1s, then `generating` with `outputChars` climbing 0 → 405 → 810 → 1215 → 1580 over
  ~12s (the 400-char throttle visible in the step size), terminating at `succeeded` with the
  proposal and summary in the same poll; the wizard rendered the live panel and handed off to
  the review step on its own. The failure path was exercised too (provider down → `retrying` →
  attempt 3/3 → terminal `failed` with the error).
- A design now survives client disconnects and reloads, is readable from any replica, and
  leaves an audit row of every attempt — the description, provider, phase reached, issues hit,
  and outcome.
- +94 tests (operate-server 41 files / 669; kernel 582 with table #138). architect-cli's table
  count assertion moved 137 → 138. Full workspace build + typecheck + test green, operate-web
  build green.
- Follow-ups: a retention scheduler calling `deleteExpired` on an interval (the store method
  exists, nothing schedules it yet); server-side cancellation (Cancel is client-side only);
  and a platform-level review queue for AI proposals.
