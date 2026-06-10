# Operate reporting & API discovery

A map of the report-execution and API-discovery surface that landed across
Phase 3 P3.22–P3.30, spanning two serving apps. Read this to understand how a
manifest's reports become data on the wire, and how a client discovers the API.

The two serving apps play different roles:

- **`apps/operate-server`** — the gateway-backed **JSON REST API**. Every request
  runs through the 17-stage gateway pipeline (auth → RBAC → rate-limit →
  classification redaction → audit). Serves entity CRUD + lifecycle, reports, and
  an OpenAPI document.
- **`apps/operate-web`** — the **view-model** shell. Serves redaction-aware view
  models as JSON (`/ui/...`) and server-rendered HTML pages (`/app/...`), plus a
  discovery descriptor.

---

## 1. Report execution

A report is declared in the manifest (`manifest.reports[name]`) with a `kind`
(`tabular` / `kpi` / `pivot`), an `entity`, group-by / row-column dimensions, and
aggregations over the 8 kinds (`count` / `count_distinct` / `sum` / `avg` / `min`
/ `max` / `median` / `p95`). A tabular report may carry `sort` + `limit`.

Three executors compute the same `ReportData` shape, behind one contract —
`(report, tenantId, canRead) → Promise<ReportData | null>`:

| executor | package | aggregates over | when |
|---|---|---|---|
| `executeReport` (in-memory) | `@crossengin/operate-web` (`report-exec.ts`) | a bounded ≤500-row page | `--store memory`, or as a fallback |
| `PostgresReportExecutor` | `@crossengin/operate-runtime-pg` (`report-sql.ts`) | `GROUP BY` over the JSONB `meta.operate_entity_records` (`document ->> 'field'`) | `--store pg` |
| `PostgresColumnReportExecutor` | `@crossengin/operate-runtime-pg` (`report-sql.ts`) | `GROUP BY` over the typed per-entity tables (native columns) | `--store pg-columns` |

Both SQL executors are **full-dataset** (not a bounded page). They share the
`rowsToTabular` / `rowsToPivot` / `toNum` row→data mappers; the column builder
maps each dimension/measure field to its typed column via `columnIndex(plan)`.

**Fail-closed + safe.** A referenced field the caller can't read withholds the
whole report (`null`); for the column store an encrypted (`phi`/`regulated`)
`BYTEA` column can't be aggregated, so the report is withheld. Field names are
identifier-validated and embedded; `tenantId` (+ `entity` for the JSONB store)
are the only bound parameters.

**Sort + limit (P3.29).** A tabular report's `sort` + `limit` push into SQL via a
shared `tabularOrderLimit(report)` helper (` ORDER BY … LIMIT n`), referencing the
output aliases (a dimension → its field name, an aggregation → its name). Unknown
sort fields and bad limits are skipped (fail-safe).

---

## 2. operate-server: report + OpenAPI routes

`@crossengin/operate-runtime` provides the generic gateway plumbing; the app
supplies the manifest-aware pieces.

### `GET /v1/reports/:report` (P3.25)

- **operate-runtime** (`report-routes.ts`): one parametric route
  (`reportRouteDefinition()`) + `buildReportHandler(runner)` over an injected
  `ReportRunner` (`run(name, {tenantId, principal, query}) → unknown | null`); a
  `null` result is a fail-closed `404` (`report_unavailable`). Registered only
  when `OperateRuntimeOptions.reportRunner` is set. operate-runtime stays free of
  report-execution logic (no `operate-web` dependency).
- **operate-server** (`reports.ts`): `buildManifestReportRunner({manifest, store,
  principalRoles, executor?})` resolves the named report, derives the caller's
  `canRead` from the **same `EntityFieldResolver`** the UI uses, and aggregates
  via the injected SQL executor (`pg` → `PostgresReportExecutor`, `pg-columns` →
  `PostgresColumnReportExecutor`) or the bounded in-memory path (`memory`).

### `GET /v1/openapi.json` (P3.26, P3.28)

