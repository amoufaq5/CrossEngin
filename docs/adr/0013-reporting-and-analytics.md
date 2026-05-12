# ADR-0013: Reporting and Analytics

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0003, ADR-0008, ADR-0010, ADR-0014, ADR-0018 |

## Context

Every tenant wants reports. The pharma manager wants weekly dispensing summaries; the hospital wants admission-discharge volumes by service line; the procurement office wants vendor performance scorecards; the NGO wants donor cohort retention. Reports drive operational decisions and many are obligatory — pharma deviations summary for regulators, GMP batch yield reports, HIPAA disclosure logs, IFRS revenue recognition reports.

Reports also serve CrossEngin internally: per-tenant cost telemetry (cross-link ADR-0006), AI Architect cost dashboards, integration health dashboards, audit-log analytics for fraud detection.

Reporting requirements:

- **Per-tenant reports.** Tenants read their own data; cross-tenant aggregation is impossible (per ADR-0002 isolation).
- **Internal ops cross-tenant aggregation.** CrossEngin staff need to see aggregate metrics across tenants for capacity planning, fraud detection, anomaly alerts.
- **Saved queries.** Tenants save reports for later re-run.
- **Pivot analysis.** Cross-tabbed rollups (by month × by drug × by status).
- **KPIs and dashboards.** Composed widgets on a canvas.
- **Scheduled exports.** Daily / weekly / monthly to email + R2 (PDF, CSV, XLSX).
- **Compliance reports.** Pack-mandated reports (e.g., 21 CFR Part 11 audit-trail integrity summary).
- **Performance.** Reports must not block transactional traffic on Supabase Postgres.

Round 8 decided: **ClickHouse mirror only for cross-tenant analytics.** Per-tenant analytics stay on Supabase Postgres unless tenants demand more horsepower.

## Decision

CrossEngin uses a two-tier reporting architecture:

```
┌────────────────────────────────────────────────────────────────┐
│ Per-tenant reports (default)                                    │
│   - Manifest-declared reports + dashboards                      │
│   - Queries run against tenant's Postgres schema                │
│   - TanStack Table + Recharts in renderer (ADR-0018)            │
│   - Materialized views for hot reports                          │
└────────────────────────────────────────────────────────────────┘
                          │
                          │  CDC stream
                          ▼
┌────────────────────────────────────────────────────────────────┐
│ ClickHouse analytics mirror (cross-tenant + heavy analytics)    │
│   - Every entity write → CDC → ClickHouse table                 │
│   - Schema-per-tenant in ClickHouse (parallel to Postgres)      │
│   - Cross-tenant aggregate queries (CrossEngin ops only)         │
│   - Tenant-facing heavy analytics (pivot, time-series)          │
└────────────────────────────────────────────────────────────────┘
```

### Report declaration in manifest

```jsonc
"reports": {
  "weeklyDispensingSummary": {
    "label": { "en": "Weekly Dispensing Summary" },
    "kind": "tabular",
    "entity": "prescription",
    "filters": [
      { "field": "status", "operator": "in", "values": ["dispensed"] },
      { "field": "dispensedAt", "operator": "gte", "value": "$today - 7 days" }
    ],
    "groupBy": ["drug.category", "dispensingPharmacist"],
    "aggregations": [
      { "name": "count", "kind": "count" },
      { "name": "totalValue", "kind": "sum", "field": "totalCost" }
    ],
    "sort": [{ "field": "count", "direction": "desc" }],
    "limit": 100,
    "permissions": { "roles": ["pharmacist", "manager", "auditor"] },
    "abac": "data.report.access.weekly_dispensing"
  },
  "monthlyDeviationRecap": {
    "label": { "en": "Monthly Deviation Recap" },
    "kind": "pivot",
    "entity": "deviation",
    "rows": ["severity"],
    "columns": ["month"],
    "measures": [{ "name": "count", "kind": "count" }],
    "schedule": { "cron": "0 8 1 * * *", "tz": "Asia/Dubai", "deliverTo": ["qa@..."] },
    "compliancePack": "21-cfr-part-11"
  }
}
```

Report kinds:

| Kind | Description |
|---|---|
| `tabular` | Flat table with optional grouping + aggregations |
| `pivot` | Cross-tabbed (rows × columns × measures) |
| `timeseries` | Time-series chart |
| `kpi` | Single numeric KPI with optional comparison period |
| `funnel` | Stepwise conversion |
| `cohort` | Cohort retention analysis |
| `custom` | Tenant-defined SQL fragment (rare; closed-source posture means CrossEngin curates these per tenant) |

### Dashboard declaration

