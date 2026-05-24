# Retention CLI Operator Guide

> Reference for `crossengin retention <action>` — the per-tenant data-
> retention management surface. Covers all 15 actions, the full filter
> family, output formats, query inspection, and the analytics `summary`
> surface.

All retention actions require PostgreSQL environment variables
(`PGHOST`/`PGDATABASE`/etc.) since they read/write the
`meta.tenant_retention_opt_out_history` audit log + the
`meta.tenant_retention_policies` table.

---

## Concepts

- **Platform default** — the baseline retention policy for a table
  (`meta.retention_policies`).
- **Per-tenant override** — a tenant-specific policy
  (`meta.tenant_retention_policies`) that overrides the platform default.
- **Opt-out** — a per-tenant flag (`opt_out=true`) suppressing pruning
  for a (tenant, table), optionally with an expiry (`opt_out_until`) and
  reason.
- **History / audit log** — every policy mutation is appended to
  `meta.tenant_retention_opt_out_history` with `event_kind`, `actor_id`,
  `occurred_at`, and `prev_state`/`next_state` snapshots.
- **event_kind** — one of `opt_out_set | opt_out_cleared | retention_set
  | policy_deleted`.
- **actor_id** — the user UUID that performed the mutation; `null` for
  system-driven mutations (rendered `<system>`).

---

## Actions at a glance

| Action | Purpose |
|--------|---------|
| `expiring` | List opt-outs expiring within a window |
| `effective` | Resolve the effective policy for one (tenant, table) |
| `effective-batch` | Bulk-resolve effective policies from a file |
| `opt-out` | Set opt_out=true |
| `opt-in` | Clear opt_out |
| `set` | Set a non-opt-out retention override |
| `delete` | Remove a per-tenant policy row |
| `list-policies` | List platform retention policies |
| `history` | Query the append-only mutation audit log |
| `summary` | Aggregate history counts by dimension |
| `restore` | Restore a policy to a historical state |
| `diff-history` | Compare two history events (expectation checks) |
| `diff-timeline` | Merge history into a chronological timeline |
| `diff` | Compare effective policies across tenants/tables |
| `prune` | Run/preview retention pruning |

---

## Mutation actions

### `retention opt-out <tenant-id> <table-name>`

Set `opt_out=true`. Flags: `--until DATE` (expiry), `--reason TEXT`,
`--retention-days N`. Preserves existing `retention_days` (default 365
for new rows).

### `retention opt-in <tenant-id> <table-name>`

Clear `opt_out` (set false) and `opt_out_until` (NULL). Preserves
`opt_out_reason` as audit history.

### `retention set <tenant-id> <table-name> --days N [--enabled true|false]`

Set a non-opt-out retention override. Clears any existing opt_out +
opt_out_until; preserves opt_out_reason (per ADR-0161).

### `retention delete <tenant-id> <table-name>`

Remove the per-tenant policy row entirely; the tenant inherits the
platform default. Idempotent.

### `retention restore <history-id> [--dry-run] [--actor <uuid>]`

Restore a per-tenant policy to the state captured in a history row.
`prev_state=null` restores via DELETE; populated `prev_state` restores
via the appropriate mutation. Writes a new history row with
`attributes.restored_from = history-id`. `--dry-run` shows the planned
mutation without applying.

All mutation/restore actions accept `--attributes '<json>'` merged into
the history row's `attributes` JSONB column.

---

## Read actions

### `retention effective <tenant-id> <table-name>`

Resolve the effective policy: tenant override / tenant opt-out /
platform default / none.

### `retention effective-batch --pairs-file <path>`

Bulk-resolve from a JSON file (array of `{tenantId, tableName}`). 2 PG
queries total.

### `retention expiring [--within-days N] [--include-expired]`

List opt-outs whose `opt_out_until` falls within the window (default
30d). `--include-expired` also includes already-expired opt-outs.

### `retention list-policies`

List platform retention policies (alphabetical).

---

## `retention history` — the audit log query

```
retention history [--tenant <uuid>] [--table <name>]
                  [--kind <event-kind> ...] [--kind-not <event-kind> ...]
                  [--actor-id <uuid> ...] [--actor-id-not <uuid> ...]
                  [--system-only | --no-system]
                  [--since DATE] [--until DATE] [--limit N]
                  [--after-id <uuid>] [--before-id <uuid>]
                  [--range <after-id>..<before-id>] [--with-actor-names]
                  [--explain] [--format human|json|csv|tsv|ndjson]
```

