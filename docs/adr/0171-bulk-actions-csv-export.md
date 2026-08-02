# ADR-0171: Bulk actions — row selection, bulk delete, CSV export

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0166 (server-side search), ADR-0165 (pagination), ADR-0168 (shareable list state), ADR-0077 (Phase 3 P3 renderer) |

## Context

The generic entity list could view / filter / search / page, but every operation was one record at
a time — no way to select many, act on them, or get the data out. Bulk selection + CSV export are
the standard "operational" list affordances a real tenant expects.

## Decision

- **Row selection.** A checkbox column with a header select-all (over the loaded rows) and per-row
  toggles; selected rows are highlighted. Selection is client state keyed by record id.
- **CSV export.** An "Export" button serializes rows to RFC-4180 CSV (CRLF, quote-escaped) over the
  entity's fields and triggers a browser download. When rows are selected it exports **those**;
  otherwise it pages through **every** row matching the current filter/sort/search (bounded at
  10,000) and exports the lot. Crucially the rows come from the list API, which has **already
  applied per-caller redaction** — so a cashier's CSV can't contain the `unit_cost` their table
  hides. No new endpoint, no redaction bypass.
- **Bulk delete.** When the caller has `delete` access and rows are selected, a "Delete N" button
  confirms then deletes each selected record (sequentially, via the existing delete op), clears the
  selection, and reloads — RBAC is enforced per delete by the gateway, unchanged.

## Consequences

- The list is now operational: select a filtered set, export it, or delete it — the three things a
  spreadsheet-trained user reaches for.
- Export is safe by construction: it reuses the redaction-applied JSON rows, so classified fields
  never leak into a file even though CSV bypasses the JSON `transform_response` stage.
- Bulk delete is honest about cost (a confirm with the count) and per-record RBAC-checked; a
  mid-batch failure surfaces the error and stops, leaving the rest for a retry.
- Pure frontend, one file — no API or contract change. Typecheck-verified + Next build green
  (operate-web has no vitest suite, like prior console PRs); workspace stays at 6,795 tests, build
  + typecheck green.
- Follow-ups: a server-side streaming export for very large tables (past the 10k client cap); bulk
  lifecycle transitions; column selection for the export.
