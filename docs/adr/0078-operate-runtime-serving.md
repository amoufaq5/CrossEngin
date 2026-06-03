# ADR-0078: operate-runtime — serving a manifest as a multi-tenant API (Phase 3 P1)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (Phase 3 plan), ADR-0050 (api-gateway-runtime), ADR-0069 (manifest-derived redaction), ADR-0003 (auth RBAC), ADR-0047 (kernel-pg) |

## Context

Phase 3 P1 (ADR-0077) is the keystone: take a resolved manifest pack and serve it as a live multi-tenant HTTP API. Every runtime pillar exists — the gateway runs its pipeline, auth does RBAC + classification redaction, the kernel applies DDL — but nothing *composes* them so that "a manifest becomes a serving API." This ADR introduces `@crossengin/operate-runtime`: the **manifest → routes → handlers** compiler plus an injectable entity store, composed into a `GatewayRuntime`.

This first increment delivers the serving *logic* — tested end-to-end in-memory — so the composition is proven before the Postgres entity store and the HTTP/`apps/operate-server` binary are bolted on.

## Decision

`@crossengin/operate-runtime` (depends on `api-gateway`, `api-gateway-runtime`, `auth`, `kernel`, `types`):

- **`slugs.ts`** — the naming conventions: `entityCamel` (`SalesOrder` → `salesOrder`) for operationIds (the gateway operationId regex forbids hyphens), `resourceSlug` (`SalesOrder` → `sales-orders`) for URL paths, `operationId(entity, action)`, `entityReadOperationIds` (for redaction), `routeId` (a valid `rt_…`).
- **`store.ts`** — `EntityStore` (async `list`/`get`/`create`/`update`/`remove` keyed by `(tenantId, entity)`) + `InMemoryEntityStore`. The Postgres binding (entity-schema tables under RLS) is the next increment behind this interface.
- **`operations.ts`** — `manifestRouteSpecs(manifest)` derives a `RouteSpec` per entity operation: the five CRUD ops (`GET /v1/<slug>`, `POST /v1/<slug>`, `GET|PATCH|DELETE /v1/<slug>/{id}`) plus one `POST /v1/<slug>/{id}/<transition>` per `entityLifecycle` transition (carrying the workflow's `stateField` + target state + allowed-from states). `routeFromSpec` emits a schema-valid `RouteDefinition`.
- **`handlers.ts`** — `buildSpecHandler(spec, ctx)` returns a gateway `Handler` that: bridges the gateway's scope-bearing principal to an auth `Principal`, **enforces the manifest's RBAC** via `rbacCheck` (403 on an ungranted role), executes the CRUD/transition against the store (404 on missing, 409 on an invalid lifecycle transition), and returns the **full** record — field-level redaction happens at the gateway's `transform_response` stage, per-caller.
- **`compile.ts`** — `compileOperateServer(manifest, {store, principalRoles, policyForEntity?})` → `{routes, handlers, redactionRegistry}` (the redaction registry built via `redactionRegistryFromManifest` with the matching operationId convention). `buildOperateGateway(...)` wires those into a ready `GatewayRuntime` (in-memory stores by default).

## Cross-cutting invariants enforced (by tests)

- **The API is the manifest.** Routes, handlers, RBAC, and redaction all derive from the resolved manifest — no entity endpoint is hand-written. A test resolves the retail pack and serves `GET /v1/products`, `GET /v1/products/{id}`, `POST /v1/sales-orders/{id}/place` with zero bespoke code.
- **Redaction at the edge, end-to-end.** A cashier `GET /v1/products` through the **real gateway pipeline** receives rows with `unit_cost` dropped; a store manager gets them — same route, same handler, redaction decided by the manifest's classification + the caller's role.
- **RBAC from the manifest.** `rbacCheck` enforces the entity permissions: a cashier creating a `Product` is 403, a manager is allowed; a transition is gated by its `permissions.transitions.<name>` grant.
- **Lifecycle is the workflow.** A `salesOrder.place` advances `cart → placed`; firing `place` again from `placed` is a 409 (the transition's `fromStates` don't include `placed`) — the manifest's `entityLifecycle` enforced at the route.
- **Every request is auditable.** Each served request produces a `PipelineExecution` (queryable by tenant + operationId) — the gateway's audit, now over manifest-derived routes.
- **Multi-tenant by construction.** The tenant comes from the resolved principal; the store is keyed by `(tenantId, entity)`; the Postgres binding will set `app.current_tenant_id` for RLS.

## Alternatives considered

- **Code-generate handlers at build time.**
  - **Decision.** Interpret the resolved manifest at startup (build the route table + handlers once) — a pack install becomes a hot reload, not a redeploy (ADR-0077 Q2). Code-gen is a later optimization if startup cost matters.
- **One service per pack.**
  - **Decision.** No — one `operate-runtime` that loads any resolved manifest is the multi-tenant product; per-pack services would re-wire the gateway + store + redaction each time (ADR-0077's anti-pattern).
- **Put the entity store inline (no interface).**
  - **Decision.** `EntityStore` is injected, so the in-memory store tests the composition offline and the Postgres store (RLS-backed entity-schema tables) swaps in for production — the same contract-vs-impl split as every `*-runtime` / `*-pg` pair.
- **Hand-build problem-detail error bodies in handlers.**
  - **Decision.** Handlers return plain domain errors (403/404/409 JSON); turning them into RFC-9457 problem details belongs in the gateway's dispatch stage (see follow-ups), not duplicated per handler.

## Consequences

- **58 packages + 1 app, 122 meta-schema tables, 6,189 tests** (was 57 / 122 / 6,170; +1 package, +19 tests, 0 new tables). A resolved manifest now *serves* — the Phase 3 keystone exists.
- **The retail pack is a working API.** `buildOperateGateway(resolvedRetail, …)` answers `GET /v1/products` with per-caller redaction and `POST /v1/sales-orders/{id}/place` with lifecycle enforcement, all from the manifest — the P1 exit-criterion behavior, in-memory.
- **The composition pattern is set.** P3's `operate-web` renders what this serves; P5's marketplace installs packs into it; the Postgres store + the HTTP binary slot in behind the existing interfaces.
- **Two gateway-runtime gaps are now visible** (and are the immediate P1.5 follow-up, below) — both are honest limitations the serving app surfaced, not papered over.

## Open questions / follow-ups (P1.5)

- **Q1 — Request body parsing. ✅ Resolved (ADR-0079).** `parse_request` now decodes a JSON body (by `content-type`) into `ctx.parsedBody`; `buildIncomingRequest` retains the raw `Uint8Array` on a `RuntimeIncomingRequest`. The write path runs end-to-end through the gateway.
- **Q2 — Handler-returned 4xx/5xx. ✅ Resolved (ADR-0079).** The dispatch stage now maps the handler status class to a stage outcome (`deny` for 4xx with a `handler-error` problem-type URI, `error` for 5xx) and halts, so a domain 4xx no longer trips the `PipelineExecution` "pass cannot be 4xx" invariant. RBAC 403 / 404 / 409 lifecycle errors are served through the gateway with correct audit outcomes.
- **Q3 — Postgres `EntityStore`. ✅ Resolved (ADR-0086).** `@crossengin/operate-runtime-pg` ships `PostgresEntityStore` over `meta.operate_entity_records` — a tenant-scoped JSONB document table under RLS, every operation run inside `withTenantContext` (`set_config('app.current_tenant_id', …, true)`). Drops straight into `buildOperateGateway`. Column-mapped per-entity tables (DDL emitted from the pack) remain the deeper follow-up behind the same `EntityStore` contract.
- **Q4 — `apps/operate-server` binary. ✅ Resolved (ADR-0087).** `@crossengin/operate-server` is the Node `http` shell over `buildOperateGateway`: `OperateHttpServer.dispatch` maps a `RawHttpRequest` → pipeline → `RawHttpResponse`, `serve(--pack … --store memory|pg --api-key …)` loads + resolves the manifest at boot and listens. A real loopback test boots it and gets a 200. Hot-reload on pack install + an edge adapter remain follow-ups behind the `RawHttpRequest` seam.
- **Q5 — Pagination, filtering, field selection on `list`. ✅ Resolved (ADR-0088).** `store.listPage(tenantId, entity, ListQuery)` returns a bounded `ListPage` with an opaque cursor; `listConfigForEntity` + `parseListQuery` drive `limit` / `sort` / equality filters from the entity's `ListView` (pageSize, default sort, sortable/filterable columns). The Postgres store pushes `ORDER BY` / `LIMIT+1 OFFSET` / `document ->> 'field' = $n` into SQL (identifier-validated). Keyset pagination + typed operator filters + field selection remain refinements behind the opaque-cursor contract.
