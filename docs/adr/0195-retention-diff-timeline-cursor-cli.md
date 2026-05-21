# ADR-0195: `crossengin retention diff-timeline --after-id` cursor pagination across all three diff-timeline paths (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.cursor)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0175 (--after-id on retention history), ADR-0189 (diff-timeline pair-wise), ADR-0191 (--add-tenant N-way), ADR-0192 (--cross-table), ADR-0193 (--actor-id filter), ADR-0194 (--kind filter) |

## Context

ADR-0175 shipped compound-cursor `--after-id` pagination on `retention history` with DESC ordering (walk-backward in time). ADR-0189/0190/0191/0192/0193/0194 built out `retention diff-timeline` across three dispatch paths (pair-wise cross-tenant + N-way cross-tenant + cross-table) with filter dimensions including `--actor-id` and `--kind`. ADR-0189 Q5 listed cursor pagination on diff-timeline as future work.

Now that filter dimensions are complete, operators auditing high-volume cohorts hit the >100-event limit. Iterating with `--limit N` and adjusting `--since`/`--until` is fragile under concurrent inserts; cursor pagination is the canonical solution. ADR-0193/0194 documented that future cursor pagination depends on substrate-side filter correctness — both are now in place.

M6.7.zz.tenant.opt-out.cli.diff-timeline.cursor closes ADR-0189 Q5 by threading `--after-id <uuid>` through all three diff-timeline paths.

## Decision

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--add-tenant <c> ...]
                                   [--actor-id <uuid>] [--kind <event-kind>]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>]
                                   [--format human|json]

crossengin retention diff-timeline <tenant> <table-a> <table-b> --cross-table
                                   [--add-table <c> ...]
                                   [--actor-id <uuid>] [--kind <event-kind>]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>]
                                   [--format human|json]
```

- `--after-id <uuid>` added to all three dispatch paths uniformly.
- Composes with every existing flag (`--actor-id`, `--kind`, `--with-actor-names`, `--add-tenant`, `--cross-table`, `--add-table`, `--since`, `--until`, `--limit`) without restriction.
- Output gains `nextAfterId: string | null` field (JSON envelope) + page-full hint (human format) — same convention as ADR-0175.

### Why `>` cursor (not `<` like ADR-0175)

ADR-0175 retention history orders DESC (latest first) so the cursor walks BACKWARD in time: `(h.occurred_at, h.id) < (...)`. ADR-0189 diff-timeline orders ASC (chronological top-to-bottom) so the cursor walks FORWARD in time: `(h.occurred_at, h.id) > (...)`. Same compound-cursor compound shape, opposite direction operator.

### Why compound `(occurred_at, id)` cursor

Ties on shared `occurred_at` (concurrent CLI runs producing events at same wall-clock instant) would cause rows to skip pages with single-key `occurred_at` cursor. The compound `(occurred_at, id)` cursor lexicographically tie-breaks via UUID v7 `id`. ORDER BY already includes `h.id ASC` as secondary key on diff-timeline (matches ADR-0175's `h.id DESC` secondary on history).

### Adapter changes

All three input types gain optional `afterId?: string` field:

```ts
export interface DiffHistoryTimelineInput {
  // ...existing fields
  readonly afterId?: string;  // NEW
}

export interface DiffHistoryTimelineNwayInput {
  // ...existing fields
  readonly afterId?: string;  // NEW
}

export interface DiffHistoryTimelineCrossTableInput {
  // ...existing fields
  readonly afterId?: string;  // NEW
}
```

All three adapter methods add identical conditional WHERE clause when `input.afterId !== undefined`:

```sql
(h.occurred_at, h.id) > (
  (SELECT occurred_at FROM meta.tenant_retention_opt_out_history WHERE id = $N),
  $N
)
```

Same `$N` param reused for both the inline subquery lookup and the tiebreaker — operators don't need to pass both `id` AND `occurred_at`; substrate resolves the timestamp server-side from the id.

When `afterId` doesn't exist in the table, the inline subquery returns NULL → outer comparison evaluates NULL → row filtered out → empty result set. Operators detect end-of-pagination via empty result OR via `results.length < limit`.

### `nextAfterId` computation (CLI-side)

The adapter just returns entries; `nextAfterId` is computed at the CLI layer immediately after each adapter call:

```ts
const nextAfterId =
  entries.length === limit ? (entries[entries.length - 1]?.id ?? null) : null;
```

When `entries.length === limit`, the result is page-full and there may be more rows — `nextAfterId` is the last entry's id. When `entries.length < limit`, there are no more rows — `nextAfterId` is null. Same convention as ADR-0175 on retention history.

`nextAfterId` is best-effort — accurate at query time but concurrent inserts may add events later (which the next page would correctly walk via the compound cursor).

### JSON envelope

All three envelope shapes (pair-wise, nway:true, crossTable:true) gain two new fields:

```json
{
  "action": "diff-timeline",
  "since": null,
  "until": null,
  "limit": 100,
  "withActorNames": false,
  "actorId": null,
  "kind": null,
  "afterId": "50000000-...",
  "nextAfterId": "60000000-...",
  "result": { ... }
}
```

Operators chain pagination via bash loop:

```bash
AFTER=""
while true; do
  RESULT=$(crossengin retention diff-timeline <a> <b> <table> \
    ${AFTER:+--after-id $AFTER} \
    --format json --limit 1000)
  echo "$RESULT" | jq '.result.entries[]'
  AFTER=$(echo "$RESULT" | jq -r '.nextAfterId // empty')
  [ -z "$AFTER" ] && break