### The filter family (shared across history / diff-timeline / summary)

| Flag | Semantics |
|------|-----------|
| `--tenant <uuid>` | filter to one tenant |
| `--table <name>` | filter to one table |
| `--kind X --kind Y` | event_kind IN (X, Y) — OR-semantic tuple |
| `--kind-not X` | event_kind NOT IN (X) — exclusion |
| `--actor-id X --actor-id Y` | actor_id IN (X, Y) |
| `--actor-id-not X` | actor_id NOT IN (X); system events included |
| `--system-only` | actor_id IS NULL (system-authored only) |
| `--no-system` | actor_id IS NOT NULL (human-authored only) |
| `--since DATE` / `--until DATE` | occurred_at range (ISO 8601) |

All multi-value flags are repeatable (built on the `multiFlags`
infrastructure). Empty = filter-not-set.

### Pagination

Sorted `occurred_at DESC, id DESC`. `--after-id` paginates forward
(older), `--before-id` backward (newer); mutually exclusive. `--range
<after>..<before>` is a single-flag window. Output gives `nextAfterId` +
`nextBeforeId` when the page is full.

### `--with-actor-names`

LEFT JOINs `meta.users` to surface `display_name` + `email` alongside
raw actor UUIDs.

### Contradiction detection

The CLI rejects contradictory flag combinations BEFORE querying (exit 2):
- **Same-dimension** — `--kind X --kind-not X` (set intersection
  non-empty); `--actor-id Y --actor-id-not Y`.
- **Cross-dimensional** — `--system-only --actor-id X` (system requires
  null actor_id; --actor-id requires a UUID → empty by construction).

---

## `retention summary` — aggregate analytics

```
retention summary [--group-by kind|tenant|actor|table|day|hour|week|month]
                  [--then-by <dimension>]
                  [<filter family>]
                  [--fill-gaps] [--timezone <iana-tz>]
                  [--top N] [--min-count N]
                  [--explain] [--format ...]
```

Aggregates history counts grouped by one dimension, returning buckets
`{key, count}` plus a `totalCount`.

### Grouping dimensions

- **Categorical** — `kind` / `tenant` / `actor` / `table`. Ordered by
  count DESC (leaderboard). `actor` null → `<system>`.
- **Temporal** — `day` / `hour` / `week` / `month`. `date_trunc` buckets
  ordered chronologically (key ASC). Histogram-style.

### `--then-by <dimension>` (cross-tab)

A second grouping dimension (must differ from `--group-by`) produces a
cross-tab grid of composite `{key, subKey, count}` buckets ordered
(primary ASC, secondary ASC). Any × any dimension combination.

```
retention summary --group-by day --then-by kind   # daily per-kind volume
```

### `--fill-gaps` (continuous histograms)

For single-dimension temporal grouping, emit zero-count buckets for
empty time periods (via `generate_series`). Requires `--since` +
`--until`; incompatible with `--then-by`.

```
retention summary --group-by day --since 2026-05-01 --until 2026-05-31 --fill-gaps
```

### `--timezone <iana-tz>` (local-time buckets)

Bucket temporal dimensions in a custom IANA timezone (default UTC).
Parameterized (injection-safe). Temporal grouping only.

```
retention summary --group-by day --timezone America/New_York
```

### `--top N` / `--min-count N` (result limiting)

- `--top N` — return only the N highest-count buckets (forces count-DESC
  ordering).
- `--min-count N` — omit buckets with fewer than N events (HAVING
  threshold).
- Incompatible with `--fill-gaps` (opposite intents).

```
retention summary --group-by actor --min-count 5 --top 20   # top 20 actors with >= 5 events
```

---

## `retention diff-history <id-a> <id-b>` — per-event-pair checks

Compares the policy state in two history events (must be same tenant +
table). Renders a field-by-field diff. Supports expectation-check flags
that assert properties of the two events and exit 1 on mismatch:

- **Global** (both events): `--kind` (multi), `--kind-not` (multi),
  `--actor-id` (multi), `--actor-id-not` (multi), `--system-only` /
  `--no-system`.
