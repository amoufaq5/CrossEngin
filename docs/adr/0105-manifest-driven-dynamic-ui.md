# ADR-0105: Manifest-driven dynamic admin UI + UI schema endpoint

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0087 (operate-server), ADR-0103 (numbering), ADR-0104 (domain depth) |

## Context

`operate-web` rendered entities from a **hand-authored** `lib/resources.ts`
covering 23 entities — so the 18 entities added in ADR-0104 were served by the
API but invisible in the console, and every future entity needed hand-wiring. The
UI offered only list + create + delete (no detail, edit, search, sort, filter,
relationship navigation, or lifecycle actions).

## Decision

Make the console fully **manifest-driven** off a new server endpoint.

### Backend: `GET /v1/meta/schema` (`operate-runtime/ui-schema.ts`)

`buildUiSchema(manifest)` derives a `UiSchema` from the resolved manifest: per
entity — kebab-plural slug, field list (input type mapped from the kernel field
kind, enum values, reference target, classification, `readOnly` for
sequence-defaulted fields), the list columns, sortable/filterable fields, the
lifecycle `stateField` + transitions (name → operationId + from/to), and CRUD
operationIds. `buildUiSchemaHandler` serves it to any authenticated principal
(shape, not data — no role gate). `compileOperateServer` registers it via a new
`literalRoute` helper (also used to de-duplicate the admin-settings routes), so
every `operate-server` deployment exposes it with no extra wiring.

### Frontend: dynamic rendering (`operate-web`)

- `lib/schema.ts` — typed client + a `useSchema()` hook (module-level cache +
  in-flight dedupe).
- `components/Sidebar.tsx` — schema-driven, searchable entity list (all 41
  entities) replacing the static domain groups.
- `app/page.tsx` — dashboard cards over the live schema.
- `app/e/[slug]/page.tsx` — list view: text search, server-side sort (sortable
  columns), typed filters (filterable columns), enum→badge cells, reference cells
  deep-linking to the target record, and an inline create form rendering each
  field by its schema input type.
- `app/e/[slug]/[id]/page.tsx` — detail/edit: read view of every field, inline
  edit (PATCH only changed fields), delete, reference links, and **lifecycle
  action buttons** for the transitions whose `from` includes the current state
  (POST the transition operation).
- `components/FieldInput.tsx` — one input component switching on the schema input
  type (select / checkbox / textarea / number / date / datetime / email / text);
  sequence-defaulted fields render read-only.

Removed the now-obsolete `lib/resources.ts`, `lib/nav.ts`,
`components/ResourcePage.tsx`, and the `app/[domain]/[entity]` route.

## Consequences

- All 41 entities (and any future manifest entity, in any vertical pack) appear
  in the console automatically — list, detail, create, edit, delete, search,
  sort, filter, relationship navigation, and lifecycle transitions, with **zero
  per-entity UI code**.
- Classification surfaces in the UI (PII/commercial-sensitive field badges);
  redaction still happens at the gateway, so a low-privilege caller simply sees
  fewer fields.
- Verified end-to-end against a live `operate-server`: the schema endpoint
  returns 41 entities, create auto-numbers, and a lifecycle transition advances
  state. `next build` green; 6,463 tests pass; zero type errors.
- Literal-default population at create (so a new record gets its default enum
  state without the form) remains a small follow-up; the create form already lets
  the user pick it.
