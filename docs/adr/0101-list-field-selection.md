# ADR-0101: field selection (projection) on list + read (Phase 3 P1.21)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-03 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0096 (keyset pagination + typed filters), ADR-0088 (list pagination), ADR-0068 (gateway redaction), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 follow-on increment (P1.21), the field-selection
> follow-up ADR-0096 named.

## Context

ADR-0096 completed pagination + filtering and named **field selection
(projection)** as the open list refinement. Without it, every list/read returns
the full record; a caller that only needs a few columns over-fetches. This
increment adds `?fields=a,b,c` projection to both the list and single-read
endpoints.

The key safety property: projection only **narrows** the response — it can never
widen access, because the gateway's classification redaction runs at the edge
*after* the handler returns. A caller that projects a classified field still has
it dropped by redaction. So projection needs no access gating.

## Decision

- **`operate-runtime/store.ts`** — `projectRecord(record, fields)` returns `id`
  + the requested fields (always keeps `id`; an absent field is omitted). Pure;
  store-agnostic.
- **`operate-runtime/list-query.ts`** — `parseFields(query)` reads `?fields=a,b,c`
  (comma-split, trimmed, deduped) → a field list or null (no projection);
  `fields` is added to the reserved params so it's never treated as a filter.
- **`operate-runtime/handlers.ts`** — the `list` handler projects each record
  when `?fields` is present; the `read` handler projects the single record. The
  handlers return the projected records; the gateway's `transform_response`
  redaction still drops classified fields per-caller afterwards.

## Cross-cutting invariants enforced (by tests)

- **Projection narrows, redaction still applies.** A manager
  `GET /v1/products?fields=sku,unit_cost` gets `{id, sku, unit_cost}`; a cashier
  with the **same** projection gets `{id, sku}` — `unit_cost` is dropped by
  classification redaction at the edge, not by projection. Projection can't be
  used to bypass redaction.
- **`id` is always present.** `projectRecord` keeps `id` even if not requested,
  so records stay identifiable; unknown requested fields are ignored.
- **Read projection.** `GET /v1/products/{id}?fields=name` → `{id, name}`.
- **`fields` is reserved.** `?fields=…` is never parsed as an equality filter;
  `parseFields` dedupes + drops blanks and returns null when absent/empty.

## Alternatives considered

- **Gate projectable fields to the ListView columns.**
  - **Decision.** Unnecessary — projection only narrows and redaction is
    authoritative at the edge, so projecting an arbitrary (even classified) field
    can't leak it. Gating would add config without a security benefit.
- **Push projection into the store's SELECT (column store) / JSONB extraction.**
  - **Decision.** Applied as a pure post-step in the handler so it's uniform
    across the in-memory, JSONB, and column stores and needs no per-store SQL.
    SQL-level projection (select only requested columns) is an efficiency
    refinement behind the same `?fields` contract.
- **A sparse-fieldset syntax (`fields[entity]=…`, JSON:API style).**
  - **Decision.** A flat `?fields=a,b,c` matches the single-entity endpoints
    here; a typed/nested sparse-fieldset is over-scoped for now.
- **Project before redaction in one pass.**
  - **Decision.** No — keep the two concerns separate: the handler projects
    (narrowing), the gateway redacts (classification). Composing them in order
    (project → redact) is correct and keeps redaction the single authority.

## Consequences

- **59 packages + 2 apps, 123 meta-schema tables, 6,381 tests** (was 6,374;
  +7, 0 new packages/tables). ADR-0096's open list refinement is delivered:
  list + read support `?fields` projection, composing safely with classification
  redaction.
- **The P1 list surface is feature-complete.** Keyset pagination + typed filters
  (P1.16) + field selection (P1.21), all from the manifest's `ListView`, across
  every store.
- **SQL-level projection pushdown** is **delivered in ADR-0102 (P1.22)** — the
  column store selects only the projected (+ sort) columns.
