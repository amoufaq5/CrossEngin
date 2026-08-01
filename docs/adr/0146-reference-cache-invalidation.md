# ADR-0146: Reference-label cache invalidation on mutation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0135 (read-mode labels), ADR-0136 (reference cache) |

## Context

The session-shared reference-label cache (ADR-0135) fetches a target entity's `id → label`
map once and never refetches, so after creating or renaming a record its label stayed stale
until a full page reload. Delivered in the four-agent polish batch.

## Decision

- **`invalidateReferenceCache(slug?)` (`reference-cache.ts`).** With a `slug`, drops that
  entity's `caches` / `inflight` entries and every `oneInflight` key prefixed `slug:`; with no
  argument, clears all three maps. Existing exports untouched.
- **Call sites.** The entity pages invalidate the mutated entity's cache after a successful
  write: the list page after `createRecord`; the detail page after `updateRecord` (only when
  a patch was sent), `deleteRecord`, and `runTransition`.

## Consequences

- Creating, renaming, or deleting a record refreshes its label everywhere it's referenced on
  the next render — no full reload needed.
- `operate-web` builds green (no test framework there; verified by build + review).
- Follow-up: a finer-grained single-record invalidation (`slug, id`) if whole-entity
  invalidation proves too coarse on very large lists.
