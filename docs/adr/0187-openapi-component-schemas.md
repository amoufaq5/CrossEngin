# ADR-0187: OpenAPI component schemas (Phase 3 P3.32)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0181 (operate-server OpenAPI discovery), ADR-0183 (per-caller OpenAPI filtering), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.26's `GET /v1/openapi.json` listed the path/operation surface (operationIds,
methods, path params, tags) but carried **no `components.schemas`** and no
per-operation `requestBody`/typed responses — so an SDK generator or API explorer
got endpoints without types. The OpenAPI document was discovery-grade, not
codegen-grade.

## Decision

Derive typed component schemas from the manifest and reference them from each
operation's request/response bodies.

- **`@crossengin/operate-runtime` `schemas.ts`** — a minimal OpenAPI/JSON-Schema
  subset (`OpenApiSchema`). `fieldTypeToSchema(FieldType)` maps every manifest
  field-type kind (text/long_text/url/… → string; email → string+format; integer
  → integer; decimal → number; boolean; date/datetime/time → string+format;
  uuid → string+uuid; enum → string + its values; reference → string;
  json/file/currency_amount/geo_* → object; array → items). `entitySchemaFor(entity)`
  builds an object schema (a typed property per field + a string `id`, `required`
  from the manifest); `entitySchemasFromManifest` keys them by entity name. A
  static `REPORT_DATA_SCHEMA` is the `tabular | kpi | pivot` `oneOf`.
- **`openapi.ts`** — `toOpenApiDocument(descriptor, info, { entitySchemas? })`
  embeds the schemas under `components.schemas` (+ `ReportData` when a report op is
  present) and references them per operation: `read`/`create`/`update`/`transition`
  → the entity `$ref` (create/update/transition also get a `requestBody`; the
  transition body is `{ transition: string }`); `list` → a `{ data: [entity],
  page }` wrapper; `report` → `$ref ReportData`; `delete` → `204`. `OpenApiDocument`
  gained `components`; the operation object gained `requestBody` + typed
  `responses` (content). `buildPerCallerOpenApiHandler` threads the schemas, so the
  per-caller filtered document still carries them.
- **`compileOperateServer`** derives `entitySchemasFromManifest(manifest)` once and
  passes it to both the exposed `openApiDocument` and the served per-caller handler.

## Cross-cutting invariants enforced

- **The schemas are projected from the manifest, not hand-written.** Field types
  come from the same `FieldType` the DDL emitter reads, so the OpenAPI types can't
  drift from the entity definitions.
- **Schemas describe the full contract.** Field-level classification redaction is a
  runtime, per-caller concern; the schema is the published entity shape. (Operation
  *visibility* is still per-caller RBAC-filtered, P3.28.)

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,102 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests: `schemas.test.ts`
  (field-type → schema mappings, entity schema incl. id/required, the ReportData
  oneOf), `openapi.test.ts` component-schema cases (embedding + $refs on
  read/create/list/report), and an operate-server `server.test.ts` e2e (the served
  doc carries `components.schemas.Product` with `unit_price` + the create op's
  `requestBody` `$ref`s it). No new META_ tables.
- A generated typed client driven off this document is the natural follow-up;
  nullability (`type: [..., "null"]`) for optional fields + per-operation response
  error schemas are possible refinements.
