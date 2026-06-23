# ADR-0136: Reference picker for large datasets — filter + on-demand labels

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0134 (reference picker), ADR-0135 (read-mode labels) |

## Context

The reference picker (ADR-0134) and read-mode label cache (ADR-0135) each fetched the
target entity's first 200 records. For entities with more (Accounts, Contacts), two gaps
appeared: the picker couldn't offer a record beyond the first page, and a saved value whose
id fell outside the first page showed as a raw UUID in read mode. This hardens both for
large datasets.

## Decision

**On-demand single-id label resolution (`reference-cache.ts`).** `useReferenceLabel` now,
after the list page loads, falls back to a single `getRecord(slug, id)` when the id isn't
in the cached map — caching the resolved label (or the id itself on not-found, to avoid a
refetch loop) and deduping concurrent lookups per `(slug, id)`. So a reference label
resolves regardless of how far down the list the record sits.

**Searchable picker (`ReferencePicker`).** The fetch cap is raised to 500 and, when a
target has more than 12 options, a filter input appears above the `<select>` that narrows
the options client-side by label; the currently-selected option is always kept visible so
filtering never hides the active value. Still defensive: unresolvable target / failed list
→ raw id input.

## Consequences

- Picking and reading references on large entities works: the filter box makes a
  500-option list navigable, and read-mode labels resolve even for ids past the first page
  (one extra single-record fetch per such id, cached + deduped).
- Bounded cost: the list fetch is one request per entity per session; misses cost one
  `getRecord` each, cached thereafter.
- `operate-web` build green; no package/server change.
- Follow-up: a true server-side typeahead (needs a `contains` list-filter operator in the
  runtime) for entities with thousands of records; a reference-cache bust on mutation.
