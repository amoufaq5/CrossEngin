# ADR-0017: Observability and SLOs

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0006, ADR-0008, ADR-0009, ADR-0011, ADR-0013, ADR-0015 |

## Context

CrossEngin's vision sets explicit reliability targets: **99.9% uptime Year 1, 99.95% Year 2+**, and **0 cross-tenant data isolation incidents**. Those numbers only mean something if we can measure them, observe drift, and respond before commitments break.

The platform has many moving parts: Vercel (apps/web), Supabase (Postgres + Storage + Auth), Cloudflare (CDN/WAF/R2), Inngest (jobs/workflows), Fly Machines (cdc-shipper, hl7-listener, virus-scanner, BGE GPU), Typesense, Fireworks (LLM), ClickHouse (analytics mirror). A latency spike or error rate in any of these can degrade the AI Architect, break a workflow, or cause an audit-relevant operation to fail.

Observability must cover:

- **Errors:** exceptions, crashes, unhandled rejections, frontend errors.
- **Tracing:** end-to-end request spans across services.
- **Logs:** structured per-tenant logs with correlation IDs.
- **Metrics:** latency, error rate, throughput, queue depth, cost, dependency health.
- **SLOs:** explicit availability and latency targets per surface.
- **Alerts:** routed by severity to on-call.
- **Tenant-facing health:** public status page; per-tenant ops dashboards.
- **AI Architect telemetry:** cost, latency, eval-suite results, regression signal.

The original `/home/user/ERP` has minimal observability — no OTel, no Sentry, no structured logs. Phase 0 cleanup (per ADR-0024) installs the basics; this ADR formalizes the production-grade stack.

## Decision

CrossEngin uses **OpenTelemetry (OTel) as the instrumentation standard**, with managed backends per signal type:

| Signal | Stack |
|---|---|
| Errors + exceptions | **Sentry** (cloud) |
| Traces | **OTel SDK → Sentry traces** (v1); add Tempo / Honeycomb later if Sentry's tracing limits hit |
| Logs | **Pino** structured JSON → **Better Stack** (Logtail) or **Axiom** |
| Metrics + dashboards | **Per-tenant ClickHouse aggregations** (cross-link ADR-0013) + Grafana Cloud for cross-tenant ops |
| Synthetic monitoring | **Checkly** for endpoint + AI Architect synthetic flows |
| Status page | **Statuspage.io** or **Vercel Statuspage** |
| Alerts | **PagerDuty** (Year 2 hire on-call); founder phone number for v1 |

### Instrumentation

Every kernel API call, integration call, job run, LLM call carries:

- **Trace ID + Span ID** — propagated end-to-end.
- **Tenant ID** — every span tags `tenant_id`.
- **User ID + Session ID** — every authenticated span tags both.
- **Workflow / job IDs** — when applicable.
- **Data classification** — `phi`, `pii_strict`, etc., for security telemetry.

Spans are emitted by `packages/observability` wrappers around:

- HTTP handlers (Next.js middleware).
- Database queries (Prisma + Supabase client).
- LLM calls (per ADR-0006).
- Integration calls (per ADR-0011).
- Inngest functions (per ADR-0015).
- File operations (per ADR-0014).
- Workflow transitions (per ADR-0007).

### Per-tenant scoping

Every metric, log, trace tags `tenant_id`. The ops dashboard supports filtering by tenant; tenant admin dashboards see only their own tenant. PHI / PII in payloads is redacted before logging (per ADR-0009 data-classification rules).

The `meta.audit_log` (per ADR-0008) is separate from observability logs:

- **Audit log:** business-meaningful actions (entity create/update/transition; manifest apply; integration call). Long retention; compliance-driven.
- **Observability log:** technical events (exceptions, slow queries, retry attempts). Short retention; debugging-driven.

### Service-Level Objectives (SLOs)