- **Per-side** (event A vs B independently): `--kind-a`/`--kind-b`,
  `--kind-not-a`/`--kind-not-b`, `--actor-id-a`/`--actor-id-b`,
  `--actor-id-not-a`/`--actor-id-not-b`, `--system-only-a`/
  `--no-system-a`/`--system-only-b`/`--no-system-b` — all multi-value.

Use case: CI forensic assertions like "assert event A is a system
opt_out_set and event B is a human policy_deleted".

---

## `retention diff-timeline` — chronological merge

Three dispatch paths:
- **Pair-wise** — `<tenant-a> <tenant-b> <table>` merges two tenants'
  history into one chronological timeline; events tagged `[A]`/`[B]`.
- **N-way** — `--add-tenant <c> ...` for 3+ tenants.
- **Cross-table** — `<tenant> <table-a> <table-b> --cross-table
  [--add-table <c> ...]` merges one tenant's history across tables.

Supports the full filter family + cursor pagination (ASC ordering).

---

## `retention diff` — effective-policy comparison

- `<tenant-a> <tenant-b> <table>` — compare effective policies between
  two tenants.
- `<tenant> <table> --vs-platform` — compare a tenant against the
  platform default.
- `<tenant> <table-a> <table-b> --cross-table` — compare one tenant
  across two tables.

---

## `retention prune` — pruning execution

Run or preview retention pruning across prunable tables.

---

## Output formats (`--format`)

| Format | Use |
|--------|-----|
| `human` (default) | aligned text tables |
| `json` | structured envelope (operator input echo + result data) |
| `csv` | RFC 4180 CSV (custom separator via `--csv-separator`) |
| `tsv` | tab-separated |
| `ndjson` | one JSON object per line (log pipelines) |

### JSON envelope: two levels

The JSON envelope has a deliberate two-level field naming separation:
- **Envelope level** echoes operator INPUT (CLI-flag-derived plural
  names: `kinds`, `actorIds`, `kindsA`) — "what did you ask for?"
- **Result level** (inside `result` / `entries`) contains actual DATA
  (domain-model names: `eventKindA`, `actorId`) — "what did you get?"

Example: `diff-history --kind-a opt_out_set --format=json` yields BOTH
`env.kindsA: ["opt_out_set"]` (input echo) AND
`env.result.eventKindA: "opt_out_set"` (actual event A kind).

---

## `--explain` — query inspection

Add `--explain` to `history` / `summary` / `diff-history` /
`diff-timeline` to print the query plan (filters + pagination + output
spec) **plus the raw PostgreSQL SQL with bound parameters**, WITHOUT
executing. Useful for debugging empty results or learning the query
shape.

```
retention history --tenant X --kind opt_out_set --explain
```

Fires AFTER validation + contradiction detection but BEFORE any database
round-trip.

---

## Exit codes

- `0` — success.
- `1` — adapter / database error, or a diff-history expectation-check
  mismatch.
- `2` — CLI validation error (invalid flag value, contradictory flags,
  missing required argument).

---

## Worked examples

```sh
# Set a 90-day retention override for a tenant
retention set 00000000-...-A workflow_traces --days 90

# Opt a tenant out with a 30-day expiry + reason
retention opt-out 00000000-...-A workflow_traces \
  --until 2026-06-30 --reason "legal hold"

# Audit: who changed opt-out policy this month, excluding system sweeps?
retention history --kind opt_out_set --kind opt_out_cleared \
  --no-system --since 2026-05-01 --with-actor-names

# Daily opt-out activity histogram for May (continuous, NY time)
retention summary --group-by day --kind opt_out_set \
  --since 2026-05-01 --until 2026-05-31 \
  --fill-gaps --timezone America/New_York

# Top 10 actors by mutation count, JSON for a dashboard
retention summary --group-by actor --top 10 --format json

# Cross-tab: daily volume per kind, CSV for a spreadsheet
retention summary --group-by day --then-by kind --format csv

# Forensic: assert a restore pair (A deleted, B rebuilt)
retention diff-history <id-a> <id-b> --kind-a policy_deleted --kind-b retention_set

# See the SQL a complex query would run, without executing
retention summary --group-by tenant --min-count 100 --explain
```
