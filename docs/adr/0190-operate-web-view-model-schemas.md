# ADR-0190: operate-web view-model schemas in discovery (Phase 3 P3.35)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0182 (operate-web discovery endpoint), ADR-0189 (operate-web discovery field schemas), ADR-0080 (Phase 3 P3 plan) |

## Context

`/ui/_describe` (P3.27/P3.34) listed entities × routes + per-entity field schemas,
but not the *view-model* shapes a UI client actually receives — `TableModel`,
`DetailModel`, `FormModel`, `KanbanModel`, … Those shapes are defined as zod
schemas in `model.ts`; a dynamic client had no machine-readable description of the
`{ table, page }` / `{ detail, record }` / `{ form }` envelopes.

## Decision

Publish the view-model shapes under a top-level `WebApiDescriptor.models` map.

- **`model-schema.ts`** — `zodToOpenApiSchema(zodType)`: a focused zod→OpenAPI/JSON-
  Schema converter for the subset `model.ts` uses (object / string / number /
  boolean / array / enum / literal / discriminated-union / optional / unknown). It
  reads zod 3's stable `_def.typeName` discriminator and is defensive — an unknown
  construct degrades to an open `{}` schema rather than throwing. `webModelSchemas()`
  converts the nine exported model zod schemas (`WebAppModel` / `TableModel` /
  `DetailModel` / `FormModel` / `KanbanModel` / `CalendarModel` / `MapModel` /
  `DashboardModel` / `PivotModel`). Deriving from the zod schemas means the
  published shapes **can't drift** from the source of truth.
- **`describeWebApi`** attaches `models: webModelSchemas()`. The model shapes are
  **caller-independent** (the shape is the same for every viewer; only the data +
  which fields appear are redacted per-caller — that redaction lives in the
  per-entity `schema` from P3.34).

## Cross-cutting invariants enforced

- **No drift.** The published shapes are converted from the same zod schemas the
  renderer validates against, so they stay in sync automatically.
- **Shape vs. data.** `models` describes structure (caller-independent); the
  per-entity `schema` (P3.34) describes the redacted field set (per-caller). The
  two are complementary.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,120 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests: `model-schema.test.ts`
  (the converter over primitives/optional/enum/literal/array/nested/discriminated-
  union/unknown; `webModelSchemas` publishes the nine shapes; TableModel's typed
  columns + DetailModel's nested sections) + a `describe.test.ts` + operate-web-app
  `server.test.ts` e2e (the served `/ui/_describe` carries `models.TableModel`). No
  new META_ tables.
- A full route→envelope schema (`{ table: TableModel, page }`) referencing these
  model schemas is a possible follow-up; this increment publishes the model shapes
  themselves.
