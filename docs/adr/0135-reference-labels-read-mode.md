# ADR-0135: Reference labels in read mode

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0134 (console reference picker) |

## Context

ADR-0134 made reference fields *editable* by label (a picker), but read mode still showed
the raw id: list cells and detail values rendered a reference as a `/e/<slug>/<id>` link
whose text was the UUID. So a saved value looked like `9b1f…` even though you picked
"VAT20". This resolves the label everywhere a reference is displayed.

## Decision

**Session-shared label cache (`lib/reference-cache.ts`).** `useReferenceLabel(schema,
target, id)` resolves a reference value to its target record's `recordLabel`, lazily
loading the target entity's records (up to 200) and caching the resolved `id → label` map
per slug in module state — so a referenced entity is fetched **at most once per session**
regardless of how many cells/fields reference it. While loading or when unresolved it
returns the raw id (a reference always renders something). A failed list is cached as empty
to avoid refetch loops.

**`ReferenceLabel` component** wraps the hook and is dropped inside the existing reference
links in the list `Cell` and the detail `ReadValue`, replacing the bare `String(value)`.
The link target (`/e/<slug>/<id>`) is unchanged — only the visible text becomes the label.

## Consequences

- A saved `tax_code_id` now reads "VAT20", an `account_id` reads the account name, etc.,
  in both the list and the detail view — matching what the picker showed when setting it.
- One fetch per referenced entity per session (cached + deduped via an in-flight promise),
  so a 50-row list referencing the same target issues a single extra request.
- Stale after an out-of-band rename of a referenced record until the next full load —
  acceptable for a console; a cache-bust on mutation is a future refinement.
- `operate-web` build green; no package/server change.
- Follow-up: a typeahead picker + paged label resolution for entities with >200 records.
