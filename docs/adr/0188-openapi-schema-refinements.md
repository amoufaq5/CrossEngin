# ADR-0188: OpenAPI schema refinements — nullability + error responses (Phase 3 P3.33)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0187 (OpenAPI component schemas), ADR-0181 (OpenAPI discovery), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.32 added typed component schemas, but two refinements were left open: optional
(non-required) fields were typed as if always present and non-null (the stores
return `null` for an unset value), and operations documented only their success
responses — no error responses, so a codegen tool / explorer saw nothing about the
`401`/`403`/`404`/`409` the API actually returns.

## Decision

- **Nullable optional fields.** `nullableSchema(schema)` widens a schema's `type`
  to include `"null"` (and, for an `enum`, adds a `null` member so a nullable
  enum's `null` validates). `entitySchemaFor` applies it to every non-required
  field; required fields + the synthetic `id` stay non-null. (`OpenApiSchema.enum`
  widened to `(string | null)[]`.)
- **RFC 9457 error responses.** A static `ProblemDetails` schema (RFC 9457:
  `type`/`title`/`status`/`detail`/`instance`) is added to `components.schemas`
  whenever the document has operations. `errorResponses(op)` attaches per
  operation, each as `application/problem+json` referencing `ProblemDetails`:
  every op gets `401`; entity ops add `403`; ops with a record id
  (read/update/delete/transition) add `404`; transitions add `409`; the report op
  keeps its `404` (no `403` — it's fail-closed at the field level, not entity
  RBAC).

## Cross-cutting invariants enforced

- **Schemas reflect store behavior.** An optional field can come back `null`, and
  the schema now says so; required fields can't.
- **The declared error format is documented.** RFC 9457 problem-details is the
  API's error envelope; the OpenAPI now advertises it per operation, so a client
  knows the failure shapes — not just the happy path.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,108 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** Updated/added tests:
  `schemas.test.ts` (optional fields nullable incl. enum + `null`; the
  ProblemDetails-adjacent shape via `nullableSchema`), `openapi.test.ts` (report
  now also documents `401`; per-op error responses + the ProblemDetails $ref; a
  transition op's `404`+`409`), and the operate-server `server.test.ts` e2e (the
  served doc carries `ProblemDetails` + the create op's `403` problem response). No
  new META_ tables.
- Per-operation success/error examples + more precise per-status error sub-types
  (e.g. a distinct `validation` problem) remain possible future refinements.
