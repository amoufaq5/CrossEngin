# ADR-0168: Shareable list state — search / sort / filters in the URL

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0167 (optimistic concurrency), ADR-0166 (server-side search), ADR-0165 ("Load more" pagination) |

## Context

The entity list's search / sort / filter state lived only in React `useState`, so it was lost on
refresh and couldn't be shared or bookmarked — a link to "overdue invoices sorted by due date"
wasn't possible. Completes the list-view UX trio with pagination (ADR-0165) and search (ADR-0166).

## Decision

- **List state ⇄ URL query string.** `readInitialListState(entity)` seeds `q` / `sort` / `filters`
  from the URL on mount, **validated against the entity** (a stale link can't push a
  non-sortable/non-filterable field). A mirror effect writes the current state back with
  `history.replaceState` (replace, not push — no per-keystroke history spam), so the view is
  shareable and survives a refresh.
- **Namespacing.** Search is `?q`, sort is `?sort=&order=`; filters ride under an **`fl_`** prefix
  (`?fl_status=open`) so they never collide with the create-form prefill params, which are raw
  field names (e.g. the "Raise WHT certificate" deep link's `?new=1&invoice_id=…`). The mirror
  effect deletes only the keys it manages, **preserving** any unrelated params.

## Consequences

- A filtered/sorted/searched list is now a shareable URL: copy the address, send it, and the
  recipient lands on the same view. A refresh keeps the state instead of resetting it.
- Deep links stay intact — the create-prefill flow (`?new=1` + raw field params) is untouched
  because filters are namespaced and unrelated params are preserved.
- Pure frontend, one file: no API or contract change. The URL is the source of truth on load;
  React state drives it thereafter.
- Typecheck-verified + Next build green (operate-web has no vitest suite, like prior console PRs);
  workspace stays at 6,778 tests, build + typecheck green.
- Follow-ups: encode the active page/cursor for exact-position deep links; a "copy link" affordance;
  remembered per-user default views.
