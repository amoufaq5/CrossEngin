# ADR-0015: Jobs and Async Runtime

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0007, ADR-0008, ADR-0011, ADR-0013, ADR-0014, ADR-0017 |

## Context

CrossEngin runs hundreds of asynchronous operations per tenant per day:

- **Workflow effects** (ADR-0007): notify, transition, integration call.
- **Integration calls** with retries (ADR-0011).
- **File processing** (ADR-0014): virus scan, OCR, embedding, PDF generation.
- **Reporting** (ADR-0013): scheduled exports, materialized-view refresh, CDC shipping.
- **Compliance** (ADR-0012): audit-log archival, attestation reminders.
- **AI Architect** (ADR-0005): conversation summarization, eval-suite runs, manifest-resolver cache warming.
- **Tenant lifecycle**: schema provisioning, manifest apply DDL, sandbox creation, deletion.
- **Cross-tenant ops**: cost aggregation, anomaly detection, security telemetry.

All of these need a durable async runtime: jobs that survive process restarts, retry transient failures, support long waits (minutes to weeks), provide observability, isolate tenants from each other, and don't lose work.

Round 1 implied **Inngest** as the substrate (it's in the ADR-0024 monorepo layout and ADR-0007 uses it). This ADR formalizes the job model, conventions, observability, isolation, and operational practices.

The cost / availability profile of the job runtime matters: a job system that loses work is unacceptable in a compliance-bound platform; one that's expensive at scale erodes margins.

## Decision

`packages/jobs` is the unified job layer. Every async operation in CrossEngin runs as an Inngest function. The kernel registers per-tenant function variants at manifest apply time. The job layer provides retries, durability, observability, and isolation; consumers focus on business logic.

### Job kinds

| Kind | Trigger | Example |
|---|---|---|
| `event` | Kernel event emitted (per ADR-0007) | `prescription.verified` → `notifyPatient` |
| `scheduled` | Cron expression | Daily expiry check, weekly reporting |
| `delayed` | Time-relative to event | Vaccination dose-2 reminder 28 days after dose-1 |
| `userInvoked` | Direct API call from app | PDF generation requested from UI |
| `workflow` | Step in an orchestration | `humanTask` step assigned, `callIntegration` step queued |
| `cdc` | Database change event | Postgres write → ClickHouse mirror |

### Job declaration

```typescript
// packages/jobs/registry/notifyPatient.ts
import { inngest } from "@crossengin/jobs";

export const notifyPatientJob = inngest.createFunction(
  {
    id: "notify-patient",
    name: "Notify Patient Prescription Ready",
    concurrency: { limit: 50, key: "event.data.tenant_id" },
    rateLimit: { limit: 200, period: "1m", key: "event.data.tenant_id" },
    retries: 5,
    onFailure: handleFailure,
  },
  { event: "prescription.verified" },
  async ({ event, step }) => {
    const patient = await step.run("load-patient", () => loadPatient(event.data.patient_id));
    const channel = await step.run("pick-channel", () => pickChannel(patient));
    await step.run("send-notification", () => sendNotification(patient, channel));
    await step.run("emit-audit", () => emitAudit(event));
  }
);
```

Every job has:

- **`id`** — stable, used in dashboards and audit logs.
- **`concurrency` key** — per-tenant by default; prevents one tenant from saturating the worker pool.
- **`rateLimit`** — per-tenant per-job; prevents runaway loops.
- **`retries`** — default 3 for events, 5 for integrations.
- **`onFailure`** — declarative failure handler (dead-letter, alert, escalate).
- **`step.run` blocks** — Inngest's checkpointing primitive. Each step is independently retried; intermediate state is persisted.

### Tenant isolation

Three isolation mechanisms:

1. **Concurrency keys.** Default `event.data.tenant_id`; per-tenant concurrency limits prevent one tenant's workload from exhausting global slots.
2. **Rate limits.** Per-tenant per-job rate limits.
3. **Per-tenant function variants.** When a tenant's manifest declares custom workflows (per ADR-0007), the kernel generates `<tenant_id>__<workflow>__<version>` Inngest functions. Different tenants' workflows are different Inngest functions; no cross-tenant code execution.

### Per-tenant concurrency tiers

| Tier | Default concurrency limit |
|---|---|
| Free / trial | 10 |
| Operate base | 50 |
| Operate premium | 200 |
| Regulated (pharma, healthcare) | 500 |
| Enterprise | Negotiated |

Limits raise on plan upgrade; never auto-reduce (regression-protection). Aggregate platform-wide concurrency is capped to protect Inngest budget; per-tenant limits are a fairness mechanism within the platform cap.

### Retry semantics

Per job declaration:

- **`retries: N`** — max attempts. Defaults: events 3, integrations 5, scheduled 3, user-invoked 2.
- **Backoff:** exponential with jitter (1s, 2s, 4s, 8s, 16s) up to a max retry interval.
- **Permanent vs. transient errors:** the job's error handler returns either:
  - `throw new RetryableError(...)` — retry
  - `throw new PermanentError(...)` — no retry, route to dead-letter immediately

### Dead-letter handling

Every job has an `onFailure` declaration:

| Strategy | Behavior |
|---|---|
| `dead-letter` | Move to `meta.dead_letter_jobs` for manual review. Default. |
| `alert-and-dead-letter` | P2 alert + dead-letter. Used for tenant-visible jobs (notifications, integrations). |
| `escalate` | P1 alert; emit cross-tenant ops event. Used for compliance-critical jobs. |
| `swallow-and-log` | Suppress; log only. Used for nice-to-have jobs (telemetry). |

Dead-letter rows include: job id, input event, attempt history, final error, tenant context. Admin UI surfaces dead-letter queue with reprocess / discard actions.

### Long-running jobs

Jobs with wait durations of minutes to weeks (per ADR-0007 orchestrations, ADR-0014 retention archival) use Inngest's `step.sleepUntil` primitive. Inngest persists the wait state in its own storage; no process holds memory while waiting.

Examples:

- Vaccination dose-2 reminder: 28-day `step.sleepUntil`.
- 7-year retention archival: `step.sleepUntil(date)` scheduled at file creation.
- Long-running orchestrations: Inngest tracks state across days/weeks.

The kernel does not implement its own cron — Inngest's scheduled functions handle it.

### Audit on jobs

Every job execution writes to `meta.job_runs`:

```jsonc
{
  "job_id": "notify-patient",
  "tenant_id": "t_...",
  "run_id": "...",
  "trigger": { "kind": "event", "event_name": "prescription.verified", "event_id": "..." },
  "started_at": "...",
  "completed_at": "...",
  "duration_ms": 423,
  "attempts": 1,
  "status": "completed" | "failed" | "dead-lettered",
  "input_redacted": { ... },
  "output_redacted": { ... },
  "error": null
}
```

PHI / PII redaction (per ADR-0009 data-classification rules) applies to input/output before logging. Job run history is retained 30 days by default; longer for compliance-critical jobs per pack rules.

### Observability

Per ADR-0017:

- **Inngest dashboard** for real-time job state.
- **Metrics into Sentry + per-tenant ClickHouse aggregates:** job duration, retry count, failure rate, queue depth, per-job p50/p95/p99 latency.
- **Per-tenant dashboards** show their own job queue health.
- **Alert thresholds:** dead-letter rate > 1% of run rate → P2; > 5% → P1; failure rate > 50% on any job → P1.

### Job versioning

Manifest changes that affect workflow definitions emit new Inngest function versions. In-flight runs continue under their original version; new runs use the latest. Inngest handles version coexistence natively.

Job-package code changes (e.g., a bug fix in the `notifyPatient` body) deploy as part of CrossEngin releases; version transition uses Inngest's built-in deployment-aware function registration.

### Worker scaling

v1 uses Inngest Cloud's hosted runtime. CrossEngin doesn't operate worker processes directly. Inngest scales horizontally on its side; CrossEngin pays per-execution.

When ARR + execution volume justify, evaluate Inngest's self-hosted option to reduce per-execution cost. Estimated trigger: ~10M executions/month sustained.

### Cost telemetry

Every job execution records an estimated cost into `meta.job_costs`:

```jsonc
{
  "tenant_id": "t_...",
  "job_id": "notify-patient",
  "run_id": "...",
  "estimated_cost_usd": 0.00002,
  "occurred_at": "..."
}
```

Aggregated into ClickHouse for per-tenant cost dashboards (per ADR-0013). Per-tenant cost reports drive billing for usage-priced AI Architect calls (per pricing decision) and surface anomalies (a tenant suddenly spawning 10× the jobs is investigated).

### Idempotency

Event-triggered jobs default to **idempotent retries** — re-running the same `(job_id, event_id)` produces the same effect. Achieved via:

- **Pure logic where possible.** Side-effects guarded by idempotency keys.
- **`step.run` checkpointing.** Inngest re-runs only the steps that haven't succeeded.
- **External-call idempotency.** Integration calls use idempotency keys (per ADR-0011); file uploads use deterministic R2 keys; database writes use unique constraints or upsert.

User-invoked jobs (e.g., "generate this PDF") use kernel-issued tokens for client-side idempotency — repeated clicks don't generate duplicate PDFs.

### Manifest-declared jobs

Tenants can declare scheduled jobs via the manifest (cross-ref ADR-0007 scheduled workflows). Code-defined jobs are first-party (CrossEngin staff write); manifest-declared jobs are tenant-configurable but invoke first-party action kinds.

### AI Architect interaction with jobs

The agent (ADR-0005) can propose manifest changes that add or modify scheduled workflows. It cannot directly invoke user-invoked jobs; user-invoked jobs go through the API surface which enforces permissions.

The agent's own conversation-summary job is a system job (`actor.kind = "ai_architect_system"`).

## Alternatives considered

### Option A — Postgres-backed job queue (pg-boss, Graphile Worker)

Use Postgres as the job queue.

- **Pros:** One database. No new infrastructure.
- **Cons:** Long-running jobs (weeks) hold Postgres rows. Cron / scheduled / event-pattern matching becomes complex. Per-tenant concurrency control is awkward. Replay / step-checkpointing primitives less mature than Inngest's.
- **Why not:** Inngest's primitives (`step.run`, `step.sleepUntil`, durable functions) are designed for this exact problem; reinventing them on Postgres is months of work.

### Option B — BullMQ / Redis-backed queue

Use Redis + BullMQ for job orchestration.

- **Pros:** Mature. Cheap Redis hosting.
- **Cons:** Adds a separate Redis dependency. Long-running jobs (weeks) and complex retry+wait state management is harder. Tenant isolation requires custom queue-naming conventions.
- **Why not:** Inngest abstracts the underlying storage and gives us the primitives natively.

### Option C — AWS SQS + Lambda / GCP Cloud Tasks + Cloud Functions

Cloud-native job queues.

- **Pros:** Battle-tested at scale.
- **Cons:** Vendor lock-in to AWS / GCP. Lambda cold starts. Per-message pricing. Long-waits require workarounds (Step Functions).
- **Why not:** Vercel + Supabase + Cloudflare + Inngest avoids the AWS / GCP dependency; Inngest fills the durable-workflow role.

### Option D — Temporal.io (already considered for workflows in ADR-0007)

Use Temporal as the job + workflow layer.

- **Pros:** Powerful workflow primitives.
- **Cons:** Self-hosted complexity; Temporal Cloud pricing.
- **Why not:** Inngest is the right fit at our scale (per ADR-0007 alternative). Reconsider Temporal at multi-region multi-tenant scale.

### Option E — Build our own job runtime

Roll a custom durable-function system on Postgres + Inngest-like primitives.

- **Pros:** Maximum fit.
- **Cons:** Months of foundational work. Inngest has done this engineering already.
- **Why not:** Buy don't build.

### Option F — Inngest self-hosted from day one

Skip Inngest Cloud; self-host from v1.

- **Pros:** Lower per-execution cost at high volume.
- **Cons:** Operational complexity (storage, scaling, monitoring) before any product value. Inngest Cloud's free tier covers low-volume v1.
- **Why not:** Start on Cloud; transition to self-hosted when execution volume + savings justify.

## Consequences

### Positive

- **Durable async by default.** Every async operation survives crashes, retries transient failures, supports long waits.
- **Per-tenant isolation via concurrency keys** prevents one tenant from blocking others.
- **Audit + observability** built-in; compliance-friendly.
- **Manifest-driven scheduling** lets tenants configure recurring operations through the same apply pipeline as schema changes.
- **Inngest primitives align with workflow needs** (per ADR-0007); one foundational platform.
- **Cost telemetry** feeds per-tenant billing and anomaly detection.

### Negative

- **Inngest dependency is real.** Inngest Cloud outage cuts off background processing. Mitigation: critical-path operations (workflow transition state changes; audit writes) are synchronous; only async-natural operations (notifications, file processing) depend on the job runtime.
- **Per-execution cost** at Inngest Cloud scales with volume. Mitigation: telemetry to detect explosions; self-hosted transition at the right volume.
- **Step-checkpointing requires correct decomposition.** Developers must structure code as `step.run` blocks where appropriate; naive monolithic code doesn't get checkpointing benefits. Mitigation: code-review checklist + linter rule encouraging step decomposition.
- **Job versioning visibility.** Tenants and engineers occasionally need to see "which version is running for this in-flight job?" Mitigation: Inngest dashboard + per-job version tagging.

### Neutral

- **Inngest is TypeScript-native**; fits the Node.js stack.
- **Scheduled functions** replace traditional cron systems cleanly.

### Reversibility

**Moderate cost** to swap Inngest for Temporal or another durable-function platform. Most code is per-job business logic; the wrappers `inngest.createFunction()` are thin. Migration of in-flight state is the hard part.

**Low cost** to evolve per-job concurrency / retry / rate-limit policies.

**High cost** to remove the job-runtime abstraction. Hardcoded synchronous calls would lose durability; we don't plan to.

## Implementation notes

- **Package locations:**
  - `packages/jobs` — Inngest client + job registry + types.
  - `packages/jobs/registry/<name>.ts` — individual job definitions.
  - `apps/web/api/inngest/route.ts` — Inngest HTTP endpoint for function serving.
- **Function registration:** all jobs registered at app boot. Manifest-driven workflow functions registered after manifest apply.
- **Event store:** events emitted via `inngest.send({ name, data })`. Inngest stores events; consumers subscribe by name.
- **Concurrency tuning:** initial per-tenant defaults set by plan tier; admins can request elevation. Platform-wide cap reviewed monthly against Inngest cost.
- **Dead-letter UI:** admin view in `apps/ops` listing dead-lettered jobs with reprocess / discard actions. Per-tenant view in tenant admin showing only their tenant's dead letters.
- **Reprocessing dead-letters:** kernel API endpoint re-emits the original event with a `_reprocessed: true` marker; the job sees this and may take different action (skip side-effects already done, or full retry from scratch).
- **Job-run retention:** `meta.job_runs` partitioned monthly. Default retention 30 days hot, 13 months in ClickHouse mirror. Compliance-bound jobs (manifest-tagged) retain longer.
- **Cost telemetry sampling:** every run; aggregated hourly into ClickHouse `t_<id>.job_costs_hourly` materialized views.
- **Worker scaling alerts:** Inngest queue depth + execution latency monitored; threshold breach alerts.
- **Per-tenant dashboards:** show job execution count, failure rate, retry rate over time. Operations dashboard for tenant admins.
- **Testing:**
  - Unit tests on per-step logic.
  - Inngest local-runtime tests for step.run / step.sleepUntil semantics.
  - Property tests on idempotency (rerun same input → same effect).
  - Failure-injection tests on retry / dead-letter behavior.
  - E2E tests for critical job paths (file upload → scan → OCR → embedding).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Inngest Cloud → self-hosted transition threshold — sustained executions per month + Inngest Cloud cost trajectory. Target Year 2-3 evaluation. | amoufaq5 | Year 2 |
| Per-tenant concurrency limit per plan — exact numbers for free, Operate base, Operate premium, regulated, enterprise. Decided with commercial hire. | amoufaq5 + commercial hire | Phase 5 |
| Dead-letter retention — 30 days default; compliance packs may require longer. Pack-driven policy? | _pending compliance hire_ | Phase 4 |
| Reprocessing UX — tenant admin vs. CrossEngin staff-only? Tenant admin needs visibility but not necessarily control over the reprocess action. | _pending design hire_ | Phase 4 |
| Job-cost billing visibility — surface to tenant as a cost dashboard, or aggregate into the AI usage line item? | amoufaq5 + commercial hire | Phase 5 |
| Long-running orchestration timeout — at what total duration does an orchestration warrant a P2 alert (months are normal for some workflows; years are abnormal)? | amoufaq5 | Phase 4 |
| Cross-region job execution — Inngest Cloud handles region routing internally, but for `me-only` residency, do we need self-hosted Inngest in UAE to keep job state in-country? | amoufaq5 | Year 2-3 |

## References

- ADR-0007 (Workflow engine) — defines workflow-kind jobs.
- ADR-0008 (RBAC v2, ABAC, audit) — defines audit emission for job runs.
- ADR-0011 (Integration mesh) — defines integration jobs.
- ADR-0013 (Reporting and analytics) — defines CDC and scheduled-export jobs.
- ADR-0014 (Files and storage) — defines virus scan / OCR / embedding / lifecycle jobs.
- ADR-0017 (Observability and SLOs) — defines per-job latency and error-rate alerts.
- Inngest documentation; Temporal.io (alternative); pg-boss (alternative).
