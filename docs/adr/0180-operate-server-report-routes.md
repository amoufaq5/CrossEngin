# ADR-0180: report routes on the operate-server serving API (Phase 3 P3.25)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0173 (operate-web report-data execution), ADR-0177 (report aggregation engine + JSONB SQL pushdown), ADR-0179 (column-store SQL pushdown), ADR-0087 (operate-server serving binary), ADR-0078 (operate-runtime), ADR-0080 (Phase 3 P3 plan) |

## Context

`apps/operate-web` serves executed report data (dashboard widgets + pivot cells)
at its `/ui/...` routes, aggregating via the full-dataset SQL pushdown
(`PostgresReportExecutor` / `PostgresColumnReportExecutor`) or the bounded
in-memory engine. But `apps/operate-server` — the gateway-backed JSON REST API —
served only entity CRUD + lifecycle transitions; it had no way to return report
data. The two serving apps were at parity for entities but not for reports.

operate-server routes every request through the 17-stage gateway pipeline
(auth → RBAC → … → redaction → audit), so a report endpoint must live *in* that
pipeline (to inherit auth, rate-limiting, the `PipelineExecution` audit, the
per-route SLO surface) rather than as a side path. The report-execution engine
+ classification redaction live in `@crossengin/operate-web`; the SQL executors
in `@crossengin/operate-runtime-pg`. `@crossengin/operate-runtime` (which builds
the gateway) must not depend on `operate-web` (that would be circular —
`operate-web` depends on `operate-runtime`).

## Decision

A two-layer split that keeps `operate-runtime` free of report-execution logic:

- **`@crossengin/operate-runtime`** gained generic report-route *plumbing*
  (`report-routes.ts`): one parametric gateway route `GET /v1/reports/:report`
  (`reportRouteDefinition()`, operationId `report.run`) + `buildReportHandler(runner)`
  — a `Handler` that requires a tenant (401), reads the `:report` param, and
  delegates to an injected `ReportRunner` (`run(name, {tenantId, principal,
  query}) → unknown | null`). A `null` result is a fail-closed **404**
  (`report_unavailable` — the caller is never told unknown-vs-unreadable).
  `compileOperateServer` / `buildOperateGateway` register the route + handler
  only when `OperateRuntimeOptions.reportRunner` is set. The runner owns RBAC +
  redaction, exactly as the per-route handlers own theirs.
- **`apps/operate-server`** gained `reports.ts` — `buildManifestReportRunner({
  manifest, store, principalRoles, executor? })`: resolves the named report from
  `manifest.reports`, derives the caller's field-readability gate from the
  report-entity classification via the **same `EntityFieldResolver`** the UI uses
  (so redaction is identical across both apps), then aggregates — via the
  injected SQL-pushdown executor when set, else a bounded in-memory `listPage`
  (≤500) + the pure `executeReport`. The app added a dependency on
  `@crossengin/operate-web` (for the report engine + the field resolver). `node.ts`
  builds the executor by `--store` (`PostgresReportExecutor` for `pg`,
  `PostgresColumnReportExecutor` for `pg-columns`, none → in-memory for `memory`)
  over the store's own connection (`resolveStore` now returns the conn, closed on
  shutdown), and threads the runner into `buildOperateHttpServer` →
  `buildOperateGateway`.

## Cross-cutting invariants enforced

- **Reports ride the full pipeline.** `GET /v1/reports/:report` is a real gateway
  route — it inherits auth, rate-limiting, the `PipelineExecution` audit, and
  security headers like every entity route.
- **Identical redaction across apps.** The runner computes `canRead` from the
  same `EntityFieldResolver` + classification rules `operate-web` uses; an
  unreadable referenced field withholds the whole report (fail-closed `null` →
  404). A cashier can't read `Product.unit_cost`, so a report summing it is
  withheld; a manager's resolves.
- **Full-dataset aggregation under Postgres.** `--store pg` / `--store pg-columns`
  push the `GROUP BY` to Postgres (P3.22/P3.24); `--store memory` uses the bounded
  in-memory engine.
- **No circular dependency.** `operate-runtime` stays free of report execution
  (it only carries the route + an injected-runner seam); the app supplies the
  engine + redaction.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,061 offline tests + 51 gated
  real-Postgres integration tests** (18 worker* + 23 operate-server + 11
  operate-web) **+ five CI gates**. New tests: `operate-runtime`'s
  `report-routes.test.ts` (route shape; handler 401/404/200 + arg passing),
  `operate-server`'s `reports.test.ts` (kpi/tabular/pivot over the in-memory path
  + fail-closed cashier-vs-manager redaction) + three `server.test.ts` e2e cases
  (200 through the gateway, 404 unknown, 401 unauthenticated), and one gated
  integration case proving SQL-pushdown report data over real Postgres
  (`salesRevenue` = 185, `ordersByState` placed = 2/160). No new META_ tables.
  (*operate-server gated count is 23: the prior 22 + the new report case.)
- Map/dashboard/pivot *view models* remain operate-web's surface; operate-server
  now serves the underlying *report data* a client would render. A single static
  parametric route serves every manifest report — new reports need no
  re-registration.
