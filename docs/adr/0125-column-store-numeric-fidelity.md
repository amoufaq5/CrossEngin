# ADR-0125: column-store NUMERIC read fidelity (Phase 3 P1.27)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0090 (column-mapped store), ADR-0119 (column-store integration test), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 (serving-stack) hardening increment (P1.27).

## Context

The P1.24 real-Postgres integration test (ADR-0119) surfaced a type-fidelity
gap: node-postgres returns a `NUMERIC` column as a **string** (to avoid float
precision loss), so a manifest `decimal` field read back through the
`ColumnMappedEntityStore` came out as `"3.00"` instead of the number `3` the
in-memory and JSONB stores round-trip. The test had to wrap assertions in
`Number(...)`; a caller would see a string where the contract implies a number.

## Decision

- **`ColumnMappedEntityStore` — `rowToRecord` coerces on read.** A new
  `coerceColumnValue(mapping, value)` converts a `NUMERIC(...)`-typed column's
  **string** value back to a JS `number` (`Number(v)` when finite, else the raw
  string untouched). All read paths (`get` / `listPage` / `update`'s RETURNING)
  funnel through `rowToRecord`, so the coercion is uniform.

Only `NUMERIC` needs this: the driver already parses `INTEGER` → number,
`BOOLEAN` → boolean, `TIMESTAMPTZ` → Date. `BIGINT` isn't emitted by any field
type (`integer` → `INTEGER`), so no precision-losing coercion is introduced. A
`decimal(p, s)` with `p ≤ 15` fits a JS number exactly — matching what the
other two stores hold.

## Cross-cutting invariants enforced (by tests)

- **Offline.** `get` on a row whose `price` column is the string `"9.50"`
  returns `price: 9.5` as a `number`.
- **Real-PG (gated, tightened).** The P1.24 integration assertions dropped their
  `Number(...)` workarounds — `unit_price` reads back as the number `3`, and a
  keyset page maps to `[1, 2]` / `[3]` directly.

## Alternatives considered

- **Register a global node-postgres type parser for NUMERIC.**
  - **Decision.** No — that's a process-wide side effect that would change every
    consumer's NUMERIC handling (including the JSONB store's `document` and other
    callers). Coercing in the column store's own `rowToRecord`, driven by the
    column's `sqlType`, is local and explicit.
- **Coerce by the field's logical kind (add `kind` to `ColumnMapping`).**
  - **Decision.** Not needed — the existing `sqlType` string (`NUMERIC(p,s)`)
    already identifies the columns the driver returns as strings; keying on it
    avoids widening the mapping shape.
- **Also coerce DATE/TIMESTAMPTZ to ISO strings for cross-store parity.**
  - **Decision.** Deferred — the driver returns `Date` objects, which are usable
    (and arguably better than strings); aligning date representations across all
    three stores is a separate, debatable normalization, not the surfaced bug.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,527 offline tests + 24 gated
  real-Postgres integration tests** (+1 offline; 0 new tables/columns/packages).
  The column store now round-trips `decimal` fields as numbers, matching the
  in-memory and JSONB stores — a record read through any of the three
  `EntityStore` bindings has the same shape.
- **Cross-store record parity is tighter** — a numeric field no longer changes
  JS type depending on which store served it.
