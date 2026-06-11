# Typed client author's guide

How to build a **typed client** against a CrossEngin deployment by consuming its
discovery documents. The platform exposes two serving apps, each self-describing
its API at runtime — so a client never hard-codes routes or field shapes.

This guide is task-oriented (how do I generate types and call the API). For the
architecture behind these surfaces, see
[`operate-reporting-and-discovery.md`](./operate-reporting-and-discovery.md).

---

## The two surfaces

| app | what it serves | discovery route | discovery format |
|---|---|---|---|
| `operate-server` | JSON REST API (entity CRUD + lifecycle + reports) | `GET /v1/openapi.json` | standard **OpenAPI 3.1** |
| `operate-web` | redaction-aware view models (`/ui/...`) + SSR HTML (`/app/...`) | `GET /ui/_describe` | **`WebApiDescriptor`** (a small custom JSON shape) |

Pick the surface that matches your client:

- Building a **data/integration client** (read/write records, run reports, your own
  UI)? → `operate-server` + its OpenAPI document. Use off-the-shelf OpenAPI codegen.
- Building a **dynamic UI** that renders the platform's own view models (tables,
  forms, kanban, dashboards) without hand-authoring screens? → `operate-web` +
  `/ui/_describe`. The descriptor tells you which views/routes a caller has and the
  exact envelope each returns.

