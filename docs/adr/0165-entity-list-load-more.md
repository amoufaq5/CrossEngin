# ADR-0165: Cursor pagination ("Load more") in the generic entity list

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (Phase 3 plan — P3 renderer), ADR-0096 (keyset pagination), ADR-0088 (list pagination from the ListView) |

## Context

The manifest-driven entity list (`/e/[slug]`) requested `limit=50` and, when more rows existed,
showed a dead-end note: "more available (refine filters)". The serving API has returned an opaque
keyset `nextCursor` since P1.16 (ADR-0096) — the console just never used it, so a tenant with more
than 50 records of an entity literally could not see past the first page. First concrete slice of
Phase 3 P3 (the renderer).

## Decision

- **Accumulating cursor pagination.** `EntityList` now holds the loaded `data` + the current
  `nextCursor` (instead of a single response). The first load (and any reload on a sort/filter
  change) replaces the rows; a **"Load more"** button — shown only while `nextCursor !== null` —
  fetches the next page with `&cursor=<nextCursor>` appended to the same query and **appends** the
  rows. The keyset cursor is stable under concurrent inserts/deletes (ADR-0096), so paging never
  skips or repeats.
- **Client search is scoped to loaded rows**, and says so: the footer reads `N shown (of M
  loaded)` when the quick filter is narrowing, plus "· more available" while further pages exist —
  no more misleading "refine filters" dead-end.
- Server-side sort + filter are unchanged; changing either resets pagination (the `query` memo
  drives `load`), so a new cursor sequence starts from the filtered set.

## Consequences

- A tenant can now walk an entire entity, page by page, from the generic renderer — the list is
  no longer capped at an unreachable 50.
- Pure frontend: no API or contract change (the endpoint already accepted `?cursor`); the keyset
  seek means "Load more" is O(page), not an OFFSET scan.
- Typecheck-verified (operate-web has no vitest suite, like prior console PRs); the workspace build
  + typecheck stay green at 6,765 tests.
- Follow-ups: server-side text search (the quick filter is client-only over loaded rows);
  remembered page size; virtualized rows for very large pages.
