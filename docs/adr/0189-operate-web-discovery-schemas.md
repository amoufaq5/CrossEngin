# ADR-0189: operate-web discovery field schemas (Phase 3 P3.34)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0182 (operate-web discovery endpoint), ADR-0187/0188 (operate-server OpenAPI schemas), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.32/P3.33 gave operate-server's OpenAPI document typed component schemas;
operate-web's `GET /ui/_describe` (P3.27) listed entities × routes but carried no
field types. For parity — and because a UI client wants the field shapes to render
forms/tables — the descriptor should include a per-entity schema. But operate-web
is **per-caller redaction-aware**, so the schema must reflect only the fields the
viewer can read (not the full contract operate-server publishes).

## Decision

`WebEntityDescriptor` gained a `schema: OpenApiSchema` — the redaction-aware object
schema of the fields the caller can **read**. `entitySchemaForViewer` resolves the
entity's field access via the same `EntityFieldResolver` the models use, drops any
field the viewer can't read, and types the rest with operate-runtime's
`fieldTypeToSchema` (+ `nullableSchema` for optional fields) — so the field→schema
mapping is **identical** to operate-server's, just filtered. `id` is always
present. A cashier's `Product` schema omits `unit_cost`; a manager's includes it —
the same redaction as the model + data.

## Cross-cutting invariants enforced

- **Redaction parity.** The descriptor's schema drops exactly the fields the
  model/data redaction drops for that caller — it can't advertise a field the
  caller can't read.
- **Shared field→schema mapping.** Reuses operate-runtime's `fieldTypeToSchema` /
  `nullableSchema`, so a field's type renders the same in both apps' discovery
  surfaces.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,110 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests: operate-web
  `describe.test.ts` (a manager's `Product` schema carries `unit_cost`, a
  cashier's omits it) + an operate-web-app `server.test.ts` e2e (the served
  `/ui/_describe` carries the redaction-aware schema). No new META_ tables.
- The view-model shapes themselves (`TableModel`/`DetailModel`/`FormModel`) could
  also be published as schemas; this increment covers the entity field schema,
  the operate-server parity item.
