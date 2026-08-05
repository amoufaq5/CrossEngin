# ADR-0210: List-view column chooser + per-column filters (Phase 3 P3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0196 (list filtering), ADR-0080 (renderer), ADR-0102 (SQL projection), ADR-0077 (P3) |

## Context

The entity list view rendered a fixed column set (`entity.listColumns`) with only a small preset filter
shortcut. The serving API already supports far more — `?<field>=<value>` filters gated to filterable
columns, `?sort`/`?order`, and `?fields=` projection — but the renderer surfaced almost none of it. This
adds a column chooser and per-column filter inputs so a user can shape the list to their task, and
pushes the chosen columns into the query as a projection.

## Decision

- **Column chooser** (`operate-web`, new `components/ColumnChooser.tsx`). A "Columns (N)" toolbar button
  opens a click-outside popover of checkboxes over *every* field on the entity (not just the defaults).
  Headers keep schema field order regardless of check order; the last visible column can't be unchecked
  (the table never collapses). A "Reset" restores `entity.listColumns`. The choice persists in
  `localStorage` keyed `operate-web:columns:<slug>` (guarded by `typeof window`), and stored names that
  no longer exist on the entity are dropped on load (schema-drift safe).
- **Per-column filter inputs** (list `page.tsx`). A compact filter row under the header shows an input
  (a select for enum/`select` fields) beneath each *visible, filterable* column; non-filterable columns
  get a blank cell, and the row only appears when at least one visible column is filterable (no dead
  inputs). Typing feeds the existing `filters` state → `?<field>=<value>` on the list query, replacing
  the page (filters reset to the first page). It composes with the existing `?fl_*` "View all"
  deep-links — a field arriving pre-filtered is unioned into the visible columns and its input
  pre-filled.
- **Server projection.** The list query now sends `?fields=` narrowed to the visible columns — always
  including `id` (rows stay navigable) and the entity's state field (bulk-transition eligibility stays
  computable). CSV export uses a separate un-projected query, so it still exports every field.

## Consequences

- The list view now exposes the serving API's filter + projection capability the schema already
  described: users pick columns and filter per column, and the query only fetches the columns shown
  (`?fields=` pushes projection to SQL on the column store, ADR-0102).
- Persistence is per-browser (`localStorage`), not per-tenant/server — a deliberate keep-it-simple
  choice; a saved-views feature (server-persisted column sets) is the natural follow-up.
- `operate-web` has no unit-test harness; verified by strict `next build` type-check (the established
  renderer gate). Full workspace build + typecheck + test green (no server test count change — this is a
  renderer-only change over already-supported endpoints).
- Follow-ups: server-persisted saved views; operator-side per-column operator pickers (the API supports
  `[op]` beyond equality); sortable-column affordances in the same header row.
