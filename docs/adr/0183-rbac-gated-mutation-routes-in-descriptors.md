# ADR-0183: RBAC-gated mutation routes in the discovery descriptors (Phase 3 P3.28)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0182 (operate-web discovery endpoint), ADR-0181 (operate-server OpenAPI discovery), ADR-0080 (Phase 3 P3 plan) |

## Context

The P3.26/P3.27 discovery artifacts described the *read* surface well, but the
write surface was incomplete or static:

- **operate-web** `/ui/_describe` listed only the read view-model routes
  (`table`/`detail`/`form`/…); the create/update/delete/transition routes a
  caller may invoke weren't surfaced at all.
- **operate-server** `/v1/openapi.json` listed every operation (CRUD + lifecycle)
  as a single static document, so it didn't reflect *which* of those a given
  caller can actually invoke.

## Decision

Make both descriptors surface the mutation routes, gated by the caller's RBAC.

- **operate-web** — `describeWebApi(manifest, viewer, options?)` now appends, per
  entity, the mutation routes the caller may invoke: `create` (POST `/ui/{e}`),
  `update` (PATCH `/ui/{e}/{id}`), `delete` (DELETE `/ui/{e}/{id}`) per
  `EntityFieldResolver.canPerform`, and one `transition` route per
  `entityLifecycle` transition the caller may fire (`canTransition`, carrying the
  transition name). `WebViewKind` gained `create`/`update`/`delete`/`transition`
  and `WebRouteDescriptor.method` widened to `GET|POST|PATCH|DELETE` (+ a
  `transition?` field). A route the caller can't perform is omitted.
- **operate-server** — the `GET /v1/openapi.json` handler is now **per-caller**:
  `buildPerCallerOpenApiHandler` filters the descriptor's operations via
  `filterDescriptorForPrincipal` (reconstructs each entity op's RBAC `Operation`
  from its `kind`/`transition`, keeps it only when `rbacCheck` allows the
  caller's role; no-entity ops like the report route always stay), then projects
  to OpenAPI per request. The full (unfiltered) `openApiDocument` stays on
  `CompiledOperateServer` for programmatic use.

## Cross-cutting invariants enforced

- **Both descriptors reflect what the caller can do.** A write route appears only
  when the caller's role is RBAC-granted for it — the same `rbacCheck` /
  `canPerform` the servers enforce at call time, so the descriptor can't promise
  an operation the request would deny.
- **Read surface unchanged.** operate-web read view routes still come from
  `compileWebApp`; operate-server read ops (list/read) are kept when RBAC allows
  (a cashier still sees `GET /v1/products`, just not `POST`).

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,084 offline tests + 51 gated
  real-Postgres integration tests + five CI gates.** New tests: operate-runtime
  `openapi.test.ts` `filterDescriptorForPrincipal` cases (pharmacist keeps
  read/create/verify, delete-granted-to-nobody dropped, staff keeps only the
  report op; the per-caller handler projects the filtered doc), operate-web
  `describe.test.ts` mutation + transition gating (manager has create/update +
  place/fulfill; cashier has neither create nor `fulfill`), and one operate-server
  `server.test.ts` e2e (a cashier's OpenAPI omits `POST /v1/products`, a
  manager's includes it; both keep `GET`). No new META_ tables.
- Per-caller OpenAPI filtering is a deliberate departure from the "static full
  contract" convention; the unfiltered document remains available
  programmatically for tooling that wants the whole surface.