```jsonc
"dashboards": {
  "managerDailyDashboard": {
    "label": { "en": "Manager's Daily Dashboard" },
    "layout": "grid",
    "cells": [
      { "x": 0, "y": 0, "w": 4, "h": 2, "widget": { "kind": "kpi", "report": "todayDispensedCount" } },
      { "x": 4, "y": 0, "w": 4, "h": 2, "widget": { "kind": "kpi", "report": "todayRevenue" } },
      { "x": 8, "y": 0, "w": 4, "h": 2, "widget": { "kind": "kpi", "report": "pendingPrescriptionsCount" } },
      { "x": 0, "y": 2, "w": 12, "h": 4, "widget": { "kind": "timeseries", "report": "hourlyDispensingTrend" } },
      { "x": 0, "y": 6, "w": 6, "h": 4, "widget": { "kind": "list", "report": "expiringStockNext30d" } },
      { "x": 6, "y": 6, "w": 6, "h": 4, "widget": { "kind": "list", "report": "topPrescribers" } }
    ],
    "permissions": { "roles": ["manager"] }
  }
}
```

The Dashboard renderer (ADR-0018) reads the manifest declaration + report results + permission decisions and composes the grid.

### Query execution layers

**Layer 1 — Postgres for per-tenant tabular + KPI + simple time-series.** Reports declared in the manifest compile to SQL with parameterized filters. The kernel evaluates ABAC predicates as `WHERE` clauses (so the tenant can only see records their role permits).

**Layer 2 — Materialized views for hot reports.** Reports flagged `materialize: true` are precomputed via Postgres materialized views, refreshed every N minutes via Inngest. The renderer hits the view, not the underlying table.

**Layer 3 — ClickHouse for pivot / cohort / cross-tenant ops.** Reports flagged `engine: "clickhouse"` query the mirror. The CDC pipeline keeps ClickHouse fresh with sub-minute lag.

The report renderer is engine-agnostic; it sees the result, not the engine.

### CDC pipeline (Postgres → ClickHouse)

The kernel uses Supabase's `wal2json` logical-replication output + a custom CDC service (`apps/cdc-shipper`, Fly Machines):

```
Supabase Postgres
   │
   │ logical replication slot
   ▼
apps/cdc-shipper (decodes wal2json, batches, transforms)
   │
   ▼
ClickHouse (multi-region, sharded by tenant_id)
```

Per-tenant ClickHouse tables mirror Postgres schemas. Schema changes flow through the kernel's manifest-apply pipeline — a manifest change triggers Postgres DDL AND ClickHouse DDL atomically.

ClickHouse-only columns: derived fields not stored in Postgres (e.g., `dispensing_hour_of_day` computed at write). Materialized views in ClickHouse precompute common rollups.

### KPI engine

Reports with `kind: "kpi"` expose:

- A single numeric metric (count, sum, avg, distinct).
- Optional comparison period (vs. last week, vs. last month, vs. last year).
- Optional sparkline (last N data points).
- Optional threshold (warning / critical) for traffic-light rendering.

KPIs are the building blocks of dashboards. They're computed on demand or refreshed via materialized views.

### Scheduled exports

Reports with `schedule` declared run on cron schedule and deliver via:

- Email (HTML body + PDF attachment).
- R2 bucket (PDF / CSV / XLSX) with signed URL emailed to recipients.
- Webhook (for integration into customer BI tools).

Exports use Inngest (ADR-0015) for durable scheduling. Failed exports retry with backoff; after 3 failures, alert the tenant admin.

### Permissions on reports and dashboards

Reports and dashboards have their own RBAC + ABAC checks (per ADR-0008):

- Coarse: which roles can run this report?
- Fine: an ABAC predicate filters the result rows (e.g., a regional manager sees only their region).
- Field-level: redacted fields are stripped from report output.
- Audit: every report run is audited.

The kernel evaluates ABAC at query time by translating to SQL predicates. If the user's session doesn't satisfy the report's role requirement, the kernel returns 403 without executing the query.

### Compliance reports

Compliance packs (ADR-0012) ship reports they require:

- **21 CFR Part 11:** "Audit-trail integrity summary" (last quarter; checksum verification of audit chain).
- **HIPAA:** "PHI disclosure log" (every read of `phi`-classified entity outside the workforce).
- **EU GMP:** "Batch release records summary" with electronic signature verification.

These reports cannot be deleted by the tenant; only superseded by a newer version of the pack.

### AI Architect integration

The agent (ADR-0005) can propose new reports as manifest patches. The agent reads existing reports + recent ad-hoc queries (when the tenant uses a "save this query" UI affordance) to suggest reports that match observed usage patterns.

The agent does NOT execute arbitrary SQL. All queries flow through the manifest-declared report pipeline.

### Ad-hoc query UI

