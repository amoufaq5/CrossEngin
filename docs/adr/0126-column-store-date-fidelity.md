# ADR-0126: column-store DATE / TIMESTAMPTZ read fidelity (Phase 3 P1.28)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-04 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0125 (NUMERIC fidelity), ADR-0090 (column-mapped store), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P1 (serving-stack) hardening increment (P1.28), the
> deferred sibling of P1.27.

## Context

P1.27 (ADR-0125) coerced `NUMERIC` back to a number on read but explicitly
deferred dates. node-postgres returns a `DATE` and a `TIMESTAMPTZ` column as a
JS `Date` object, while the in-memory and JSONB stores round-trip the **string**
that was written (a manifest `date` field is `"1990-01-01"`, a `datetime` is an
ISO 8601 string). So a record read through the `ColumnMappedEntityStore` carried
`Date` objects where the other two bindings carried strings — the remaining
cross-store parity gap.

## Decision

- **`coerceColumnValue` now normalizes `Date` values** (extending P1.27):
  - `TIMESTAMPTZ` / `TIMESTAMP` → `value.toISOString()` — a canonical ISO 8601
    string, timezone-independent (the value is an instant).
  - `DATE` → `YYYY-MM-DD` built from the value's **local** Y/M/D getters.
    node-postgres parses a `DATE` into a `Date` at *local midnight* from the
    wire's local components, so the local getters reproduce the original wire
    date regardless of the process timezone (avoiding the classic `toISOString`
    off-by-one-day trap).

`TIME` is already a string from the driver; `INTERVAL` (a `duration` field, rare)
is left as the driver's object — a separate normalization if it ever matters.
System columns (`created_at` / `updated_at`) are not in the entity plan, so they
never reach `rowToRecord`.

## Cross-cutting invariants enforced (by tests)

- **Offline.** `get` on a row with `dob = new Date(1990,0,1)` and `seen_at =
  new Date("2026-06-04T12:00:00Z")` returns `dob: "1990-01-01"` and
  `seen_at: "2026-06-04T12:00:00.000Z"` (strings, not `Date`s).
- **Real-PG (gated).** A healthcare `Patient` created with `date_of_birth:
  "1990-01-01"` reads back as the string `"1990-01-01"` from the typed `DATE`
  column — proving the local-getter round-trip in the actual environment.

## Alternatives considered

- **A global node-postgres DATE/TIMESTAMPTZ type parser.**
  - **Decision.** No — same reasoning as P1.27: a process-wide parser would
    change every consumer's date handling. Coercing in the store's own
    `rowToRecord`, keyed on the column's `sqlType`, is local and explicit.
- **`toISOString().slice(0,10)` for DATE.**
  - **Decision.** No — that uses UTC and, on a `Date` built at *local* midnight,
    shifts the day in negative-offset timezones. Local Y/M/D getters reproduce
    the wire date faithfully.
- **`col::text` in the SELECT to get strings from Postgres directly.**
  - **Decision.** No — `TIMESTAMPTZ::text` yields `2026-06-04 12:00:00+00` (not
    ISO-`T` form), so it wouldn't match the written ISO string; and it would
    complicate the generated SELECT. Coercing the driver's `Date` is simpler and
    canonical.

## Consequences

- **60 packages + 3 apps, 124 meta-schema tables, 6,528 offline tests + 24 gated
  real-Postgres integration tests** (+1 offline; 0 new tables/columns/packages).
  With P1.27 (numbers) + P1.28 (dates), the column store now round-trips
  `decimal`, `date`, and `datetime` fields with the **same JS types** as the
  in-memory and JSONB stores — a record is store-binding-independent.
- **Cross-store record parity is complete for the common scalar types**; only
  `duration`/`INTERVAL` (rare) remains a driver-shaped object, a deferred edge.
