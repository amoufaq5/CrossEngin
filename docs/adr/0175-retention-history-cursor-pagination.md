# ADR-0175: `retention history --after-id` cursor pagination (Phase 2 M6.7.zz.tenant.opt-out.cli.history.cursor)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0170 (META_TENANT_RETENTION_OPT_OUT_HISTORY + listOptOutHistory) |

## Context

ADR-0170 / M6.7.zz.tenant.opt-out.history shipped `listOptOutHistory` returning up to `limit` rows ordered by `occurred_at DESC`. The default limit is 100; operators wanting more set `--limit N` up to whatever bound makes sense.

At low-scale deployments this is fine. At high-scale (>100K events per tenant, multi-year retention horizons), operators run into two issues:

1. **`--limit 100000` loads everything into memory** — clumsy for sampling / pagination / streaming workflows.
2. **OFFSET-based pagination is unstable** under concurrent inserts (rows shift between pages as new events land at the top).

The canonical fix is cursor pagination. ADR-0170 Q8 lined it up:

> Q8: History query cursor pagination via `--after-id <uuid>` for >100K-event tenants. Currently uses LIMIT only. Defer.

M6.7.zz.tenant.opt-out.cli.history.cursor closes Q8.

## Decision

### Adapter

Extend `ListOptOutHistoryInput` with optional `afterId?: string` field. When provided, the SQL adds a compound-cursor WHERE clause:

```sql
AND (occurred_at, id) < (
  (SELECT occurred_at FROM meta.tenant_retention_opt_out_history WHERE id = $N),
  $N
)
```

The compound cursor `(occurred_at, id)` ordered lexicographically is stable even when multiple rows share an `occurred_at` (concurrent CLI runs producing events at the same wall-clock instant). `id` (UUID v7, time-ordered) is the tiebreaker.

Same `$N` param used twice — the cursor row's `occurred_at` is fetched server-side via the inline subquery; the cursor id is the literal value.

When `afterId` doesn't exist in the table, the inline subquery returns NULL → outer comparison `(occurred_at, id) < (NULL, $N)` evaluates NULL → row filtered out → empty result set. Operators detect end-of-pagination this way OR when result count is less than the requested limit.

### ORDER BY widened to compound tiebreaker

The ORDER BY clause widens from `ORDER BY occurred_at DESC` to `ORDER BY occurred_at DESC, id DESC` — ensures the result rows match the cursor's order. Without the id tiebreaker, PG could return rows sharing an `occurred_at` in arbitrary order, causing the same row to appear on two consecutive pages or skip across pages.

`occurred_at DESC, id DESC` is naturally consistent with `(occurred_at, id) <` (returns rows strictly "less than" the cursor in compound-order, walking the timeline backwards).

### CLI

Add `--after-id <uuid>` flag to the existing `retention history` action. Operators thread it through to `listOptOutHistory.afterId`. No validation at the CLI boundary — PG enforces UUID format at query time.

Output enhancements:

- **JSON envelope** gains two new fields:
  - `afterId`: the cursor passed in (null when omitted)
  - `nextAfterId`: the last row's id when `results.length === limit` (indicating more pages may exist); null otherwise

- **Human output** gains a footer hint when `results.length === limit`:
  ```
  Page full — next page: crossengin retention history --after-id <last-id> ...
  ```
  Omitted when results.length < limit (end of pagination).

### `nextAfterId` semantic

`nextAfterId` is "the id to pass as `--after-id` for the next page." It equals the last row's id when results.length === limit. It's `null` when results.length < limit — operators interpret this as "no more pages." This is a hint, not a guarantee — concurrent inserts after the query landed might add events, but operators paginating typically don't care (they want the snapshot at query time).

### Backward compatibility

Omitting `--after-id` produces identical query shape to the pre-cursor implementation (modulo the new `id DESC` tiebreaker in ORDER BY, which is a stability improvement, not a behavior change for single-page consumers).

Existing tests pass without modification. The pre-existing test asserting `"ORDER BY occurred_at DESC"` as a substring still matches (the new ORDER BY string contains it as a prefix).

## Use cases unblocked

**1. Paginated dashboard rendering**

```bash
# Page 1
crossengin retention history --tenant <uuid> --limit 50 --format json
# Extract nextAfterId; pass to page 2
crossengin retention history --tenant <uuid> --limit 50 --after-id <id> --format json
```

Dashboards render N at a time without holding huge result sets.

**2. Streaming export for compliance**

