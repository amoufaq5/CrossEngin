# ADR-0181: OpenAPI / report discovery on operate-server (Phase 3 P3.26)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0180 (operate-server report routes), ADR-0087 (operate-server serving binary), ADR-0078 (operate-runtime), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.25 added the `GET /v1/reports/:report` route, but it (and the entity CRUD /
lifecycle routes) were undiscoverable: a client had to know the operationIds +
paths out of band, and the available report *names* weren't exposed anywhere over
HTTP. There was no API-description artifact (no OpenAPI document, no route
listing) on the serving binary.

## Decision

Add a structural API descriptor + a minimal OpenAPI 3.1 document, projected
purely from the already-compiled route specs + the manifest's report catalog, and
serve it at `GET /v1/openapi.json` through the gateway.

- **`@crossengin/operate-runtime` `api-descriptor.ts`** — the serializable
  `ApiDescriptor` (`{ apiVersion, operations: ApiOperation[], reports:
  ReportDescriptor[] }`): `operationsFromRouteSpecs` projects each entity
  `RouteSpec` to an `{ operationId, method, path (template), kind, entity,
  transition? }`; `pathTemplate` renders segments as `/v1/products/{id}`;
  `reportDescriptorsFromManifest` reads `manifest.reports` **structurally** (name,
  kind, entity, `label.en`) — skipping malformed entries — so `operate-runtime`
  needs no `operate-web` dependency. `buildApiDescriptor` includes the
  `report.run` operation only when a report runner is wired, but always lists the
  report catalog.
- **`@crossengin/operate-runtime` `openapi.ts`** — `toOpenApiDocument(descriptor,
  info)` projects the descriptor to a minimal-but-valid OpenAPI 3.1 document:
  paths grouped by template, methods lowercased, `{param}` placeholders → path
  parameters (`required`, `type: string`), `tags` = entity (or `reports`), a
  generic `200` (the report op also documents `404`), and the report catalog
  under the `x-reports` extension. Per-operation request/response component
  schemas are a deferred enrichment. `openApiRouteDefinition()` +
  `buildOpenApiHandler(doc)` serve it.
- **`compileOperateServer`** now always computes + exposes `apiDescriptor` +
  `openApiDocument` on `CompiledOperateServer` (cheap, pure — useful
  programmatically + in tests), and registers the `GET /v1/openapi.json` route
  only when `OperateRuntimeOptions.serveApiDescriptor` is set.
  `apps/operate-server`'s `serve()` enables it (`serveApiDescriptor: true`), with
  an `openApiInfo` block.

## Cross-cutting invariants enforced

- **The descriptor is projected, not hand-maintained.** It is derived from the
  same `routeSpecs` the gateway registers + the manifest's `reports`, so it can't
  drift from the served surface.
- **Discovery rides the gateway pipeline.** `GET /v1/openapi.json` authenticates
  like every route (401 unauthenticated) — the document is the published API
  *shape* (not tenant data), returned to any authenticated caller. (Per-caller
  filtering of the surface is a deferred option; OpenAPI specs conventionally
  describe all endpoints, with authz enforced at call time.)
- **No new dependency cycle.** `operate-runtime` reads the report catalog
  structurally; it does not import `operate-web`.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,075 offline tests + 51 gated
  real-Postgres integration tests + five CI gates.** New tests: `operate-runtime`'s
  `api-descriptor.test.ts` (pathTemplate, operation projection, report extraction
  incl. skipping malformed, report-route inclusion toggle) + `openapi.test.ts`
  (3.1 shape, grouped paths, path params, report 404 + `x-reports`, the route +
  handler) and two `operate-server` `server.test.ts` e2e cases (200 OpenAPI doc
  listing entity + report routes + `x-reports`; 401 unauthenticated). No new META_
  tables.
- A full OpenAPI document with component schemas (request/response bodies derived
  from entity fields + the `ReportData` union) and per-caller surface filtering
  remain follow-ups.
