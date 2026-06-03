# ADR-0096: keyset pagination + typed filter operators (Phase 3 P1.16)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0088 (list pagination), ADR-0086/0090 (entity stores), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.16).

## Context

ADR-0088 shipped list pagination with **offset cursors** and **equality-only**
filters, naming keyset pagination + richer operators as the refinement. Offset
pagination drifts when rows are inserted/deleted between pages (rows repeat or
are skipped) and scans+discards `OFFSET` rows; equality-only filtering can't
express ranges (`price >= 10`) or membership (`status in [...]`). This increment
upgrades both — across the in-memory, JSONB, and column stores — behind the
existing `ListQuery` contract.

## Decision

- **`operate-runtime/store.ts`**
  - `ListFilter` gains an optional `op` (`eq | ne | gt | gte | lt | lte | in`,
    default `eq`); `value` is `string | readonly string[]` (`in` takes a list).
    `matchesFilter` evaluates one filter (numeric coercion when the record value
    is numeric), shared by the in-memory path.
  - The cursor is now a **keyset** position: `encodeKeyset` / `decodeKeyset` over
    `{ k: sortValues[], id }` (opaque base64url JSON; malformed → null → first
    page). `keysetOf(record, sort)` builds the next page's cursor from the last
    row. `applyListQuery` filters → sorts (sort fields + `id` tiebreaker) →
    **seeks** past the cursor (no offset).
  - The legacy offset `encodeCursor`/`decodeCursor` stay (deprecated) for
    compatibility.
- **`operate-runtime-pg/list-sql.ts`** (new) — one query builder for both PG
  stores via a `ListSqlAdapter` (`columnExpr(field)` → SQL expression or `null`
  to drop; `castSuffix(field)` → a typed cast for the bound value; `idExpr`):
  - **filters** → `<expr> <op> $n<cast>` for comparisons, `<expr>::text =
    ANY($n::text[])` for `in`;
  - **keyset seek** → the standard OR-of-AND expansion
    `(s1 ▸ c1) OR (s1 = c1 AND s2 ▸ c2) OR … OR (all = AND id > cid)`, handling
    mixed sort directions;
  - **order** → the sort fields + `id` tiebreaker. The caller appends `LIMIT
    n+1` (next-page detection) — **no `OFFSET`**.
- **The JSONB store** passes an adapter of `document ->> 'field'` (text
  compares, identifier-validated); **the column store** passes `"col"` with a
  `::<sqlType>` cast (typed compares; encrypted/unknown columns drop). Both build
  `nextCursor` via `keysetOf` over the last mapped record.
- **`operate-runtime/list-query.ts`** — `parseListQuery` now reads
  `?field[op]=value` (e.g. `?price[gte]=10`) and `?field[in]=a,b,c`
  (comma-split), still gated to filterable columns; a plain `?field=value` stays
  `eq`.

## Cross-cutting invariants enforced (by tests)

- **Stable pages.** A keyset cursor doesn't repeat or skip rows when an earlier
  row is inserted between pages (asserted in-memory); the SQL stores emit a seek
  predicate + `LIMIT n+1`, no `OFFSET`.
- **Typed comparisons, injection-safe.** The column store emits `"price" >=
  $n::NUMERIC(12, 2)` (value cast to the column type) and `"status"::text =
  ANY($n::text[])` for `in` — only values bound. The JSONB store text-compares
  (consistent with its text sort).
- **Operators end-to-end.** `matchesFilter` covers eq/ne/gt/gte/lt/lte/in with
  numeric coercion; `parseListQuery` maps `field[op]` / `field[in]=a,b,c` to
  `ListFilter`s on filterable columns only (an operator on a non-filterable
  field is dropped).
- **Mixed-direction seek.** The OR-of-AND expansion uses `<` for a `DESC` sort
  key and `>` for `ASC`, with the `id` tiebreaker always ascending.

## Alternatives considered

- **Keep offset cursors.**
  - **Decision.** No — offset drifts under concurrent writes and scans
    `OFFSET` rows; keyset is stable and index-friendly. The cursor was already
    opaque, so the encoding change is invisible to callers.
- **Row-value comparison `(a, b) > ($1, $2)` for the seek.**
  - **Decision.** No — Postgres row-value comparison requires all columns to
    share one direction; the OR-of-AND expansion handles per-key directions
    (a `DESC` then `ASC` sort), which real `ListView`s use.
- **Operator-per-type filter values (numeric/date params).**
  - **Decision.** The column store casts the bound *value* to the column's
    `sqlType` (`$n::NUMERIC(…)`), which gives correct typed comparison without
    the query layer knowing types; the JSONB store stays text (documented). `in`
    compares as text membership.
- **A new filter-DSL query param syntax.**
  - **Decision.** `field[op]=value` is conventional, URL-safe, and brackets
    can't appear in snake_case field names, so it's unambiguous.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,344 tests** (was 6,333;
  +11, 0 new packages/tables). ADR-0088's refinement is delivered: list
  pagination is **keyset** (stable, no offset scan) and filters are **typed**
  (range + membership), uniformly across all three stores from one query builder.
- **The serving list endpoint scales correctly.** A client pages with a stable
  cursor and filters with `?price[gte]=…&status[in]=a,b` — pushed into SQL by
  both PG stores, derived from the manifest's `ListView`.
- **Field selection (projection) remains the open list refinement**, behind the
  same `ListQuery`/`ListConfig` seams.