```jsonc
{
  "kernel-api": {
    "availability": { "target": 0.999, "window": "30d" },
    "latency": { "p95": "300ms", "p99": "1000ms", "endpoint_class": "read" },
    "latency": { "p95": "1000ms", "p99": "3000ms", "endpoint_class": "write" }
  },
  "manifest-apply": {
    "availability": { "target": 0.99, "window": "30d" },
    "latency": { "p95": "5s", "p99": "30s" }
  },
  "ai-architect-loop-turn": {
    "availability": { "target": 0.99, "window": "30d" },
    "latency": { "p95": "8s", "p99": "20s" }
  },
  "file-upload-end-to-end": {
    "availability": { "target": 0.995, "window": "30d" },
    "latency": { "p95": "5s for files < 10MB" }
  },
  "search-typeahead": {
    "availability": { "target": 0.995, "window": "30d" },
    "latency": { "p95": "200ms", "p99": "500ms" }
  },
  "tenant-isolation": {
    "incidents": { "target": 0, "window": "ever" }
  }
}
```

SLOs are tracked via OTel + Grafana + ClickHouse-aggregated metrics. Error budgets drive engineering priorities: a sustained budget burn for one SLO is a stop-the-line signal.

### Alerts and routing

Severity tiers (cross-link ADR-0009):

| Tier | Definition | Routing |
|---|---|---|
| **P0** | Tenant data leak; security breach; > 5 min outage of a critical surface | PagerDuty: founder phone immediately (24/7) |
| **P1** | > 1 hour partial outage; SLO budget burn > 50% in 24h; AI Architect eval regression > 5% | PagerDuty: founder business hours, escalate to phone after 30 min |
| **P2** | > 4 hour partial outage; SLO budget burn > 25% in 7d; dead-letter rate spike | Slack notification; phone if not acknowledged in 8h |
| **P3** | Performance degradation, single-feature outage | Email digest |

Alert thresholds:

- **Error rate** on any endpoint > 5% over 5 min → P2.
- **Error rate** > 20% over 5 min → P1.
- **p95 latency** > 2× SLO for 15 min → P2.
- **Job dead-letter rate** > 1% over 1 hour → P2.
- **AI Architect cost** per tenant > 10× rolling-week average → P2 (potential attack or runaway prompt).
- **Cross-tenant query attempt** (per ADR-0002 RLS-blocked) → P0.

### Tenant-facing observability

Per-tenant `apps/ops` views:

- **Service health:** real-time status indicators for components the tenant uses.
- **Job queue depth + recent failures:** their own jobs only.
- **Integration health:** per-integration error rate, latency.
- **Recent audit log:** last 24 h of operations (read-only).
- **Cost summary:** AI Architect cost this month + storage usage.
- **Public status:** "We are aware of an issue affecting tenants in EU-Central; ETA fix 30 min."

Tenant admins can subscribe to email/SMS notifications for events affecting their tenant.

### Public status page

`status.crossengin.com` (Year 1) shows per-region component health:

- API
- AI Architect
- File uploads
- Workflows
- Integrations
- Search

