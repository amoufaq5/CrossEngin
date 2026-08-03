# ADR-0200: Related records on the detail view (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-06 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0080 (renderer), ADR-0088 (list pagination/filtering), ADR-0077 (P3) |

## Context

The `operate-web` detail view rendered a record's own fields, edits, lifecycle transitions, and
*forward* references (a field's value linking to the entity it points at). But it showed nothing about
the record's **children** — the rows that reference *it* (an Account's Invoices, an Invoice's Lines).
That's the classic manifest-driven "related lists" panel, and every relation the manifest already
declares as a reference field is enough to render it. This adds it, end-to-end and manifest-driven.

## Decision

- **Reference fields are always server-filterable** (`operate-runtime`, `list-query.ts`). A new
  `withReferenceFilters` force-adds every reference (FK) field to a list's `filterableFields`, the same
  principle as the existing `withLifecycleStateFilter` (the inbox's state filter). Reference columns
  are the natural join keys for "the children pointing at this record", so a related-records query
  `?<field>=<id>` is pushed into SQL rather than scanned client-side — for any entity, with or without
  a `ListView` that happened to mark the FK filterable.
- **`reverseReferences(schema, targetName)`** (`operate-web`, `lib/schema.ts`) — pure, derived from the
  UI schema: every entity that carries a reference field pointing at `targetName`, restricted to
  entities the viewer may `list` and fields the server exposes as filterable (so the query actually
  narrows). No new schema — the reverse relation is inferred from the existing reference fields.
- **A `RelatedRecords` panel** on the detail view (per reverse reference): fetches `?<field>=<id>`
  (bounded to 6 rows), renders a compact table over the child's list columns with each row deep-linked
  to its detail page and a "View all" link to the child list pre-filtered (`?fl_<field>=<id>`, the list
  page's existing filter-URL contract). Empty relations render nothing; it's hidden while editing.

## Consequences

- A detail page now shows both directions of every relation the manifest declares — forward references
  (already) and the reverse children — with zero per-entity code, purely from the reference fields.
  The renderer speaks the manifest's relational intent natively, as ADR-0080 intended.
- Making reference fields filterable is a broadly useful, principled change beyond this view: any
  client can now filter a list by an FK (`?account=<id>`), not just search/sort. It's additive — a
  reference already filterable via its `ListView` is unchanged — and gated the same way as every other
  filter (only the value is bound; unknown params ignored).
- `operate-web` has no unit-test harness (a Next.js renderer); the tested surface is the
  `operate-runtime` server change. The renderer compiles under strict `tsc --noEmit` and the pure
  `reverseReferences` derivation is small + total.
- 7,016 tests pass (+1: `listConfigForEntity` always makes reference fields filterable). Full workspace
  build + typecheck green.
- Follow-ups: m2m (association) related lists via the join-table link API; paginating a related panel
  in place; counts/badges on each relation; a manifest hint to order/curate which relations surface.
