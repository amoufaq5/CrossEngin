# ADR-0201: Many-to-many related lists — association read route + detail panel (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-07 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0200 (1:N related records), ADR-0095 (association link/unlink API), ADR-0080 (renderer), ADR-0077 (P3) |

## Context

ADR-0200 rendered a record's **1:N** children (rows whose reference field points at it). The other
half of "related lists" is **many-to-many**: the records linked across a join table (an Order's Tags,
a Tag's Products). P1.15 (ADR-0095) built the store-level `link`/`unlink`/`listLinks` API on the
column store, but "manifest-derived association routes (HTTP)" were left as the open follow-up — so
nothing served or rendered associations. This ships the read path end-to-end.

## Decision

- **A manifest-derived association read route** (`operate-runtime`, `association.ts`).
  `manifestAssociationRoutes` turns each `many_to_many` relation into two routes
  (`GET /v1/<owner>/{id}/<related>`, each side lists the other; one route for a self-relation),
  registered in `compileOperateServer` alongside the CRUD routes.
- **`buildAssociationListHandler`** RBAC-checks `list` on the *related* entity, resolves the owner's
  links (`listLinks` narrowed to the owner side via `ownerIsLeft`), fetches each linked record, and
  returns `{data}` (full records — the gateway redacts per-caller at the edge, exactly like the list
  endpoint). `401` no-tenant → `403` role → `501 associations_unsupported`.
- **A capability seam, not a hard dependency.** `AssociationReader` (structural `listLinks`) +
  `isAssociationReader` — the column store satisfies it; the JSONB / in-memory stores don't, and the
  route reports `501` rather than lying with an empty list. `operate-runtime` needs no `-pg` import.
- **UI schema exposes associations** (`buildUiSchema`): each entity carries its `associations`
  (related entity + resource slug + label), derived from the same `manifestAssociationRoutes`.
- **A detail-view panel** (`operate-web`) per association fetches
  `GET /v1/<owner>/<id>/<related>` (via `listAssociations`) and renders a compact deep-linked table
  over the related entity's list columns — the m2m twin of ADR-0200's 1:N panel. Empty / unsupported
  associations render nothing.

## Consequences

- A detail page now shows **all three** relation directions the manifest declares: forward references,
  1:N reverse children (ADR-0200), and M:N associations (this) — all manifest-driven, zero per-entity
  code. The renderer speaks the full relational model.
- Association reads work on the column store (`--store pg-columns`, which has the join tables); on the
  JSONB / in-memory stores the route returns `501` and the panel simply doesn't render — an honest
  degradation, not a silent empty.
- The write side (link/unlink from the UI) and cross-store association support remain follow-ups; the
  store-level write API already exists (ADR-0095), so it's a handler + UI increment.
- 7,026 tests pass (+10: association routes derivation — two-per-relation / self-relation / non-m2m
  skip; handler — 401 / 403 / 200-with-narrowed-links / deleted-record-skip / 501-unsupported;
  `isAssociationReader`; ui-schema surfaces associations both directions + empty). `operate-web` has no
  unit harness; verified by strict `tsc`. Full build + typecheck green.
- Follow-ups: link/unlink write UI over the existing store API; paginating an association panel; an
  `AssociationReader` for the JSONB store; counts/badges per relation.