Incidents posted manually; auto-incidents from PagerDuty when an alert opens. Per-region status reflects the actual tenant impact (EU-Central down doesn't show US-East as red).

### Synthetic monitoring

Checkly runs every 5 min against:

- API health endpoints in each region.
- AI Architect synthetic conversation (canned flow that exercises plan → tool → reply).
- Manifest-apply synthetic on a dedicated test tenant.
- File upload + download round-trip on a test tenant.

Synthetic failures alert sooner than real-tenant failures and catch silent degradation.

### AI Architect-specific telemetry

Beyond standard metrics:

- **Eval suite results.** Every deploy runs the eval suite (per ADR-0005); regression > 5% blocks. Per-model + per-prompt-version results stored.
- **Per-session cost.** Each AI Architect session reports total tokens + cost (per ADR-0006); P2 alert on per-session > $10.
- **Tool-call success rate.** Per tool, per provider, per model: success rate, retry count, error categories.
- **Confidence calibration.** Plans carry low/medium/high confidence; we measure correlation with actual outcomes (per ADR-0005).
- **Conversation drop-off rate.** What fraction of conversations end with `finishConversation(failure)` vs. success.

### Performance budgets

Frontend (per ADR-0018):

- FCP < 1.5 s on 4G median.
- TTI < 3.0 s.
- Per-route JS bundle < 250 KB gzipped initial.

Backend:

- API endpoint p95 < 300 ms read, < 1000 ms write.
- DB query p95 < 100 ms.
- Inngest job p95 < SLO per job class.

Performance regressions block PR merges via CI checks.

### Cost telemetry

Already detailed in ADR-0006 (LLM provider costs) and ADR-0015 (job costs). Aggregated per tenant in ClickHouse for billing inputs and anomaly detection.

### Log retention

- **Observability logs (technical):** 30 days hot in Better Stack/Axiom; 13 months in cold tier.
- **Audit logs (business):** 13 months hot; 7 years cold per compliance pack rules (ADR-0008).
- **PHI / PII in logs:** redacted before write; verification spot-checks weekly.

### Incident response

Cross-link ADR-0009. Each P0/P1 produces a post-mortem in `docs/incidents/<YYYY-MM-DD>-<slug>.md`. Affected tenants notified within 24 h per the customer-notification SLA.

### CrossEngin-internal dashboards

`apps/ops` (Year 2 when revenue justifies the maintenance burden):

- Platform-wide health.
- Per-region SLO compliance.
- Top-cost tenants (for support outreach).
- Failing integrations across tenants.
- AI Architect eval-suite trends.
- Audit anomalies (cross-tenant query attempts, MFA bypasses).

Until Year 2 the founder uses Grafana Cloud + Sentry + Better Stack directly.

## Alternatives considered

### Option A — Datadog as one-stop observability

- **Pros:** Mature; covers errors, traces, logs, metrics, APM, RUM.
- **Cons:** Expensive at scale. Per-host pricing penalizes serverless. Vendor lock-in.
- **Why not:** Sentry + Pino + Grafana Cloud is the modern serverless-friendly stack and cheaper at v1 volume. Reconsider Datadog at multi-million ARR scale.

### Option B — Self-hosted Grafana / Loki / Tempo / Mimir stack

- **Pros:** Maximum control. Open source.
- **Cons:** Real operational burden. Pre-revenue, our time is better spent elsewhere.
- **Why not:** Use managed equivalents (Grafana Cloud, Sentry traces, Better Stack) at v1.

### Option C — Honeycomb / Lightstep for tracing only

- **Pros:** Best-in-class for distributed tracing.
- **Cons:** Adds another vendor; Sentry's tracing is sufficient at v1 volume.
- **Why not:** Add Honeycomb if Sentry tracing limits become a problem.

### Option D — Vercel-only observability

- **Pros:** Built-in; minimal config.
- **Cons:** Covers only Vercel surface (apps/web). Misses Inngest, Fly Machines, Supabase logs.
- **Why not:** Need cross-service visibility.

### Option E — Skip SLOs in v1; just monitor

- **Pros:** Faster setup.
- **Cons:** No explicit reliability commitment. Engineering can't prioritize against budgets.
- **Why not:** SLOs are non-negotiable for credibility with regulated buyers.

## Consequences

### Positive

- **End-to-end visibility.** Trace IDs propagated across Vercel + Inngest + Fly Machines + Supabase.
- **Explicit SLOs** drive engineering prioritization and tenant-facing commitments.
- **Tenant-facing health** builds trust without exposing platform-wide secrets.
- **AI Architect-specific telemetry** catches eval regressions before tenants notice.
- **Cost telemetry** feeds pricing and anomaly detection.

### Negative

- **Stack complexity.** Sentry + Pino + Better Stack + Grafana Cloud + Checkly + PagerDuty = six vendors. Mitigation: most are managed; toil is config not ops.
- **Instrumentation overhead.** Wrapping every kernel call has small CPU + bandwidth cost. Mitigation: sampling for high-volume paths; full instrumentation for low-volume critical paths.
- **PII redaction must be correct.** Logging PHI is a P0 incident. Mitigation: data-classification labels + automated CI scanner for log statements that include high-class fields.
- **Alert fatigue risk.** Mitigation: tune thresholds based on real data; quarterly alert review.

### Neutral

- **Solo / duo team uses managed offerings.** Year 2-3 hires evaluate self-hosted.
- **Tenant dashboards** are part of `apps/ops` (per ADR-0024 monorepo layout).

### Reversibility

**Low cost** to swap individual vendors (Sentry for Bugsnag, Better Stack for Axiom). OTel-based instrumentation is portable.

**Moderate cost** to add a new managed backend (e.g., Datadog for APM).

**High cost** to remove observability from a critical path after tenants depend on incident response times.

## Implementation notes

- **Package locations:**
  - `packages/observability` — OTel setup + Sentry/Pino integration + wrappers.
  - `packages/observability/middleware` — Next.js middleware + Inngest middleware.
- **OTel configuration:** `OTEL_EXPORTER_OTLP_ENDPOINT` to Sentry; `OTEL_RESOURCE_ATTRIBUTES` carries service name + region.
- **Sentry config:** per-app Sentry projects (web, marketing, docs-site, ops). Source maps uploaded on deploy.
- **Pino structured logs:** JSON output to stdout (Vercel + Fly Machines auto-collect). Shipped to Better Stack via their agent.
- **Trace propagation:** W3C Trace Context headers; baggage carries `tenant_id`, `user_id`, `session_id`.
- **SLO dashboards in Grafana:** burn-rate alerts (multi-window, multi-burn-rate per Google SRE workbook).
- **Synthetic flows:** Checkly browser checks + API checks. AI Architect canned conversation hits a test tenant.
- **Status page:** Statuspage.io initially; reconsider Vercel Statuspage if it ships before Phase 5.
- **PII redaction:** middleware strips fields tagged `phi` / `pii_strict` from logged objects before serialization.
- **Performance CI gate:** Lighthouse CI for frontend; custom check for backend p95 latency on representative test cases.
- **Audit log vs. observability log:** separation enforced — `packages/observability` never writes to `meta.audit_log`; `packages/auth` (audit) never writes to Better Stack.
- **Testing:**
  - Unit tests on PII redaction rules.
  - Integration tests on trace propagation across service boundaries.
  - Synthetic flow tests on staging.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Sentry tracing volume — Sentry's tracing pricing scales with span count; at what volume do we need to sample or move to Tempo / Honeycomb? | amoufaq5 | Phase 5 |
| Better Stack vs. Axiom vs. Logtail vs. Grafana Loki Cloud for logs — feature parity + pricing comparison. | amoufaq5 | Phase 4 |
| Per-tenant observability UI — show technical metrics (latency, error rate) or only business metrics (job counts, audit summaries)? | _pending design hire_ | Phase 5 |
| PagerDuty alternatives — Opsgenie, Better Stack on-call. Cost vs. integration depth. | amoufaq5 | Year 2 |
| Public status page granularity — per-region vs. per-component-per-region. | amoufaq5 | Phase 5 |
| Synthetic AI Architect cost — Checkly running synthetic conversations consumes Fireworks tokens. Budget allocation. | amoufaq5 | Phase 4 |
| Per-tenant SLO commitments in enterprise contracts — different SLO for different plan tiers (e.g., enterprise 99.95%, base 99.9%)? | amoufaq5 + commercial hire | Year 2 |
| Audit anomaly detection — explicit rule set vs. ML-based. Start rule-based (cross-tenant query attempts, MFA bypass attempts); evolve. | _pending compliance hire_ | Year 2 |

## References

- ADR-0002 (Multi-tenancy model) — defines per-tenant scoping requirements.
- ADR-0006 (LLM provider router) — defines AI Architect cost telemetry.
- ADR-0008 (RBAC v2, ABAC, audit) — defines audit-log separation from observability.
- ADR-0009 (Security model) — defines incident response severity tiers.
- ADR-0011 (Integration mesh) — defines per-integration health metrics.
- ADR-0013 (Reporting and analytics) — defines ClickHouse aggregations for metrics.
- ADR-0015 (Jobs and async runtime) — defines per-job observability.
- Google SRE Workbook; OpenTelemetry specification; Sentry documentation.
