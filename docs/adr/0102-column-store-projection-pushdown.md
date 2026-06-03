# ADR-0102: SQL-level field-projection pushdown in the column store (Phase 3 P1.22)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0101 (field selection), ADR-0090 (column-mapped store), ADR-0096 (keyset pagination), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.22), the efficiency follow-up
> ADR-0101 named.

## Context

ADR-0101 applied `?fields` projection as a pure post-step in the handler — the
store still fetched every column, then the handler narrowed. For the
column-mapped store that means reading large or encrypted (`pgp_sym_decrypt`'d)
columns the caller never asked for. ADR-0101 named SQL-level pushdown as the
efficiency follow-up. This increment pushes the projection into the column
store's `SELECT` so unselected columns are never read or decrypted.

The JSONB store stores the whole record in one `document` column (nothing to
prune) and `get` returns a single row (negligible), so pushdown is column-store
+ list-path only.

## Decision

- **`operate-runtime/store.ts`** — `ListQuery` gains an optional `fields?`
  hint. A store **may** use it to select fewer columns; one that ignores it is
  still correct (the handler applies the exact projection), so in-memory + JSONB
  are unchanged.
- **`operate-runtime/handlers.ts`** — the list handler now threads the parsed
  `?fields` into `ListQuery.fields` (and still re-projects the result records to
  the exact set).
- **`operate-runtime-pg/column-store.ts`**
  - `selectList(plan, only?)` selects `id` + only the named columns when `only`
    is given (encrypted columns still decrypt); all columns otherwise.
  - `listPage` computes `projectionColumns(query, idx)` = the requested fields'
    columns **plus the sort fields' columns** (needed to build the keyset
    cursor), and passes it to `selectList`. The handler then re-projects to the
    exact requested set, so the extra sort columns aren't visible to clients.

## Cross-cutting invariants enforced (by tests)

- **Fewer columns fetched.** `listPage(..., { fields: ["sku"], sort: [price] })`
  emits a SELECT of `id`, `sku`, and `price` (the sort column for the cursor)
  only — `status` / `owner_id` are **not** selected.
- **No projection → select all.** With no `fields`, every domain column is
  selected (unchanged behavior).
- **Cursor still correct.** Sort columns are always selected so `keysetOf` can
  build `nextCursor` even when the sort field isn't in `?fields`; the handler
  drops it from the client response.
- **Composes with everything.** Encrypted columns in the projection still
  decrypt; classification redaction at the edge still narrows further; the exact
  client-visible set is the handler's `projectRecord` output (ADR-0101).

## Alternatives considered

- **Push projection into the JSONB store / `get` too.**
  - **Decision.** No measurable benefit — JSONB is one `document` column,
    `get` is one row. Keep them on the handler-level projection.
- **Drop the handler-level projection once the store pushes down.**
  - **Decision.** No — the store selects sort columns (for the cursor) that the
    client didn't request, and in-memory / JSONB don't push down. The handler's
    `projectRecord` stays the single authority for the exact client-visible set;
    pushdown is a pure efficiency layer beneath it.
- **Make `fields` a required `ListQuery` field.**
  - **Decision.** Optional — a store that doesn't implement pushdown (or a
    caller with no projection) just omits it; the contract stays additive.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,383 tests** (was 6,381;
  +2, 0 new packages/tables). ADR-0101's efficiency follow-up is delivered: the
  column store reads only the columns a projected list needs (plus the cursor's
  sort columns), avoiding large/encrypted-column fetches.
- **The list surface is both feature-complete and efficient** on the typed
  store: keyset pagination + typed filters (P1.16) + projection (P1.21) with
  SQL-level pushdown (P1.22), all from the manifest's `ListView`.
- **No remaining P1 list follow-ups.** Further work (read-path pushdown, JSONB
  key extraction) is unmotivated; the next milestone is P2.