Both documents **require a credential** (401 unauthenticated) and are
**per-caller**: they describe only what *that* principal may see and do. Treat a
fetched document as scoped to the token used — see [Per-caller gotchas](#per-caller-gotchas).

---

## Auth (both surfaces)

Send a credential on the discovery request (and every request after):

- **API key (dev/service):** `x-api-key: <token>` or `Authorization: Bearer <token>`
  where the token is a registered opaque key.
- **JWT (production):** `Authorization: Bearer <jwt>` — an EdDSA-signed token the
  server verifies against its JWKS. The JWT's `tenant_id` claim is authoritative;
  the `x-tenant-id` header is only a fallback (and a mismatch is rejected).

The principal's scopes/roles drive both RBAC (which operations exist for them) and
classification redaction (which fields appear).

---

## Path A — `operate-server` (OpenAPI 3.1)

### 1. Fetch the document

```http
GET /v1/openapi.json
Authorization: Bearer <token>
```

It is a standard OpenAPI 3.1 document:

```jsonc
{
  "openapi": "3.1.0",
  "info": { "title": "CrossEngin operate API", "version": "v1" },
  "paths": {
    "/v1/products": {
      "get":  { "operationId": "product.list", "responses": { "200": { "content": { "application/json": { "schema": { /* { data: [#/.../Product], page } */ } } } }, "401": …, "403": … } },
      "post": { "operationId": "product.create", "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Product" } } } }, "responses": { "201": … } }
    },
    "/v1/products/{id}": { "get": …, "patch": …, "delete": … },
    "/v1/sales-orders/{id}/{transition}": { "post": … },
    "/v1/reports/{report}": { "get": … }
  },
  "components": { "schemas": { "Product": { … }, "ReportData": { … }, "ProblemDetails": { … } } },
  "x-reports": [ { "name": "salesRevenue", "kind": "kpi", "entity": "SalesOrder", "label": "…" } ]
}
```

### 2. Generate types

**Built-in (no external tool, P3.38):** operate-server ships a pure TypeScript
client emitter — one self-contained, dependency-free module (typed interfaces +
a `fetch`-based `createOperateClient` factory):

```bash
operate-server openapi-client --pack erp-retail --out ./src/retail-client.ts
# or --manifest <file>, and --client-name <name> for the factory
```

A committed example lives at `apps/operate-server/src/generated/retail-client.ts`
(typechecked + drift-guarded in CI).

**Or any OpenAPI 3.1 toolchain** — the document is intentionally vanilla:

```bash
# types only (TypeScript)
npx openapi-typescript ./openapi.json -o ./src/api-types.ts

# or a full client (many languages)
openapi-generator-cli generate -i ./openapi.json -g typescript-fetch -o ./client
```

### 3. What's in the schemas

- **One component schema per entity** (`#/components/schemas/<Entity>`), derived
  from the manifest fields. Field types map to JSON Schema (`text`→string,
  `decimal`→number, `datetime`→string+`date-time`, `enum`→string+enum,
  `reference`→string, `uuid`→string+`uuid`, …).
- **Required vs nullable** — required fields are in the schema's `required` list;
  optional fields are **nullable** (`type: ["...", "null"]`), because the store
  returns `null` for an unset value.
- **`ReportData`** — the `tabular | kpi | pivot` union (`oneOf`, discriminated by
  `kind`), referenced from the report operation's `200`.
- **`ProblemDetails`** — the RFC 9457 error body (`type`/`title`/`status`/`detail`/
  `instance`), referenced from each operation's error responses via
  `application/problem+json`.

### 4. Response & error shapes per operation

| operation | success | errors |
|---|---|---|
| `list` (`GET /v1/<plural>`) | `200` `{ data: <Entity>[], page: { limit, nextCursor } }` | `401`, `403` |
| `read` (`GET /v1/<plural>/{id}`) | `200` `<Entity>` | `401`, `403`, `404` |
| `create` (`POST`) | `201` `<Entity>` (body: `<Entity>`) | `401`, `403` |
| `update` (`PATCH /{id}`) | `200` `<Entity>` (body: `<Entity>`) | `401`, `403`, `404` |
| `delete` (`DELETE /{id}`) | `204` | `401`, `403`, `404` |
| `transition` (`POST /{id}/<transition>`) | `200` `<Entity>` (body: `{ transition }`) | `401`, `403`, `404`, `409` |
| `report` (`GET /v1/reports/{report}`) | `200` `ReportData` | `401`, `404` |

### 5. Pagination & filtering (list)

List endpoints use **keyset** cursors. Query params (driven by the entity's
`ListView`):

- `?limit=N` (capped at 500), `?cursor=<opaque>` (from the previous `page.nextCursor`)
- `?sort=field&order=asc|desc` (sortable fields only)
- `?field[op]=value` typed filters (`eq|ne|gt|gte|lt|lte`), `?field[in]=a,b,c`
- `?fields=a,b,c` projection (narrows only — can't reveal a redacted field)

---

## Path B — `operate-web` (`WebApiDescriptor`)

`/ui/_describe` returns a compact custom shape (not OpenAPI) describing the
**view-model** API. Use it when your client renders the platform's own UI models.

### 1. Fetch the document

```http
GET /ui/_describe
Authorization: Bearer <token>
```

```jsonc
{
  "title": "…",
  "routes": [
    { "kind": "app", "method": "GET", "path": "/ui/app", "responseSchema": { "$ref": "#/models/WebAppModel" } },
    { "kind": "describe", "method": "GET", "path": "/ui/_describe" }
  ],
  "entities": [
    {
      "entity": "Product",
      "label": "Product",
      "views": ["table", "detail", "form", "kanban"],
      "routes": [
        { "kind": "table",  "method": "GET",   "path": "/ui/Product",        "entity": "Product", "responseSchema": { /* { table: $ref TableModel, page } */ } },
        { "kind": "detail", "method": "GET",   "path": "/ui/Product/{id}",   "entity": "Product", "responseSchema": { /* { detail: $ref DetailModel, record } */ } },
        { "kind": "create", "method": "POST",  "path": "/ui/Product",        "entity": "Product", "responseSchema": { /* { record } */ } },
        { "kind": "delete", "method": "DELETE","path": "/ui/Product/{id}",   "entity": "Product" }
      ],
      "schema": { "type": "object", "properties": { "id": …, "sku": …, "unit_cost": … }, "required": ["sku"] }
    }
  ],
  "models": {
    "WebAppModel": { … }, "TableModel": { … }, "DetailModel": { … }, "FormModel": { … },
    "KanbanModel": { … }, "CalendarModel": { … }, "MapModel": { … }, "DashboardModel": { … }, "PivotModel": { … }
  }
}
```

### 1a. Generate a client (built-in, P3.39)

operate-web ships a pure view-model client emitter — one self-contained module
(typed view-model + entity interfaces + a `createWebClient` factory):

```bash
operate-web web-client --pack erp-retail --role retail_admin --out ./src/web-client.ts
# --role repeats (the descriptor is per-caller); --client-name sets the factory name
```

A committed example lives at `apps/operate-web/src/generated/retail-web-client.ts`
(typechecked + drift-guarded in CI). The sections below explain the descriptor the
emitter consumes, for hand-rolled clients.

### 2. The three schema layers

The descriptor carries everything a client needs to type its calls:

1. **`entities[].schema`** — the redaction-aware **field schema** for *this caller*
   (an OpenAPI object schema; fields the caller can't read are absent, optional
   fields nullable). This is the shape of a `record` / table row.
2. **`models`** — the **view-model shapes** (`TableModel`/`DetailModel`/… as OpenAPI
   schemas, converted from the renderer's zod source so they can't drift).
3. **`entities[].routes[].responseSchema`** (and `routes[].responseSchema`) — the
   **envelope** each route returns, with the view model referenced via a `$ref`
   into the descriptor's own `models` map.

### 3. Resolving `$ref`

The `$ref`s use a self-contained convention: `#/models/<Name>` points into the
**same document's** top-level `models` map. There is no external file. To resolve:

```ts
function resolveRef(doc: WebApiDescriptor, schema: any): any {
  if (schema?.$ref?.startsWith("#/models/")) {
    return doc.models[schema.$ref.slice("#/models/".length)];
  }
  return schema;
}
```

### 4. Envelope shapes by route kind

| route kind | envelope (`responseSchema`) |
|---|---|
| `app` | `$ref WebAppModel` |
| `table` / `kanban` / `calendar` / `map` | `{ <kind>: $ref <Model>, page: { data, nextCursor } }` |
| `dashboard` | `{ dashboard: $ref DashboardModel, widgetData }` |
| `pivot` | `{ pivot: $ref PivotModel, data }` |
| `detail` | `{ detail: $ref DetailModel, record }` |
| `form` | `{ form: $ref FormModel }` |
| `create` / `update` / `transition` | `{ record }` |
| `delete` | _(no body — `204`)_ |
| `describe` | _(self; no schema)_ |

`page` is `{ data: object[], nextCursor: string | null }`. A `record` is the
caller's redacted entity (precise shape = that entity's `schema`).

### 5. Worked example — typing `GET /ui/Product`

```ts
const doc: WebApiDescriptor = await (await fetch("/ui/_describe", { headers })).json();
const product = doc.entities.find((e) => e.entity === "Product")!;
const tableRoute = product.routes.find((r) => r.kind === "table")!;

// envelope: { table: $ref TableModel, page }
const env = tableRoute.responseSchema!;                 // { properties: { table: {$ref}, page } }
const tableModelSchema = resolveRef(doc, env.properties.table); // -> doc.models.TableModel
const rowSchema = product.schema;                       // the redacted Product row shape

// call it
const { table, page } = await (await fetch(tableRoute.path, { headers })).json();
// `table` conforms to TableModel; `page.data` rows conform to `product.schema`
```

---

## Per-caller gotchas

Both documents are **scoped to the credential** used to fetch them. Build clients
accordingly:

- **Don't share a fetched document across roles.** A cashier's OpenAPI omits
  `POST /v1/products`; their `Product` schema omits `unit_cost`. A manager's
  includes both. Generate types per-role, or fetch with the highest-privilege
  service token if you want the full surface (then enforce per-user RBAC server-side
  anyway — the server is the boundary).
- **Redaction is structural.** A field the caller can't read is **absent** from the
  schema *and* from the data — not `null`. Don't assume a property exists because
  the manifest declares it.
- **Nullable ≠ absent.** Optional fields are `type: [..., "null"]` (present but may
  be `null`). Redacted fields are gone entirely. Handle both.
- **Errors are RFC 9457.** Non-2xx responses are `application/problem+json`
  (`{ type, title, status, detail, instance }`) on operate-server; operate-web
  mutations return the same problem envelope. Type your error path off
  `ProblemDetails`.
- **The server is authoritative.** Discovery describes intent; the gateway still
  enforces RBAC, redaction, rate limits, and idempotency on every call. A client
  must handle a `403`/`404` even if its (possibly stale) document suggested the
  operation was available.

---

## Quick reference

| need | operate-server | operate-web |
|---|---|---|
| discovery route | `GET /v1/openapi.json` | `GET /ui/_describe` |
| format | OpenAPI 3.1 | `WebApiDescriptor` |
| codegen | `openapi-typescript` / `openapi-generator` | resolve `$ref` into `models`, emit from `schema`/`models` |
| entity field shape | `components.schemas.<Entity>` | `entities[].schema` (redacted) |
| response envelope | per-operation `responses[].content` | `routes[].responseSchema` |
| error shape | `ProblemDetails` (`application/problem+json`) | same |
| per-caller | RBAC-filtered operations + schemas | RBAC-gated routes + redacted schemas |

See [`operate-reporting-and-discovery.md`](./operate-reporting-and-discovery.md)
for the architecture and ADR-0181–0191 for the increment-by-increment detail.
