# ADR-0143: `contains` list-filter operator + server-side reference typeahead

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0096 (keyset pagination + typed operators), ADR-0134/0136 (reference picker) |

## Context

The reference picker (ADR-0134/0136) fetched the target entity's first page and filtered
client-side, so it couldn't reach records past the cap on large entities (Accounts,
Contacts). The list-filter operators (ADR-0096: `eq|ne|gt|gte|lt|lte|in`) had no substring
match, so there was no way to search server-side. This adds a `contains` operator across the
stack and wires the picker to it.

## Decision

**`contains` operator (runtime + both PG stores).** Added to `FILTER_OPS`. The in-memory
`matchesFilter` does a case-insensitive substring (`String(rv).toLowerCase().includes(…)`);
the shared `list-sql` builder emits `<expr>::text ILIKE ('%' || $n || '%')` — the value is
**bound** (never interpolated); `%`/`_` in the query act as wildcards, which is fine for a
search box. Serves the JSONB and column stores identically via the existing `ListSqlAdapter`.

**Parsing.** `parseListQuery`'s filter-key regex accepts `?field[contains]=value`, still
gated to `filterableFields` (an unknown/non-filterable field is ignored — can't widen
results).

**Server-side typeahead (`ReferencePicker`).** `searchFieldFor` picks a filterable
label-ish field (name/title/code/`*_number`/email, else the first filterable text field). If
one exists, typing runs a debounced (250 ms) `?<field>[contains]=<q>&limit=50` search and
shows the results; otherwise the picker keeps the client-side filter over the loaded page.
The selected option is always kept visible.

## Consequences

- Reference pickers scale to large entities: a Contacts field searches server-side by name
  as you type instead of being limited to the first page.
- The `contains` operator is a general runtime capability — any list endpoint / inbox /
  report can now do substring search on a filterable field.
- Injection-safe: the search value is a bound parameter in every store; only the (validated)
  column expression is interpolated.
- 6,600 tests pass (+6: in-memory contains match, parse of `[contains]` + non-filterable
  rejection, `list-sql` ILIKE predicate + unknown-column drop), zero type errors, full build
  green, `operate-web` compiles.
- Follow-up: an accent-insensitive / trigram-indexed search for very large tables; escaping
  `%`/`_` when a literal match is wanted.