Tenants can compose ad-hoc reports through a Pivot Table-style UI without manifest changes:

- Select entity → pick dimensions → pick measures → pick filters → execute.
- "Save as report" promotes the ad-hoc into a manifest-declared report (subject to the schema-change approval gate per ADR-0003).
- Ad-hoc queries are still permission-checked and audited.

## Alternatives considered

### Option A — Postgres only, no ClickHouse

Skip the analytics mirror; run everything on Supabase.

- **Pros:** Simpler infra. One database.
- **Cons:** Heavy analytics (pivot over millions of rows; cross-tenant aggregations) saturate the OLTP Postgres. Reports degrade tenant write performance. Cross-tenant queries are forbidden by ADR-0002 RLS; we'd need a separate read replica with RLS disabled — fragile.
- **Why not:** ClickHouse for analytics is the standard pattern. Round 8 decision.

### Option B — Snowflake / BigQuery / Redshift instead of ClickHouse

Use a managed cloud data warehouse.

- **Pros:** Less ops to run.
- **Cons:** Cost per query is high for the latency-sensitive use cases CrossEngin needs (sub-minute lag, sub-second query latency on dashboards). ClickHouse self-hosted is cheaper at our scale.
- **Why not:** ClickHouse Cloud or self-hosted is the right balance for our workload. Reconsider Snowflake when ARR justifies the cost premium.

### Option C — Embedded analytics SaaS (Metabase, Cube.js, Looker)

Embed a third-party analytics platform.

- **Pros:** Pre-built features (drag-drop query, dashboards, scheduling, alerts).
- **Cons:** Per-tenant embedding is complex with strict isolation. Licensing per tenant at scale gets expensive. Conflicts with manifest-driven model — their abstractions don't compose with our spec.
- **Why not:** Build our own renderer (ADR-0018) extended with reporting widgets. Reconsider embedded analytics at Year 5+ if maintenance becomes a burden.

### Option D — TimescaleDB (Postgres extension for time-series)

Add Timescale to Supabase for time-series analytics.

- **Pros:** Stays in Postgres ecosystem. No CDC needed.
- **Cons:** Doesn't help cross-tenant or pivot queries. Supabase doesn't natively support TimescaleDB.
- **Why not:** Doesn't solve the cross-tenant problem (the primary driver for the mirror).

### Option E — Real-time streaming analytics (Materialize, RisingWave)

Streaming SQL on top of Postgres logical replication.

- **Pros:** Sub-second freshness. SQL-native.
- **Cons:** Costly compared to ClickHouse. Streaming-SQL ergonomics differ enough to require new mental model. Operationally heavier.
- **Why not:** ClickHouse with sub-minute lag is fresh enough for v1. Reconsider real-time streaming when a tenant demands sub-second.

### Option F — Build pivot UI on raw Postgres only (no ClickHouse)

Heavy pivot UI directly against the tenant's Postgres schema with aggressive caching.

- **Pros:** Single-database simplicity.
- **Cons:** Saturates Postgres on big tenant data sets. Caching helps but doesn't eliminate the spike.
- **Why not:** ClickHouse exists for this exact reason.

## Consequences

### Positive

- **Cross-tenant operations metrics** are possible (cost, integration health, AI Architect cost per tenant) without violating tenant isolation.
- **Heavy analytics don't impact OLTP.** Tenant dispensing-volume pivot doesn't slow down their checkout.
- **Compliance-mandated reports auto-shipped with packs.** No tenant-side work for the basics.
- **Scheduled exports + KPIs + dashboards** are first-class manifest concepts. Tenants can configure their own reporting without dev work.
- **AI Architect can propose reports** based on observed query patterns.

### Negative

- **CDC pipeline is a real operational burden.** Schema drift between Postgres and ClickHouse is a class of bug we must prevent (atomic DDL in the apply pipeline). ClickHouse outage cuts off some reports but doesn't impact OLTP. Mitigation: alerts on CDC lag; replay tools.
- **Two query engines, two SQL dialects.** Postgres + ClickHouse SQL diverge in edge cases. Report compilation has engine-specific paths. Mitigation: abstraction layer + property tests.
- **Materialized view freshness** can confuse users. "Why does the dashboard show 100 dispenses when I just made the 101st?" Mitigation: per-view freshness indicator in UI; tenants can force-refresh.
- **PDF export quality** depends on rendering pipeline. Mitigation: server-side rendering via Puppeteer (Inngest job); templated layouts.

### Neutral

- **ClickHouse cluster size** scales linearly with tenant base. v1 single-node is sufficient for hundreds of tenants; sharding kicks in at thousands.
- **Tenant-side BI tool integration** (export to Snowflake, push to Looker) is supported via webhook integrations (ADR-0011).

