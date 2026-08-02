# ADR-0166: Server-side free-text search (`?q`) in the entity list

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0165 ("Load more" pagination), ADR-0144 (accent-insensitive trigram search), ADR-0143 (contains filter), ADR-0096 (keyset pagination), ADR-0088 (list config) |

## Context

The console's quick-search filtered the *loaded* rows client-side (over `listColumns`) — so with
pagination (ADR-0165) it only saw the current page, never the whole table. The serving stack
already had an accent-insensitive `contains` operator per field (ADR-0143/0144); what was missing
was a single **cross-field** `?q` that searches the whole dataset server-side. Natural companion
to the pagination just shipped.

## Decision

- **`?q=<term>` on the list endpoint.** A new `ListQuery.search = {term, fields}` — a match when
  `term` is a substring of **any** listed field (an OR group), AND-ed with the typed `filters`.
  `applyListQuery` (in-memory) applies it via `matchesSearch`; the shared `list-sql` builder emits
  an OR of the same accent-insensitive `unaccent(...) ILIKE` used by `contains`, binding the term
  **once** and reusing the placeholder across every column (unresolved/encrypted columns skipped).
- **Searchable set derived from the manifest.** `ListConfig.searchableFields` = the entity's
  text-like fields (`text`/`long_text`/`email`/…), narrowed to the list view's visible columns
  when a view exists. `parseListQuery` builds `search` from `?q` only when the entity has
  searchable fields — so an arbitrary `?q` can't widen results. `searchableFields` is exposed on
  the UI schema so the console knows search is server-side.
- **Console.** The search box debounces (250 ms) into a `?q` request when the entity is searchable
  (rows come back already filtered across the whole table, page by page); for a non-searchable
  entity it falls back to the prior client-side filter over loaded rows. Changing `q` resets
  pagination (a fresh cursor sequence over the filtered set).

## Consequences

- Search now spans the **entire** entity, not just the loaded page — the pagination + search story
  is coherent: type a term, page through all matches.
- Reuses the existing `contains` SQL (a plain-column `pg_trgm` GIN index still accelerates it); the
  OR group binds one value, so it's a single parameter regardless of column count.
- Fail-safe: unknown/non-searchable `?q` is ignored (never widens results); encrypted columns are
  skipped (can't ILIKE ciphertext).
- 6,775 tests pass (+10: `parseListQuery` ?q on/off/blank/not-a-filter, `listConfig`
  searchableFields, `applyListQuery` OR-search + AND-with-filters, `list-sql` OR group +
  skip-unknown, ui-schema searchable-are-text). Full build + typecheck green; console
  typecheck-verified.
- Follow-ups: ranked results / relevance ordering; a dedicated FTS (`tsvector`) index for very
  large tables; search across reference labels.
