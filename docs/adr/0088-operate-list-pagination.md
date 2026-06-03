# ADR-0088: list pagination + filtering from the ListView (Phase 3 P1.8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0078 (operate-runtime serving), ADR-0086 (operate-runtime-pg), ADR-0087 (operate-server), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is the final P1 follow-on increment (P1.8), taking the next
> free number after ADR-0087.

## Context

The P1 list endpoint returned the **entire** collection in one response —
ADR-0078's open question **Q5**, the last unresolved P1 item. A real list needs
bounded pages, a stable cursor, sorting, and filtering. Critically, those
defaults shouldn't be invented per endpoint: the manifest already declares a
`ListView` per entity with a `pageSize`, a default `sort`, and per-column
`sortable` / `filterable` flags. The list endpoint should be driven by that
view, the same way routes, RBAC, and redaction are driven by the manifest.

## Decision

A `ListQuery` → `ListPage` over the `EntityStore`, derived from the `ListView`.

- **`operate-runtime/store.ts`** — the store contract gains
  `listPage(tenantId, entity, query: ListQuery): Promise<ListPage>` alongside the
  existing `list`. `ListQuery = { limit, cursor, sort[], filters[] }`;
  `ListPage = { records, nextCursor }`. Cursors are **opaque offset tokens**
  (`encodeCursor`/`decodeCursor`, base64url; a malformed cursor reads as 0). A
  pure `applyListQuery(records, query)` does filter → sort → offset-slice and is
  shared by the in-memory store.
- **`operate-runtime/list-query.ts`** — `listConfigForEntity(manifest, entity)`
  reads the first `ListView` targeting the entity into a `ListConfig`
  (`defaultLimit` = the view's `pageSize`, `defaultSort` = the view's `sort`,
  `sortableFields` / `filterableFields` = the non-hidden columns flagged
  sortable / filterable). `parseListQuery(query, config)` turns a request query
  into a resolved `ListQuery`: `?limit` (clamped to `MAX_PAGE_SIZE = 500`),
  `?cursor`, `?sort=<field>&order=asc|desc` (**only** when the field is
  sortable, else the view's default), and equality filters on any non-reserved
  param whose key is a **filterable** column. Unknown / non-filterable params
  are ignored — an arbitrary query can't widen the result set.
- **`operate-runtime/operations.ts`** — the `list` `RouteSpec` carries its
  `ListConfig` (computed via `listConfigForEntity` in `manifestRouteSpecs`), so
  the handler has the view-derived defaults without re-reading the manifest.
- **`operate-runtime/handlers.ts`** — the `list` case now
  `parseListQuery(request.query, spec.listConfig)` →
  `store.listPage(...)` and returns `{ data: page.records, page: { limit,
  nextCursor } }`. The redaction stage still walks the `data` array unchanged.
- **`operate-runtime-pg/entity-store.ts`** — `PostgresEntityStore.listPage`
  **pushes the query into SQL**: `document ->> '<field>' = $n` equality filters,
  `ORDER BY document ->> '<field>' ASC|DESC, record_id ASC`, `LIMIT limit+1
  OFFSET offset`. Field names are validated against `^[A-Za-z_][A-Za-z0-9_]*$`
  (only the value is bound; the JSONB key is interpolated, so a non-identifier
  field is dropped, never executed). Fetching `limit+1` rows detects whether a
  next page exists → `nextCursor`.

## Cross-cutting invariants enforced (by tests)

- **The page is the ListView.** A `GET /v1/products?limit=2` returns 2 rows
  sorted by the view's default (`name` asc) with a non-null `nextCursor`;
  following the cursor returns the remainder with `nextCursor: null` — end to end
  through the real gateway and over raw HTTP in `operate-server`.
- **Filtering is column-scoped.** `?status=active` filters because `status` is a
  filterable column; `?bogus=x` is ignored. A sort on a non-sortable field falls
  back to the view default. Fail-safe: arbitrary params never widen results.
- **SQL pushdown, injection-safe.** The Postgres store emits `ORDER BY` / `LIMIT
  $n OFFSET $n` / `document ->> 'field' = $n`; a field that isn't a safe
  identifier is dropped (a `name; DROP` sort / `x'; DELETE` filter never reach
  the SQL, asserted by test), values are always bound.
- **Opaque, robust cursors.** `encodeCursor`/`decodeCursor` round-trip; a
  garbage cursor degrades to the first page rather than erroring.
- **Backward compatible.** `list` is unchanged; the list response gains a `page`
  sibling to `data`, so existing readers and the redaction wrapper keep working.

## Alternatives considered

- **Keyset (seek) pagination instead of offset.**
  - **Decision.** Offset first; **keyset delivered in ADR-0096 (P1.16)** behind
    the same opaque-cursor contract (the token was already opaque, so the
    encoding changed without an API break).
- **Typed/operator filters (`gte`, `in`, ranges).**
  - **Decision.** Equality-only first cut; **typed operators delivered in
    ADR-0096 (P1.16)** on the same `ListFilter` shape (`op?`), gated by the same
    `ListView` filterable-column flags.
- **Sort/order via the SQL JSONB text cast vs typed columns.**
  - **Decision.** `document ->> 'field'` (text ordering) for the JSONB store —
    correct for strings, lexicographic for numbers. The column-mapped store
    (ADR-0086's deferred follow-up) gets typed ordering for free; documented as a
    known first-cut limitation.
- **Hand a full `ListView` to the handler.**
  - **Decision.** No — distill it to a minimal `ListConfig` at compile time
    (`listConfigForEntity`), keeping the runtime off the `views`/`@crossengin/
    views` types and the handler dependency-light.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,274 tests** (was 6,254; +20,
  0 new packages/tables). **ADR-0078 Q5 is resolved — every P1 open question is
  now closed.** The P1 arc (compile → gateway gaps → Postgres store → runnable
  server → paginated lists) is complete.
- **The list endpoint scales.** Bounded pages + a stable cursor + view-driven
  sort/filter, pushed into SQL by the Postgres store, derived entirely from the
  manifest's `ListView`.
- **Phase 3 can move to P2.** With P1 closed, the next milestone is distributed
  workers (ADR-0080-adjacent) over the workflow event log; keyset pagination,
  typed filters, and the column-mapped store are refinements behind settled
  contracts.
