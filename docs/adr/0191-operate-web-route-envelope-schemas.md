# ADR-0191: operate-web route envelope schemas (Phase 3 P3.36)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0182 (operate-web discovery endpoint), ADR-0189/0190 (operate-web field + view-model schemas), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.35 published the view-model *shapes* (`TableModel`/`DetailModel`/…) under
`WebApiDescriptor.models`, but nothing tied a *route* to the envelope it returns —
a client still had to know out-of-band that `GET /ui/:entity` yields
`{ table, page }` while `GET /ui/:entity/:id` yields `{ detail, record }`. The
discovery descriptor described the models and the routes, but not the wiring
between them.

## Decision

`WebRouteDescriptor` gained an optional `responseSchema: OpenApiSchema` — the
envelope the route returns, with the view model referenced via a `$ref` into the
descriptor's own `models` map (`#/models/TableModel`). `envelopeSchemaFor(kind)`
mirrors exactly what `apps/operate-web`'s server returns:

| route kind | envelope |
|---|---|
| `app` | `$ref WebAppModel` |
| `table` / `kanban` / `calendar` / `map` | `{ <kind>: $ref <Model>, page }` |
| `dashboard` | `{ dashboard: $ref DashboardModel, widgetData }` |
| `pivot` | `{ pivot: $ref PivotModel, data }` |
| `detail` | `{ detail: $ref DetailModel, record }` |
| `form` | `{ form: $ref FormModel }` |
| `create` / `update` / `transition` | `{ record }` |
| `delete` (204) / `describe` | _(no body schema)_ |

The `page` wrapper (`{ data: [...], nextCursor }`) and `record` are inlined
(`record`'s precise field shape is the per-caller entity `schema` from P3.34).

## Cross-cutting invariants enforced

- **Envelope ↔ server parity.** The schemas mirror the exact `jsonResponse(...)`
  shapes the operate-web server returns — a client can rely on them.
- **Self-contained refs.** Every `$ref` resolves into the descriptor's own
  `models` map (published in the same payload, P3.35) — no external document
  needed.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,124 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests: `describe.test.ts`
  (per-route `responseSchema` $ref'ing the models; the ref resolves into `models`;
  mutation `{ record }`; `delete`/`describe` have none) + an operate-web-app
  `server.test.ts` e2e (the served `/ui/_describe` carries `table.responseSchema`).
  Pre-existing exact-match route assertions relaxed to `objectContaining` for the
  new field. No new META_ tables.
- The discovery surface is now complete: routes ↔ envelopes ↔ model shapes ↔
  per-caller field schemas. A generated typed client off either app's discovery
  doc is the natural next step.
