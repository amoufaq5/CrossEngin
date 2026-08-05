# ADR-0209: Association "load more" pagination (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0208 (association count badges + capped preview), ADR-0201 (m2m read), ADR-0080 (renderer), ADR-0077 (P3) |

## Context

ADR-0208 capped the association read at `?limit` and showed the true total via the count route, but the
capped rows beyond the first page were simply unreachable in the UI — the panel showed "Showing N of M"
with no way to see the rest. This adds cursor pagination so the panel can "load more".

## Decision

- **The association read handler paginates** (`operate-runtime`, `association.ts`). Alongside `?limit`
  (ADR-0208) it now reads `?cursor` — a zero-based offset into the owner's link list (a bad/forged
  cursor resets to 0, never errors). It slices `[offset, offset+limit]` of the linked ids, and returns
  `{data, page:{limit, nextCursor}}` where `nextCursor` is `String(offset+limit)` when more links remain
  and `null` on the last page — mirroring the entity-list endpoint's page envelope.
- **The renderer loads more** (`operate-web`). `AssociatedRecords` keeps the count-route badge for the
  true total (ADR-0208) and now tracks a `cursor`; a **Load more** button (shown while `nextCursor !==
  null`) appends the next page's rows and advances the cursor. `listAssociations` returns
  `{data, nextCursor}` and takes `{limit, cursor}`.

## Consequences

- Every associated record is now reachable from the panel — the capped preview grows on demand instead
  of hiding the tail. The count badge (exact total) and the paged list (bounded fetch) compose: the user
  sees "Showing N of M" and clicks to raise N.
- The offset cursor is simple and correct for this read (the link list is small and fetched whole by
  `listLinks`); it is opaque to the client (a `String` token), so it can later become a keyset cursor
  without an API change if link volumes grow.
- 7,086 tests pass (+1: the handler advertises `nextCursor` when more links remain and clears it on the
  last page, advancing past `?cursor`). `operate-web` verified by strict `tsc`. Full build + typecheck
  green.
- Follow-up: a keyset cursor over `listLinks` (instead of an in-memory offset slice) if a single owner's
  link count ever gets large enough that fetching all links per page matters.
