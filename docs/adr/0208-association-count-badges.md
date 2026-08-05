# ADR-0208: Association count badges + capped preview (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-14 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0204 (association count route), ADR-0202 (association write UI), ADR-0201 (m2m read), ADR-0080 (renderer), ADR-0077 (P3) |

## Context

ADR-0204 added a `GET /v1/<owner>/{id}/<related>/count` route but nothing consumed it — the renderer's
association panel derived its badge from `rows.length`, which was only correct because the read handler
returned *every* linked record in an unbounded `Promise.all` of `get`s. That fan-out is a latency/scale
hazard, and the badge would understate the total the moment the list were capped. This wires the count
route into the UI and caps the read, so the two work together: preview a page, show the true total.

## Decision

- **The association read handler honors `?limit`** (`operate-runtime`, `association.ts`). It parses a
  `?limit` (clamped to `MAX_PAGE_SIZE`, default `DEFAULT_PAGE_SIZE` — the entity-list conventions) and
  slices the related ids before fetching, bounding the `get` fan-out. A caller that wants the exact size
  uses the sibling `…/count` route (unbounded), not this list.
- **The renderer previews + counts** (`operate-web`). `AssociatedRecords` now fetches the first page
  (`listAssociations(…, PREVIEW=8)`) and the true total (`countAssociation` → the ADR-0204 route)
  concurrently. The **count badge shows the true total**, not the loaded row count; when the preview is
  capped it renders "Showing N of M". The empty-panel decision keys off the total. `linkAssociation` /
  `unlinkAssociation` keep the badge honest — unlink optimistically decrements the total (restoring it
  on server rejection), link reloads.
- **New API client** (`api.ts`): `countAssociation(ownerSlug, id, relatedSlug)` hits the count route;
  `listAssociations` gains an optional `limit`.

## Consequences

- The ADR-0204 count route is now consumed end-to-end (client → proxy → operate-server count route →
  `countLinks`), and the panel badge is authoritative regardless of how many rows are previewed — so it
  stays correct under the capped read (and any future in-panel pagination).
- The unbounded association-record fan-out is gone: a record with thousands of links no longer triggers
  thousands of `get`s to render a panel; it fetches a page and one count.
- The two association routes now have clear, non-overlapping roles: the list route previews records
  (bounded), the count route reports size (exact). The renderer uses both.
- 7,085 tests pass (+1: the association list handler caps fetched records at `?limit`). `operate-web`
  verified by strict `tsc` (no unit harness). Full build + typecheck green.
- Follow-ups: in-panel "load more" pagination over the capped list (cursor); entity list-view per-row
  relation counts (chattier — deferred pending a batch-count endpoint).