### Reversibility

**Moderate cost to swap ClickHouse** for another OLAP engine (DuckDB, Druid). The kernel's report-compilation abstraction insulates most code. Schema migration is the main cost.

**Low cost** to add new report kinds, dashboard widget types, or aggregation functions.

**High cost** to swap the manifest report declaration format. Tenants and AI Architect both depend on it.

## Implementation notes

- **Package locations:**
  - `packages/reporting` — report compiler + execution APIs + manifest types.
  - `packages/reporting/engines/postgres` — Postgres-side compilation.
  - `packages/reporting/engines/clickhouse` — ClickHouse-side compilation.
  - `apps/cdc-shipper` — CDC replication service.
  - `packages/ui-renderers/dashboard` — dashboard renderer (cross-link ADR-0018).
- **CDC technology:** Supabase native logical replication via `wal2json` decoder. Shipper service in Go for throughput.
- **ClickHouse hosting:** ClickHouse Cloud (managed) for v1; reconsider self-hosted at Year 3 when costs justify.
- **Schema parallelism:** every Postgres DDL during manifest apply emits a corresponding ClickHouse DDL in the same transaction (atomicity via two-phase commit; rollback drops the new ClickHouse table on Postgres failure).
- **Materialized view refresh:** Postgres MVs refreshed via `REFRESH MATERIALIZED VIEW CONCURRENTLY` triggered by Inngest. ClickHouse materialized views auto-refresh on insert.
- **Per-tenant ClickHouse isolation:** schema-per-tenant in ClickHouse (`t_<id>` mirror). RLS-equivalent enforced via ClickHouse row policies + per-tenant queries.
- **PDF rendering:** Puppeteer in an Inngest job; renders the dashboard or report at a stable URL with a print-friendly stylesheet. Result uploaded to R2 with signed URL emailed.
- **Scheduled-export persistence:** `meta.scheduled_exports(tenant_id, report_id, last_run_at, next_run_at, last_status)` drives the Inngest cron.
- **Query result caching:** TanStack Query in the renderer caches results client-side; server-side Redis-equivalent (Supabase `kv`) caches by `(report_id, parameters_hash, tenant_id)` for 60 s.
- **Audit on report runs:** every report execution writes to `meta.report_runs` with parameters, latency, row count. PHI/PII redaction applied to logged parameters.
- **Sandboxed custom SQL:** Year 5+ feature. v1 is manifest-declared only.
- **Testing:**
  - Property tests on report compilation (random manifest → valid SQL).
  - Snapshot tests on compiled SQL for representative reports.
  - Integration tests against a test ClickHouse + Postgres pair, verifying CDC lag + query correctness.
  - E2E tests for scheduled-export delivery (mock SMTP / R2).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| ClickHouse Cloud cost model at scale — what tenant volume triggers self-hosted ClickHouse? Estimate based on v1 ingestion rates. | amoufaq5 | Year 2 |
| CDC technology — wal2json + custom shipper vs. Debezium vs. Materialize CDC. Debezium is more mature; wal2json is lighter-weight; trade-off is engineering effort vs. infra complexity. | amoufaq5 | Phase 4 |
| Custom-SQL report authoring for tenants — closed-source posture leans toward no, but enterprise customers may demand it. | amoufaq5 | Year 2+ |
| Dashboard editor UX — visual drag-drop in the renderer (Phase 4) vs. JSON-only at v1 (forces AI Architect or manifest CLI). | _pending design hire_ | Phase 4 |
| Cross-tenant aggregation safeguards — even for internal ops, do we require manual approval per query to prevent accidental tenant-scope leakage? | amoufaq5 + _pending compliance hire_ | Phase 5 |
| Excel-style ad-hoc query UI complexity — how much do we build vs. tell tenants to export to CSV + analyze externally? | amoufaq5 | Phase 5 |
| Report-result persistence for compliance — when a 21 CFR Part 11 compliance report runs, do we persist the exact result alongside the parameters (regulator may want the immutable record)? | _pending compliance hire_ | Phase 4 |

## References

- ADR-0002 (Multi-tenancy model) — defines per-tenant isolation that reports respect.
- ADR-0003 (Meta-schema and dynamic entity engine) — defines the entities reports query.
- ADR-0008 (RBAC v2, ABAC, audit) — defines permission checks on reports.
- ADR-0010 (Multi-region and data residency) — defines region-pinning for ClickHouse mirror.
- ADR-0014 (Files and storage) — defines R2 paths for export delivery.
- ADR-0018 (Frontend renderer architecture) — defines Dashboard / Pivot renderers.
- ClickHouse documentation; Supabase logical replication; Debezium; Puppeteer.