- **operate-runtime** (`api-descriptor.ts` + `openapi.ts` + `schemas.ts`):
  `buildApiDescriptor` projects the compiled `routeSpecs` + `manifest.reports`
  (read structurally) into an `ApiDescriptor`; `toOpenApiDocument` renders an
  OpenAPI 3.1 document (paths grouped by template, `{param}` path parameters, the
  report catalog under `x-reports`). **Component schemas (P3.32):** `schemas.ts`
  derives a typed schema per entity from the manifest fields
  (`entitySchemasFromManifest`) + the `ReportData` union, embedded under
  `components.schemas` and `$ref`'d from each operation's request/response bodies —
  so the document is codegen-grade, not just paths. **Refinements (P3.33):**
  optional fields are nullable (`type: [..., "null"]`), and a `ProblemDetails`
  (RFC 9457) schema is `$ref`'d from per-operation error responses
  (`401`/`403`/`404`/`409` as applicable).
- **Per-caller (P3.28):** the served document is RBAC-filtered —
  `buildPerCallerOpenApiHandler` + `filterDescriptorForPrincipal` keep an entity
  operation only when `rbacCheck` allows the caller's role (no-entity ops like the
  report route always stay). A cashier's document omits `POST /v1/products`; a
  manager's includes it. The full unfiltered `openApiDocument` stays on
  `CompiledOperateServer` for tooling.

`apps/operate-server`'s `serve()` enables both under any `--store`; reports
aggregate in Postgres for `pg`/`pg-columns`.

---

## 3. operate-web: view-model, SSR, discovery

`@crossengin/operate-web` compiles redaction-aware view models; the app serves
them as JSON and SSR HTML.

### Report-backed views

- JSON: `GET /ui/:entity/dashboard` → `{ dashboard, widgetData }`,
  `GET /ui/:entity/pivot` → `{ pivot, data }` — each report-backed widget/cell is
  computed via `runReport` (→ the `reportExecutor` seam, P3.22/P3.24).
- SSR HTML: `GET /app/:entity/dashboard|pivot` render the same executed data
  through `DashboardView` / `PivotView` (`@crossengin/operate-web-react`), proven
  over the column store end-to-end (P3.30).

The `reportExecutor` seam on `OperateWebServer` selects the executor by `--store`
in `node.ts`, exactly as operate-server does.

### `GET /ui/_describe` (P3.27, P3.28)

`describeWebApi(manifest, viewer, options?)` (`describe.ts`) projects
`compileWebApp` into a **per-caller** `WebApiDescriptor`: for each entity, the
available view-model routes (`table`/`detail`/`form` always; `kanban`/`calendar`/
`map`/`dashboard`/`pivot` only when that view compiles for the viewer) **plus** the
RBAC-gated mutation routes the caller may invoke (`create`/`update`/`delete` via
`EntityFieldResolver.canPerform`, one `transition` route per lifecycle transition
via `canTransition`). It can't drift from what's served because it's derived from
the same compile + RBAC the routes use.

---

## 4. Discovery at a glance

| app | discovery route | shape | per-caller |
|---|---|---|---|
| operate-server | `GET /v1/openapi.json` | OpenAPI 3.1 (paths + `x-reports`) | yes (RBAC-filtered) |
| operate-web | `GET /ui/_describe` | `WebApiDescriptor` (entities × routes) | yes (compile + RBAC) |

Both ride the gateway / `/ui` auth (401 unauthenticated): the document is the
published API *shape*, not tenant data, but still requires a credential.

---

## 5. Testing

- **Offline (hermetic):** the `report-exec` engine, `buildReportSql` /
  `buildColumnReportSql` query shape (incl. the `ORDER BY`/`LIMIT` tail),
  `filterDescriptorForPrincipal`, `describeWebApi`, and the OpenAPI projection are
  all unit-tested with fixtures — no DB.
- **Gated (`CROSSENGIN_PG_TEST=1`):** the operate-server + operate-web integration
  suites drive the routes over a live Postgres (JSONB **and** column store),
  proving full-dataset aggregation, ordering, SSR rendering, and per-caller
  redaction/RBAC end-to-end.

See `CLAUDE.md` (the P3.22–P3.30 narratives) and ADR-0177–0185 for the
increment-by-increment detail.
