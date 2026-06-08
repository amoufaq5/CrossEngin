# ADR-0080: operate-web — a redaction-aware view-model renderer + serving shell (Phase 3 P3.1)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0078 (operate-runtime serving), ADR-0087 (operate-server binary), ADR-0067/0068/0069 (classification redaction), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADR-0080 is the first of the block reserved for Phase 3 P3–P8
> (per ADR-0077). P3 is the `operate-web` renderer; this increment (P3.1) claims
> 0080 for it. 0081–0085 stay reserved for the remaining P-milestones.

## Context

P1 (ADR-0078) compiled a resolved manifest into a live multi-tenant **API**;
P2 (ADR-0103…) built the distributed worker arc. The P3 keystone (ADR-0077) is
turning a manifest's `views` into a **UI surface**. The platform already carries
everything a frontend needs as declarative data — entities + fields (with data
classifications), per-entity `ListView` / `RecordView` / `FormView`, RBAC
permissions, roles — but nothing assembles those into render-ready descriptors,
and nothing enforces per-caller redaction at the rendering boundary.

Three product constraints shaped the design: (1) **framework-neutral view
models** — a pure compiler matching the codebase's "zod contracts + pure
functions" style, no React/DOM dependency; (2) a **renderer + serving shell** —
both a compiler package *and* a runnable app that serves the models over HTTP;
(3) **redaction/RBAC-aware from day one** — the compiled models already drop
classification-redacted + RBAC-forbidden fields per caller, so the wire never
carries a field the viewer can't read.

## Decision

### Part A — `@crossengin/operate-web` (the pure compiler, the 63rd package)

Three source modules, all pure (no sockets, no DB):

- **`model.ts`** — the serializable render descriptors as zod `XSchema` + `type X`
  pairs: `WebAppModel` (title + `EntityNav[]`), `TableModel`
  (columns `{field,label,type,sortable,filterable}` + defaultSort + pageSize +
  rowActions), `DetailModel` (sections of `FieldModel`s, each optionally bound to
  a record value), `FormModel` (`FormFieldModel`s with `required` / `readOnly` /
  typed `validations`), plus `ColumnModel` / `FieldModel` / `WebFieldType` (one
  render hint per manifest field kind). Every shape is plain data so a model is
  JSON-serializable to any frontend.
- **`viewer.ts`** — `ViewerContext` (`{roles}`) + the redaction bridge.
  `EntityFieldResolver` builds an auth `Principal` from the viewer's roles
  (keeping only manifest-declared roles, registering a `__anonymous__` sentinel
  so `resolveEffectiveRoles` never throws on an unknown role) and **reuses the
  auth helpers** `computeClassifiedFieldRedaction` (drives read → field inclusion)
  + `validateClassifiedWriteMask` (drives write → form `readOnly`), parameterized
  by an optional `SensitiveFieldPolicy`. `redactRecord` strips read-forbidden
  fields from a data row (keeping `id`). Fail-closed: an unknown / empty role
  yields no grants.
- **`compile.ts`** — the core. `compileWebApp` / `compileTableModel` /
  `compileDetailModel` / `compileFormModel`. The table derives columns from the
  entity's `ListView` (or every field when none); the detail from the
  `RecordView` sections (or one "Details" section of all readable fields); the
  form from the `FormView` (or every writable field). Every model drops fields the
  viewer can't read; a readable-but-not-writable field is included `readOnly`.
  Labels come from the view's localized text, else a humanized snake_case name.

### Part B — `apps/operate-web` (the runnable serving shell, the 4th app)

A thin Node `http` shell (`operate-web` bin) serving the models + redacted data
as JSON, per caller. Six modules: `http` (raw req/res + `splitTarget` +
`jsonResponse` / `problemResponse`), `principals` (`key:role:tenant` API keys via
`x-api-key` / `Authorization: Bearer`, fail-closed → 401), `manifest-source`
(the same `loadBuiltinPack` lineage-resolver as operate-server),
`server` (`OperateWebServer.dispatch` routes `GET /ui/app`, `/ui/:entity`,
`/ui/:entity/new`, `/ui/:entity/:id`), `cli` (`parseWebArgs`), `node`
(`createNodeRequestListener` + `serve()` → a close handle, exposing the in-memory
store so a boot script can seed rows). The data behind a table/detail is read
from an injected `EntityStore` (the operate-runtime `InMemoryEntityStore` by
default) and **redacted per caller** before serialization.

## Cross-cutting invariants enforced (by tests)

- **Redaction is real at the boundary.** A `store_manager`'s compiled
  `DetailModel` / `FormModel` and the served record carry the classified
  `Product.unit_cost`; a `cashier`'s OMIT it — same handler, same route. The
  healthcare PHI case proves the same for `Patient.mrn` (privileged clinician vs
  front desk, driven by the classification default + a `SensitiveFieldPolicy`).
- **It actually boots.** `serve(--pack erp-retail --port 0)` + a real loopback
  `fetch` returns `200` for `/ui/app`, `401` unauthenticated, and the
  unprivileged caller's `/ui/:entity/:id` JSON has no `unit_cost` while the
  privileged caller's does.
- **Works with or without explicit views.** The retail/healthcare packs declare
  only `ListView`s; the detail + form fall back to `listConfigForEntity` + the
  all-readable-fields path, so the compiler is correct either way.
- **No new persistence.** Pure rendering over existing stores → zero new
  meta-schema tables; the schema-drift gate stays green and the 125-table count
  is unchanged.

## Alternatives considered

- **Ship a React/Vue renderer.** No — a framework would couple the platform to
  one client stack. Framework-neutral JSON view models let any frontend (or none)
  consume them; a concrete renderer is a later, out-of-tree concern.
- **Re-derive classification rules in the web layer.** No — `viewer.ts` reuses
  the exact `auth` helpers the gateway's `transform_response` uses, so redaction
  is defined once and can't drift between API and UI.
- **Route through the full gateway pipeline (like operate-server).** No — the UI
  routes are read-only model + data fetches; a 60-line dispatch + an API-key
  registry is enough. JWT/edge auth is deferred behind the same seam.
- **Compile a write/mutation surface now.** Deferred — this increment scopes to
  read views + a basic create form model; mutation routing reuses operate-server.

## Consequences

- **63 packages + 4 apps, 125 meta-schema tables** (was 62 / 3 apps / 125;
  +1 package, +1 app, 0 tables), **+64 offline tests** (31 package + 33 app),
  all green, no type errors.
- **The P3 keystone exists.** `operate-web --pack erp-retail --api-key
  key:store_manager:<tenant>` answers `GET /ui/Product` with a redaction-aware
  table model + a redacted data page, and `GET /ui/Product/:id` with a detail
  model + the record — from the manifest, over HTTP.
- **Natural follow-ups:** a JWT/edge adapter (mirroring operate-server P1.9/P1.17),
  wiring the Postgres entity stores, mutation routing, and the remaining
  view kinds (kanban / calendar / dashboard) behind the same compiler shape.
