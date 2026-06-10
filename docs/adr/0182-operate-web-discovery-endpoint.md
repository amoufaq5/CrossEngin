# ADR-0182: operate-web discovery endpoint (Phase 3 P3.27)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0181 (operate-server OpenAPI discovery), ADR-0080 (Phase 3 P3 plan), ADR-0162/0167/0170/0171 (operate-web view models) |

## Context

P3.26 gave `apps/operate-server` a discovery artifact (`GET /v1/openapi.json`),
but `apps/operate-web` — the view-model serving shell — had none. A client had to
know its `/ui/...` route shapes out of band, and which *view kinds* an entity
actually exposes (kanban / calendar / map / dashboard / pivot are conditional on
an authored, caller-readable axis view) was undiscoverable.

operate-web already computes exactly this per-caller surface: `compileWebApp`
returns a `WebAppModel` whose `nav` lists every entity with its available view
kinds (`table`/`detail`/`form` always; the richer kinds only when they compile
non-null for the viewer).

## Decision

Add a per-caller discovery descriptor, projected from `compileWebApp` so it can't
drift from what the server serves.

- **`@crossengin/operate-web` `describe.ts`** — `describeWebApi(manifest, viewer):
  WebApiDescriptor` (`{ title, routes (global), entities }`). For each
  `compileWebApp` nav entry it maps the entity's available view kinds to concrete
  route paths (`table`→`/ui/{e}`, `detail`→`/ui/{e}/{id}`, `form`→`/ui/{e}/new`,
  `kanban`→`/ui/{e}/kanban`, …`pivot`→`/ui/{e}/pivot`), and lists the global
  routes (`/ui/app`, `/ui/_describe`). Pure data — no DOM/handler references; the
  parity sibling of operate-runtime's `api-descriptor.ts`.
- **`apps/operate-web`** serves it at `GET /ui/_describe`, intercepted in
  `dispatchUi` before the generic `/ui/:entity` route (`_describe` is not an
  entity name). It is behind auth like every `/ui` route (401 unauthenticated)
  and computed for the caller's `ViewerContext`.

## Cross-cutting invariants enforced

- **Per-caller + drift-proof.** The descriptor is derived from `compileWebApp`, so
  a view kind appears only when it actually compiles for the viewer — the same
  resolution the routes use. It can't list a route the server wouldn't serve.
- **Auth-gated.** Discovery rides the same auth as the data routes (401 without a
  credential); it is the API *shape*, not tenant data.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,078 offline tests + 51 gated
  real-Postgres integration tests + five CI gates.** New tests: operate-web's
  `describe.test.ts` (global routes, table/detail/form paths, kanban only when a
  board compiles) + three operate-web-app `server.test.ts` e2e cases (401
  unauthenticated; global + per-entity routes; kanban surfaced once authored). No
  new META_ tables.
- A richer descriptor that also lists the RBAC-gated mutation routes
  (create/update/delete/transition per the caller's `canPerform`) is a follow-up;
  this increment covers the read view-model surface.