```bash
AFTER_ID=""
while :; do
  PAGE=$(crossengin retention history --limit 1000 \
    ${AFTER_ID:+--after-id "$AFTER_ID"} --format json)
  echo "$PAGE" | jq -c '.entries[]' >> compliance-export.jsonl
  AFTER_ID=$(echo "$PAGE" | jq -r '.nextAfterId // empty')
  [ -z "$AFTER_ID" ] && break
done
```

Compliance team exports the full audit log in JSONL chunks without memory pressure.

**3. Replaying recent events for debugging**

```bash
# Get the 10 most recent events
crossengin retention history --limit 10
# Walk back further if needed
crossengin retention history --after-id <last-id-from-above> --limit 10
```

Operators investigating an incident step backwards through the timeline at their own pace.

**4. CI snapshot of audit log state**

```bash
# Capture the most recent 100 events as a snapshot baseline
crossengin retention history --limit 100 --format json > baseline.json
# Later, fetch new events since the baseline's most recent event
crossengin retention history --after-id $(jq -r '.entries[0].id' baseline.json) ...
```

Wait — that's "newer than" not "older than." For forward-in-time pagination (newest first), our DESC + after-id walks backwards. For "show events newer than X," operators use `--since <iso-of-X>` instead.

## Drawbacks

1. **Compound cursor is asymmetric.** `--after-id` walks backwards in time (older entries past the cursor). Operators wanting "events newer than X" use `--since <iso-timestamp>` — separate semantic. The CLI doesn't unify these into one cursor abstraction.
2. **No `--before-id` for ascending pagination.** Operators wanting old → new pagination chain via `--since` + `--limit` instead. Defer.
3. **Cursor row need not be in the result set.** Pagination assumes operators picked a real cursor; passing an arbitrary UUID that doesn't exist in the table produces empty results silently. Documented behavior.
4. **No total-count field.** JSON envelope doesn't include `totalAvailable` — computing it would require a separate `COUNT(*)` query. Operators wanting totals run a separate query.
5. **`nextAfterId === null` is best-effort.** It's accurate at query time. Concurrent inserts can land more events; operators re-running the query later find new entries. This is the standard caveat for any paginated query on a live table.
6. **One extra ORDER BY column** in the query plan. Index optimisations on `(tenant_id, occurred_at)` from ADR-0170 still apply; PG uses occurred_at DESC for the primary sort, id DESC only when ties occur (rare in practice given UUID v7 time-ordering).

## Alternatives considered

1. **OFFSET-based pagination via `--page N`.** Rejected — unstable under concurrent inserts; PG OFFSET scans + discards rows (linear cost growth).
2. **Two-cursor pagination (`--after-id` + `--before-id`).** Rejected this milestone — single forward direction covers the common case; bidirectional needs operator-driven demand.
3. **Use `occurred_at` as the cursor.** Rejected — ties on shared occurred_at would cause rows to skip pages. The compound (occurred_at, id) cursor handles ties.
4. **Use just `id` as the cursor.** Rejected — UUID v7 is mostly time-ordered but PG's index choice + concurrent writes could produce out-of-order rows for the same occurred_at. The compound cursor is bulletproof.
5. **Add `totalAvailable` count to JSON envelope.** Rejected — separate query; operators run COUNT(*) when needed.
6. **Validate `--after-id` as UUID format at CLI boundary.** Rejected — PG enforces format at query time with a clearer error than CLI substring matching.
7. **Auto-paginate via streaming (yield generator).** Rejected — operators want explicit page control; auto-streaming hides the pagination from scripts.
8. **Inline subquery rewritten as a JOIN.** Rejected — current shape is clearer; PG's optimizer handles it efficiently.

## Open questions

1. **`--before-id` for reverse pagination.** Defer until operators ask.
2. **`--page-size` as `--limit` alias.** Defer — `--limit` is consistent with the established CLI convention.
3. **Server-side cursor encoding via opaque base64 token.** Rejected for now; raw id is operator-readable and debuggable.
4. **`totalAvailable` count in JSON envelope.** Defer.
5. **Cross-process cursor stability via point-in-time snapshot.** Currently each invocation sees the latest state. For multi-step paginated workflows where data shouldn't shift, operators wrap with a serializable transaction at the application layer.
6. **`--all` flag to auto-paginate.** Defer; shell loops cover this pattern.
7. **CLI integration with --since for "events between cursor-id and timestamp."** Currently `--since` and `--after-id` compose via WHERE AND. Operators get the intersection. No special-case handling needed.