done
```

### Human-format page-full hint

When `nextAfterId !== null`, the three formatters append a blank line + hint:

```
Events (100):
  ...

Page full — next page: crossengin retention diff-timeline --after-id <uuid> ...
```

Hint omitted when `entries.length < limit`. Same convention as ADR-0175.

### No CLI-side UUID validation

Same convention as ADR-0175/0186/0193: invalid UUIDs hit PG error message rather than crisp CLI exit 2. Substrate doesn't second-guess.

## Use cases unblocked

**1. Iterate through >100-event audit window**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --since 2026-01-01 --limit 1000
# If page is full, output includes nextAfterId pointing at the last event id.
# Re-run with --after-id <that-id> to fetch the next page.
```

**2. Streaming cohort audit via shell loop**

```bash
AFTER=""
while true; do
  PAGE=$(crossengin retention diff-timeline <a> <b> workflow_traces \
    --add-tenant <c> --add-tenant <d> \
    --since 2026-Q1 ${AFTER:+--after-id $AFTER} --format json)
  echo "$PAGE" | jq '.result.entries[]'
  AFTER=$(echo "$PAGE" | jq -r '.nextAfterId // empty')
  [ -z "$AFTER" ] && break
done > full-cohort-audit.ndjson
```

**3. Resume interrupted audit**

```bash
# First run interrupted; save last seen id from terminal or jq pipe.
crossengin retention diff-timeline <a> <b> workflow_traces \
  --after-id <last-known-id> --since <window-start>
# Picks up exactly where it stopped — no overlap, no skipped rows.
```

**4. Per-actor per-kind paginated forensics**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --actor-id <alice> --kind opt_out_set \
  --since 2026-01-01 --limit 1000 --after-id <prev-cursor>
# All filter dimensions compose; cursor walks forward through Alice's
# opt_out_set events one page at a time.
```

## Drawbacks

1. **Three adapter methods each gain identical cursor logic** — acceptable structural symmetry; mirrors ADR-0193/0194's pattern.
2. **No `--before-id` reverse cursor** — operators wanting ascending walks in the reverse direction (newer-first like history's natural order) chain via `--since`/`--until`. Defer; matches ADR-0175's single-direction approach.
3. **`nextAfterId` is best-effort** — concurrent inserts may add events after the page boundary, walked correctly on the next page. Standard caveat for paginated queries on live tables.
4. **No CLI-side UUID validation** — matches ADR-0175/0186/0193 deferred decision.
5. **Cursor `>` direction not `>=`** — operators wanting to include the cursor row jq-filter on the unpaginated result. Strict `>` matches ADR-0175's strict `<` (exclusive boundary).
6. **No total-available count in envelope** — separate `COUNT(*)` query would add a round-trip per page. Operators wanting totals query separately.
7. **`afterId` doesn't compose well with `--since`/`--until` boundary changes mid-pagination** — if operators narrow the window mid-paging, the cursor might point at an event now outside the window. Documented — operators keep window constant across paginated calls.

## Alternatives considered

1. **OFFSET-based pagination via `--page N`** — unstable under concurrent inserts (rows shift between pages). Rejected (same as ADR-0175).
2. **Two-cursor `--after-id` + `--before-id`** — single forward direction covers common case; bidirectional needs operator demand. Defer.
3. **Single-key `occurred_at` cursor** — ties cause skipped pages. Rejected (matches ADR-0175 reasoning).
4. **Single-key `id` cursor** — UUID v7 mostly time-ordered but not strictly; out-of-order rows for same occurred_at could skip. Rejected.
5. **`totalAvailable` count in envelope** — separate COUNT(*) round-trip; not worth the cost per page. Defer.
6. **Validate `--after-id` UUID format at CLI boundary** — PG enforces with clearer error. Matches ADR-0175/0186/0193. Rejected.
7. **Auto-paginate via streaming generator** — operators want explicit page control; shell loops cover the bulk-pagination pattern. Defer.
8. **`nextAfterId` always populated** (even when `entries.length < limit`) — would mislead operators that more pages exist when they don't. Null is the canonical end-of-pagination signal.
9. **Server-side opaque cursor encoding** (base64 of `(occurred_at, id)` tuple) — opaque cursors are useful when the server's pagination implementation might change, but our cursor is a simple UUID — opaque encoding adds complexity without benefit. Defer.
10. **Adapter returns `nextAfterId` directly** — moves the conditional logic into kernel-pg. Acceptable but the per-call calculation is cheap at CLI layer + matches ADR-0175 pattern. Adopted CLI-side computation.

## Open questions

1. **`--before-id <uuid>` reverse cursor** for backward pagination across diff-timeline (pairs with ADR-0175 Q1). Defer.
2. **`totalAvailable` count in envelope** for pagination UI rendering. Defer.
3. **Cross-process cursor stability via point-in-time snapshot** (so paginating through a multi-day window doesn't get affected by concurrent retention/prune mutations). Defer.
4. **`--all` flag to auto-paginate** the whole window in one CLI invocation. Defer; shell loops cover.
5. **Server-side opaque cursor encoding**. Defer.
6. **Cursor + `--include-cursor-row`** for `>=` semantic instead of strict `>`. Defer.
7. **Composite index on `(tenant_id, occurred_at, id)` and `(tenant_id, table_name, occurred_at, id)`** for paginated query performance at scale. Defer until measured.
